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
const { correctedService, bareCorrectedName, normalize, isValidEmail, emailFrom, customerSaid, explicitName, correctionField, isConfirmation, hasAllFields, isSwedish } = require("./leadstate");

require("dotenv").config();

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
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

// CHAT AND CUSTOMER DATA
// A lead is only written after the customer confirms all three fields.
// Draft and correction status live in MongoDB, independently of the AI transcript.
app.post("/message", chatLimiter, async (req, res) => {
  try {
    const { message, sessionId } = req.body || {};
    if (
      typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 100 ||
      typeof message !== "string" || !message.trim() || message.length > 2000
    ) {
      return res.status(400).send("Valid message and session ID are required");
    }

    const userMessage = message.trim();
    let conversation = await Conversation.findOne({ sessionId });
    if (!conversation) conversation = new Conversation({ sessionId, messages: [] });
    if (conversation.messages.length >= 40) {
      return res.status(400).send("Den här konversationen är full. Starta en ny chatt.");
    }

    const draft = {
      name: conversation.leadDraft?.name || "",
      email: conversation.leadDraft?.email || "",
      service: conversation.leadDraft?.service || "",
    };
    const swedish = isSwedish([...conversation.messages, { role: "user", content: userMessage }]);
    const say = (sv, en) => swedish ? sv : en;
    const reply = async (text) => {
      conversation.messages.push({ role: "assistant", content: text });
      await conversation.save();
      return res.send(`AI: ${text}`);
    };

    // Accept an explicit yes ONLY after we have shown the complete draft.
    // A correction invalidates that confirmation immediately.
    const rawCorrection = correctionField(userMessage);
    const correction = rawCorrection === "unknown" && !conversation.awaitingConfirmation && !conversation.pendingCorrection ? "" : rawCorrection;
    const originalDraft = { ...draft };
    const hadPendingCorrection = Boolean(conversation.pendingCorrection);
    const wasAwaitingConfirmation = conversation.awaitingConfirmation;
    conversation.messages.push({ role: "user", content: userMessage });

    if (correction) {
      conversation.awaitingConfirmation = false;
      conversation.pendingCorrection = correction;
      if (correction !== "unknown") draft[correction] = "";
    }

    if (!correction && !hadPendingCorrection && wasAwaitingConfirmation && isConfirmation(userMessage)) {
      if (!hasAllFields(draft)) {
        conversation.awaitingConfirmation = false;
        await conversation.save();
        return reply(say("Någon uppgift saknas. Vi behöver kontrollera dem igen.", "Some information is missing. Let's verify it again."));
      }
      // Update a lead created by THIS conversation if the customer later corrected it.
      // Never rewrite another customer's lead based only on a matching email.
      let lead = conversation.leadId ? await Lead.findById(conversation.leadId) : null;
      if (lead) {
        const collision = await Lead.findOne({ email: draft.email, _id: { $ne: lead._id } });
        if (collision) {
          conversation.awaitingConfirmation = false;
          await conversation.save();
          return reply(say("Den här mejladressen finns redan registrerad. Kontakta oss om du behöver hjälp.",
            "This email address is already registered. Contact us if you need help."));
        }
        lead.name = draft.name;
        lead.email = draft.email;
        lead.service = draft.service;
        await lead.save();
      } else {
        lead = await Lead.findOne({ email: draft.email });
        if (!lead) lead = await new Lead(draft).save();
        // Do not take ownership of another conversation's lead.
        else {
          conversation.awaitingConfirmation = false;
          await conversation.save();
          return reply(say("Den här mejladressen finns redan registrerad. Kontakta oss om du behöver hjälp.",
            "This email address is already registered. Contact us if you need help."));
        }
      }
      if (lead) conversation.leadId = lead._id;
      conversation.awaitingConfirmation = false;
      await conversation.save();
      return reply(say("Tack! Dina uppgifter är mottagna.", "Thanks! Your details have been received."));
    }

    if (correction === "unknown") {
      conversation.leadDraft = draft;
      await conversation.save();
      return reply(say("Vilken uppgift vill du ändra: namn, mejladress eller tjänst?",
        "Which detail would you like to change: name, email or service?"));
    }

    if (conversation.pendingCorrection === "unknown") {
      // Do not proceed until we know which previous value must be invalidated.
      const declared = /namn|name/i.test(userMessage) ? "name" :
        /mejl|mail|e-post|email/i.test(userMessage) ? "email" :
        /tjänst|service/i.test(userMessage) ? "service" : "";
      if (!declared) {
        await conversation.save();
        return reply(say("Skriv vilken uppgift som är fel: namn, mejladress eller tjänst.",
          "Please tell me which detail is wrong: name, email or service."));
      }
      conversation.pendingCorrection = declared;
      draft[declared] = "";
    }

    // Capture a newly supplied email even if we are still waiting for a corrected name.
    const suppliedEmail = emailFrom(userMessage);
    if (suppliedEmail && correction !== "email" && conversation.pendingCorrection !== "email") {
      draft.email = suppliedEmail;
    }

    // During a correction, a previous AI guess cannot restore the invalidated field.
    if (conversation.pendingCorrection === "name") {
      const newName = bareCorrectedName(userMessage) || explicitName(userMessage);
      if (!newName) {
        conversation.leadDraft = draft;
        await conversation.save();
        return reply(say("Vad heter du egentligen? Skriv gärna: Jag heter [ditt namn].",
          "What is your correct name? Please write: My name is [your name]."));
      }
      draft.name = newName;
      conversation.pendingCorrection = "";
    } else if (conversation.pendingCorrection === "email") {
      const newEmail = emailFrom(userMessage);
      if (!newEmail) {
        conversation.leadDraft = draft;
        await conversation.save();
        return reply(say("Skriv din rätta, fullständiga mejladress.", "Please enter your correct, complete email address."));
      }
      draft.email = newEmail;
      conversation.pendingCorrection = "";
    } else if (conversation.pendingCorrection === "service") {
      // Read the new service from this message. Do not reuse the old service.
      const newService = correctedService(userMessage, hadPendingCorrection && !correction);
      if (!newService) {
        conversation.leadDraft = draft;
        await conversation.save();
        return reply(say("Vilken tjänst vill du ha? Skriv gärna: Jag vill ha [tjänst].",
          "Which service do you want? Please write: I want [service]."));
      }
      draft.service = newService;
      conversation.pendingCorrection = "";
    }

    // A valid address must actually be present in a CUSTOMER message, never
    // copied from company.email or hallucinated by the language model.
    conversation.leadDraft = draft;
    conversation.awaitingConfirmation = false;
    await conversation.save();

    const response = await openai.responses.create({
      model: "gpt-5.4-mini",
      instructions: `
        You are LeadFlow AI, customer support and sales assistant for ${company.name}.
        COMPANY: ${company.description}
        SERVICES: ${company.services.join(", ")}
        BUSINESS EMAIL (NOT the customer's email): ${company.email}
        HOURS: ${company.openingHours}

        Reply briefly in the customer's language. Only state supported company facts.
        Never promise an employee will get in touch. Never call the company email a customer email.
        Gather missing customer name, valid email and service naturally, asking one question at a time.
        The backend, not you, decides when a lead is saved and when confirmation is required.
        Previously corrected details must not be reused.
        CURRENT VERIFIED CUSTOMER DRAFT (empty means not yet verified): ${JSON.stringify(draft)}.
        You may suggest NEW information in customer fields below, including partial information.
        Only propose information actually stated in the customer's own messages.
        Prefer the most recent customer correction. An email must include @ and a real domain format.
        If a detail remains unknown, return null for it. Do NOT infer from company details or assistant replies.
      `,
      input: conversation.messages.map(m => ({ role: m.role, content: m.content })),
      text: {
        format: {
          type: "json_schema",
          name: "customer_response",
          strict: true,
          schema: {
            type: "object",
            properties: {
              reply: { type: "string" },
              customer: {
                type: "object",
                properties: {
                  name: { type: ["string", "null"] },
                  email: { type: ["string", "null"] },
                  service: { type: ["string", "null"] },
                },
                required: ["name", "email", "service"],
                additionalProperties: false,
              },
            },
            required: ["reply", "customer"],
            additionalProperties: false,
          },
        },
      },
    });

    const result = JSON.parse(response.output_text);
    const candidate = result.customer || {};
    const proposedName = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const proposedService = typeof candidate.service === "string" ? candidate.service.trim() : "";

    if (!draft.name && proposedName.length >= 2 && proposedName.length <= 80 &&
        !/@/.test(proposedName) && customerSaid(conversation.messages, proposedName) &&
        !correction && !hadPendingCorrection) {
      draft.name = proposedName;
    }

    if (!draft.service && proposedService.length <= 100 && proposedService &&
        customerSaid(conversation.messages, proposedService) &&
        !correction && !hadPendingCorrection) {
      draft.service = proposedService;
    }

    // Preserve a corrected name/service we explicitly extracted above, even
    // if the model still suggests a stale one from earlier in the transcript.
    conversation.leadDraft = draft;

    if (hasAllFields(draft) && !conversation.pendingCorrection &&
        (!conversation.leadId || ["name", "email", "service"].some(k => draft[k] !== originalDraft[k]) || correction || hadPendingCorrection)) {
      conversation.awaitingConfirmation = true;
      await conversation.save();
      return reply(say(
        `Stämmer följande uppgifter: namn ${draft.name}, mejladress ${draft.email}, tjänst ${draft.service}? Svara ja eller berätta vad som ska ändras.`,
        `Are these details correct: name ${draft.name}, email ${draft.email}, service ${draft.service}? Reply yes or tell me what to correct.`
      ));
    }

    await conversation.save();
    if (!draft.service) return reply(result.reply || say("Vad kan vi hjälpa dig med?", "What can we help you with?"));
    if (!draft.name) return reply(say("Vad heter du?", "What's your name?"));
    if (!draft.email) return reply(say("Vad är din fullständiga mejladress?", "What's your full email address?"));
    return reply(result.reply);
  } catch (error) {
    console.error("Chat error:", error);
    return res.status(500).send("AI: Något gick fel.");
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
