"use strict";
// Regression: while the customer has not chosen a service yet and keeps chatting
// (asking questions, "hmm", "?"), the backend used to append the SAME full service
// question (with the whole service list) after every single message.
// NOTE: reconstructed from the code path that causes it; add the exact customer
// conversation here if it differs.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness } = require("../test-support/helpers");

const lastParagraph = (reply) => reply.split("\n\n").pop();

test("REGRESSION: the service question is not repeated word for word while the customer chats", async () => {
  const t = createHarness();
  const replies = [];
  replies.push(await t.say("Hej, vad gör ni egentligen?", { reply: "Vi är en digital marknadsföringsbyrå." }));
  replies.push(await t.say("Vad kostar det?", { reply: "Jag har tyvärr inget pris här." }));
  replies.push(await t.say("Vad ingår i SEO?", { reply: "SEO handlar om att synas bättre i sökmotorer." }));
  replies.push(await t.say("Vad ingår i sociala medier?", { reply: "Vi hjälper till med innehåll och annonser i sociala kanaler." }));
  replies.push(await t.say("hmm", {}));
  replies.push(await t.say("?", {}));

  // The full question, with the list of services, is shown once.
  const withList = replies.filter((r) => r.includes("Vi erbjuder:"));
  assert.equal(withList.length, 1, "full service list shown only once");
  assert.ok(replies[0].includes("Vi erbjuder:"), "and it comes first");

  // No two consecutive replies end with the same question.
  for (let i = 1; i < replies.length; i++) {
    assert.notEqual(lastParagraph(replies[i]), lastParagraph(replies[i - 1]), `reply ${i + 1} repeats reply ${i}`);
  }

  // The customer's questions are still answered.
  assert.match(replies[0], /digital marknadsföringsbyrå/);
  assert.match(replies[1], /inget pris/);
  assert.match(replies[2], /synas bättre i sökmotorer/);
  assert.match(replies[3], /sociala kanaler/);
  // Once the customer has been asked twice, a real answer is not followed by yet another question.
  assert.doesNotMatch(replies[3], /\?/);
  // A message with nothing to answer still gets a helpful reply that points to the service.
  assert.match(replies[4], /tjänst/);
  assert.match(replies[5], /tjänst/);

  // Nothing about the customer's details changed.
  assert.deepEqual(t.draft(), { name: "", email: "", service: "" });
  assert.equal(t.doc().awaitingConfirmation, false);

  // The data and confirmation flow is unaffected afterwards.
  let r = await t.say("ok, SEO då", { service: "SEO" });
  assert.match(r, /Vad heter du\?/);
  r = await t.say("Anna", { name: "Anna" });
  assert.match(r, /fullständiga mejladress/);
  r = await t.say("anna@example.com", { email: "anna@example.com" });
  assert.match(r, /Stämmer följande uppgifter: namn Anna, mejladress anna@example\.com, tjänst SEO\?/);
  assert.equal(t.leads.rows.length, 0);
  await t.say("ja");
  assert.equal(t.leads.rows.length, 1);
});

test("REGRESSION (English): the service question is not repeated word for word", async () => {
  const t = createHarness();
  const replies = [];
  replies.push(await t.say("Hi, what do you do?", { reply: "We are a digital marketing agency." }));
  replies.push(await t.say("What are your opening hours?", { reply: "Monday-Friday 09:00-17:00." }));
  replies.push(await t.say("Do you do SEO?", { reply: "Yes, we offer SEO." }));
  replies.push(await t.say("Is it expensive?", { reply: "I don't have pricing here." }));
  assert.equal(replies.filter((r) => r.includes("We offer:")).length, 1);
  for (let i = 1; i < replies.length; i++) {
    assert.notEqual(lastParagraph(replies[i]), lastParagraph(replies[i - 1]));
  }
  assert.match(replies[3], /pricing/);
  assert.deepEqual(t.draft(), { name: "", email: "", service: "" });
});