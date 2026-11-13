const test = require("node:test");
const assert = require("node:assert/strict");

const { actionGate, actionId, classifyOutcome, errorKind, friendlyError, issueMatches, pendingForWalletCallback, pendingStore, persistTransactionHash, transactionHash, waitForState, waitForWalletResult, walletCallbackHashes } = require("./v3-confirmation.js");

test("waitForState rereads until a callback-created record is visible", async () => {
  let reads = 0;
  const waits = [];
  const record = await waitForState(
    async () => ({ issue: reads++ < 2 ? null : { id: "0" } }),
    (state) => state.issue,
    { attempts: 4, delayMs: 25, sleep: async (milliseconds) => waits.push(milliseconds) },
  );
  assert.deepEqual(record, { id: "0" });
  assert.equal(reads, 3);
  assert.deepEqual(waits, [25, 25]);
});

test("waitForState returns null after bounded unsuccessful verification", async () => {
  let reads = 0;
  const record = await waitForState(
    async () => { reads += 1; return { decision: null }; },
    (state) => state.decision,
    { attempts: 3, delayMs: 0 },
  );
  assert.equal(record, null);
  assert.equal(reads, 3);
});

test("waitForState tolerates an unavailable or stale RPC before confirmation", async () => {
  const reads = [new Error("RPC unavailable"), { votes: [] }, { votes: [{ voter: "member.testnet", option: 0 }] }];
  const match = await waitForState(
    async () => { const value = reads.shift(); if (value instanceof Error) throw value; return value; },
    (state) => state.votes.find((vote) => vote.voter === "member.testnet" && vote.option === 0),
    { attempts: 3, delayMs: 0 },
  );
  assert.equal(match.voter, "member.testnet");
});

test("classifyOutcome handles Wallet Selector wrappers and confirmed failures", () => {
  assert.equal(classifyOutcome({ final_execution_outcome: { status: { SuccessValue: "" } } }).state, "accepted");
  const result = classifyOutcome({ status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "member already voted" } } } } } });
  assert.equal(result.state, "failed");
  assert.equal(result.message, "member already voted");
  assert.equal(classifyOutcome({}).state, "uncertain");
});

test("confirmed contract failures retain their exact reason and transaction hash", () => {
  const failure = new Error("Smart contract panicked: join deadline must be in the future");
  failure.transactionState = "failed";
  assert.equal(errorKind(failure), "contract-rejected");
  assert.equal(
    friendlyError(failure),
    "The contract rejected this action: join deadline must be in the future. Your draft is safe.",
  );
  assert.equal(transactionHash({ final_execution_outcome: { transaction: { hash: "tx-hash" } } }), "tx-hash");
  assert.equal(transactionHash({ outcomes: [{ finalExecutionOutcome: { transaction: { hash: "array-hash" } } }] }), "array-hash");
});

test("a lost Meteor redirect hash attaches to the newest unresolved action", () => {
  const chosen = pendingForWalletCallback([
    { id: "old", savedAt: 10 },
    { id: "already-known", savedAt: 30, transactionHash: "known" },
    { id: "new", savedAt: 20 },
  ]);
  assert.equal(chosen.id, "new");
});

test("an incomplete Meteor response becomes pending without waiting forever", async () => {
  const unresolved = new Promise(() => {});
  const result = await waitForWalletResult(unresolved, {
    timeoutMs: 1,
    sleep: async () => undefined,
  });
  assert.equal(result.state, "pending");
});

test("a successful delayed Meteor response remains available for authoritative verification", async () => {
  const result = await waitForWalletResult(Promise.resolve({ transaction: { hash: "tx" } }), {
    timeoutMs: 100,
  });
  assert.equal(result.state, "returned");
  assert.equal(transactionHash(result.value), "tx");
});

