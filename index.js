require("dotenv").config();

// Local Windows/router DNS ঠিক করার জন্য — Vercel-এর sandboxed environment-এ
// dns.setServers() কল করলে crash করতে পারে (permission error), তাই শুধু লোকালি রান করাচ্ছি
if (!process.env.VERCEL) {
  try {
    const dns = require("dns");
    dns.setServers(["8.8.8.8", "1.1.1.1"]);
  } catch (err) {
    console.warn("⚠️  Could not set custom DNS servers:", err.message);
  }
}

const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 3000;

/* =========================
   ENV
========================= */

const {
  DB_USER,
  DB_PASS,
  STRIPE_SECRET,
  SITE_DOMAIN = "http://localhost:5173",
  FB_SERVICE_KEY, // base64-encoded firebase service account JSON
} = process.env;

if (!DB_USER || !DB_PASS) {
  console.error("❌ Missing MongoDB credentials in .env");
}

const stripe = STRIPE_SECRET ? require("stripe")(STRIPE_SECRET) : null;

/* =========================
   Firebase Admin (for auth)
========================= */

if (FB_SERVICE_KEY) {
  try {
    const decoded = Buffer.from(FB_SERVICE_KEY, "base64").toString("utf8");
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(decoded)),
    });
  } catch (err) {
    console.error("❌ Failed to initialize Firebase Admin — check FB_SERVICE_KEY:", err.message);
  }
} else {
  console.warn(
    "⚠️  FB_SERVICE_KEY not set — auth-protected routes will reject all requests."
  );
}

/* =========================
   CORS
========================= */

// SITE_DOMAIN থেকে trailing slash সরিয়ে দেওয়া হচ্ছে (accidental URL mismatch এড়াতে)
const cleanedSiteDomain = SITE_DOMAIN.replace(/\/$/, "");

