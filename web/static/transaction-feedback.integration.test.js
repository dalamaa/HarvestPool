const test = require("node:test");
const assert = require("node:assert/strict");

const {
  actionGate,
  classifyOutcome,
  pendingStore,
  persistTransactionHash,
  transactionHash,
  waitForState,
  waitForWalletResult,
} = require("./v3-confirmation.js");

class MemoryStorage {
  constructor(values = new Map()) { this.values = values; }
  getItem(key) { return this.values.get(key) || null; }
  setItem(key, value) { this.values.set(key, value); }
}

function success(hash = "tx-success") {
  return { status: { SuccessValue: "" }, transaction: { hash } };
}

function failure(message = "contract rejected action") {
  return {
    status: {
      Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: message } } } },
    },
    transaction: { hash: "tx-failed" },
  };
}

function createFeedbackHarness(options = {}) {
  const storage = options.storage || new MemoryStorage();
  const store = pendingStore(storage, "feedback-test-actions");
  const gate = options.gate || actionGate();
  const phases = [];
  let rerenders = 0;
  let walletCalls = 0;
  const action = {
    networkId: "testnet",
    signerId: "buyer.testnet",
    receiverId: "harvestpool-v5.testnet",
    methodName: "commit_usdc",
    args: { purchase_id: "2", quantity: 1 },
  };

  async function run() {
    const target = options.target || action;
    if (!gate.begin(target)) return { state: "duplicate" };
    let saved = store.save({ ...action, phase: "wallet" });
    phases.push("wallet");
    walletCalls += 1;
    const wallet = await waitForWalletResult(Promise.resolve().then(options.walletCall), {
      timeoutMs: options.walletTimeoutMs || 50,
      sleep: options.walletSleep,
      onLateResult: (lateResult) => {
        if (lateResult?.state === "returned") persistTransactionHash(store, saved, lateResult.value);
      },
    });
    if (wallet.state === "pending") {
      saved = store.save({ ...saved, phase: "unresolved" });
      phases.push("unresolved");
      gate.finish(target, { keepLocked: true });
      return { state: "unresolved", action: saved };
    }
    if (wallet.state === "rejected") {
      store.remove(saved.id);
      phases.push("wallet-rejected");
      gate.finish(target);
      return { state: "wallet-rejected", error: wallet.error };
    }

    const submitted = classifyOutcome(wallet.value);
    if (submitted.state === "failed") {
      store.remove(saved.id);
      phases.push("failed");
      gate.finish(target);
      return submitted;
    }
    saved = store.save({
      ...saved,
      phase: submitted.state === "accepted" ? "confirming" : "unresolved",
      transactionHash: transactionHash(wallet.value),
    });
    phases.push(submitted.state === "accepted" ? "confirming" : "unresolved");
    if (submitted.state !== "accepted") {
      gate.finish(target, { keepLocked: true });
      return { state: "unresolved", action: saved };
    }

    const authoritative = await waitForState(
      options.readContract,
      (state) => state?.state && state.state !== "uncertain" ? state : null,
      { attempts: options.confirmationAttempts || 4, delayMs: 0, sleep: async () => undefined },
    );
    if (authoritative?.state === "confirmed") {
      store.remove(saved.id);
      phases.push("confirmed");
      rerenders += 1;
      gate.finish(target);
      return authoritative;
    }
    if (authoritative?.state === "failed") {
      store.remove(saved.id);
      phases.push("failed");
      gate.finish(target);
      return authoritative;
    }
    saved = store.save({ ...saved, phase: "unresolved" });
    phases.push("unresolved");
    gate.finish(target, { keepLocked: true });
    return { state: "unresolved", action: saved };
  }

  return { action, gate, phases, run, storage, store, walletCalls: () => walletCalls, rerenders: () => rerenders };
}

test("immediate wallet success waits for authoritative confirmation and rerenders", async () => {
  const harness = createFeedbackHarness({
    walletCall: async () => success(),
    readContract: async () => ({ state: "confirmed", purchase: { id: "2", total_quantity: 1 } }),
  });
  const result = await harness.run();
  assert.equal(result.state, "confirmed");
  assert.deepEqual(harness.phases, ["wallet", "confirming", "confirmed"]);
  assert.equal(harness.rerenders(), 1);
  assert.equal(harness.store.list().length, 0);
});
test("delayed authoritative confirmation keeps polling before success", async () => {
  const states = [{ state: "uncertain" }, { state: "uncertain" }, { state: "confirmed" }];
  const harness = createFeedbackHarness({
    walletCall: async () => success("tx-delayed"),
    readContract: async () => states.shift(),
  });
  assert.equal((await harness.run()).state, "confirmed");
  assert.equal(states.length, 0);
});