test("a Meteor result arriving after the response timeout is still delivered for recovery", async () => {
  let resolveWallet;
  const walletResult = new Promise((resolve) => { resolveWallet = resolve; });
  let lateResult = null;
  const first = await waitForWalletResult(walletResult, {
    timeoutMs: 1,
    sleep: async () => undefined,
    onLateResult: (result) => { lateResult = result; },
  });
  assert.equal(first.state, "pending");
  resolveWallet({ finalExecutionOutcome: { transaction: { hash: "late-meteor-hash" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateResult.state, "returned");
  assert.equal(transactionHash(lateResult.value), "late-meteor-hash");
});

test("transaction feedback distinguishes wallet, permission, network, and unknown outcomes", () => {
  assert.equal(errorKind(new Error("User rejected request")), "wallet-rejected");
  assert.equal(errorKind(new Error("Access key does not allow this method")), "wallet-permission");
  assert.equal(errorKind(new Error("Failed to fetch RPC")), "network-error");
  const pending = new Error("No final status");
  pending.transactionState = "pending";
  assert.equal(errorKind(pending), "unknown-outcome");
  assert.match(friendlyError(pending), /Please don't submit again while we check/);
  pending.networkFailure = true;
  assert.match(friendlyError(pending), /connection was interrupted/);
});

test("submission gate blocks rapid repeats throughout delayed wallet authorization", async () => {
  const gate = actionGate();
  const target = {};
  assert.equal(gate.begin(target), true);
  assert.equal(gate.begin(target), false);
  assert.equal(gate.isLocked(target), true);
  gate.finish(target, { keepLocked: true });
  assert.equal(gate.begin(target), false);
  gate.finish(target);
  assert.equal(gate.begin(target), true);
});

test("confirmed failure releases the submission gate for a safe explicit retry", () => {
  const gate = actionGate();
  const target = {};
  assert.equal(gate.begin(target), true);
  gate.finish(target);
  assert.equal(gate.begin(target), true);
});

test("wallet callback hash capture accepts redirect and direct parameter names", () => {
  assert.deepEqual(walletCallbackHashes("?transactionHashes=hash-a"), ["hash-a"]);
  assert.deepEqual(walletCallbackHashes("?transactionHash=hash-b"), ["hash-b"]);
  assert.deepEqual(walletCallbackHashes("?transactionHashes=hash-a,hash-b"), ["hash-a", "hash-b"]);
});

test("authoritative issue matching confirms the async membership callback and prevents duplicates", () => {
  const issue = {
    id: "0",
    purchase_id: "0",
    raised_by: "buyer.testnet",
    subject: "Pickup clarification",
    description: "No physical pickup or delivery occurred.",
    suggested_solution: "Clarify in the issue thread.",
  };
  const expected = {
    purchaseId: "0",
    requesterId: "buyer.testnet",
    subject: issue.subject,
    description: issue.description,
    suggestedSolution: issue.suggested_solution,
  };
  assert.equal(issueMatches(issue, expected), true);
  assert.equal(issueMatches(issue, { ...expected, subject: "Different issue" }), false);
});

test("pending actions survive refresh and remain scoped to the signer", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const first = pendingStore(storage);
  const action = first.save({ signerId: "a.testnet", receiverId: "v3.testnet", methodName: "vote_on_decision", args: { decision_id: "0", option: 0 } });
  assert.equal(action.id, actionId(action));
  assert.equal(pendingStore(storage).list("a.testnet").length, 1);
  assert.equal(pendingStore(storage).list("b.testnet").length, 0);
  pendingStore(storage).remove(action.id);
  assert.equal(pendingStore(storage).list().length, 0);
});

test("late and callback hashes update only the matching saved action and survive refresh", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const store = pendingStore(storage);
  const saved = store.save({
    signerId: "buyer.testnet",
    receiverId: "usdc.testnet",
    methodName: "community_contribute_usdc",
    args: { amount: "1000000" },
  });
  const updated = persistTransactionHash(store, saved, { transaction: { hash: "late-hash" } });
  assert.equal(updated.transactionHash, "late-hash");
  assert.equal(updated.phase, "confirming");
  assert.equal(pendingStore(storage).list("buyer.testnet")[0].transactionHash, "late-hash");

  store.remove(saved.id);
  assert.equal(persistTransactionHash(store, saved, "must-not-resurrect"), null);
  assert.equal(store.list().length, 0);
});

test("a late response without a transaction hash preserves the unresolved action", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const store = pendingStore(storage);
  const saved = store.save({ signerId: "buyer.testnet", receiverId: "usdc.testnet", methodName: "community_contribute_usdc", args: { amount: "1000000" }, phase: "unresolved" });
  assert.equal(persistTransactionHash(store, saved, { status: "unknown" }), null);
  assert.equal(store.list()[0].phase, "unresolved");
  assert.equal(store.list()[0].transactionHash, undefined);
});

test("a pending vote cannot be saved twice while its outcome is uncertain", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const store = pendingStore(storage);
  const action = { signerId: "a.testnet", receiverId: "v3.testnet", methodName: "vote_on_decision", args: { decision_id: "0", option: 0 } };
  store.save(action);
  store.save(action);
  assert.equal(store.list("a.testnet").length, 1);
});

test("two wallet votes become a completed 2-of-2 decision awaiting the supplier", async () => {
  const states = [
    { votes: [{ voter: "a.testnet", option: 0 }], eligible_voters: ["a.testnet", "b.testnet"], state: "Open" },
    { votes: [{ voter: "a.testnet", option: 0 }, { voter: "b.testnet", option: 0 }], eligible_voters: ["a.testnet", "b.testnet"], selected_option: 0, state: "AwaitingSupplier" },
  ];
  const decision = await waitForState(
    async () => states.shift(),
    (state) => state.votes.length === state.eligible_voters.length && state.state === "AwaitingSupplier" ? state : null,
    { attempts: 2, delayMs: 0 },
  );
  assert.equal(decision.votes.length, 2);
  assert.equal(decision.selected_option, 0);
  assert.equal(decision.state, "AwaitingSupplier");
});

test("a duplicate-vote contract rejection is a confirmed failure", () => {
  const outcome = { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: member already voted on this decision" } } } } } };
  const result = classifyOutcome(outcome);
  assert.equal(result.state, "failed");
  assert.match(result.message, /already voted/);
});
