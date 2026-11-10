const test = require("node:test");
const assert = require("node:assert/strict");
const usdc = require("./usdc-payments.js");

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
