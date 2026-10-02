"use strict";

// Runs async tasks for the same key one at a time (per server process).
// Prevents two quick messages in one chat from reading the same old state
// and overwriting each other.
const tails = new Map();

async function withSessionLock(key, task) {
  const previous = tails.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  tails.set(key, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

module.exports = { withSessionLock };