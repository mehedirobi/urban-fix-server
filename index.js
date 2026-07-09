require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const {
  DB_USER,
  DB_PASS,
  STRIPE_SECRET,
  SITE_DOMAIN = "http://localhost:5173",
} = process.env;

if (!DB_USER || !DB_PASS || !STRIPE_SECRET) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

const uri = `mongodb+srv://${DB_USER}:${DB_PASS}@cluster0.yvhjyyn.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const normalizeEmail = (email = "") => email.toLowerCase().trim();
const validRoles = ["citizen", "staff", "admin"];

async function run() {
  try {
    await client.connect();
    console.log("MongoDB Connected");

    const db = client.db("urbanFixDB");
    const usersCollection = db.collection("users");
    const issuesCollection = db.collection("issues");
    const paymentsCollection = db.collection("payments");

    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await paymentsCollection.createIndex({ sessionId: 1 }, { unique: true });

    app.get("/", (_req, res) => {
      res.send("UrbanFix Backend Running");
    });

    // ========================
    // USERS
    // ========================

    // Create / sync user
    app.post("/users", async (req, res) => {
  try {
    const { email, name, photoURL } = req.body;

    if (!email) {
      return res.status(400).send({ message: "Email is required" });
    }

    const normalizedEmail = email.toLowerCase();
    const existingUser = await usersCollection.findOne({ email: normalizedEmail });

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
    res.send(newUser);
  } catch (error) {
    console.error("Error saving user:", error);
    res.status(500).send({ message: "Failed to save user" });
  }
});

    // =========================
    // PAYMENTS
    // =========================

    app.post("/create-checkout-session", async (req, res) => {
      try {
        const { cost, userEmail, purpose = "UrbanFix Premium Service" } = req.body;

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
      } catch (error) {
        console.error("POST /create-checkout-session error:", error);
        res.status(500).send({ message: "Failed to create checkout session" });
      }
    });

    app.post("/payments/verify", async (req, res) => {
      try {
        const { sessionId, email } = req.body;

        if (!sessionId || !email) {
          return res.status(400).send({ message: "sessionId and email are required" });
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
        res.send(paymentDoc);
      } catch (error) {
        console.error("POST /payments/verify error:", error);
        res.status(500).send({ message: "Verification failed" });
      }
    });

    app.get("/payments/:email", async (req, res) => {
      try {
        const email = normalizeEmail(req.params.email);

        const payments = await paymentsCollection
          .find({ userEmail: email })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(payments);
      } catch (error) {
        console.error("GET /payments/:email error:", error);
        res.status(500).send({ message: "Failed to fetch payments" });
      }
    });

    // =========================
    // ISSUES
    // =========================

    // All issues
    app.get("/issues", async (_req, res) => {
      try {
        const issues = await issuesCollection.find().sort({ createdAt: -1 }).toArray();
        res.send(issues);
      } catch (error) {
        console.error("GET /issues error:", error);
        res.status(500).send({ message: "Failed to fetch issues" });
      }
    });

    // My issues
    app.get("/issues/my/:email", async (req, res) => {
      try {
        const email = normalizeEmail(req.params.email);

        const issues = await issuesCollection
          .find({ "postedBy.email": email })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(issues);
      } catch (error) {
        console.error("GET /issues/my/:email error:", error);
        res.status(500).send({ message: "Failed to fetch user issues" });
      }
    });

    // Assigned issues
    app.get("/issues/assigned/:email", async (req, res) => {
      try {
        const email = normalizeEmail(req.params.email);

        const issues = await issuesCollection
          .find({ "assignedTo.email": email })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(issues);
      } catch (error) {
        console.error("GET /issues/assigned/:email error:", error);
        res.status(500).send({ message: "Failed to fetch assigned issues" });
      }
    });

    // Single issue
    app.get("/issues/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid issue ID" });
        }

        const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });

        if (!issue) {
          return res.status(404).send({ message: "Issue not found" });
        }

        res.send(issue);
      } catch (error) {
        console.error("GET /issues/:id error:", error);
        res.status(500).send({ message: "Failed to fetch issue" });
      }
    });

    // Create issue
    app.post("/issues", async (req, res) => {
      try {
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
        const createdIssue = await issuesCollection.findOne({ _id: result.insertedId });

        res.send(createdIssue);
      } catch (error) {
        console.error("POST /issues error:", error);
        res.status(500).send({ message: "Failed to create issue" });
      }
    });

    // Update issue (owner)
    app.put("/issues/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { title, description, category, location, image, userEmail } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid issue ID" });
        }

        const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
        if (!issue) {
          return res.status(404).send({ message: "Issue not found" });
        }

        if (!userEmail || normalizeEmail(issue.postedBy.email) !== normalizeEmail(userEmail)) {
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

        const updatedIssue = await issuesCollection.findOne({ _id: new ObjectId(id) });
        res.send(updatedIssue);
      } catch (error) {
        console.error("PUT /issues/:id error:", error);
        res.status(500).send({ message: "Failed to update issue" });
      }
    });

    // Delete issue (owner)
    app.delete("/issues/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { userEmail } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid issue ID" });
        }

        const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
        if (!issue) {
          return res.status(404).send({ message: "Issue not found" });
        }

        if (!userEmail || normalizeEmail(issue.postedBy.email) !== normalizeEmail(userEmail)) {
          return res.status(403).send({ message: "Unauthorized" });
        }

        await issuesCollection.deleteOne({ _id: new ObjectId(id) });
        res.send({ message: "Issue deleted successfully" });
      } catch (error) {
        console.error("DELETE /issues/:id error:", error);
        res.status(500).send({ message: "Failed to delete issue" });
      }
    });

    // Upvote issue
    app.put("/issues/:id/upvote", async (req, res) => {
      try {
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

        const updatedIssue = await issuesCollection.findOne({ _id: new ObjectId(id) });
        res.send(updatedIssue);
      } catch (error) {
        console.error("PUT /issues/:id/upvote error:", error);
        res.status(500).send({ message: "Failed to upvote issue" });
      }
    });

    // Assign issue to staff
    app.patch("/issues/:id/assign", async (req, res) => {
      try {
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

        const updatedIssue = await issuesCollection.findOne({ _id: new ObjectId(id) });
        res.send(updatedIssue);
      } catch (error) {
        console.error("PATCH /issues/:id/assign error:", error);
        res.status(500).send({ message: "Failed to assign issue" });
      }
    });

    // Staff/Admin update issue status
    app.patch("/issues/:id/status", async (req, res) => {
      try {
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

        const updatedIssue = await issuesCollection.findOne({ _id: new ObjectId(id) });
        res.send(updatedIssue);
      } catch (error) {
        console.error("PATCH /issues/:id/status error:", error);
        res.status(500).send({ message: "Failed to update issue status" });
      }
    });

    // Optional: boost priority after payment
    app.patch("/issues/:id/boost", async (req, res) => {
      try {
        const { id } = req.params;
        const { userEmail } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid issue ID" });
        }

        const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
        if (!issue) {
          return res.status(404).send({ message: "Issue not found" });
        }

        if (!userEmail || normalizeEmail(issue.postedBy.email) !== normalizeEmail(userEmail)) {
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

        const updatedIssue = await issuesCollection.findOne({ _id: new ObjectId(id) });
        res.send(updatedIssue);
      } catch (error) {
        console.error("PATCH /issues/:id/boost error:", error);
        res.status(500).send({ message: "Failed to boost issue" });
      }
    });

    console.log(`UrbanFix server ready on port ${port}`);
  } catch (error) {
    console.error("Backend Error:", error);
  }
}

run();

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});