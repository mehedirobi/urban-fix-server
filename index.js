require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;

// ========================
// ENV VALIDATION
// ========================
const {
  DB_USER,
  DB_PASS,
  STRIPE_SECRET,
  SITE_DOMAIN = "http://localhost:5173",
  EXTRA_ORIGINS = "",
} = process.env;

if (!DB_USER || !DB_PASS || !STRIPE_SECRET) {
  console.error(
    "Missing required environment variables: DB_USER / DB_PASS / STRIPE_SECRET. " +
      "Set them in your .env locally or Vercel Project Settings -> Environment Variables."
  );
}

// ========================
// CORS
// ========================
const allowedOrigins = [
  SITE_DOMAIN,
  "http://localhost:5173",
  ...EXTRA_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);
app.use(express.json());

// ========================
// STRIPE
// ========================
const stripe = STRIPE_SECRET ? require("stripe")(STRIPE_SECRET) : null;

// ========================
// MONGODB CONNECTION
// ========================
const encodedUser = encodeURIComponent(DB_USER || "");
const encodedPass = encodeURIComponent(DB_PASS || "");

const uri = `mongodb+srv://${encodedUser}:${encodedPass}@cluster0.yvhjyyn.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
  maxPoolSize: 10,
});

let db;
let usersCollection;
let issuesCollection;
let paymentsCollection;
let connectPromise = null;
let indexesEnsured = false;

const normalizeEmail = (email = "") => email.toLowerCase().trim();
const validRoles = ["citizen", "staff", "admin"];
const allowedStatuses = ["Pending", "In Progress", "Resolved", "Rejected"];

async function connectDB() {
  if (db) return db;

  if (!connectPromise) {
    connectPromise = client
      .connect()
      .then(async () => {
        db = client.db("urbanfix");
        usersCollection = db.collection("users");
        issuesCollection = db.collection("issues");
        paymentsCollection = db.collection("payments");

        if (!indexesEnsured) {
          try {
            await Promise.all([
              usersCollection.createIndex({ email: 1 }, { unique: true }),
              paymentsCollection.createIndex({ sessionId: 1 }, { unique: true }),
              paymentsCollection.createIndex({ userEmail: 1 }),
              issuesCollection.createIndex({ "postedBy.email": 1 }),
              issuesCollection.createIndex({ "assignedTo.email": 1 }),
              issuesCollection.createIndex({ status: 1 }),
              issuesCollection.createIndex({ createdAt: -1 }),
            ]);
          } catch (idxErr) {
            console.error("Index creation warning:", idxErr.message);
          }
          indexesEnsured = true;
        }

        console.log("MongoDB Connected");
        return db;
      })
      .catch((err) => {
        connectPromise = null;
        db = null;
        throw err;
      });
  }

  return connectPromise;
}

function withDB(handler) {
  return async (req, res) => {
    try {
      await connectDB();
    } catch (error) {
      console.error("DB connection error:", error);
      return res.status(500).send({ message: "Database connection failed" });
    }
    try {
      await handler(req, res);
    } catch (error) {
      console.error(`${req.method} ${req.originalUrl} error:`, error);
      if (!res.headersSent) {
        res.status(500).send({ message: "Internal server error" });
      }
    }
  };
}

function requireValidObjectId(paramName = "id") {
  return (req, res, next) => {
    if (!ObjectId.isValid(req.params[paramName])) {
      return res.status(400).send({ message: "Invalid ID" });
    }
    next();
  };
}

function getPagination(req, defaultLimit = 20, maxLimit = 100) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(
    Math.max(parseInt(req.query.limit, 10) || defaultLimit, 1),
    maxLimit
  );
  return { page, limit, skip: (page - 1) * limit };
}

// ========================
// ROOT
// ========================
app.get("/", async (_req, res) => {
  res.send("UrbanFix Backend Running");
});

app.get("/health", async (_req, res) => {
  res.send({ status: "ok", dbConnected: Boolean(db) });
});

// ========================
// USERS
// ========================
app.post(
  "/users",
  withDB(async (req, res) => {
    const { email, name, photoURL } = req.body;
    if (!email) return res.status(400).send({ message: "Email is required" });

    const normalizedEmail = normalizeEmail(email);
    const existingUser = await usersCollection.findOne({ email: normalizedEmail });

    if (existingUser) {
      const updatedFields = {
        name: name || existingUser.name || "",
        photoURL: photoURL || existingUser.photoURL || "",
        updatedAt: new Date(),
      };
      await usersCollection.updateOne({ email: normalizedEmail }, { $set: updatedFields });
      const updatedUser = await usersCollection.findOne({ email: normalizedEmail });
      return res.send(updatedUser);
    }

    const newUser = {
      email: normalizedEmail,
      name: name || "",
      photoURL: photoURL || "",
      phone: "",
      role: "citizen",
      isBlocked: false,
      isPremium: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await usersCollection.insertOne(newUser);
    return res.status(201).send(newUser);
  })
);

app.get(
  "/users",
  withDB(async (req, res) => {
    const { role, email } = req.query;
    const query = {};
    if (role && validRoles.includes(role.toLowerCase())) query.role = role.toLowerCase();
    if (email) query.email = normalizeEmail(email);

    const { page, limit, skip } = getPagination(req);
    const [users, total] = await Promise.all([
      usersCollection.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      usersCollection.countDocuments(query),
    ]);

    res.send({ data: users, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  })
);

app.get(
  "/users/:email",
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);
    if (!email) return res.status(400).send({ message: "Email is required" });
    const user = await usersCollection.findOne({ email });
    if (!user) return res.status(404).send({ message: "User not found" });
    res.send(user);
  })
);

app.patch(
  "/users/:email",
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);
    const { name, photoURL, phone } = req.body;
    const updateDoc = { $set: { updatedAt: new Date() } };
    if (name !== undefined) updateDoc.$set.name = name;
    if (photoURL !== undefined) updateDoc.$set.photoURL = photoURL;
    if (phone !== undefined) updateDoc.$set.phone = phone;

    const result = await usersCollection.updateOne({ email }, updateDoc);
    if (result.matchedCount === 0) return res.status(404).send({ message: "User not found" });
    const updatedUser = await usersCollection.findOne({ email });
    res.send(updatedUser);
  })
);

app.patch(
  "/users/:id/role",
  requireValidObjectId(),
  withDB(async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;
    if (!role || !validRoles.includes(role.toLowerCase()))
      return res.status(400).send({ message: "Invalid role" });

    const result = await usersCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { role: role.toLowerCase(), updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) return res.status(404).send({ message: "User not found" });
    const updatedUser = await usersCollection.findOne({ _id: new ObjectId(id) });
    res.send(updatedUser);
  })
);

app.patch(
  "/users/:id/block",
  requireValidObjectId(),
  withDB(async (req, res) => {
    const { id } = req.params;
    const { isBlocked } = req.body;
    const result = await usersCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { isBlocked: Boolean(isBlocked), updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) return res.status(404).send({ message: "User not found" });
    const updatedUser = await usersCollection.findOne({ _id: new ObjectId(id) });
    res.send(updatedUser);
  })
);

app.patch(
  "/users/:email/premium",
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);
    const { isPremium = true } = req.body;
    const result = await usersCollection.updateOne(
      { email },
      { $set: { isPremium: Boolean(isPremium), updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) return res.status(404).send({ message: "User not found" });
    const updatedUser = await usersCollection.findOne({ email });
    res.send(updatedUser);
  })
);

// ========================
// PAYMENTS
// ========================
app.post(
  "/create-checkout-session",
  withDB(async (req, res) => {
    if (!stripe) return res.status(500).send({ message: "Stripe is not configured on the server" });

    const { cost, userEmail, purpose = "UrbanFix Premium Service" } = req.body;
    if (!cost || Number(cost) <= 0) return res.status(400).send({ message: "Valid cost is required" });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        { price_data: { currency: "usd", product_data: { name: purpose }, unit_amount: Math.round(Number(cost) * 100) }, quantity: 1 },
      ],
      metadata: { userEmail: normalizeEmail(userEmail || ""), purpose },
      success_url: `${SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_DOMAIN}/dashboard/payment-cancel`,
    });

    res.send({ url: session.url, sessionId: session.id });
  })
);

app.post(
  "/payments/verify",
  withDB(async (req, res) => {
    if (!stripe) return res.status(500).send({ message: "Stripe is not configured on the server" });

    const { sessionId, email } = req.body;
    if (!sessionId || !email) return res.status(400).send({ message: "sessionId and email are required" });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") return res.status(400).send({ message: "Payment not completed" });

    const existingPayment = await paymentsCollection.findOne({ sessionId });
    if (existingPayment) return res.send({ message: "Already verified", payment: existingPayment });

    const paymentDoc = {
      userEmail: normalizeEmail(email),
      amount: session.amount_total / 100,
      transactionId: session.payment_intent,
      sessionId,
      status: "Paid",
      method: "Card",
      purpose: session.metadata?.purpose || "UrbanFix Payment",
      createdAt: new Date(),
    };

    try {
      await paymentsCollection.insertOne(paymentDoc);
    } catch (err) {
      if (err.code === 11000) {
        const existing = await paymentsCollection.findOne({ sessionId });
        return res.send({ message: "Already verified", payment: existing });
      }
      throw err;
    }

    await usersCollection.updateOne(
      { email: normalizeEmail(email) },
      { $set: { isPremium: true, updatedAt: new Date() } }
    );

    res.status(201).send(paymentDoc);
  })
);

app.get(
  "/payments/:email",
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);
    const { page, limit, skip } = getPagination(req);
    const [payments, total] = await Promise.all([
      paymentsCollection.find({ userEmail: email }).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      paymentsCollection.countDocuments({ userEmail: email }),
    ]);
    res.send({ data: payments, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  })
);

// ========================
// ISSUES
// ========================
app.get(
  "/issues",
  withDB(async (req, res) => {
    const { status, category } = req.query;
    const query = {};
    if (status && allowedStatuses.includes(status)) query.status = status;
    if (category) query.category = category;

    const { page, limit, skip } = getPagination(req);
    const [issues, total] = await Promise.all([
      issuesCollection.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      issuesCollection.countDocuments(query),
    ]);
    res.send({ data: issues, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  })
);

app.get(
  "/issues/my/:email",
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);
    const { page, limit, skip } = getPagination(req);
    const [issues, total] = await Promise.all([
      issuesCollection.find({ "postedBy.email": email }).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      issuesCollection.countDocuments({ "postedBy.email": email }),
    ]);
    res.send({ data: issues, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  })
);

app.get(
  "/issues/assigned/:email",
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);
    const { page, limit, skip } = getPagination(req);
    const [issues, total] = await Promise.all([
      issuesCollection.find({ "assignedTo.email": email }).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      issuesCollection.countDocuments({ "assignedTo.email": email }),
    ]);
    res.send({ data: issues, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  })
);

app.get(
  "/issues/:id",
  requireValidObjectId(),
  withDB(async (req, res) => {
    const { id } = req.params;
    const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
    if (!issue) return res.status(404).send({ message: "Issue not found" });
    res.send(issue);
  })
);

app.post(
  "/issues",
  withDB(async (req, res) => {
    const p = req.body;
    if (!p.title || !p.postedBy?.email)
      return res.status(400).send({ message: "title and postedBy.email are required" });

    const issueDoc = {
      title: p.title,
      description: p.description || "",
      location: p.location || "",
      category: p.category || "General",
      status: "Pending",
      priority: p.priority || "Normal",
      postedBy: {
        email: normalizeEmail(p.postedBy.email),
        name: p.postedBy.name || "",
        photoURL: p.postedBy.photoURL || "",
      },
      assignedTo: null,
      image: p.image || "",
      upvotes: 0,
      upvotedUsers: [],
      timeline: [
        { status: "Pending", message: "Issue reported by citizen", updatedBy: normalizeEmail(p.postedBy.email), date: new Date() },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await issuesCollection.insertOne(issueDoc);
    const createdIssue = await issuesCollection.findOne({ _id: result.insertedId });
    res.status(201).send(createdIssue);
  })
);

app.put(
  "/issues/:id",
  requireValidObjectId(),
  withDB(async (req, res) => {
    const { id } = req.params;
    const { title, description, category, location, image, userEmail } = req.body;

    const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
    if (!issue) return res.status(404).send({ message: "Issue not found" });
    if (!userEmail || normalizeEmail(issue.postedBy.email) !== normalizeEmail(userEmail))
      return res.status(403).send({ message: "Unauthorized" });

    const updateDoc = {
      ...(title && { title }),
      ...(description !== undefined && { description }),
      ...(category && { category }),
      ...(location !== undefined && { location }),
      ...(image && { image }),
      updatedAt: new Date(),
    };

    await issuesCollection.updateOne({ _id: new ObjectId(id) }, { $set: updateDoc });
    const updatedIssue = await issuesCollection.findOne({ _id: new ObjectId(id) });
    res.send(updatedIssue);
  })
);

app.delete(
  "/issues/:id",
  requireValidObjectId(),
  withDB(async (req, res) => {
    const { id } = req.params;
    const { userEmail } = req.body;

    const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
    if (!issue) return res.status(404).send({ message: "Issue not found" });
    if (!userEmail || normalizeEmail(issue.postedBy.email) !== normalizeEmail(userEmail))
      return res.status(403).send({ message: "Unauthorized" });

    await issuesCollection.deleteOne({ _id: new ObjectId(id) });
    res.send({ message: "Issue deleted successfully" });
  })
);

app.put(
  "/issues/:id/upvote",
  requireValidObjectId(),
  withDB(async (req, res) => {
    const { id } = req.params;
    const { userEmail } = req.body;
    if (!userEmail) return res.status(400).send({ message: "userEmail is required" });

    const normalizedUserEmail = normalizeEmail(userEmail);
    const result = await issuesCollection.findOneAndUpdate(
      { _id: new ObjectId(id), "postedBy.email": { $ne: normalizedUserEmail }, upvotedUsers: { $ne: normalizedUserEmail } },
      { $inc: { upvotes: 1 }, $push: { upvotedUsers: normalizedUserEmail }, $set: { updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    if (!result) {
      const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
      if (!issue) return res.status(404).send({ message: "Issue not found" });
      if (normalizeEmail(issue.postedBy.email) === normalizedUserEmail)
        return res.status(400).send({ message: "Cannot upvote your own issue" });
      return res.status(400).send({ message: "Already upvoted" });
    }

    res.send(result);
  })
);

app.patch(
  "/issues/:id/assign",
  requireValidObjectId(),
  withDB(async (req, res) => {
    const { id } = req.params;
    const { staffEmail, staffName, adminEmail } = req.body;
    if (!staffEmail) return res.status(400).send({ message: "staffEmail is required" });

    const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
    if (!issue) return res.status(404).send({ message: "Issue not found" });

    const assignedStaff = { email: normalizeEmail(staffEmail), name: staffName || "" };
    const timelineEntry = {
      status: issue.status,
      message: `Issue assigned to ${staffName || staffEmail}`,
      updatedBy: normalizeEmail(adminEmail || "admin"),
      date: new Date(),
    };

    await issuesCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { assignedTo: assignedStaff, updatedAt: new Date() }, $push: { timeline: timelineEntry } }
    );

    const updatedIssue = await issuesCollection.findOne({ _id: new ObjectId(id) });
    res.send(updatedIssue);
  })
);

app.patch(
  "/issues/:id/status",
  requireValidObjectId(),
  withDB(async (req, res) => {
    const { id } = req.params;
    const { status, message, updatedBy } = req.body;
    if (!allowedStatuses.includes(status)) return res.status(400).send({ message: "Invalid status" });

    const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
    if (!issue) return res.status(404).send({ message: "Issue not found" });

    const timelineEntry = {
      status,
      message: message || `Issue status updated to ${status}`,
      updatedBy: normalizeEmail(updatedBy || "staff"),
      date: new Date(),
    };

    await issuesCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status, updatedAt: new Date() }, $push: { timeline: timelineEntry } }
    );

    const updatedIssue = await issuesCollection.findOne({ _id: new ObjectId(id) });
    res.send(updatedIssue);
  })
);

app.patch(
  "/issues/:id/boost",
  requireValidObjectId(),
  withDB(async (req, res) => {
    const { id } = req.params;
    const { userEmail } = req.body;

    const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
    if (!issue) return res.status(404).send({ message: "Issue not found" });
    if (!userEmail || normalizeEmail(issue.postedBy.email) !== normalizeEmail(userEmail))
      return res.status(403).send({ message: "Unauthorized" });

    const timelineEntry = {
      status: issue.status,
      message: "Issue priority boosted by citizen",
      updatedBy: normalizeEmail(userEmail),
      date: new Date(),
    };

    await issuesCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { priority: "High", updatedAt: new Date() }, $push: { timeline: timelineEntry } }
    );

    const updatedIssue = await issuesCollection.findOne({ _id: new ObjectId(id) });
    res.send(updatedIssue);
  })
);

// ========================
// 404 HANDLER
// ========================
app.use((req, res) => {
  res.status(404).send({ message: "Route not found", path: req.originalUrl });
});

// ========================
// ERROR HANDLER
// ========================
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  if (!res.headersSent) {
    const status = err.message?.startsWith("CORS blocked") ? 403 : 500;
    res.status(status).send({ message: err.message || "Internal server error" });
  }
});

// ========================
// START SERVER
// ========================
if (!process.env.VERCEL) {
  let server;

  connectDB()
    .then(() => {
      server = app.listen(port, () => {
        console.log(`Server running on http://localhost:${port}`);
      });
    })
    .catch((error) => {
      console.error("Backend startup error:", error);
    });

  const shutdown = async () => {
    console.log("\nShutting down gracefully...");
    if (server) server.close();
    await client.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = app;