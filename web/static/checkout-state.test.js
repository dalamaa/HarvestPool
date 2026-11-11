const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const checkout = require("./checkout-state.js");

const purchase = {
  id: "0",
  commitments: [{ account_id: "dalamaa.testnet", quantity: 1, amount: "2000000", state: "Active" }],
};

test("an authoritative active commitment always resolves to the confirmed screen", () => {
  const state = checkout.resolve({ purchase, accountId: "dalamaa.testnet", pending: true, phase: { kind: "awaiting" } });
  assert.equal(state.kind, "confirmed");
  assert.equal(state.commitment.quantity, 1);
  assert.equal(state.commitment.amount, "2000000");
});

test("another wallet remains a new buyer and cannot inherit the confirmed screen", () => {
  assert.equal(checkout.resolve({ purchase, accountId: "harvestpool-member-a-2026.testnet" }).kind, "ready");
});

test("both buyers resolve to their own confirmed order when the second buyer fills the group", () => {
  const fullPurchase = {
    id: "0",
    state: "Open",
    total_quantity: 2,
    max_quantity: 2,
    funded_member_count: 2,
    available_funded_member_slots: 0,
    commitments: [
      { account_id: "dalamaa.testnet", quantity: 1, amount: "2000000", state: "Active" },
      { account_id: "harvestpool-member-a-2026.testnet", quantity: 1, amount: "2000000", state: "Active" },
    ],
  };
  const buyer1 = checkout.resolve({ purchase: fullPurchase, accountId: "dalamaa.testnet" });
  const buyer2 = checkout.resolve({ purchase: fullPurchase, accountId: "harvestpool-member-a-2026.testnet", pending: true });
  assert.equal(buyer1.kind, "confirmed");
  assert.equal(buyer2.kind, "confirmed");
  assert.equal(buyer2.commitment.amount, "2000000");
});

test("an unresolved transfer remains confirming and blocks a duplicate", () => {
  assert.equal(checkout.resolve({ purchase: { id: "0", commitments: [] }, accountId: "dalamaa.testnet", pending: true }).kind, "confirming");
});

test("rejected and failed payments remain retryable states rather than success", () => {
  const empty = { id: "0", commitments: [] };
  assert.equal(checkout.resolve({ purchase: empty, accountId: "dalamaa.testnet", phase: { kind: "wallet-rejected" } }).kind, "wallet-rejected");
  assert.equal(checkout.resolve({ purchase: empty, accountId: "dalamaa.testnet", phase: { kind: "failed" } }).kind, "failed");
});

test("confirmed checkout removes old controls and uses state-aware payment copy", () => {
  const app = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  assert.match(app, /You've joined the Group Deal!/);
  assert.match(app, /View My Group Buys/);
  assert.match(app, /replace\(" USDC", " test USDC"\)/);
  assert.match(app, /through your wallet\. No USD card charge\./);
  assert.doesNotMatch(app, /It is separate from the listed USD price\./);
  assert.match(app, /checkoutStateTools\.resolve/);
  assert.match(app, /if \(checkoutState\.kind === "confirmed"\) \{[\s\S]*clearDraft\(root\)/);
  assert.match(app, /const joinedDeals = state\.purchases\.filter\(\(purchase\) => commitmentFor\(purchase\)\)/);
  assert.match(app, /\["commit", "commit_usdc"\].*action\.methodName/);
  assert.match(app, /funded\) throw new Error\("This wallet already has a funded place/);
});

test("payment confirmation refreshes the current purchase and polls long enough for Circle receipts", () => {
  const app = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  assert.match(app, /confirmationAttempts: 30/);
  assert.match(app, /confirmationDelayMs: 1000/);
  assert.match(app, /await loadPurchase\(purchaseId\)\.catch/);
  assert.match(app, /transactionHash: transactionHash|\.\.\.saved, transactionHash/);
});

test("unresolved payment uses a dedicated non-editable status screen", () => {
  const app = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  assert.match(app, /if \(confirming\) \{[\s\S]*checkout-payment-status[\s\S]*return;/);
  assert.match(app, /We haven't confirmed the result yet\. Please don't pay again while we check\./);
  assert.match(app, /Your payment was submitted/);
  assert.match(app, /Check payment status/);
});

test("rendered checkout wallet buttons use delegated Meteor connection handling", () => {
  const app = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  assert.match(app, /document\.addEventListener\("click", async \(event\) => \{[\s\S]*closest\("\[data-connect-wallet\]"\)[\s\S]*await connectWallet\(\)/);
  assert.doesNotMatch(app, /\$\$\('\[data-connect-wallet\]'\)\.forEach/);
});

test("confirmed copy does not duplicate spot wording and explains finalization", () => {
  const app = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  assert.doesNotMatch(app, /spotLabel\(fundedSpots\)\)\} left/);
  assert.match(app, /the deal must be finalized before the supplier can submit fulfillment evidence/);
  assert.match(app, /quantityLabel\(purchase, total\)\} of \$\{quantityLabel\(purchase, maximum\)/);
});
