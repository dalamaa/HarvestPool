const test = require("node:test");
const assert = require("node:assert/strict");

const { actionId, classifyOutcome, pendingStore, waitForState } = require("./v3-confirmation.js");

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
