"use strict";
// The model call itself is not tested (needs the real API). These tests protect the parts
// of interpreter.js that the rest of the code depends on.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSchema, buildInstructions } = require("../interpreter");
const company = require("../company");

test("schema is strict-compatible and limits service to the configured services", () => {
  const schema = buildSchema(company.services);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  assert.deepEqual(schema.properties.service.anyOf[0].enum, company.services);
  assert.deepEqual(schema.properties.service.anyOf[1], { type: "null" });
  assert.deepEqual(schema.properties.confirmation.enum, ["confirm", "none"]);
});

test("instructions tell the model to react to business info and give recommendations", () => {
  const text = buildInstructions({ company, draft: { name: "", email: "", service: "" }, awaitingConfirmation: false });
  assert.match(text, /react briefly to what\s+they tell you about themselves or their business/);
  assert.match(text, /give a concrete one/);
  assert.match(text, /NEVER ask for the customer's name,\s+email or service/);
  assert.match(text, /ONLY when the whole message is just a requested detail/);
  for (const service of company.services) assert.ok(text.includes(service));
});