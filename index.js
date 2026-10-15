require("dotenv").config();

const express = require("express");
const cors = require("cors");
const dns = require("dns");
const {
  MongoClient,
  ServerApiVersion,
  ObjectId,
} = require("mongodb");
const admin = require("firebase-admin");

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const {
  DB_USER,
  DB_PASS,
  STRIPE_SECRET,
  FB_SERVICE_KEY,
  MONGODB_URI,
  MONGODB_DB_NAME,
  SITE_DOMAIN,
  FRONTEND_URL,
} = process.env;

const PREMIUM_PRICE_CENTS = 10000;
const PREMIUM_PURPOSE = "UrbanFix Premium Service";

const VALID_ROLES = ["citizen", "staff", "admin"];

const VALID_STATUSES = [
  "Pending",
  "In Progress",
  "Resolved",
  "Rejected",
];

const MAX_PAGE_SIZE = 100;

/* ========================================
   DNS CONFIGURATION
======================================== */

// Optional workaround for local MongoDB SRV DNS resolution.
// Configure your DNS through the operating system if possible.
if (!process.env.VERCEL && process.env.CONFIGURE_PUBLIC_DNS === "true") {
  try {
    dns.setServers(["1.1.1.1", "8.8.8.8"]);
  } catch (error) {
    console.warn("DNS configuration failed:", error.message);
  }
}

/* ========================================
   FIREBASE ADMIN
======================================== */

let firebaseReady = false;

if (FB_SERVICE_KEY) {
  try {
    let serviceAccount;

    try {
      serviceAccount = JSON.parse(
        Buffer.from(FB_SERVICE_KEY, "base64").toString("utf8")
      );
    } catch {
      serviceAccount = JSON.parse(FB_SERVICE_KEY);
    }

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }

    firebaseReady = true;
    console.log("Firebase Admin initialized");
  } catch (error) {
    console.error(
      "Firebase Admin initialization failed:",
      error.message
    );
  }
} else {
  console.warn("FB_SERVICE_KEY is not configured");
}

/* ========================================
   STRIPE
======================================== */

let stripe = null;

if (STRIPE_SECRET) {
  try {
    stripe = require("stripe")(STRIPE_SECRET);
  } catch (error) {
    console.error("Stripe initialization failed:", error.message);
  }
}

/* ========================================
   CORS AND BODY PARSING
======================================== */

const defaultSiteDomain = process.env.VERCEL
  ? "https://urban-fix-project-01.netlify.app"
  : "http://localhost:5173";

function normalizeOrigin(value) {
  const trimmed = value.trim().replace(/\/+$/, "");

  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed;
  }
}

const allowedOrigins = new Set(
  [
    FRONTEND_URL || defaultSiteDomain,
    SITE_DOMAIN || "",
    process.env.CORS_ORIGINS || "",
    "https://urban-fix-project-01.netlify.app",
    "https://urban-fix.netlify.app",
    "http://localhost:5173",
    "http://localhost:5174",
  ]
    .flatMap((value) => value.split(","))
    .map(normalizeOrigin)
    .filter(Boolean)
);

const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(normalizeOrigin(origin))) {
      return callback(null, true);
    }

    return callback(new Error("Origin not allowed by CORS"));
  },
  credentials: true,
};

app.use(cors(corsOptions));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

/* ========================================
   MONGODB CONNECTION
======================================== */

const mongoURI =
  MONGODB_URI ||
  (DB_USER && DB_PASS
    ? `mongodb+srv://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASS)}@cluster0.yvhjyyn.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`
    : "");

const uriDatabaseName = (() => {
  if (!MONGODB_URI) return "";

  try {
    return decodeURIComponent(new URL(MONGODB_URI).pathname.slice(1));
  } catch {
    return "";
  }
})();

const DATABASE_NAME =
  MONGODB_DB_NAME?.trim() || uriDatabaseName || "urbanfix";

let mongoClient;
let db;
let usersCollection;
let issuesCollection;
let paymentsCollection;
let connectionPromise;

function getClient() {
  if (!mongoURI) {
    throw new Error(
      "MongoDB configuration missing. Set MONGODB_URI or DB_USER and DB_PASS."
    );
  }

  if (!mongoClient) {
    mongoClient = new MongoClient(mongoURI, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
      maxPoolSize: 10,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });
  }

  return mongoClient;
}

