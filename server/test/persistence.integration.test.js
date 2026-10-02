"use strict";
// OPTIONAL: runs the real conversation flow against the REAL Mongoose model and a real MongoDB.
// Skipped unless TEST_MONGO_URI is set. Use a throwaway/test database, NOT production.
// It only creates and deletes its own conversation (random sessionId).
const test = require("node:test");
const assert = require("node:assert/strict");

const uri = process.env.TEST_MONGO_URI;

test("leadDraft is persisted by MongoDB between messages", { skip: !uri && "set TEST_MONGO_URI to run" }, async () => {
  const mongoose = require("mongoose");
  const Conversation = require("../models/Conversation");
  const { handleChatMessage } = require("../chatflow");
  const { ScriptedModel } = require("../test-support/helpers");
  const company = require("../company");

  await mongoose.connect(uri);
  const sessionId = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const model = new ScriptedModel();
  // Stand-in for the Lead collection, using real ObjectIds so Conversation.leadId casts correctly.
  const rows = [];
  const leads = {
    findById: async (id) => rows.find((r) => String(r._id) === String(id)) || null,
    findDuplicateEmail: async (email, excludeId) =>
      rows.find((r) => r.email === email && String(r._id) !== String(excludeId)) || null,
    create: async (data) => { const row = { _id: new mongoose.Types.ObjectId(), ...data }; rows.push(row); return row; },
    update: async (lead, data) => Object.assign(lead, data),
  };
  const deps = { company, interpret: model.interpret, leads };

  // Same cycle as the route: load -> handle -> save (a fresh load every message).
  const turn = async (message, output) => {
    if (output) model.push(output);
    let conversation = await Conversation.findOne({ sessionId });
    if (!conversation) conversation = new Conversation({ sessionId, messages: [] });
    const { reply } = await handleChatMessage({ conversation, message, deps });
    await conversation.save();
    return reply;
  };
  const stored = async () => (await Conversation.findOne({ sessionId }).lean());

  try {
    await turn("Jag vill ha SEO.", { service: "SEO" });
    assert.deepEqual({ ...(await stored()).leadDraft }, { name: "", email: "", service: "SEO" });

    await turn("sejla", { name: "sejla" });
    assert.deepEqual({ ...(await stored()).leadDraft }, { name: "sejla", email: "", service: "SEO" });

    await turn("elller nä, kör på lead", { service: "Lead generation" });
    await turn("oskar@lillen.com", { email: "oskar@lillen.com" });
    let doc = await stored();
    assert.deepEqual({ ...doc.leadDraft }, { name: "sejla", email: "oskar@lillen.com", service: "Lead generation" });
    assert.equal(doc.awaitingConfirmation, true);
    assert.equal(doc.messages.length, 8);

    await turn("ja");
    doc = await stored();
    assert.equal(doc.awaitingConfirmation, false);
    assert.equal(rows.length, 1);
    assert.equal(String(doc.leadId), String(rows[0]._id), "lead id stored on the conversation");
  } finally {
    await Conversation.deleteMany({ sessionId });
    await mongoose.disconnect();
  }
});