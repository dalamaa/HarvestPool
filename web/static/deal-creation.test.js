const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { consumeConnectionIntent, markConnectionIntent, mode, transaction, validateDeadlines } = require("./deal-creation.js");

const terms = { product_name: "Test basket", price_per_unit: "2000000" };
const supplier = "harvestpool-farmer-1.testnet";

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) || null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

test("supplier mode publishes with the connected supplier wallet", () => {
  const selected = mode("supplier_offer");
  assert.equal(selected.cta, "Publish Group Deal");
  assert.equal(selected.progress, "Publishing your Group Deal…");
  assert.equal(selected.success, "Your Group Deal is live!");
  assert.deepEqual(transaction(selected.value, terms, supplier, supplier), {
    methodName: "create_supplier_offer",
    args: { terms },
  });
});

test("supplier mode cannot fall through to an organizer request or use another signer", () => {
  assert.throws(
    () => transaction("supplier_offer", terms, supplier, "organizer.testnet"),
    /connected supplier wallet/,
  );
});

test("organizer mode sends a supplier request with the named supplier", () => {
  const selected = mode("organizer_request");
  assert.equal(selected.cta, "Send Request to Supplier");
  assert.equal(selected.progress, "Sending your request to the supplier…");
  assert.equal(selected.success, "Your request was sent to the supplier.");
  assert.deepEqual(transaction(selected.value, terms, supplier, "organizer.testnet"), {
    methodName: "create_purchase_request",
    args: { supplier_id: supplier, terms },
  });
});

test("unknown role values fail closed to organizer mode", () => {
  assert.equal(mode("unexpected").methodName, "create_purchase_request");
});

test("publication rejects an expired or nearly expired join deadline before wallet authorization", () => {
  const now = Date.parse("2026-11-10T06:00:00-06:00");
  const expired = String(BigInt(Date.parse("2026-11-10T05:00:00-06:00")) * 1000000n);
  const tooSoon = String(BigInt(now + 4 * 60 * 1000) * 1000000n);
  const fulfillment = String(BigInt(now + 24 * 60 * 60 * 1000) * 1000000n);
  assert.throws(() => validateDeadlines(expired, fulfillment, now), /five minutes in the future/);
  assert.throws(() => validateDeadlines(tooSoon, fulfillment, now), /five minutes in the future/);
});

test("publication accepts future join and fulfillment deadlines", () => {
  const now = Date.parse("2026-11-10T06:00:00-06:00");
  const join = String(BigInt(now + 60 * 60 * 1000) * 1000000n);
  const fulfillment = String(BigInt(now + 24 * 60 * 60 * 1000) * 1000000n);
  assert.equal(validateDeadlines(join, fulfillment, now), true);
});

test("wallet connection records supplier intent but never implies publication", () => {
  const storage = new MemoryStorage();
  assert.equal(markConnectionIntent(storage, "supplier_offer"), true);
  const followup = consumeConnectionIntent(storage);
  assert.equal(followup.methodName, "create_supplier_offer");
  assert.match(followup.connected, /has not been published/);
  assert.match(followup.connected, /Publish Group Deal again/);
  assert.equal(consumeConnectionIntent(storage), null);
});

test("wallet connection records organizer intent without sending a request", () => {
  const storage = new MemoryStorage();
  markConnectionIntent(storage, "organizer_request");
  const followup = consumeConnectionIntent(storage);
  assert.equal(followup.methodName, "create_purchase_request");
  assert.match(followup.connected, /No supplier request has been sent/);
});

test("the Create Deal page uses the same role configuration for UI and transaction selection", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  const templateSource = fs.readFileSync(path.join(__dirname, "../templates/index.html"), "utf8");
  assert.match(templateSource, /deal-creation\.js/);
  assert.match(templateSource, /Send Request to Supplier/);
  assert.match(appSource, /dealCreationTools\.mode\(selected\.value\)/);
  assert.match(appSource, /dealCreationTools\.transaction\(creationMode, terms, supplierId, state\.accountId\)/);
  assert.match(appSource, /saveDraft\(form\);[\s\S]*markConnectionIntent/);
  assert.match(appSource, /Supplier actions do not require buyer community membership/);
  assert.match(appSource, /We couldn't publish your Group Deal/);
  assert.match(appSource, /onError: \(message, error\) => setCreateError/);
  assert.doesNotMatch(appSource, /supplierOffer \? "Approve and Publish" : "Send to Supplier"/);
});
