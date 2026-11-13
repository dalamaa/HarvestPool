const test = require("node:test");
const assert = require("node:assert/strict");
const { archivedAlertStore, eligibleTasks, walletViewState } = require("./action-center.js");

test("wallet restoration, connection, and disconnection have distinct views", () => {
  assert.equal(walletViewState("initializing", null), "restoring");
  assert.equal(walletViewState("connected", "buyer.testnet"), "connected");
  assert.equal(walletViewState("connected", null), "disconnected");
  assert.equal(walletViewState("disconnected", null), "disconnected");
});

test("pending actions remain isolated across account switches", () => {
  const pending = [
    { id: "buyer", signerId: "buyer.testnet", methodName: "claim_refund", args: { purchase_id: "2" } },
    { id: "other", signerId: "other.testnet", methodName: "claim_refund", args: { purchase_id: "3" } },
  ];
  assert.deepEqual(eligibleTasks({ accountId: "buyer.testnet", pending }).map((task) => task.actionId), ["buyer"]);
  assert.deepEqual(eligibleTasks({ accountId: "other.testnet", pending }).map((task) => task.actionId), ["other"]);
  assert.deepEqual(eligibleTasks({ accountId: null, pending }).map((task) => task.actionId), []);
});

test("returns only account-eligible active actions", () => {
  const tasks = eligibleTasks({
    accountId: "buyer.testnet",
    purchases: [
      { id: 1, state: "FulfillmentPending", commitments: [{ account_id: "buyer.testnet", state: "Active" }] },
      { id: 2, state: "Failed", commitments: [{ account_id: "buyer.testnet", state: "Refundable", amount: "2000000" }] },
      { id: 3, state: "FulfillmentPending", commitments: [{ account_id: "someone-else.testnet", state: "Active" }] },
    ],
    issues: [{ id: 7, purchase_id: 1 }],
    decisions: [{ id: 9, issue_id: 7, state: "Open", eligible_voters: ["buyer.testnet"], votes: [], options: ["Yes", "No"] }],
    pending: [],
  });
  assert.deepEqual(tasks.map((task) => task.kind), ["fulfillment-vote", "refund", "community-vote"]);
});

test("confirmed votes and unrelated supplier tasks are not counted", () => {
  const tasks = eligibleTasks({
    accountId: "buyer.testnet",
    purchases: [{ id: 1, state: "FulfillmentPending", commitments: [{ account_id: "buyer.testnet", state: "Active" }] }],
    votes: new Map([["fulfillment:1", { approve: true }]]),
    decisions: [{ id: 4, state: "AwaitingSupplier", requires_supplier_consent: true, supplier_id: "supplier.testnet", votes: [] }],
  });
  assert.equal(tasks.length, 0);
});

test("unresolved transactions are scoped to the connected signer", () => {
  const tasks = eligibleTasks({
    accountId: "buyer.testnet",
    pending: [
      { id: "a", signerId: "buyer.testnet", methodName: "claim_refund", args: { purchase_id: "2" } },
      { id: "b", signerId: "other.testnet", methodName: "claim_refund", args: { purchase_id: "3" } },
    ],
  });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].purchaseId, "2");
});

test("saved unresolved actions remain hidden before wallet restoration", () => {
  const tasks = eligibleTasks({
    accountId: null,
    pending: [
      { id: "a", signerId: "buyer.testnet", methodName: "claim_refund", args: { purchase_id: "2" } },
      { id: "b", signerId: "other.testnet", methodName: "community_contribute_usdc", args: { amount: "100000" } },
    ],
  });
  assert.deepEqual(tasks, []);
});

test("an unresolved submission replaces rather than duplicates its eligible task", () => {
  const tasks = eligibleTasks({
    accountId: "buyer.testnet",
    purchases: [{ id: 2, state: "Failed", commitments: [{ account_id: "buyer.testnet", state: "Refundable", amount: "2000000" }] }],
    pending: [{ id: "refund", signerId: "buyer.testnet", methodName: "claim_refund", args: { purchase_id: "2" } }],
  });
  assert.deepEqual(tasks.map((task) => task.kind), ["pending-transaction"]);
});

test("an unresolved contribution exposes the exact saved verification fields", () => {
  const action = {
    id: "garden-contribution",
    signerId: "dalamaa.testnet",
    receiverId: "usdc.testnet",
    methodName: "community_contribute_usdc",
    args: { receiver_id: "garden.sputnikv2.testnet", amount: "100000" },
    context: { daoId: "garden.sputnikv2.testnet" },
    transactionHash: null,
  };
  const [task] = eligibleTasks({ accountId: "dalamaa.testnet", pending: [action] });
  assert.equal(task.actionId, action.id);
  assert.equal(task.signerId, action.signerId);
  assert.equal(task.receiverId, action.receiverId);
  assert.equal(task.daoId, action.context.daoId);
  assert.equal(task.amount, action.args.amount);
  assert.equal(task.transactionHash, null);
});

test("archived alerts persist without changing the underlying payment attempt", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  const payment = {
    id: "garden-contribution",
    signerId: "dalamaa.testnet",
    receiverId: "usdc.testnet",
    methodName: "community_contribute_usdc",
    args: { amount: "500000" },
  };
  const first = archivedAlertStore(storage);
  first.archive({ actionId: payment.id, signerId: payment.signerId, archivedAt: 123 });
  const restarted = archivedAlertStore(storage);
  assert.equal(restarted.has(payment.id), true);
  assert.deepEqual(restarted.list(payment.signerId), [{
    actionId: payment.id,
    signerId: payment.signerId,
    archivedAt: 123,
  }]);
  assert.equal(payment.methodName, "community_contribute_usdc");
  assert.equal(payment.args.amount, "500000");
});

test("late callback identity remains archived after the saved action gains a hash", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  const store = archivedAlertStore(storage);
  store.archive({ actionId: "same-action", signerId: "dalamaa.testnet" });
  const lateAction = { id: "same-action", transactionHash: "late-hash", phase: "confirming" };
  assert.equal(store.has(lateAction.id), true);
});

test("supplier invitations are eligible only for the named supplier", () => {
  const purchase = { id: 8, state: "AwaitingSupplier", supplier_id: "supplier.testnet", proposer: "organizer.testnet" };
  assert.deepEqual(eligibleTasks({ accountId: "supplier.testnet", purchases: [purchase] }).map((task) => task.kind), ["supplier-invitation"]);
  assert.equal(eligibleTasks({ accountId: "organizer.testnet", purchases: [purchase] }).length, 0);
  assert.equal(eligibleTasks({ accountId: "outsider.testnet", purchases: [purchase] }).length, 0);
});

test("a pending supplier response replaces the invitation action", () => {
  const tasks = eligibleTasks({
    accountId: "supplier.testnet",
    purchases: [{ id: 8, state: "AwaitingSupplier", supplier_id: "supplier.testnet" }],
    pending: [{ id: "reply", signerId: "supplier.testnet", methodName: "accept_supplier_request", args: { purchase_id: "8" } }],
  });
  assert.deepEqual(tasks.map((task) => task.kind), ["pending-transaction"]);
});
