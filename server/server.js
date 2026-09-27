
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

require("dotenv").config();

const app = express();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(cors());
app.use(express.json({ limit: "10kb" }));

const PORT = process.env.PORT || 5000;

// RATE LIMITING

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    message: "Too many login attempts. Try again in 15 minutes.",
  },
});

const chatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: "Too many messages. Please try again later.",
});

// DATABASE

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB connected");
  })
  .catch((error) => {
    console.error("MongoDB connection error:", error);
  });

// TEST

app.get("/hello", (req, res) => {
  res.send("Hej från backend!");
});

// ADMIN LOGIN

app.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (
      typeof email !== "string" ||
      typeof password !== "string"
    ) {
      return res.status(400).json({
        message: "Email and password are required",
      });
    }

    if (
      !process.env.ADMIN_EMAIL ||
      !process.env.ADMIN_PASSWORD_HASH ||
      !process.env.JWT_SECRET
    ) {
      console.error("Admin authentication is not configured");

      return res.status(500).json({
        message: "Login is temporarily unavailable",
      });
    }

    const emailMatches = email === process.env.ADMIN_EMAIL;

    const passwordMatches = await bcrypt.compare(
      password,
      process.env.ADMIN_PASSWORD_HASH
    );

    if (!emailMatches || !passwordMatches) {
      return res.status(401).json({
        message: "Invalid credentials",
      });
    }

    const token = jwt.sign(
      { email },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    return res.json({ token });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      message: "Login failed",
    });
  }
});

// JWT AUTHENTICATION

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;

  const token =
    authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;

  if (!token) {
    return res.status(401).json({
      message: "Access denied",
    });
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({
      message: "Invalid or expired token",
    });
  }
};

// GET LEADS

app.get("/leads", authenticateToken, async (req, res) => {
  try {
    const leads = await Lead.find().sort({ _id: -1 });

    res.json(leads);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Could not get leads",
    });
  }
});

// UPDATE LEAD STATUS

app.patch("/leads/:id", authenticateToken, async (req, res) => {
  try {
    const { status } = req.body || {};

    const allowedStatuses = [
      "new",
      "contacted",
      "qualified",
      "closed",
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        message: "Invalid status",
      });
    }

    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );

    if (!lead) {
      return res.status(404).json({
        message: "Lead not found",
      });
    }

    res.json(lead);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Could not update lead",
    });
  }
});

// DELETE LEAD

app.delete("/leads/:id", authenticateToken, async (req, res) => {
  try {
    const lead = await Lead.findByIdAndDelete(req.params.id);

    if (!lead) {
      return res.status(404).json({
        message: "Lead not found",
      });
    }

    res.json({
      message: "Lead deleted",
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Could not delete lead",
    });
  }
});

// AI CHAT

app.post("/message", chatLimiter, async (req, res) => {
  try {
    const { message: userMessage, sessionId } =
      req.body || {};

    if (
      !sessionId ||
      typeof sessionId !== "string" ||
      typeof userMessage !== "string" ||
      !userMessage.trim()
    ) {
      return res.status(400).send(
        "Valid message and session ID are required"
      );
    }

    let conversation = await Conversation.findOne({
      sessionId,
    });

    if (!conversation) {
      conversation = new Conversation({
        sessionId,
        messages: [],
      });
    }

    conversation.messages.push({
      role: "user",
      content: userMessage,
    });

    await conversation.save();

    const response = await openai.responses.create({
      model: "gpt-5.4-mini",

      instructions: `
        You are LeadFlow AI, the AI customer support
        and sales assistant for ${company.name}.

        BUSINESS INFORMATION:
        Company: ${company.name}
        About: ${company.description}
        Services: ${company.services.join(", ")}
        Email: ${company.email}
        Opening hours: ${company.openingHours}

        RULES:
        - Answer using the business information above.
        - Keep answers clear and relatively short.
        - Reply in the same language as the customer.
        - Never invent business information.
        - If a customer shows genuine interest,
          ask for their name and email.
        - Do not ask again for information
          already provided.

        LEAD RULES:
        A lead is complete only when you know:
        - name
        - email
        - service they are interested in

        Return lead as null until all three are known.
      `,

      input: conversation.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),

      text: {
        format: {
          type: "json_schema",
          name: "lead_response",
          strict: true,

          schema: {
            type: "object",

            properties: {
              reply: {
                type: "string",
              },

              lead: {
                anyOf: [
                  {
                    type: "object",

                    properties: {
                      name: { type: "string" },
                      email: { type: "string" },
                      service: { type: "string" },
                    },

                    required: [
                      "name",
                      "email",
                      "service",
                    ],

                    additionalProperties: false,
                  },

                  {
                    type: "null",
                  },
                ],
              },
            },

            required: ["reply", "lead"],

            additionalProperties: false,
          },
        },
      },
    });

    const result = JSON.parse(response.output_text);
    const aiMessage = result.reply;

    if (
      result.lead &&
      result.lead.name?.trim() &&
      result.lead.email?.trim() &&
      result.lead.service?.trim()
    ) {
      const existingLead = await Lead.findOne({
        email: result.lead.email,
      });

      if (!existingLead) {
        const lead = new Lead(result.lead);

        await lead.save();

        console.log("Lead saved:", lead);
      } else {
        console.log(
          "Lead already exists:",
          existingLead.email
        );
      }
    }

    conversation.messages.push({
      role: "assistant",
      content: aiMessage,
    });

    await conversation.save();

    res.send(`AI: ${aiMessage}`);
  } catch (error) {
    console.error(error);

    res.status(500).send(
      "AI: Något gick fel."
    );
  }
});

// START SERVER

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
