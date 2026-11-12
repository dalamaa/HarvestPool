const test = require("node:test");
const assert = require("node:assert/strict");

const { failureMessage, withTimeout } = require("./wallet-initialization.js");

test("wallet initialization resolves normally before its deadline", async () => {
  assert.equal(await withTimeout(Promise.resolve("ready"), 50), "ready");
});

test("a stalled wallet initialization becomes a retryable timeout", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 5),
    (error) => error.code === "WALLET_INITIALIZATION_TIMEOUT",
  );
});

test("wallet initialization failures give a recovery action", () => {
  const timeout = new Error("late");
  timeout.code = "WALLET_INITIALIZATION_TIMEOUT";
  assert.match(failureMessage(timeout), /timed out/i);
  assert.match(failureMessage(timeout), /retry/i);
  assert.match(failureMessage(new Error("blocked")), /permissions/i);
  assert.match(failureMessage(new Error("blocked")), /retry/i);
});
