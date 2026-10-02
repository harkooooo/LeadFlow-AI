"use strict";
// Full conversation tests: every message goes through the same load -> handle -> save cycle
// as the real route, against a JSON "database" that only keeps the Conversation schema fields.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness } = require("../test-support/helpers");

const ASKS_NAME = /Vad heter du\?/;
const ASKS_EMAIL = /fullständiga mejladress/;
const ASKS_SERVICE = /Vilken tjänst är du intresserad av\? Vi erbjuder: Digital marketing, Social media marketing, SEO, Lead generation\./;
const summary = (name, email, service) =>
  new RegExp(`Stämmer följande uppgifter: namn ${name}, mejladress ${email.replace(".", "\\.")}, tjänst ${service}\\?`);

test("happy path: details are kept between messages and saved only after 'ja'", async () => {
  const t = createHarness();
  let r = await t.say("Jag vill ha SEO.", { service: "SEO" });
  assert.match(r, ASKS_NAME);
  assert.deepEqual(t.draft(), { name: "", email: "", service: "SEO" });

  r = await t.say("sejla", { name: "sejla" });
  assert.match(r, ASKS_EMAIL);
  assert.deepEqual(t.draft(), { name: "sejla", email: "", service: "SEO" });

  r = await t.say("oskar@lillen.com", { email: "oskar@lillen.com" });
  assert.match(r, summary("sejla", "oskar@lillen.com", "SEO"));
  assert.deepEqual(t.draft(), { name: "sejla", email: "oskar@lillen.com", service: "SEO" });
  assert.equal(t.doc().awaitingConfirmation, true);
  assert.equal(t.leads.rows.length, 0, "nothing saved before confirmation");

  const callsBefore = t.model.calls.length;
  r = await t.say("ja"); // plain yes: must not need the model
  assert.equal(t.model.calls.length, callsBefore);
  assert.match(r, /Tack! Dina uppgifter är mottagna\./);
  assert.deepEqual(t.leads.rows.map(({ name, email, service }) => ({ name, email, service })),
    [{ name: "sejla", email: "oskar@lillen.com", service: "SEO" }]);
  assert.equal(t.doc().leadId, "lead-1");
  assert.equal(t.doc().awaitingConfirmation, false);
  assert.equal(t.doc().messages.length, 8, "every message is persisted");
});

test("customer changes service mid-flow (the conversation that already worked)", async () => {
  const t = createHarness();
  await t.say("Jag vill ha SEO.", { service: "SEO" });
  await t.say("Emil", { name: "Emil" });
  let r = await t.say("Eller nej, jag vill ha sociala medier.", { service: "Social media marketing" });
  assert.match(r, ASKS_EMAIL);
  assert.deepEqual(t.draft(), { name: "Emil", email: "", service: "Social media marketing" });
  r = await t.say("emil123@example.com", { email: "emil123@example.com" });
  assert.match(r, summary("Emil", "emil123@example.com", "Social media marketing"));
});

test("REGRESSION (cause B): model repeats the old service as a 'change' -> no loop, summary is shown", async () => {
  const t = createHarness();
  await t.say("Jag vill ha SEO.", { service: "SEO" });
  await t.say("sejla", { name: "sejla" });
  let r = await t.say("elller nä, kör på lead", { service: "Lead generation" });
  assert.match(r, ASKS_EMAIL);
  assert.equal(t.draft().service, "Lead generation");

  r = await t.say("oskar@lillen.com", { email: "oskar@lillen.com", service: "Lead generation" });
  assert.match(r, summary("sejla", "oskar@lillen.com", "Lead generation"));

  // Frustrated message while reviewing: the model echoes old values that are not in the message.
  r = await t.say("de sa jag ju", { name: "sejla", service: "Lead generation" });
  assert.match(r, /Stämmer uppgifterna ovan/);
  assert.deepEqual(t.draft(), { name: "sejla", email: "oskar@lillen.com", service: "Lead generation" });

  r = await t.say("ja");
  assert.match(r, /Tack!/);
  assert.equal(t.leads.rows[0].service, "Lead generation");
});

