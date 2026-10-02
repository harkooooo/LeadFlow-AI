"use strict";
// Test harness that behaves like the real route, but without Express, MongoDB or OpenAI:
//   load conversation from the "database" -> handleChatMessage -> save.
// The "database" only keeps the fields that exist in models/Conversation.js and stores
// them as JSON, so a test fails if the code relies on anything that isn't persisted.

const { handleChatMessage } = require("../chatflow");
const company = require("../company");

const SCHEMA_FIELDS = ["sessionId", "messages", "leadDraft", "pendingCorrection",
  "awaitingConfirmation", "leadId"];

const newDoc = (sessionId) => ({
  sessionId, messages: [], leadDraft: { name: "", email: "", service: "" },
  pendingCorrection: "", awaitingConfirmation: false, leadId: null,
});

class FakeConversationStore {
  constructor() { this.rows = new Map(); }
  load(sessionId) {
    const raw = this.rows.get(sessionId);
    return raw ? JSON.parse(raw) : newDoc(sessionId);
  }
  save(doc) {
    const kept = {};
    for (const field of SCHEMA_FIELDS) kept[field] = doc[field];
    this.rows.set(doc.sessionId, JSON.stringify(kept));
  }
  peek(sessionId) { return JSON.parse(this.rows.get(sessionId)); }
}

class FakeLeads {
  constructor(rows = []) { this.rows = rows; this.counter = rows.length; }
  async findById(id) { return this.rows.find((r) => r._id === id) || null; }
  async findDuplicateEmail(email, excludeId) {
    return this.rows.find((r) => r.email === email && r._id !== excludeId) || null;
  }
  async create(data) {
    const row = { _id: `lead-${++this.counter}`, ...data };
    this.rows.push(row);
    return row;
  }
  async update(lead, data) { Object.assign(lead, data); return lead; }
}

// Model stand-in: each customer message that needs the model consumes one scripted proposal.
class ScriptedModel {
  constructor() { this.queue = []; this.calls = []; }
  push(output) { this.queue.push(output); }
  get interpret() {
    return async (input) => {
      this.calls.push(input);
      if (!this.queue.length) throw new Error("Unexpected model call");
      const next = this.queue.shift();
      if (next && next.__throw) throw new Error("model unavailable");
      if (next && "__raw" in next) return next.__raw;
      return { reply: "", name: null, email: null, service: null, clear: [],
        confirmation: "none", ...next };
    };
  }
}

function createHarness({ existingLeads = [], sessionId = "session-1" } = {}) {
  const store = new FakeConversationStore();
  const leads = new FakeLeads(existingLeads);
  const model = new ScriptedModel();
  const deps = { company, interpret: model.interpret, leads };

  return {
    store, leads, model,
    // Sends one customer message. `output` is what the scripted model returns for it;
    // leave it out for messages that must NOT reach the model.
    async say(message, output) {
      if (output !== undefined) model.push(output);
      const conversation = store.load(sessionId);          // fresh from the "database"
      const { reply } = await handleChatMessage({ conversation, message, deps });
      store.save(conversation);                            // saved once, like the route
      return reply;
    },
    doc: () => store.peek(sessionId),
    draft: () => store.peek(sessionId).leadDraft,
  };
}

module.exports = { createHarness, FakeConversationStore, FakeLeads, ScriptedModel };