const test = require("node:test");
const assert = require("node:assert/strict");
const usdc = require("./usdc-payments.js");

test("dollar display keeps cents familiar without hiding smaller nonzero USDC", () => {
  assert.equal(usdc.formatDollars("1000000", 6), "$1.00");
  assert.equal(usdc.formatDollars("800000", 6), "$0.80");
  assert.equal(usdc.formatDollars("200000", 6), "$0.20");
  assert.equal(usdc.formatDollars("250000000", 6), "$250.00");
  assert.equal(usdc.formatDollars("1", 6), "$0.000001");
});

test("USDC base units are exact at six decimals", () => {
  assert.equal(usdc.parseUnits("50", 6), "50000000");
  assert.equal(usdc.parseUnits("0.000001", 6), "1");
  assert.equal(usdc.parseUnits("1.0000001", 6), null);
  assert.equal(usdc.formatUnits("50000001", 6), "50.000001");
});

test("ft_transfer_call uses a versioned commit message and decimal strings", () => {
  const args = usdc.transferCall({ receiverId: "v5.testnet", purchaseId: "7", quantity: 2, amount: "100000000" });
  assert.equal(args.receiver_id, "v5.testnet");
  assert.equal(args.amount, "100000000");
  assert.deepEqual(JSON.parse(args.msg), { v: 1, action: "commit", purchase_id: "7", quantity: 2 });
});

test("payment labels follow the configured contract version", () => {
  assert.deepEqual(usdc.paymentAsset("V5", 6), {
    symbol: "USDC",
    displayName: "Native Testnet USDC",
    decimals: 6,
  });
  assert.equal(usdc.formatPayment("2000000", "V5", 6), "2 USDC");
  assert.equal(usdc.formatPayment("2000000000000000000000000", "V4"), "2 Testnet NEAR");
  assert.equal(usdc.paymentAsset("V4").displayName, "Native Testnet NEAR");
});

test("USD listings derive exact six-decimal USDC without rounding or divergence", () => {
  assert.deepEqual(usdc.usdPrice("50.00", 6), { cents: "5000", tokenUnits: "50000000" });
  assert.deepEqual(usdc.usdPrice("2.00", 6), { cents: "200", tokenUnits: "2000000" });
  assert.deepEqual(usdc.usdPrice("0.01", 6), { cents: "1", tokenUnits: "10000" });
  assert.equal(usdc.usdPrice("2.001", 6), null);
  assert.equal(usdc.usdPrice("0", 6), null);
});

test("reconciliation readiness requires matching values and a fresh callback timestamp", () => {
  const checkedAt = 1_794_347_400_000;
  const accounting = {
    reconciliation_status: "balanced",
    last_observed_token_balance: "4000000",
    last_reconciled_liability: "4000000",
    last_reconciled_at_ns: String(BigInt(checkedAt - 30_000) * 1_000_000n),
  };
  assert.deepEqual(usdc.reconciliationSnapshot(accounting, "4000000", "4000000", checkedAt, 300_000), {
    matches: true,
    fresh: true,
    ready: true,
    reconciledAtMs: checkedAt - 30_000,
    ageMs: 30_000,
  });
  assert.equal(usdc.reconciliationSnapshot(accounting, "3999999", "4000000", checkedAt, 300_000).ready, false);
  assert.equal(usdc.reconciliationSnapshot(accounting, "4000000", "4000000", checkedAt + 400_000, 300_000).ready, false);
  assert.equal(usdc.reconciliationSnapshot({ reconciliation_status: "not-reconciled" }, "4000000", "4000000", checkedAt).ready, false);
});