const allowedOrigins = [
  cleanedSiteDomain,
  "http://localhost:5173",
  "http://localhost:5174", // Vite যদি port shift করে (5173 busy থাকলে)
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Postman/server-to-server requests (no origin header) allow করা হচ্ছে
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      console.warn(`⚠️  CORS blocked request from origin: ${origin}`);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// ✅ FIX: default 100kb limit অনেক ছোট ছিল, যার কারণে ছবি/বড় payload এ 413 error আসছিল।
// এটা বাড়িয়ে 10mb করা হলো। ছবি এখনো ভালো practice অনুযায়ী imgbb/cloud storage এ
// আপলোড করে শুধু URL পাঠানো উচিত (base64 সরাসরি DB তে রাখা এড়িয়ে চলা ভালো)।
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/* =========================
   MongoDB
========================= */

const encodedUser = encodeURIComponent(DB_USER || "");
const encodedPass = encodeURIComponent(DB_PASS || "");

const uri =
  `mongodb+srv://${encodedUser}:${encodedPass}` +
  `@cluster0.yvhjyyn.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

let client;

function getClient() {
  if (!DB_USER || !DB_PASS) {
    // env var missing — throw INSIDE a request handler (caught by withDB),
    // not at module load time, so the function doesn't crash entirely
    throw new Error(
      "MongoDB credentials missing: DB_USER/DB_PASS not set in environment"
    );
  }
  if (!client) {
    client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
      maxPoolSize: 10,
    });
  }
  return client;
}

let db;
let usersCollection;
let issuesCollection;
let paymentsCollection;
let connected = false;

/* =========================
   Helpers
========================= */

const normalizeEmail = (email = "") => email.toLowerCase().trim();

const validRoles = ["citizen", "staff", "admin"];

const allowedStatuses = ["Pending", "In Progress", "Resolved", "Rejected"];

function isValidId(id) {
  return ObjectId.isValid(id);
}

function getPagination(req) {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100); // cap at 100
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function requireValidObjectId(paramName = "id") {
  return (req, res, next) => {
    if (!isValidId(req.params[paramName])) {
      return res.status(400).send({ message: "Invalid ID" });
    }
    next();
  };
}

/* =========================
   Connect DB
========================= */

async function connectDB() {
  if (connected) return;

  const dbClient = getClient();
  await dbClient.connect();

  db = dbClient.db("urbanFixDB");

  usersCollection = db.collection("users");
  issuesCollection = db.collection("issues");
  paymentsCollection = db.collection("payments");

  await Promise.all([
    usersCollection.createIndex({ email: 1 }, { unique: true }),
    paymentsCollection.createIndex({ sessionId: 1 }, { unique: true }),
    paymentsCollection.createIndex({ userEmail: 1 }),
    issuesCollection.createIndex({ "postedBy.email": 1 }),
    issuesCollection.createIndex({ "assignedTo.email": 1 }),
    issuesCollection.createIndex({ status: 1 }),
    issuesCollection.createIndex({ category: 1 }),
    issuesCollection.createIndex({ createdAt: -1 }),
  ]);

  connected = true;
  console.log("✅ MongoDB Connected");
}

/* =========================
   Wrapper
========================= */

function withDB(handler) {
  return async (req, res) => {
    try {
      await connectDB();
      await handler(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        res.status(500).send({ message: "Internal Server Error" });
      }
    }
  };
}

/* =========================
   AUTH MIDDLEWARE
========================= */

// Verifies Firebase ID token sent as: Authorization: Bearer <token>
async function verifyFBToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send({ message: "Unauthorized: No token" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded = decoded; // decoded.email available
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorized: Invalid token" });
  }
}

// Ensures the token's email matches the :email route param
function verifyEmailMatch(req, res, next) {
  const routeEmail = normalizeEmail(req.params.email || "");
  const tokenEmail = normalizeEmail(req.decoded?.email || "");

  if (routeEmail !== tokenEmail) {
    return res.status(403).send({ message: "Forbidden: Email mismatch" });
  }
  next();
}

// Role-based guard — checks role in DB (call AFTER verifyFBToken)
function verifyRole(...roles) {
  return async (req, res, next) => {
    try {
      await connectDB();
      const email = normalizeEmail(req.decoded?.email || "");
      const user = await usersCollection.findOne({ email });

      if (!user || !roles.includes(user.role)) {
        return res.status(403).send({ message: "Forbidden: Insufficient role" });
      }
      req.dbUser = user;
      next();
    } catch (err) {
      console.error(err);
      res.status(500).send({ message: "Internal Server Error" });
    }
  };
}

const verifyAdmin = verifyRole("admin");
const verifyStaffOrAdmin = verifyRole("staff", "admin");

// ========================
// USERS
// ========================

// Create / Sync User (public — called right after login/signup)
app.post(
  "/users",
  withDB(async (req, res) => {
    const { email, name = "", photoURL = "" } = req.body;

    if (!email) {
      return res.status(400).send({ message: "Email is required" });
    }

    const normalizedEmail = normalizeEmail(email);

    const existingUser = await usersCollection.findOne({ email: normalizedEmail });

    if (existingUser) {
      await usersCollection.updateOne(
        { email: normalizedEmail },
        { $set: { name, photoURL, updatedAt: new Date() } }
      );

      const updatedUser = await usersCollection.findOne({ email: normalizedEmail });
      return res.send(updatedUser);
    }

    const newUser = {
      email: normalizedEmail,
      name,
      photoURL,
      phone: "",
      role: "citizen",
      isBlocked: false,
      isPremium: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await usersCollection.insertOne(newUser);
    res.status(201).send(newUser);
  })
);

// Get Users — admin only
app.get(
  "/users",
  verifyFBToken,
  verifyAdmin,
  withDB(async (req, res) => {
    const query = {};

    if (req.query.role && validRoles.includes(req.query.role.toLowerCase())) {
      query.role = req.query.role.toLowerCase();
    }

    if (req.query.email) {
      query.email = normalizeEmail(req.query.email);
    }

    const { page, limit, skip } = getPagination(req);

    const [users, total] = await Promise.all([
      usersCollection.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      usersCollection.countDocuments(query),
    ]);

    res.send({
      data: users,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  })
);

// Single User — must be self or admin
app.get(
  "/users/:email",
  verifyFBToken,
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);
    const tokenEmail = normalizeEmail(req.decoded.email);

    if (email !== tokenEmail) {
      const requester = await usersCollection.findOne({ email: tokenEmail });
      if (!requester || requester.role !== "admin") {
        return res.status(403).send({ message: "Forbidden" });
      }
    }

    const user = await usersCollection.findOne({ email });

    if (!user) {
      return res.status(404).send({ message: "User not found" });
    }

    res.send(user);
  })
);

// Update Profile — self only
app.patch(
  "/users/:email",
  verifyFBToken,
  verifyEmailMatch,
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);
    const { name, photoURL, phone } = req.body;

    const updateDoc = { $set: { updatedAt: new Date() } };

    if (name !== undefined) updateDoc.$set.name = name;
    if (photoURL !== undefined) updateDoc.$set.photoURL = photoURL;
    if (phone !== undefined) updateDoc.$set.phone = phone;

    const result = await usersCollection.updateOne({ email }, updateDoc);

    if (!result.matchedCount) {
      return res.status(404).send({ message: "User not found" });
    }

    const updatedUser = await usersCollection.findOne({ email });
    res.send(updatedUser);
  })
);

// Change Role — admin only
app.patch(
  "/users/:id/role",
  verifyFBToken,
  verifyAdmin,
  requireValidObjectId(),
  withDB(async (req, res) => {
    const { role } = req.body;

    if (!validRoles.includes(role?.toLowerCase())) {
      return res.status(400).send({ message: "Invalid role" });
    }

    const result = await usersCollection.findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: { role: role.toLowerCase(), updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    if (!result) {
      return res.status(404).send({ message: "User not found" });
    }

    res.send(result);
  })
);

// Block / Unblock — admin only
app.patch(
  "/users/:id/block",
  verifyFBToken,
  verifyAdmin,
  requireValidObjectId(),
  withDB(async (req, res) => {
    const result = await usersCollection.findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: { isBlocked: Boolean(req.body.isBlocked), updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    if (!result) {
      return res.status(404).send({ message: "User not found" });
    }

    res.send(result);
  })
);

// Premium — self only (usually triggered right after payment verification)
app.patch(
  "/users/:email/premium",
  verifyFBToken,
  verifyEmailMatch,
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);

    const result = await usersCollection.findOneAndUpdate(
      { email },
      { $set: { isPremium: Boolean(req.body.isPremium ?? true), updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    if (!result) {
      return res.status(404).send({ message: "User not found" });
    }

    res.send(result);
  })
);

// ========================
// PAYMENTS
// ========================

// Create Checkout Session — must be logged in
app.post(
  "/create-checkout-session",
  verifyFBToken,
  withDB(async (req, res) => {
    if (!stripe) {
      return res.status(500).send({ message: "Stripe is not configured" });
    }

    const { cost, userEmail, purpose = "UrbanFix Premium Service", issueId } = req.body;

    if (!cost || Number(cost) <= 0) {
      return res.status(400).send({ message: "Valid cost is required" });
    }

    const normalizedEmail = normalizeEmail(userEmail || req.decoded.email);

    if (normalizedEmail !== normalizeEmail(req.decoded.email)) {
      return res.status(403).send({ message: "Forbidden" });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: Math.round(Number(cost) * 100),
            product_data: { name: purpose },
          },
        },
      ],
      metadata: {
        userEmail: normalizedEmail,
        purpose,
        issueId: issueId || "",
      },
      success_url: `${cleanedSiteDomain}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${cleanedSiteDomain}/dashboard/payment-cancel`,
    });

    res.send({ url: session.url, sessionId: session.id });
  })
);

// Verify Payment — must be logged in as the paying user
app.post(
  "/payments/verify",
  verifyFBToken,
  withDB(async (req, res) => {
    if (!stripe) {
      return res.status(500).send({ message: "Stripe is not configured" });
    }

    const { sessionId, email } = req.body;

    if (!sessionId || !email) {
      return res.status(400).send({ message: "sessionId and email are required" });
    }

    if (normalizeEmail(email) !== normalizeEmail(req.decoded.email)) {
      return res.status(403).send({ message: "Forbidden" });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res.status(400).send({ message: "Payment not completed" });
    }

    const existingPayment = await paymentsCollection.findOne({ sessionId });

    if (existingPayment) {
      return res.send({ success: true, message: "Already verified", payment: existingPayment });
    }

    const payment = {
      sessionId,
      transactionId: session.payment_intent,
      amount: session.amount_total / 100,
      method: "Card",
      status: "Paid",
      purpose: session.metadata?.purpose || "UrbanFix Premium Service",
      issueId: session.metadata?.issueId || null,
      userEmail: normalizeEmail(email),
      createdAt: new Date(),
    };

    try {
      await paymentsCollection.insertOne(payment);
    } catch (err) {
      if (err.code === 11000) {
        const oldPayment = await paymentsCollection.findOne({ sessionId });
        return res.send({ success: true, payment: oldPayment });
      }
      throw err;
    }

    await usersCollection.updateOne(
      { email: normalizeEmail(email) },
      { $set: { isPremium: true, updatedAt: new Date() } }
    );

    res.status(201).send({ success: true, payment });
  })
);

// Payment History — self only
app.get(
  "/payments/:email",
  verifyFBToken,
  verifyEmailMatch,
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);
    const { page, limit, skip } = getPagination(req);

    const [payments, total] = await Promise.all([
      paymentsCollection.find({ userEmail: email }).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      paymentsCollection.countDocuments({ userEmail: email }),
    ]);

    res.send({
      data: payments,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  })
);

// ========================
// ISSUES
// ========================

// Get All Issues — public (citizens browse community issues)
app.get(
  "/issues",
  withDB(async (req, res) => {
    const query = {};

    if (req.query.status && allowedStatuses.includes(req.query.status)) {
      query.status = req.query.status;
    }

    if (req.query.category) {
      query.category = req.query.category;
    }

    const { page, limit, skip } = getPagination(req);

    const [issues, total] = await Promise.all([
      issuesCollection.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      issuesCollection.countDocuments(query),
    ]);

    res.send({
      data: issues,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  })
);

// My Issues — self only
app.get(
  "/issues/my/:email",
  verifyFBToken,
  verifyEmailMatch,
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);
    const { page, limit, skip } = getPagination(req);
    const query = { "postedBy.email": email };

    const [issues, total] = await Promise.all([
      issuesCollection.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      issuesCollection.countDocuments(query),
    ]);

    res.send({
      data: issues,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  })
);

// Assigned Issues — self (staff) or admin
app.get(
  "/issues/assigned/:email",
  verifyFBToken,
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);
    const tokenEmail = normalizeEmail(req.decoded.email);

    if (email !== tokenEmail) {
      const requester = await usersCollection.findOne({ email: tokenEmail });
      if (!requester || requester.role !== "admin") {
        return res.status(403).send({ message: "Forbidden" });
      }
    }

    const { page, limit, skip } = getPagination(req);
    const query = { "assignedTo.email": email };

    const [issues, total] = await Promise.all([
      issuesCollection.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      issuesCollection.countDocuments(query),
    ]);

    res.send({
      data: issues,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  })
);

// Single Issue — public
app.get(
  "/issues/:id",
  requireValidObjectId(),
  withDB(async (req, res) => {
    const issue = await issuesCollection.findOne({ _id: new ObjectId(req.params.id) });

    if (!issue) {
      return res.status(404).send({ message: "Issue not found" });
    }

    res.send(issue);
  })
);

// Create Issue — must be logged in; postedBy comes from token, not body
app.post(
  "/issues",
  verifyFBToken,
  withDB(async (req, res) => {
    const p = req.body;

    if (!p.title) {
      return res.status(400).send({ message: "title is required" });
    }

    const posterEmail = normalizeEmail(req.decoded.email);
    const poster = await usersCollection.findOne({ email: posterEmail });

    if (poster?.isBlocked) {
      return res.status(403).send({ message: "Your account is blocked" });
    }

    const issue = {
      title: p.title.trim(),
      description: p.description?.trim() || "",
      location: p.location || "",
      category: p.category || "General",
      image: p.image || "",
      priority: p.priority || "Normal",
      status: "Pending",
      upvotes: 0,
      upvotedUsers: [],
      postedBy: {
        email: posterEmail,
        name: poster?.name || p.postedBy?.name || "",
        photoURL: poster?.photoURL || p.postedBy?.photoURL || "",
      },
      assignedTo: null,
      timeline: [
        {
          status: "Pending",
          message: "Issue reported by citizen",
          updatedBy: posterEmail,
          date: new Date(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await issuesCollection.insertOne(issue);
    const created = await issuesCollection.findOne({ _id: result.insertedId });

    res.status(201).send(created);
  })
);

// ========================
// UPDATE ISSUE — owner only (via token, not body)
// ========================
app.put(
  "/issues/:id",
  verifyFBToken,
  requireValidObjectId(),
  withDB(async (req, res) => {
    const { id } = req.params;
    const { title, description, category, location, image } = req.body;

    const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });

    if (!issue) {
      return res.status(404).send({ message: "Issue not found" });
    }

    if (normalizeEmail(issue.postedBy.email) !== normalizeEmail(req.decoded.email)) {
      return res.status(403).send({ message: "Unauthorized" });
    }

    const updateData = { updatedAt: new Date() };

    if (title !== undefined) updateData.title = title.trim();
    if (description !== undefined) updateData.description = description.trim();
    if (category !== undefined) updateData.category = category;
    if (location !== undefined) updateData.location = location;
    if (image !== undefined) updateData.image = image;

    await issuesCollection.updateOne({ _id: new ObjectId(id) }, { $set: updateData });

    const updatedIssue = await issuesCollection.findOne({ _id: new ObjectId(id) });
    res.send(updatedIssue);
  })
);

// ========================
// DELETE ISSUE — owner or admin only
// ========================
app.delete(
  "/issues/:id",
  verifyFBToken,
  requireValidObjectId(),
  withDB(async (req, res) => {
    const { id } = req.params;

    const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });

    if (!issue) {
      return res.status(404).send({ message: "Issue not found" });
    }

    const tokenEmail = normalizeEmail(req.decoded.email);
    const isOwner = normalizeEmail(issue.postedBy.email) === tokenEmail;

    if (!isOwner) {
      const requester = await usersCollection.findOne({ email: tokenEmail });
      if (!requester || requester.role !== "admin") {
        return res.status(403).send({ message: "Unauthorized" });
      }
    }

    await issuesCollection.deleteOne({ _id: new ObjectId(id) });

    res.send({ success: true, message: "Issue deleted successfully" });
  })
);

// ========================
// UPVOTE ISSUE — logged in users only
// ========================
app.put(
  "/issues/:id/upvote",
  verifyFBToken,
  requireValidObjectId(),
  withDB(async (req, res) => {
    const { id } = req.params;
    const email = normalizeEmail(req.decoded.email);

    const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });

    if (!issue) {
      return res.status(404).send({ message: "Issue not found" });
    }

    if (normalizeEmail(issue.postedBy.email) === email) {
      return res.status(400).send({ message: "You cannot upvote your own issue" });
    }

    const result = await issuesCollection.findOneAndUpdate(
      { _id: new ObjectId(id), upvotedUsers: { $ne: email } },
      {
        $inc: { upvotes: 1 },
        $push: { upvotedUsers: email },
        $set: { updatedAt: new Date() },
      },
      { returnDocument: "after" }
    );

    if (!result) {
      return res.status(400).send({ message: "Already upvoted" });
    }

    res.send(result);
  })
);

// ========================
// ASSIGN ISSUE — staff or admin only
// ========================
app.patch(
  "/issues/:id/assign",
  verifyFBToken,
  verifyStaffOrAdmin,
  requireValidObjectId(),
  withDB(async (req, res) => {
    const { id } = req.params;
    const { staffEmail, staffName } = req.body;

    if (!staffEmail) {
      return res.status(400).send({ message: "staffEmail is required" });
    }

    const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });

    if (!issue) {
      return res.status(404).send({ message: "Issue not found" });
    }

    const updatedIssue = await issuesCollection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $set: {
          assignedTo: { email: normalizeEmail(staffEmail), name: staffName || "" },
          updatedAt: new Date(),
        },
        $push: {
          timeline: {
            status: issue.status,
            message: `Assigned to ${staffName || staffEmail}`,
            updatedBy: normalizeEmail(req.decoded.email),
            date: new Date(),
          },
        },
      },
      { returnDocument: "after" }
    );

    res.send(updatedIssue);
  })
);

// ========================
// UPDATE ISSUE STATUS — staff or admin only
// ========================
app.patch(
  "/issues/:id/status",
  verifyFBToken,
  verifyStaffOrAdmin,
  requireValidObjectId(),
  withDB(async (req, res) => {
    const { id } = req.params;
    const { status, message } = req.body;

    if (!allowedStatuses.includes(status)) {
      return res.status(400).send({ message: "Invalid status" });
    }

    const updatedIssue = await issuesCollection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $set: { status, updatedAt: new Date() },
        $push: {
          timeline: {
            status,
            message: message || `Issue marked as ${status}`,
            updatedBy: normalizeEmail(req.decoded.email),
            date: new Date(),
          },
        },
      },
      { returnDocument: "after" }
    );

    if (!updatedIssue) {
      return res.status(404).send({ message: "Issue not found" });
    }

    res.send(updatedIssue);
  })
);

// ========================
// BOOST PRIORITY — owner only
// ========================
app.patch(
  "/issues/:id/boost",
  verifyFBToken,
  requireValidObjectId(),
  withDB(async (req, res) => {
    const { id } = req.params;
    const email = normalizeEmail(req.decoded.email);

    const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });

    if (!issue) {
      return res.status(404).send({ message: "Issue not found" });
    }

    if (normalizeEmail(issue.postedBy.email) !== email) {
      return res.status(403).send({ message: "Unauthorized" });
    }

    if (issue.priority === "High") {
      return res.status(400).send({ message: "Issue is already boosted" });
    }

    const updatedIssue = await issuesCollection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $set: { priority: "High", updatedAt: new Date() },
        $push: {
          timeline: {
            status: issue.status,
            message: "Issue priority boosted",
            updatedBy: email,
            date: new Date(),
          },
        },
      },
      { returnDocument: "after" }
    );

    res.send(updatedIssue);
  })
);

// ========================
// HEALTH CHECK
// ========================
app.get("/", (req, res) => {
  res.send({ status: "ok", message: "UrbanFix API is running" });
});

// ========================
// 404 HANDLER
// ========================
app.use((req, res) => {
  res.status(404).send({ message: "Route not found" });
});

// ========================
// GLOBAL ERROR HANDLER
// ========================
// এটা catch করবে যদি express.json() নিজেই malformed JSON বা oversized payload এ error দেয়,
// যাতে raw crash/stack trace এর বদলে clean JSON error response যায়
app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") {
    return res.status(413).send({ message: "Payload too large. Please reduce file/data size." });
  }
  if (err.message === "Not allowed by CORS") {
    return res.status(403).send({ message: "CORS: Origin not allowed" });
  }
  console.error("Unhandled error:", err);
  if (!res.headersSent) {
    res.status(500).send({ message: "Internal Server Error" });
  }
});

// ========================
// START SERVER
// ========================

async function startServer() {
  try {
    await connectDB();

    if (!process.env.VERCEL) {
      const server = app.listen(port, () => {
        console.log(`🚀 Server running on http://localhost:${port}`);
      });

      const shutdown = async () => {
        console.log("\nClosing server...");

        server.close(async () => {
          try {
            await getClient().close();
            console.log("MongoDB Closed");
          } catch (err) {
            console.error(err);
          }

          process.exit(0);
        });
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    }
  } catch (err) {
    console.error("Startup Error:", err);
  }
}

startServer();

module.exports = app;