test("a lost wallet response stays unresolved and blocks an automatic retry", async () => {
  const harness = createFeedbackHarness({
    walletCall: () => new Promise(() => {}),
    walletTimeoutMs: 1,
    walletSleep: async () => undefined,
    readContract: async () => ({ state: "uncertain" }),
  });
  assert.equal((await harness.run()).state, "unresolved");
  assert.equal(harness.store.list()[0].phase, "unresolved");
  assert.equal((await harness.run()).state, "duplicate");
  assert.equal(harness.walletCalls(), 1);
});

test("a wallet response after timeout persists its hash without resubmitting", async () => {
  let resolveWallet;
  const walletResult = new Promise((resolve) => { resolveWallet = resolve; });
  const harness = createFeedbackHarness({
    walletCall: () => walletResult,
    walletTimeoutMs: 1,
    walletSleep: async () => undefined,
    readContract: async () => ({ state: "uncertain" }),
  });
  assert.equal((await harness.run()).state, "unresolved");
  resolveWallet(success("tx-returned-after-timeout"));
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = harness.store.list("buyer.testnet")[0];
  assert.equal(recovered.transactionHash, "tx-returned-after-timeout");
  assert.equal(recovered.phase, "confirming");
  assert.equal((await harness.run()).state, "duplicate");
  assert.equal(harness.walletCalls(), 1);
});

test("an existing limited function-call key can return success without a popup", async () => {
  let popupRequests = 0;
  const harness = createFeedbackHarness({
    walletCall: async () => success("tx-limited-key"),
    readContract: async () => ({ state: "confirmed" }),
  });
  assert.equal((await harness.run()).state, "confirmed");
  assert.equal(popupRequests, 0);
  assert.equal(harness.walletCalls(), 1);
});

test("wallet rejection clears pending state and allows an explicit retry", async () => {
  const target = {};
  const gate = actionGate();
  const harness = createFeedbackHarness({
    target,
    gate,
    walletCall: async () => { throw new Error("User rejected request"); },
    readContract: async () => ({ state: "uncertain" }),
  });
  assert.equal((await harness.run()).state, "wallet-rejected");
  assert.equal(harness.store.list().length, 0);
  assert.equal(gate.begin(target), true);
});

test("confirmed on-chain failure is not shown as success", async () => {
  const harness = createFeedbackHarness({
    walletCall: async () => failure("join deadline passed"),
    readContract: async () => ({ state: "uncertain" }),
  });
  const result = await harness.run();
  assert.equal(result.state, "failed");
  assert.match(result.message, /join deadline passed/);
  assert.equal(harness.rerenders(), 0);
});

test("a truly unknown returned outcome remains persisted and locked", async () => {
  const harness = createFeedbackHarness({
    walletCall: async () => ({ transaction: { hash: "tx-unknown" } }),
    readContract: async () => ({ state: "uncertain" }),
  });
  assert.equal((await harness.run()).state, "unresolved");
  assert.equal(harness.store.list()[0].transactionHash, "tx-unknown");
  assert.equal(harness.rerenders(), 0);
});

test("refresh restores the pending action from storage without resubmitting", async () => {
  const sharedValues = new Map();
  const firstStorage = new MemoryStorage(sharedValues);
  const first = createFeedbackHarness({
    storage: firstStorage,
    walletCall: () => new Promise(() => {}),
    walletTimeoutMs: 1,
    walletSleep: async () => undefined,
    readContract: async () => ({ state: "uncertain" }),
  });
  await first.run();
  const restored = pendingStore(new MemoryStorage(sharedValues), "feedback-test-actions");
  assert.equal(restored.list("buyer.testnet").length, 1);
  assert.equal(restored.list("buyer.testnet")[0].phase, "unresolved");
});

test("rapid duplicate clicks invoke the wallet only once", async () => {
  let releaseWallet;
  const walletResult = new Promise((resolve) => { releaseWallet = resolve; });
  const harness = createFeedbackHarness({
    walletCall: () => walletResult,
    walletTimeoutMs: 500,
    readContract: async () => ({ state: "confirmed" }),
  });
  const first = harness.run();
  const second = await harness.run();
  assert.equal(second.state, "duplicate");
  releaseWallet(success("tx-one-click"));
  assert.equal((await first).state, "confirmed");
  assert.equal(harness.walletCalls(), 1);
});
