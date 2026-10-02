"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { withSessionLock } = require("../sessionLock");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("tasks for the same key run one at a time, in order", async () => {
  const log = [];
  const task = (name, ms) => withSessionLock("same", async () => {
    log.push(`start ${name}`); await sleep(ms); log.push(`end ${name}`); return name;
  });
  const results = await Promise.all([task("a", 30), task("b", 1), task("c", 1)]);
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);
});

test("different keys do not block each other", async () => {
  const log = [];
  await Promise.all([
    withSessionLock("x", async () => { log.push("x start"); await sleep(30); log.push("x end"); }),
    withSessionLock("y", async () => { log.push("y start"); await sleep(1); log.push("y end"); }),
  ]);
  assert.deepEqual(log.slice(0, 2), ["x start", "y start"]);
});

test("a failing task does not block the next one", async () => {
  await assert.rejects(withSessionLock("k", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await withSessionLock("k", async () => "ok"), "ok");
});