async function connectDB() {
  if (db && usersCollection && issuesCollection && paymentsCollection) {
    return db;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    const client = getClient();

    await client.connect();

    const database = client.db(DATABASE_NAME);

    const users = database.collection("users");
    const issues = database.collection("issues");
    const payments = database.collection("payments");

    await Promise.all([
      users.createIndex({ email: 1 }, { unique: true }),
      users.createIndex({ role: 1 }),
      users.createIndex({ isBlocked: 1 }),

      issues.createIndex({ userEmail: 1, createdAt: -1 }),
      issues.createIndex({ "postedBy.email": 1 }),
      issues.createIndex({ assignedTo: 1 }),
      issues.createIndex({ status: 1, createdAt: -1 }),
      issues.createIndex({ category: 1 }),

      payments.createIndex({ sessionId: 1 }, { unique: true }),
      payments.createIndex({ userEmail: 1, createdAt: -1 }),
      payments.createIndex({ status: 1 }),
    ]);

    db = database;
    usersCollection = users;
    issuesCollection = issues;
    paymentsCollection = payments;

    console.log(`MongoDB connected: ${DATABASE_NAME}`);

    return db;
  })();

  try {
    return await connectionPromise;
  } catch (error) {
    connectionPromise = null;
    db = null;
    usersCollection = null;
    issuesCollection = null;
    paymentsCollection = null;

    throw error;
  }
}

// Compatibility helper for existing routes.
const getDB = connectDB;

