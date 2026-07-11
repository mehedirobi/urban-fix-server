require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json());

const {
  DB_USER,
  DB_PASS,
  STRIPE_SECRET,
  SITE_DOMAIN = "http://localhost:5173",
} = process.env;

// IMPORTANT: never call process.exit() in a serverless function.
// That kills the whole invocation and Vercel reports it as
// FUNCTION_INVOCATION_FAILED. Instead we just log and let routes
// fail gracefully with a 500 if something is actually missing.
if (!DB_USER || !DB_PASS || !STRIPE_SECRET) {
  console.error(
    "Missing required environment variables: DB_USER / DB_PASS / STRIPE_SECRET. " +
      "Set them in your Vercel Project Settings -> Environment Variables."
  );
}

const stripe = STRIPE_SECRET ? require("stripe")(STRIPE_SECRET) : null;

const uri = `mongodb+srv://${DB_USER}:${DB_PASS}@cluster0.yvhjyyn.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db;
let usersCollection;
let issuesCollection;
let paymentsCollection;
let connectPromise = null;
let indexesEnsured = false;

const normalizeEmail = (email = "") => email.toLowerCase().trim();
const validRoles = ["citizen", "staff", "admin"];

// Lazy, memoized connection. Safe to call on every request —
// on a warm serverless instance this resolves instantly because
// `connectPromise` is already cached in module scope.
async function connectDB() {
  if (db) return db;

  if (!connectPromise) {
    connectPromise = client
      .connect()
      .then(async () => {
        db = client.db("urbanFixDB");
        usersCollection = db.collection("users");
        issuesCollection = db.collection("issues");
        paymentsCollection = db.collection("payments");

        if (!indexesEnsured) {
          // Don't let index creation crash the request if it
          // fails for some transient reason.
          try {
            await usersCollection.createIndex({ email: 1 }, { unique: true });
            await paymentsCollection.createIndex(
              { sessionId: 1 },
              { unique: true }
            );
          } catch (idxErr) {
            console.error("Index creation warning:", idxErr.message);
          }
          indexesEnsured = true;
        }

        console.log("MongoDB Connected");
        return db;
      })
      .catch((err) => {
        // Reset so the NEXT request tries to reconnect instead of
        // being stuck on a rejected promise forever.
        connectPromise = null;
        db = null;
        throw err;
      });
  }

  return connectPromise;
}

// Small helper so every route doesn't need its own try/catch just
// for the DB-connect step, and a DB outage returns a clean 500
// instead of an unhandled crash.
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

// Create / sync user
app.post(
  "/users",
  withDB(async (req, res) => {
    const { email, name, photoURL } = req.body;

    if (!email) {
      return res.status(400).send({ message: "Email is required" });
    }

    const normalizedEmail = normalizeEmail(email);
    const existingUser = await usersCollection.findOne({
      email: normalizedEmail,
    });

    if (existingUser) {
      const updatedFields = {
        name: name || existingUser.name || "",
        photoURL: photoURL || existingUser.photoURL || "",
        updatedAt: new Date(),
      };

      await usersCollection.updateOne(
        { email: normalizedEmail },
        { $set: updatedFields }
      );

      const updatedUser = await usersCollection.findOne({
        email: normalizedEmail,
      });

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
    return res.send(newUser);
  })
);

// Get all users
app.get(
  "/users",
  withDB(async (req, res) => {
    const { role, email } = req.query;
    const query = {};

    if (role && validRoles.includes(role.toLowerCase())) {
      query.role = role.toLowerCase();
    }

    if (email) {
      query.email = normalizeEmail(email);
    }

    const users = await usersCollection
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    res.send(users);
  })
);

// Get single user by email
app.get(
  "/users/:email",
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);

    if (!email) {
      return res.status(400).send({ message: "Email is required" });
    }

    const user = await usersCollection.findOne({ email });

    if (!user) {
      return res.status(404).send({ message: "User not found" });
    }

    res.send(user);
  })
);

// Update user profile info
app.patch(
  "/users/:email",
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);
    const { name, photoURL, phone } = req.body;

    const updateDoc = {
      $set: {
        updatedAt: new Date(),
      },
    };

    if (name !== undefined) updateDoc.$set.name = name;
    if (photoURL !== undefined) updateDoc.$set.photoURL = photoURL;
    if (phone !== undefined) updateDoc.$set.phone = phone;

    const result = await usersCollection.updateOne({ email }, updateDoc);

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "User not found" });
    }

    const updatedUser = await usersCollection.findOne({ email });
    res.send(updatedUser);
  })
);

// Update role
app.patch(
  "/users/:id/role",
  withDB(async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid user ID" });
    }

    if (!role || !validRoles.includes(role.toLowerCase())) {
      return res.status(400).send({ message: "Invalid role" });
    }

    const result = await usersCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          role: role.toLowerCase(),
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "User not found" });
    }

    const updatedUser = await usersCollection.findOne({
      _id: new ObjectId(id),
    });

    res.send(updatedUser);
  })
);

// Block / unblock user
app.patch(
  "/users/:id/block",
  withDB(async (req, res) => {
    const { id } = req.params;
    const { isBlocked } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid user ID" });
    }

    const result = await usersCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          isBlocked: Boolean(isBlocked),
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "User not found" });
    }

    const updatedUser = await usersCollection.findOne({
      _id: new ObjectId(id),
    });

    res.send(updatedUser);
  })
);

// Premium update
app.patch(
  "/users/:email/premium",
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);
    const { isPremium = true } = req.body;

    const result = await usersCollection.updateOne(
      { email },
      {
        $set: {
          isPremium: Boolean(isPremium),
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "User not found" });
    }

    const updatedUser = await usersCollection.findOne({ email });
    res.send(updatedUser);
  })
);

// =========================
// PAYMENTS
// =========================

app.post(
  "/create-checkout-session",
  withDB(async (req, res) => {
    if (!stripe) {
      return res
        .status(500)
        .send({ message: "Stripe is not configured on the server" });
    }

    const {
      cost,
      userEmail,
      purpose = "UrbanFix Premium Service",
    } = req.body;

    if (!cost || Number(cost) <= 0) {
      return res.status(400).send({ message: "Valid cost is required" });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: purpose,
            },
            unit_amount: Math.round(Number(cost) * 100),
          },
          quantity: 1,
        },
      ],
      metadata: {
        userEmail: normalizeEmail(userEmail || ""),
        purpose,
      },
      success_url: `${SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_DOMAIN}/dashboard/payment-cancel`,
    });

    res.send({
      url: session.url,
      sessionId: session.id,
    });
  })
);

app.post(
  "/payments/verify",
  withDB(async (req, res) => {
    if (!stripe) {
      return res
        .status(500)
        .send({ message: "Stripe is not configured on the server" });
    }

    const { sessionId, email } = req.body;

    if (!sessionId || !email) {
      return res
        .status(400)
        .send({ message: "sessionId and email are required" });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res.status(400).send({ message: "Payment not completed" });
    }

    const existingPayment = await paymentsCollection.findOne({ sessionId });
    if (existingPayment) {
      return res.send({
        message: "Already verified",
        payment: existingPayment,
      });
    }

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

    await paymentsCollection.insertOne(paymentDoc);

    await usersCollection.updateOne(
      { email: normalizeEmail(email) },
      {
        $set: {
          isPremium: true,
          updatedAt: new Date(),
        },
      }
    );

    res.send(paymentDoc);
  })
);

app.get(
  "/payments/:email",
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);

    const payments = await paymentsCollection
      .find({ userEmail: email })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(payments);
  })
);

// =========================
// ISSUES
// =========================

// All issues
app.get(
  "/issues",
  withDB(async (_req, res) => {
    const issues = await issuesCollection
      .find()
      .sort({ createdAt: -1 })
      .toArray();

    res.send(issues);
  })
);

// My issues
app.get(
  "/issues/my/:email",
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);

    const issues = await issuesCollection
      .find({ "postedBy.email": email })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(issues);
  })
);

// Assigned issues
app.get(
  "/issues/assigned/:email",
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);

    const issues = await issuesCollection
      .find({ "assignedTo.email": email })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(issues);
  })
);

// Single issue
app.get(
  "/issues/:id",
  withDB(async (req, res) => {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid issue ID" });
    }

    const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });

    if (!issue) {
      return res.status(404).send({ message: "Issue not found" });
    }

    res.send(issue);
  })
);

// Create issue
app.post(
  "/issues",
  withDB(async (req, res) => {
    const p = req.body;

    if (!p.title || !p.postedBy?.email) {
      return res.status(400).send({
        message: "title and postedBy.email are required",
      });
    }

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
        {
          status: "Pending",
          message: "Issue reported by citizen",
          updatedBy: normalizeEmail(p.postedBy.email),
          date: new Date(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await issuesCollection.insertOne(issueDoc);
    const createdIssue = await issuesCollection.findOne({
      _id: result.insertedId,
    });

    res.send(createdIssue);
  })
);

// Update issue (owner)
app.put(
  "/issues/:id",
  withDB(async (req, res) => {
    const { id } = req.params;
    const { title, description, category, location, image, userEmail } =
      req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid issue ID" });
    }

    const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
    if (!issue) {
      return res.status(404).send({ message: "Issue not found" });
    }

    if (
      !userEmail ||
      normalizeEmail(issue.postedBy.email) !== normalizeEmail(userEmail)
    ) {
      return res.status(403).send({ message: "Unauthorized" });
    }

    const updateDoc = {
      ...(title && { title }),
      ...(description !== undefined && { description }),
      ...(category && { category }),
      ...(location !== undefined && { location }),
      ...(image && { image }),
      updatedAt: new Date(),
    };

    await issuesCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateDoc }
    );

    const updatedIssue = await issuesCollection.findOne({
      _id: new ObjectId(id),
    });
    res.send(updatedIssue);
  })
);

// Delete issue (owner)
app.delete(
  "/issues/:id",
  withDB(async (req, res) => {
    const { id } = req.params;
    const { userEmail } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid issue ID" });
    }

    const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
    if (!issue) {
      return res.status(404).send({ message: "Issue not found" });
    }

    if (
      !userEmail ||
      normalizeEmail(issue.postedBy.email) !== normalizeEmail(userEmail)
    ) {
      return res.status(403).send({ message: "Unauthorized" });
    }

    await issuesCollection.deleteOne({ _id: new ObjectId(id) });
    res.send({ message: "Issue deleted successfully" });
  })
);

// Upvote issue
app.put(
  "/issues/:id/upvote",
  withDB(async (req, res) => {
    const { id } = req.params;
    const { userEmail } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid issue ID" });
    }

    if (!userEmail) {
      return res.status(400).send({ message: "userEmail is required" });
    }

    const normalizedUserEmail = normalizeEmail(userEmail);
    const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });

    if (!issue) {
      return res.status(404).send({ message: "Issue not found" });
    }

    if (normalizeEmail(issue.postedBy.email) === normalizedUserEmail) {
      return res.status(400).send({ message: "Cannot upvote your own issue" });
    }

    if (issue.upvotedUsers?.includes(normalizedUserEmail)) {
      return res.status(400).send({ message: "Already upvoted" });
    }

    await issuesCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $inc: { upvotes: 1 },
        $push: { upvotedUsers: normalizedUserEmail },
        $set: { updatedAt: new Date() },
      }
    );

    const updatedIssue = await issuesCollection.findOne({
      _id: new ObjectId(id),
    });
    res.send(updatedIssue);
  })
);

// Assign issue to staff
app.patch(
  "/issues/:id/assign",
  withDB(async (req, res) => {
    const { id } = req.params;
    const { staffEmail, staffName, adminEmail } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid issue ID" });
    }

    if (!staffEmail) {
      return res.status(400).send({ message: "staffEmail is required" });
    }

    const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
    if (!issue) {
      return res.status(404).send({ message: "Issue not found" });
    }

    const assignedStaff = {
      email: normalizeEmail(staffEmail),
      name: staffName || "",
    };

    const timelineEntry = {
      status: issue.status,
      message: `Issue assigned to ${staffName || staffEmail}`,
      updatedBy: normalizeEmail(adminEmail || "admin"),
      date: new Date(),
    };

    await issuesCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          assignedTo: assignedStaff,
          updatedAt: new Date(),
        },
        $push: {
          timeline: timelineEntry,
        },
      }
    );

    const updatedIssue = await issuesCollection.findOne({
      _id: new ObjectId(id),
    });
    res.send(updatedIssue);
  })
);

// Staff/Admin update issue status
app.patch(
  "/issues/:id/status",
  withDB(async (req, res) => {
    const { id } = req.params;
    const { status, message, updatedBy } = req.body;

    const allowedStatuses = ["Pending", "In Progress", "Resolved", "Rejected"];

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid issue ID" });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).send({ message: "Invalid status" });
    }

    const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
    if (!issue) {
      return res.status(404).send({ message: "Issue not found" });
    }

    const timelineEntry = {
      status,
      message: message || `Issue status updated to ${status}`,
      updatedBy: normalizeEmail(updatedBy || "staff"),
      date: new Date(),
    };

    await issuesCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status,
          updatedAt: new Date(),
        },
        $push: {
          timeline: timelineEntry,
        },
      }
    );

    const updatedIssue = await issuesCollection.findOne({
      _id: new ObjectId(id),
    });
    res.send(updatedIssue);
  })
);

// Boost issue priority
app.patch(
  "/issues/:id/boost",
  withDB(async (req, res) => {
    const { id } = req.params;
    const { userEmail } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid issue ID" });
    }

    const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
    if (!issue) {
      return res.status(404).send({ message: "Issue not found" });
    }

    if (
      !userEmail ||
      normalizeEmail(issue.postedBy.email) !== normalizeEmail(userEmail)
    ) {
      return res.status(403).send({ message: "Unauthorized" });
    }

    const timelineEntry = {
      status: issue.status,
      message: "Issue priority boosted by citizen",
      updatedBy: normalizeEmail(userEmail),
      date: new Date(),
    };

    await issuesCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          priority: "High",
          updatedAt: new Date(),
        },
        $push: {
          timeline: timelineEntry,
        },
      }
    );

    const updatedIssue = await issuesCollection.findOne({
      _id: new ObjectId(id),
    });
    res.send(updatedIssue);
  })
);

// ========================
// 404 HANDLER
// ========================
app.use((req, res) => {
  res.status(404).send({
    message: "Route not found",
    path: req.originalUrl,
  });
});

// ========================
// ERROR HANDLER (catches anything that slips through)
// ========================
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  if (!res.headersSent) {
    res.status(500).send({ message: "Internal server error" });
  }
});

// ========================
// START SERVER
// ========================
// Vercel sets process.env.VERCEL = "1" on its runtime. Only call
// app.listen() when running locally (e.g. `node index.js`).
// On Vercel, the platform itself invokes the exported `app` per
// request, so calling listen() there is not just unnecessary —
// it's part of why the function was crashing.
if (!process.env.VERCEL) {
  connectDB()
    .then(() => {
      app.listen(port, () => {
        console.log(`Server running on http://localhost:${port}`);
      });
    })
    .catch((error) => {
      console.error("Backend startup error:", error);
    });
}

module.exports = app;