test("REGRESSION (cause A): model wrongly clears the service -> backend still asks the right question, never for name/email we have", async () => {
  const t = createHarness();
  const replies = [];
  replies.push(await t.say("Jag vill ha SEO.", { service: "SEO" }));
  replies.push(await t.say("sejla", { name: "sejla" }));
  // The model treats "nä" as withdrawing the service and does not map "lead".
  replies.push(await t.say("elller nä, kör på lead", { clear: ["service"], reply: "Vad är din fullständiga mejladress?" }));
  assert.deepEqual(t.draft(), { name: "sejla", email: "", service: "" });
  assert.equal(replies[2], "Vilken tjänst är du intresserad av? Vi erbjuder: Digital marketing, Social media marketing, SEO, Lead generation.",
    "the model's stale email question is dropped; the backend asks for the missing service");

  replies.push(await t.say("oskar@lillen.com", { email: "oskar@lillen.com", reply: "Vilken tjänst vill du ha?" }));
  assert.deepEqual(t.draft(), { name: "sejla", email: "oskar@lillen.com", service: "" });
  replies.push(await t.say("de sa jag ju", {}));
  replies.push(await t.say("?", {}));
  replies.push(await t.say("de har jag redan sagt", {}));
  // The missing service is still asked about every time, but no longer word for word
  // (see repeatedServiceQuestion.test.js).
  for (const reply of replies.slice(3)) assert.match(reply, /tjänst/i);
  for (const reply of replies.slice(2)) assert.doesNotMatch(reply, ASKS_NAME);
  assert.deepEqual(t.draft(), { name: "sejla", email: "oskar@lillen.com", service: "" }, "name and email survive every message");

  const r = await t.say("lead", { service: "Lead generation" });
  assert.match(r, summary("sejla", "oskar@lillen.com", "Lead generation"));
});

test("the model cannot make us ask for a field we already have", async () => {
  const t = createHarness();
  await t.say("Jag vill ha SEO tack", { service: "SEO" });
  await t.say("Anna", { name: "Anna" });
  const r = await t.say("hmm", { reply: "Vad heter du?" }); // model prose is wrong
  assert.match(r, ASKS_EMAIL);
  assert.doesNotMatch(r, ASKS_NAME, "model's stale question is dropped");
  assert.deepEqual(t.draft(), { name: "Anna", email: "", service: "SEO" });
});

test("questions in the model's text are dropped, answers are kept", async () => {
  const t = createHarness();
  const r = await t.say("Vilka öppettider har ni?", { reply: "Vi har öppet måndag-fredag 09:00-17:00. Vill du veta mer?" });
  assert.match(r, /^Vi har öppet måndag-fredag 09:00-17:00\.\n\nVilken tjänst är du intresserad av\?/);
  assert.doesNotMatch(r, /Vill du veta mer/);
});

test("natural conversation: questions are answered while details are missing", async () => {
  const t = createHarness();
  let r = await t.say("Vilka öppettider har ni?", { reply: "Vi har öppet måndag-fredag 09:00-17:00." });
  assert.match(r, /^Vi har öppet måndag-fredag 09:00-17:00\./);
  assert.match(r, ASKS_SERVICE);
  assert.deepEqual(t.draft(), { name: "", email: "", service: "" });

  await t.say("Jag vill ha SEO", { service: "SEO" });
  r = await t.say("Vad ingår i SEO?", { reply: "SEO handlar om att synas bättre i sökmotorer." });
  assert.match(r, /synas bättre i sökmotorer/);
  assert.match(r, ASKS_NAME);
  assert.equal(t.draft().service, "SEO", "asking about a service keeps the chosen one");
});

test("questions during review are answered and the review stays open", async () => {
  const t = createHarness();
  await t.say("Jag vill ha SEO.", { service: "SEO" });
  await t.say("Anna", { name: "Anna" });
  await t.say("anna@example.com", { email: "anna@example.com" });
  const r = await t.say("Vad kostar det?", { reply: "Jag har tyvärr inget pris här." });
  assert.match(r, /Jag har tyvärr inget pris här\./);
  assert.match(r, /Stämmer uppgifterna ovan/);
  assert.equal(t.doc().awaitingConfirmation, true);
  assert.equal(t.leads.rows.length, 0);
});

test("a lead is never saved without an explicit yes", async () => {
  const t = createHarness();
  await t.say("Jag vill ha SEO.", { service: "SEO" });
  await t.say("Anna", { name: "Anna" });
  await t.say("anna@example.com", { email: "anna@example.com" });
  for (const text of ["nej", "hmm vänta", "kanske"]) {
    const r = await t.say(text, {});
    assert.match(r, /Stämmer uppgifterna ovan/);
  }
  assert.equal(t.leads.rows.length, 0);
  assert.equal(t.doc().leadId, null);
});