function withDB(handler) {
  return async (req, res, next) => {
    try {
      await connectDB();
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

/* ========================================
   GENERAL HELPERS
======================================== */

const normalizeEmail = (email = "") =>
  typeof email === "string" ? email.trim().toLowerCase() : "";

const isValidEmail = (email) =>
  typeof email === "string" &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const isValidObjectId = (id) =>
  typeof id === "string" &&
  /^[a-f\d]{24}$/i.test(id);

function requireValidObjectId(paramName = "id") {
  return (req, res, next) => {
    if (!isValidObjectId(req.params[paramName])) {
      return res.status(400).json({
        success: false,
        message: "Invalid ID.",
      });
    }

    next();
  };
}

function getPagination(req) {
  const parsePositiveInteger = (value, fallback) => {
    if (
      typeof value !== "string" ||
      !/^\d+$/.test(value)
    ) {
      return fallback;
    }

    const parsed = Number(value);

    return Number.isSafeInteger(parsed) && parsed > 0
      ? parsed
      : fallback;
  };

  const limit = Math.min(
    parsePositiveInteger(req.query.limit, 10),
    MAX_PAGE_SIZE
  );
  const requestedPage = parsePositiveInteger(req.query.page, 1);
  const maxPage = Math.floor(2_147_483_647 / limit) + 1;
  const page = Math.min(requestedPage, maxPage);

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

function normalizeIssueStatus(status) {
  return String(status)
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

const ISSUE_STATUS_ALIASES = {
  pending: ["Pending", "pending"],
  "in progress": [
    "In Progress",
    "In-Progress",
    "in progress",
    "in-progress",
    "ongoing",
    "Ongoing",
  ],
  resolved: ["Resolved", "resolved"],
  rejected: ["Rejected", "rejected"],
};

const CANONICAL_ISSUE_STATUSES = {
  pending: "Pending",
  "in progress": "In Progress",
  resolved: "Resolved",
  rejected: "Rejected",
};

function getIssueStatusFilter(status) {
  const normalizedStatus = normalizeIssueStatus(status);
  const aliases = ISSUE_STATUS_ALIASES[normalizedStatus];

  return aliases ? { status: { $in: aliases } } : null;
}

function getCanonicalIssueStatus(status) {
  return CANONICAL_ISSUE_STATUSES[normalizeIssueStatus(status)];
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function publicUser(user) {
  if (!user) return null;

  const { ...safeUser } = user;

  // Never return stored private credentials or secrets.
  delete safeUser.password;
  delete safeUser.refreshToken;
  delete safeUser.resetToken;

  return safeUser;
}

function getAuthenticatedEmail(req) {
  return normalizeEmail(req.decoded?.email);
}

function getIssueOwnerEmail(issue) {
  return normalizeEmail(
    issue.userEmail || issue.postedBy?.email
  );
}

function isIssueStaff(req) {
  return ["staff", "admin"].includes(req.dbUser?.role);
}

/* ========================================
   AUTHENTICATION MIDDLEWARE
======================================== */

async function verifyFBToken(req, res, next) {
  if (!firebaseReady) {
    return res.status(503).json({
      success: false,
      message: "Authentication service is not configured.",
    });
  }

  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);

  if (!match) {
    return res.status(401).json({
      success: false,
      message: "A valid Bearer token is required.",
    });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);

    if (!decoded.email || decoded.email_verified !== true) {
      return res.status(401).json({
        success: false,
        message: "A verified email is required.",
      });
    }

    req.decoded = decoded;

    // Keep the old property available for existing frontend logic
    // and route handlers that expect req.user.
    req.user = {
      uid: decoded.uid,
      email: normalizeEmail(decoded.email),
      name: decoded.name || "",
      photoURL: decoded.picture || "",
    };

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized: Invalid or expired token.",
    });
  }
}

function verifyEmailMatch(req, res, next) {
  const requestedEmail = normalizeEmail(req.params.email);
  const authenticatedEmail = getAuthenticatedEmail(req);

  if (
    !requestedEmail ||
    requestedEmail !== authenticatedEmail
  ) {
    return res.status(403).json({
      success: false,
      message: "Forbidden: Email mismatch.",
    });
  }

  next();
}

function verifyBodyEmailMatch(req, res, next) {
  if (req.body?.email === undefined) {
    return next();
  }

  const bodyEmail = normalizeEmail(req.body?.email);
  const authenticatedEmail = getAuthenticatedEmail(req);

  if (
    !bodyEmail ||
    bodyEmail !== authenticatedEmail
  ) {
    return res.status(403).json({
      success: false,
      message: "Forbidden: Email mismatch.",
    });
  }

  next();
}

async function loadCurrentUser(req, res, next) {
  try {
    await connectDB();

    const email = getAuthenticatedEmail(req);

    const user = await usersCollection.findOne({ email });

    if (!user) {
      return res.status(403).json({
        success: false,
        message: "User account not found. Please register first.",
      });
    }

    if (user.isBlocked) {
      return res.status(403).json({
        success: false,
        message: "Your account is blocked.",
      });
    }

    req.dbUser = user;
    next();
  } catch (error) {
    next(error);
  }
}

function verifyRole(...roles) {
  return async (req, res, next) => {
    try {
      await connectDB();

      const email = getAuthenticatedEmail(req);
      const user = await usersCollection.findOne({ email });

      if (!user) {
        return res.status(403).json({
          success: false,
          message: "User account not found.",
        });
      }

      if (user.isBlocked) {
        return res.status(403).json({
          success: false,
          message: "Your account is blocked.",
        });
      }

      if (!roles.includes(user.role)) {
        return res.status(403).json({
          success: false,
          message: "Forbidden: Insufficient permissions.",
        });
      }

      req.dbUser = user;
      next();
    } catch (error) {
      next(error);
    }
  };
}

const verifyToken = verifyFBToken;
const verifyAdmin = verifyRole("admin");
const verifyStaffOrAdmin = verifyRole("staff", "admin");
const verifyNotBlocked = loadCurrentUser;

/* ========================================
   HEALTH CHECK
======================================== */

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "UrbanFix API is running.",
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "UrbanFix API is healthy.",
  });
});

app.get(
  "/health/db",
  withDB(async (req, res) => {
    await db.command({ ping: 1 });

    res.json({
      success: true,
      message: "MongoDB connection is healthy.",
    });
  })
);

/* ========================================
   DASHBOARD OVERVIEW
======================================== */

