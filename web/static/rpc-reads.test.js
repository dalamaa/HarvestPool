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

test("HTTP 429 honors Retry-After and does not retry the storming request by default", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  let calls = 0;
  await assert.rejects(fetchJsonWithRetry(async () => {
    calls += 1;
    return {
      ok: false,
      status: 429,
      headers: { get: (name) => name === "Retry-After" ? "1" : null },
    };
  }, "https://rpc-429.test", {}, { attempts: 2, storage }), /HTTP 429/);
  assert.equal(calls, 1);

  let waited = 0;
  await assert.rejects(fetchJsonWithRetry(async () => {
    calls += 1;
    return { ok: false, status: 429, headers: { get: () => null } };
  }, "https://rpc-429.test", {}, {
    attempts: 1,
    storage,
    sleep: async (milliseconds) => { waited += milliseconds; },
  }), /HTTP 429/);
  assert.equal(calls, 2);
  assert.ok(waited >= 1, `expected shared cooldown wait, got ${waited}ms`);
});

test("CORS-obscured network failures are not retried", async () => {
  let calls = 0;
  await assert.rejects(fetchJsonWithRetry(async () => {
    calls += 1;
    throw new TypeError("Failed to fetch");
  }, "https://rpc-cors.test", { method: "POST" }, { attempts: 3, delayMs: 1 }));
  assert.equal(calls, 1);
});

test("identical simultaneous reads are single-flight deduplicated", async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async () => {
    calls += 1;
    await pending;
    return { ok: true, json: async () => ({ result: "shared" }) };
  };
  const first = fetchJsonWithRetry(fetchImpl, "https://rpc-dedupe.test", { method: "POST", body: "same" }, { attempts: 1 });
  const second = fetchJsonWithRetry(fetchImpl, "https://rpc-dedupe.test", { method: "POST", body: "same" }, { attempts: 1 });
  release();
  assert.deepEqual(await Promise.all([first, second]), [{ result: "shared" }, { result: "shared" }]);
  assert.equal(calls, 1);
});
