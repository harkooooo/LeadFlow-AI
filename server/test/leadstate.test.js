"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyInterpretation, nextMissingField, hasAllFields, isConfirmation,
  groundedName, groundedEmail,
} = require("../leadstate");

const services = ["Digital marketing", "Social media marketing", "SEO", "Lead generation"];
const empty = { name: "", email: "", service: "" };
const full = { name: "Sejla", email: "sejla@example.com", service: "SEO" };

test("accepts a name that appears in the latest message", () => {
  const r = applyInterpretation(empty, "sejla", { name: "sejla" }, services);
  assert.equal(r.draft.name, "sejla");
  assert.deepEqual(r.accepted, ["name"]);
  assert.equal(r.changed, true);
});

test("a name is never taken from an email address", () => {
  const r = applyInterpretation(empty, "oskar@lillen.com", { name: "oskar", email: "oskar@lillen.com" }, services);
  assert.equal(r.draft.name, "");
  assert.equal(r.draft.email, "oskar@lillen.com");
  assert.deepEqual(r.rejected, ["name"]);
  assert.equal(groundedName("hej, jag heter Oskar Svensson", "Oskar Svensson"), "Oskar Svensson");
});

test("an invented email, or one missing from the message, is rejected", () => {
  assert.equal(groundedEmail("min mejl är bob", "bob@example.com"), "");
  assert.equal(groundedEmail("bob@example.com.", "BOB@example.com"), "bob@example.com");
  const r = applyInterpretation(empty, "hej", { email: "bob@example.com" }, services);
  assert.deepEqual(r.rejected, ["email"]);
  assert.equal(r.draft.email, "");
});

test("service must be one of the configured services (case-insensitive, canonical spelling)", () => {
  assert.equal(applyInterpretation(empty, "seo", { service: "seo" }, services).draft.service, "SEO");
  const r = applyInterpretation(empty, "jag vill ha reklamfilm", { service: "Reklamfilm" }, services);
  assert.equal(r.draft.service, "");
  assert.deepEqual(r.rejected, ["service"]);
});

test("the model repeating values we already have is ignored (not rejected, not a change)", () => {
  // Frustrated customer: message contains none of the values the model echoes.
  const r = applyInterpretation(full, "de har jag redan sagt",
    { name: "Sejla", email: "sejla@example.com", service: "SEO" }, services);
  assert.deepEqual(r.draft, full);
  assert.deepEqual(r.rejected, []);
  assert.equal(r.changed, false);
});

test("an ungrounded proposal never overwrites an existing value", () => {
  const r = applyInterpretation(full, "ok", { name: "Någon Annan" }, services);
  assert.equal(r.draft.name, "Sejla");
  assert.deepEqual(r.rejected, ["name"]);
});

test("clear removes only the named field and a new value in the same message wins", () => {
  const cleared = applyInterpretation(full, "fel mejl", { clear: ["email"] }, services);
  assert.deepEqual(cleared.draft, { ...full, email: "" });
  assert.deepEqual(cleared.cleared, ["email"]);

  const replaced = applyInterpretation(full, "nej, ny@example.com", { email: "ny@example.com", clear: ["email"] }, services);
  assert.equal(replaced.draft.email, "ny@example.com");
  assert.deepEqual(replaced.cleared, []);

  const noop = applyInterpretation(empty, "fel namn", { clear: ["name", "bogus"] }, services);
  assert.equal(noop.changed, false);
});

test("garbage from the model changes nothing", () => {
  for (const bad of [null, undefined, "text", 42, [], { clear: "name" }, { name: 5, email: {}, service: [] }]) {
    const r = applyInterpretation(full, "hej", bad, services);
    assert.deepEqual(r.draft, full);
    assert.equal(r.changed, false);
  }
});

test("nextMissingField asks in a fixed order and treats unknown (legacy) services as missing", () => {
  assert.equal(nextMissingField(empty, services), "service");
  assert.equal(nextMissingField({ name: "", email: "", service: "SEO" }, services), "name");
  assert.equal(nextMissingField({ name: "Sejla", email: "", service: "SEO" }, services), "email");
  assert.equal(nextMissingField({ name: "Sejla", email: "sejla@example.com", service: "" }, services), "service");
  assert.equal(nextMissingField({ name: "Sejla", email: "sejla@example.com", service: "lead" }, services), "service");
  assert.equal(nextMissingField({ name: "Sejla", email: "not-an-email", service: "SEO" }, services), "email");
  assert.equal(hasAllFields(full, services), true);
});

test("isConfirmation only accepts a plain yes", () => {
  for (const yes of ["ja", "Ja!", "ja det stämmer", "yes", "Stämmer."]) assert.equal(isConfirmation(yes), true, yes);
  for (const no of ["nej", "ja men byt tjänst", "kanske", "ja?", "de sa jag ju"]) assert.equal(isConfirmation(no), false, no);
});