const company = require("./company");
const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const mongoose = require("mongoose");
const Lead = require("./models/Lead");
const Conversation = require("./models/Conversation");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { rateLimit } = require("express-rate-limit");
const { handleChatMessage } = require("./chatflow");
const { createInterpreter } = require("./interpreter");
const { withSessionLock } = require("./sessionLock");

require("dotenv").config();

const app = express();
app.set("trust proxy", 1);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const allowedOrigins = [
  "https://lead-flow-ai-weld.vercel.app",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

app.use(
  cors({
    origin: allowedOrigins,
  })
);
app.use(express.json({ limit: "10kb" }));

const PORT = process.env.PORT || 5000;

// Basic per-IP limits. Before serving real customers, review proxy configuration
// and consider a shared rate-limit store if running multiple instances.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { message: "Too many login attempts. Try again later." },
});

const chatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: "Too many messages. Please try again later.",
});

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((error) => console.error("MongoDB connection error:", error));

app.get("/hello", (_req, res) => {
  res.send("Hej från backend!");
});

app.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ message: "Email and password are required" });
    }

    if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD_HASH || !process.env.JWT_SECRET) {
      console.error("Admin authentication is not configured");
      return res.status(500).json({ message: "Login is temporarily unavailable" });
    }

    const emailMatches = email === process.env.ADMIN_EMAIL;
    const passwordMatches = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);
    if (!emailMatches || !passwordMatches) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: "1h" });
    return res.json({ token });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ message: "Login failed" });
  }
});

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ message: "Access denied" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (_error) {
    return res.status(403).json({ message: "Invalid or expired token" });
  }
};

app.get("/leads", authenticateToken, async (_req, res) => {
  try {
    const leads = await Lead.find().sort({ _id: -1 });
    res.json(leads);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Could not get leads" });
  }
});

app.patch("/leads/:id", authenticateToken, async (req, res) => {
  try {
    const { status } = req.body || {};
    const allowedStatuses = ["new", "contacted", "qualified", "closed"];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const lead = await Lead.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    res.json(lead);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Could not update lead" });
  }
});

app.delete("/leads/:id", authenticateToken, async (req, res) => {
  try {
    const lead = await Lead.findByIdAndDelete(req.params.id);
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    res.json({ message: "Lead deleted" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Could not delete lead" });
  }
});

// Chat. The AI model only interprets what the customer wrote (interpreter.js).
// The backend owns the state and decides the next question and when to save
// (chatflow.js + leadstate.js). Set LEADFLOW_DEBUG=true for diagnostic logs
// that never contain customer names, emails or messages.
const chatDeps = {
  company,
  interpret: createInterpreter({ openai, company }),
  leads: {
    findById: (id) => Lead.findById(id),
    findDuplicateEmail: (email, excludeId) =>
      Lead.findOne({ email, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }),
    create: (data) => new Lead(data).save(),
    update: async (lead, data) => {
      lead.name = data.name;
      lead.email = data.email;
      lead.service = data.service;
      return lead.save();
    },
  },
  log: (event, data) => {
    if (process.env.LEADFLOW_DEBUG === "true") console.log("LeadFlow", event, data);
  },
};

app.post("/message", chatLimiter, async (req, res) => {
  try {
    const { message, sessionId } = req.body || {};
    if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 100 ||
        typeof message !== "string" || !message.trim() || message.length > 2000) {
      return res.status(400).send("Valid message and session ID are required");
    }

    // One message at a time per chat, so two quick messages cannot overwrite each other.
    const outcome = await withSessionLock(sessionId, async () => {
      let conversation = await Conversation.findOne({ sessionId });
      if (!conversation) conversation = new Conversation({ sessionId, messages: [] });
      if (conversation.messages.length >= 40) {
        return { status: 400, text: "Den här konversationen är full. Starta en ny chatt." };
      }
      const { reply } = await handleChatMessage({ conversation, message, deps: chatDeps });
      await conversation.save();
      return { status: 200, text: `AI: ${reply}` };
    });
    return res.status(outcome.status).send(outcome.text);
  } catch (error) {
    console.error("Chat error:", error);
    return res.status(500).send("AI: Något gick fel.");
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});