app.get(
  "/dashboard-overview",
  verifyFBToken,
  verifyNotBlocked,
  withDB(async (req, res) => {
    const email = getAuthenticatedEmail(req);
    const user = req.dbUser;

    if (user.role === "citizen") {
      const ownIssues = {
        $or: [
          { userEmail: email },
          { "postedBy.email": email },
        ],
      };

      const [
        totalIssues,
        pendingIssues,
        resolvedIssues,
        totalPayments,
      ] = await Promise.all([
        issuesCollection.countDocuments(ownIssues),
        issuesCollection.countDocuments({
          $and: [
            ownIssues,
            getIssueStatusFilter("Pending"),
          ],
        }),
        issuesCollection.countDocuments({
          $and: [
            ownIssues,
            getIssueStatusFilter("Resolved"),
          ],
        }),
        paymentsCollection.countDocuments({
          userEmail: email,
          status: "Paid",
        }),
      ]);

      return res.json({
        totalIssues,
        pendingIssues,
        resolvedIssues,
        totalPayments,
      });
    }

    const [
      totalIssues,
      pendingIssues,
      inProgressIssues,
      resolvedIssues,
    ] = await Promise.all([
      issuesCollection.countDocuments({}),
      issuesCollection.countDocuments(
        getIssueStatusFilter("Pending")
      ),
      issuesCollection.countDocuments(
        getIssueStatusFilter("In Progress")
      ),
      issuesCollection.countDocuments(
        getIssueStatusFilter("Resolved")
      ),
    ]);

    if (user.role === "staff") {
      return res.json({
        totalIssues,
        pendingIssues,
        inProgressIssues,
        resolvedIssues,
      });
    }

    const [
      totalUsers,
      totalPayments,
      totalPremiumUsers,
    ] = await Promise.all([
      usersCollection.countDocuments({}),
      paymentsCollection.countDocuments({ status: "Paid" }),
      usersCollection.countDocuments({ isPremium: true }),
    ]);

    res.json({
      totalUsers,
      totalIssues,
      totalPayments,
      totalPremiumUsers,
      pendingIssues,
      inProgressIssues,
      resolvedIssues,
    });
  })
);

/* ========================================
   USERS
======================================== */

// Register/synchronize Firebase user.
// The authenticated token, not the body, determines the email.
app.post(
  "/users",
  verifyFBToken,
  verifyBodyEmailMatch,
  withDB(async (req, res) => {
    const email = getAuthenticatedEmail(req);

    const name =
      typeof req.body.name === "string"
        ? req.body.name.trim().slice(0, 100)
        : "";

    const photoURL =
      typeof req.body.photoURL === "string"
        ? req.body.photoURL.trim().slice(0, 2048)
        : "";

    const existingUser = await usersCollection.findOne({ email });

    if (existingUser) {
      const fields = {
        updatedAt: new Date(),
      };

      if (name) fields.name = name;
      if (photoURL) fields.photoURL = photoURL;

      await usersCollection.updateOne(
        { email },
        { $set: fields }
      );

      const updatedUser = await usersCollection.findOne({ email });

      return res.json(publicUser(updatedUser));
    }

    const newUser = {
      email,
      name,
      photoURL,
      phone: "",
      role: "citizen",
      isBlocked: false,
      isPremium: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    try {
      await usersCollection.insertOne(newUser);
    } catch (error) {
      if (error.code !== 11000) throw error;
    }

    const savedUser = await usersCollection.findOne({ email });

    res.status(201).json(publicUser(savedUser));
  })
);

// Admin: list users.
app.get(
  "/users",
  verifyFBToken,
  verifyAdmin,
  withDB(async (req, res) => {
    const query = {};

    if (req.query.role) {
      const role = String(req.query.role).toLowerCase();

      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({
          success: false,
          message: "Invalid role filter.",
        });
      }

      query.role = role;
    }

    if (req.query.email) {
      query.email = normalizeEmail(String(req.query.email));
    }

    const { page, limit, skip } = getPagination(req);

    const [users, total] = await Promise.all([
      usersCollection
        .find(query)
        .project({
          password: 0,
          refreshToken: 0,
          resetToken: 0,
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      usersCollection.countDocuments(query),
    ]);

    res.json({
      data: users,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  })
);

// Read own profile, or another user's profile as admin.
app.get(
  "/users/:email",
  verifyFBToken,
  verifyNotBlocked,
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);
    const requesterEmail = getAuthenticatedEmail(req);

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email.",
      });
    }

    if (email !== requesterEmail) {
      if (req.dbUser.role !== "admin") {
        return res.status(403).json({
          success: false,
          message: "Forbidden.",
        });
      }
    }

    const user = await usersCollection.findOne({ email });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    res.json(publicUser(user));
  })
);

// Update own profile.
app.patch(
  "/users/:email",
  verifyFBToken,
  verifyEmailMatch,
  verifyNotBlocked,
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);
    const { name, photoURL, phone } = req.body;
    const fields = {};

    if (name !== undefined) {
      if (
        typeof name !== "string" ||
        name.trim().length > 100
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid name.",
        });
      }

      fields.name = name.trim();
    }

    if (photoURL !== undefined) {
      if (
        typeof photoURL !== "string" ||
        photoURL.trim().length > 2048
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid photoURL.",
        });
      }

      fields.photoURL = photoURL.trim();
    }

    if (phone !== undefined) {
      if (
        typeof phone !== "string" ||
        phone.trim().length > 30
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid phone.",
        });
      }

      fields.phone = phone.trim();
    }

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid profile fields provided.",
      });
    }

    fields.updatedAt = new Date();

    const result = await usersCollection.updateOne(
      { email },
      { $set: fields }
    );

    if (!result.matchedCount) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const updatedUser = await usersCollection.findOne({ email });

    res.json(publicUser(updatedUser));
  })
);