test("natural-language agreement ('japp') confirms, but only when nothing else changes", async () => {
  const t = createHarness();
  await t.say("Jag vill ha lead generation", { service: "Lead generation" });
  await t.say("Anna", { name: "Anna" });
  await t.say("anna@example.com", { email: "anna@example.com" });

  // Agreement mixed with a correction must not save.
  let r = await t.say("japp men ta SEO istället", { service: "SEO", confirmation: "confirm" });
  assert.equal(t.leads.rows.length, 0);
  assert.match(r, summary("Anna", "anna@example.com", "SEO"));

  r = await t.say("japp", { confirmation: "confirm" });
  assert.match(r, /Tack!/);
  assert.equal(t.leads.rows.length, 1);
  assert.equal(t.leads.rows[0].service, "SEO");
});

test("the model saying 'confirm' is ignored when no summary is being reviewed", async () => {
  const t = createHarness();
  await t.say("hej", { confirmation: "confirm", reply: "Hej!" });
  assert.equal(t.leads.rows.length, 0);
  await t.say("Jag vill ha SEO.", { service: "SEO" });
  await t.say("Anna", { name: "Anna", confirmation: "confirm" }); // draft incomplete
  assert.equal(t.leads.rows.length, 0);
});

test("changing a detail after the lead was saved asks again and UPDATES the same lead", async () => {
  const t = createHarness();
  await t.say("Jag vill ha SEO.", { service: "SEO" });
  await t.say("Anna", { name: "Anna" });
  await t.say("anna@example.com", { email: "anna@example.com" });
  await t.say("ja");
  assert.equal(t.leads.rows.length, 1);

  let r = await t.say("Tack!", { reply: "Varsågod!" });
  assert.match(r, /Varsågod!/);
  assert.equal(t.doc().awaitingConfirmation, false, "no new confirmation without changes");

  r = await t.say("byt mejl till ny@example.com", { email: "ny@example.com" });
  assert.match(r, summary("Anna", "ny@example.com", "SEO"));
  await t.say("ja");
  assert.equal(t.leads.rows.length, 1);
  assert.equal(t.leads.rows[0].email, "ny@example.com");
});

test("an email that is already registered is not saved twice; customer can supply another", async () => {
  const t = createHarness({ existingLeads: [{ _id: "old", name: "X", email: "taken@example.com", service: "SEO" }] });
  await t.say("Jag vill ha SEO.", { service: "SEO" });
  await t.say("Anna", { name: "Anna" });
  await t.say("taken@example.com", { email: "taken@example.com" });
  let r = await t.say("ja");
  assert.match(r, /redan registrerad/);
  assert.equal(t.leads.rows.length, 1);
  assert.deepEqual(t.draft(), { name: "Anna", email: "", service: "SEO" });

  r = await t.say("anna@example.com", { email: "anna@example.com" });
  assert.match(r, summary("Anna", "anna@example.com", "SEO"));
  await t.say("ja");
  assert.equal(t.leads.rows.length, 2);
});

test("unusable model output changes nothing and the flow continues", async () => {
  const t = createHarness();
  await t.say("Jag vill ha SEO.", { service: "SEO" });
  for (const bad of [null, "not json", 42, { reply: 5, name: 7 }]) {
    const r = await t.say("sejla", { __raw: bad });
    assert.match(r, ASKS_NAME);
  }
  assert.deepEqual(t.draft(), { name: "", email: "", service: "SEO" });
});

test("if the model call fails nothing is saved for that message", async () => {
  const t = createHarness();
  await t.say("Jag vill ha SEO.", { service: "SEO" });
  const before = t.doc();
  await assert.rejects(t.say("sejla", { __throw: true }), /model unavailable/);
  assert.deepEqual(t.doc(), before, "state unchanged, customer can simply resend");
  const r = await t.say("sejla", { name: "sejla" });
  assert.match(r, ASKS_EMAIL);
});

test("English customers get English backend questions", async () => {
  const t = createHarness();
  let r = await t.say("Hi, I want SEO please", { service: "SEO" });
  assert.match(r, /What's your name\?/);
  r = await t.say("Maria", { name: "Maria" });
  assert.match(r, /What's your full email address\?/);
});

test("long conversation: state survives 20 messages of mixed chatter", async () => {
  const t = createHarness();
  await t.say("Jag vill ha SEO.", { service: "SEO" });
  await t.say("Anna Berg", { name: "Anna Berg" });
  for (let i = 0; i < 8; i++) await t.say(`fråga ${i}?`, { reply: "Bra fråga." });
  assert.deepEqual(t.draft(), { name: "Anna Berg", email: "", service: "SEO" });
  const r = await t.say("anna@example.com", { email: "anna@example.com" });
  assert.match(r, summary("Anna Berg", "anna@example.com", "SEO"));
});