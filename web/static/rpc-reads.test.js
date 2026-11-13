const test = require("node:test");
const assert = require("node:assert/strict");

const { fetchJsonWithRetry, transientRpcPayload, transientStatus } = require("./rpc-reads.js");

test("transient RPC failures are retried and the confirmed response is returned", async () => {
  let calls = 0;
  const payload = await fetchJsonWithRetry(async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ result: "confirmed" }) };
  }, "https://rpc.test", {}, { attempts: 2, delayMs: 0 });
  assert.equal(calls, 2);
  assert.deepEqual(payload, { result: "confirmed" });
});

test("deterministic client failures are not retried", async () => {
  let calls = 0;
  await assert.rejects(fetchJsonWithRetry(async () => {
    calls += 1;
    return { ok: false, status: 400 };
  }, "https://rpc.test", {}, { attempts: 3, delayMs: 0 }), /HTTP 400/);
  assert.equal(calls, 1);
  assert.equal(transientStatus(429), true);
  assert.equal(transientStatus(400), false);
});

test("temporary JSON-RPC error payloads are retried", async () => {
  let calls = 0;
  const payload = await fetchJsonWithRetry(async () => {
    calls += 1;
    return { ok: true, json: async () => calls === 1 ? { error: { code: -32000, message: "temporarily unavailable" } } : { result: [1] } };
  }, "https://rpc.test", {}, { attempts: 2, delayMs: 0, retryPayload: transientRpcPayload });
  assert.deepEqual(payload, { result: [1] });
  assert.equal(calls, 2);
});