// Admin: change user role.
app.patch(
  "/users/:id/role",
  verifyFBToken,
  verifyAdmin,
  requireValidObjectId(),
  withDB(async (req, res) => {
    const role =
      typeof req.body.role === "string"
        ? req.body.role.toLowerCase()
        : "";

    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Invalid role.",
      });
    }

    const target = await usersCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!target) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (
      target.email === getAuthenticatedEmail(req) &&
      role !== "admin"
    ) {
      return res.status(400).json({
        success: false,
        message: "You cannot remove your own admin role.",
      });
    }

    await usersCollection.updateOne(
      { _id: target._id },
      { $set: { role, updatedAt: new Date() } }
    );

    res.json(
      publicUser(
        await usersCollection.findOne({ _id: target._id })
      )
    );
  })
);

// Admin: block/unblock user.
app.patch(
  "/users/:id/block",
  verifyFBToken,
  verifyAdmin,
  requireValidObjectId(),
  withDB(async (req, res) => {
    if (typeof req.body.isBlocked !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "isBlocked must be a boolean.",
      });
    }

    const target = await usersCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!target) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (target.email === getAuthenticatedEmail(req)) {
      return res.status(400).json({
        success: false,
        message: "You cannot block your own account.",
      });
    }

    await usersCollection.updateOne(
      { _id: target._id },
      {
        $set: {
          isBlocked: req.body.isBlocked,
          updatedAt: new Date(),
        },
      }
    );

    res.json(
      publicUser(
        await usersCollection.findOne({ _id: target._id })
      )
    );
  })
);

/* ========================================
   STRIPE PAYMENTS
======================================== */

// Create Stripe Checkout Session.
app.post(
  "/create-checkout-session",
  verifyFBToken,
  verifyNotBlocked,
  withDB(async (req, res) => {
    if (!stripe) {
      return res.status(503).json({
        success: false,
        message: "Stripe is not configured.",
      });
    }

    const email = getAuthenticatedEmail(req);
    const user = req.dbUser;

    if (user.isPremium) {
      return res.status(400).json({
        success: false,
        message: "Your account is already premium.",
      });
    }

    const siteURL = (
      FRONTEND_URL || defaultSiteDomain
    ).replace(/\/+$/, "");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: PREMIUM_PRICE_CENTS,
            product_data: {
              name: PREMIUM_PURPOSE,
            },
          },
        },
      ],
      metadata: {
        userEmail: email,
        purpose: PREMIUM_PURPOSE,
      },
      success_url:
        `${siteURL}/dashboard/payment-success` +
        "?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: `${siteURL}/dashboard/payment-cancel`,
    });

    res.json({
      url: session.url,
      sessionId: session.id,
    });
  })
);

// Verify a Stripe Checkout Session.
// For production, also use a Stripe webhook for reliable fulfillment.
app.post(
  "/payments/verify",
  verifyFBToken,
  verifyNotBlocked,
  withDB(async (req, res) => {
    if (!stripe) {
      return res.status(503).json({
        success: false,
        message: "Stripe is not configured.",
      });
    }

    const { sessionId } = req.body;
    const email = getAuthenticatedEmail(req);

    if (
      typeof sessionId !== "string" ||
      !sessionId.startsWith("cs_")
    ) {
      return res.status(400).json({
        success: false,
        message: "A valid sessionId is required.",
      });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (
      session.mode !== "payment" ||
      session.payment_status !== "paid"
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment has not been completed.",
      });
    }

    if (normalizeEmail(session.metadata?.userEmail) !== email) {
      return res.status(403).json({
        success: false,
        message: "Checkout session does not belong to this user.",
      });
    }

    if (
      session.metadata?.purpose !== PREMIUM_PURPOSE ||
      session.amount_total !== PREMIUM_PRICE_CENTS ||
      session.currency !== "usd"
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid premium payment details.",
      });
    }

    const payment = {
      sessionId: session.id,
      transactionId:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id || null,
      amount: session.amount_total / 100,
      currency: session.currency,
      method: "Card",
      status: "Paid",
      purpose: PREMIUM_PURPOSE,
      issueId: null,
      userEmail: email,
      createdAt: new Date(),
    };

    try {
      await paymentsCollection.updateOne(
        { sessionId: session.id },
        {
          $setOnInsert: payment,
        },
        { upsert: true }
      );

      await usersCollection.updateOne(
        { email },
        {
          $set: {
            isPremium: true,
            updatedAt: new Date(),
          },
        }
      );
    } catch (error) {
      throw error;
    }

    const savedPayment = await paymentsCollection.findOne({
      sessionId: session.id,
    });

    res.json({
      success: true,
      message: "Payment verified successfully.",
      payment: savedPayment,
    });
  })
);

// Payment history: own account only.
app.get(
  "/payments/:email",
  verifyFBToken,
  verifyEmailMatch,
  verifyNotBlocked,
  withDB(async (req, res) => {
    const email = normalizeEmail(req.params.email);
    const { page, limit, skip } = getPagination(req);
    const query = { userEmail: email };

    const [data, total] = await Promise.all([
      paymentsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      paymentsCollection.countDocuments(query),
    ]);

    res.json({
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  })
);

/* ========================================
   ISSUES
======================================== */

// GET issues.
//
// Public callers can view the public issue list.
// Query-string role/email values are never treated as authentication.
app.get(
  "/issues",
  withDB(async (req, res) => {
    const {
      status,
      category,
      search,
    } = req.query;

    const { page, limit, skip } = getPagination(req);
    const filter = {};

    if (
      status &&
      normalizeIssueStatus(status) !== "all"
    ) {
      const statusFilter = getIssueStatusFilter(status);

      if (!statusFilter) {
        return res.status(400).json({
          success: false,
          message: "Invalid status filter.",
        });
      }

      Object.assign(filter, statusFilter);
    }

    if (
      category &&
      String(category).toLowerCase() !== "all"
    ) {
      filter.category = String(category);
    }

    if (search) {
      const regex = new RegExp(
        escapeRegex(String(search).slice(0, 100)),
        "i"
      );

      filter.$or = [
        { title: regex },
        { description: regex },
        { location: regex },
        { category: regex },
      ];
    }

    const issueSort =
      normalizeIssueStatus(status) === "resolved"
        ? { updatedAt: -1, createdAt: -1 }
        : { createdAt: -1 };

    const [issues, total] = await Promise.all([
      issuesCollection
        .find(filter)
        .sort(issueSort)
        .skip(skip)
        .limit(limit)
        .toArray(),
      issuesCollection.countDocuments(filter),
    ]);

    res.json({
      success: true,
      issues,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  })
);

// GET one issue.
app.get(
  "/issues/:id",
  requireValidObjectId(),
  withDB(async (req, res) => {
    const issue = await issuesCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!issue) {
      return res.status(404).json({
        success: false,
        message: "Issue not found.",
      });
    }

    res.json({
      success: true,
      issue,
    });
  })
);

// CREATE issue.
app.post(
  "/issues",
  verifyFBToken,
  verifyNotBlocked,
  withDB(async (req, res) => {
    const {
      title,
      description,
      category,
      location,
      image,
      photoURL,
    } = req.body;

    const fields = {
      title,
      description,
      category,
      location,
    };

    for (const [field, value] of Object.entries(fields)) {
      if (
        typeof value !== "string" ||
        !value.trim()
      ) {
        return res.status(400).json({
          success: false,
          message: `${field} is required.`,
        });
      }

      if (value.trim().length > 5000) {
        return res.status(400).json({
          success: false,
          message: `${field} is too long.`,
        });
      }
    }

    const normalizedImage =
      typeof image === "string"
        ? image.trim()
        : typeof photoURL === "string"
          ? photoURL.trim()
          : "";

    if (normalizedImage.length > 2048) {
      return res.status(400).json({
        success: false,
        message: "Image URL is too long.",
      });
    }

    const now = new Date();
    const email = getAuthenticatedEmail(req);

    const issue = {
      title: title.trim(),
      description: description.trim(),
      category: category.trim(),
      location: location.trim(),
      image: normalizedImage,

      // Canonical ownership field.
      userEmail: email,
      userName:
        req.dbUser.name ||
        req.user.name ||
        email.split("@")[0],

      status: "Pending",
      priority: "Normal",
      upvotes: [],
      upvoteCount: 0,
      assignedTo: null,

      // Retain the legacy field for compatibility.
      postedBy: {
        email,
        name:
          req.dbUser.name ||
          req.user.name ||
          email.split("@")[0],
      },

      timeline: [
        {
          status: "Pending",
          message: "Issue reported successfully.",
          timestamp: now,
          updatedBy: email,
        },
      ],

      createdAt: now,
      updatedAt: now,
    };

    const result = await issuesCollection.insertOne(issue);

    res.status(201).json({
      success: true,
      message: "Issue reported successfully.",
      issue: {
        ...issue,
        _id: result.insertedId,
      },
    });
  })
);

// UPDATE issue details or status.
app.patch(
  "/issues/:id",
  verifyFBToken,
  verifyNotBlocked,
  requireValidObjectId(),
  withDB(async (req, res) => {
    const issueId = new ObjectId(req.params.id);

    const issue = await issuesCollection.findOne({
      _id: issueId,
    });

    if (!issue) {
      return res.status(404).json({
        success: false,
        message: "Issue not found.",
      });
    }

    const email = getAuthenticatedEmail(req);
    const isOwner = getIssueOwnerEmail(issue) === email;
    const isStaff = isIssueStaff(req);

    if (!isOwner && !isStaff) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to update this issue.",
      });
    }

    const allowedFields = [
      "title",
      "description",
      "category",
      "location",
      "image",
    ];

    const updates = {};

    for (const field of allowedFields) {
      if (req.body[field] === undefined) continue;

      if (
        typeof req.body[field] !== "string" ||
        !req.body[field].trim()
      ) {
        return res.status(400).json({
          success: false,
          message: `${field} must be a non-empty string.`,
        });
      }

      if (req.body[field].trim().length > 5000) {
        return res.status(400).json({
          success: false,
          message: `${field} is too long.`,
        });
      }

      updates[field] = req.body[field].trim();
    }

    if (req.body.status !== undefined) {
      if (!isStaff) {
        return res.status(403).json({
          success: false,
          message: "Only staff or admin can update issue status.",
        });
      }

      const canonicalStatus = getCanonicalIssueStatus(
        req.body.status
      );

      if (
        !canonicalStatus ||
        !VALID_STATUSES.includes(canonicalStatus)
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid issue status.",
        });
      }

      updates.status = canonicalStatus;

      if (canonicalStatus !== issue.status) {
        const message =
          typeof req.body.message === "string" &&
          req.body.message.trim()
            ? req.body.message.trim().slice(0, 1000)
            : `Issue status updated to ${canonicalStatus}.`;

        updates.timeline = [
          ...(Array.isArray(issue.timeline) ? issue.timeline : []),
          {
            status: canonicalStatus,
            message,
            timestamp: new Date(),
            updatedBy: email,
          },
        ];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields provided for update.",
      });
    }

    updates.updatedAt = new Date();

    await issuesCollection.updateOne(
      { _id: issueId },
      { $set: updates }
    );

    const updatedIssue = await issuesCollection.findOne({
      _id: issueId,
    });

    res.json({
      success: true,
      message: "Issue updated successfully.",
      issue: updatedIssue,
    });
  })
);

// DELETE issue.
app.delete(
  "/issues/:id",
  verifyFBToken,
  verifyNotBlocked,
  requireValidObjectId(),
  withDB(async (req, res) => {
    const issueId = new ObjectId(req.params.id);

    const issue = await issuesCollection.findOne({
      _id: issueId,
    });

    if (!issue) {
      return res.status(404).json({
        success: false,
        message: "Issue not found.",
      });
    }

    const email = getAuthenticatedEmail(req);
    const isOwner = getIssueOwnerEmail(issue) === email;
    const isAdmin = req.dbUser.role === "admin";

    if (!isOwner && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to delete this issue.",
      });
    }

    await issuesCollection.deleteOne({ _id: issueId });

    res.json({
      success: true,
      message: "Issue deleted successfully.",
    });
  })
);

// TOGGLE upvote.
//
// An atomic update avoids the read-then-write race in the old
// implementation. The aggregation pipeline derives the count from
// the resulting upvotes array.
app.patch(
  "/issues/:id/upvote",
  verifyFBToken,
  verifyNotBlocked,
  requireValidObjectId(),
  withDB(async (req, res) => {
    const issueId = new ObjectId(req.params.id);
    const email = getAuthenticatedEmail(req);

    const issue = await issuesCollection.findOne({
      _id: issueId,
    });

    if (!issue) {
      return res.status(404).json({
        success: false,
        message: "Issue not found.",
      });
    }

    if (getIssueOwnerEmail(issue) === email) {
      return res.status(403).json({
        success: false,
        message: "You cannot upvote your own issue.",
      });
    }

    const alreadyUpvoted = (
      Array.isArray(issue.upvotes) ? issue.upvotes : []
    ).some((value) => normalizeEmail(value) === email);

    const updatePipeline = alreadyUpvoted
      ? [
          {
            $set: {
              upvotes: {
                $filter: {
                  input: {
                    $ifNull: ["$upvotes", []],
                  },
                  as: "upvoter",
                  cond: {
                    $ne: [
                      { $toLower: "$$upvoter" },
                      email,
                    ],
                  },
                },
              },
              updatedAt: "$$NOW",
            },
          },
          {
            $set: {
              upvoteCount: { $size: "$upvotes" },
            },
          },
        ]
      : [
          {
            $set: {
              upvotes: {
                $setUnion: [
                  { $ifNull: ["$upvotes", []] },
                  [email],
                ],
              },
              updatedAt: "$$NOW",
            },
          },
          {
            $set: {
              upvoteCount: { $size: "$upvotes" },
            },
          },
        ];

    await issuesCollection.updateOne(
      { _id: issueId },
      updatePipeline
    );

    const updatedIssue = await issuesCollection.findOne({
      _id: issueId,
    });

    res.json({
      success: true,
      message: alreadyUpvoted
        ? "Upvote removed."
        : "Issue upvoted successfully.",
      issue: updatedIssue,
    });
  })
);

// ASSIGN issue to an active staff member.
app.patch(
  "/issues/:id/assign",
  verifyFBToken,
  verifyStaffOrAdmin,
  requireValidObjectId(),
  withDB(async (req, res) => {
    const { staffEmail } = req.body;

    if (
      typeof staffEmail !== "string" ||
      !isValidEmail(staffEmail.trim())
    ) {
      return res.status(400).json({
        success: false,
        message: "A valid staff email is required.",
      });
    }

    const normalizedEmail = normalizeEmail(staffEmail);

    const staffUser = await usersCollection.findOne({
      email: normalizedEmail,
      role: "staff",
      isBlocked: { $ne: true },
    });

    if (!staffUser) {
      return res.status(400).json({
        success: false,
        message: "The selected user is not an active staff member.",
      });
    }

    const issueId = new ObjectId(req.params.id);

    const issue = await issuesCollection.findOne({
      _id: issueId,
    });

    if (!issue) {
      return res.status(404).json({
        success: false,
        message: "Issue not found.",
      });
    }

    const email = getAuthenticatedEmail(req);
    const timeline = [
      ...(Array.isArray(issue.timeline) ? issue.timeline : []),
      {
        status: issue.status || "Pending",
        message: `Issue assigned to ${normalizedEmail}.`,
        timestamp: new Date(),
        updatedBy: email,
      },
    ];

    await issuesCollection.updateOne(
      { _id: issueId },
      {
        $set: {
          assignedTo: normalizedEmail,
          timeline,
          updatedAt: new Date(),
        },
      }
    );

    const updatedIssue = await issuesCollection.findOne({
      _id: issueId,
    });

    res.json({
      success: true,
      message: "Issue assigned successfully.",
      issue: updatedIssue,
    });
  })
);

/* ========================================
   404 HANDLER
======================================== */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

/* ========================================
   GLOBAL ERROR HANDLER
======================================== */

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  // Avoid logging request headers, authorization tokens, or secrets.
  console.error("API error:", error.message);

  if (error.message === "Origin not allowed by CORS") {
    return res.status(403).json({
      success: false,
      message: "This origin is not allowed.",
    });
  }

  if (error.code === 11000) {
    return res.status(409).json({
      success: false,
      message: "A record with this value already exists.",
    });
  }

  const status =
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status < 600
      ? error.status
      : 500;

  res.status(status).json({
    success: false,
    message:
      !IS_PRODUCTION && status !== 500
        ? error.message
        : "Internal server error.",
  });
});

/* ========================================
   SERVER STARTUP / VERCEL EXPORT
======================================== */

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`UrbanFix API running on port ${PORT}`);
  });
}

module.exports = app;