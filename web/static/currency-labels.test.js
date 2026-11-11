const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const templateSource = fs.readFileSync(path.join(__dirname, "../templates/index.html"), "utf8");

test("ordinary V5 surfaces use customer USD while signed terms retain token details", () => {
  assert.match(appSource, /customerPaymentLabel\(purchase, commitment\.amount\).*contributed/);
  assert.match(appSource, /Supplier payment<\/strong> \$\{escapeHtml\(customerPaymentLabel\(purchase, purchase\.total_funded_amount\)\)\}/);
  assert.match(appSource, /Claim \$\{escapeHtml\(customerPaymentLabel\(purchase, commitment\.amount\)\)\} refund/);
  assert.match(appSource, /Review &amp; release \$\{escapeHtml\(customerPaymentLabel\(purchase, purchase\.total_funded_amount\)\)\}/);
  assert.match(appSource, /settled as exactly \$\{escapeHtml\(paymentLabel\(purchase, purchase\.price_per_unit\)\)\} on Testnet/);
  assert.match(appSource, /Payment uses \$\{escapeHtml\(testPaymentLabel\(purchase, purchase\.price_per_unit\)\)\}.*No USD card charge/);
  assert.doesNotMatch(appSource, /It is separate from the listed USD price/);
});

test("V5 payout stays behind fresh financial checks and explicit authorization", () => {
  assert.match(appSource, /view\("get_accounting"\)/);
  assert.match(appSource, /view\("get_outbound_operation_count"\)/);
  assert.match(appSource, /storage_balance_of/);
  assert.match(appSource, /STOP: payout checks are incomplete, stale, or inconsistent/);
  assert.match(appSource, /This is a real Circle Testnet USDC transfer/);
  assert.match(appSource, /reconcile_token_balance/);
});

test("V5 smoke-test fulfillment copy never presents simulation as physical delivery", () => {
  assert.match(appSource, /Approve Simulated Evidence/);
  assert.match(appSource, /no physical delivery is represented/i);
  assert.match(appSource, /TESTNET_SIMULATION_NO_PHYSICAL_DELIVERY/);
  assert.match(templateSource, /submit a clearly labeled simulation reference/i);
});

test("V5 keeps genuine NEAR gas copy separate from USDC payment decoration", () => {
  assert.match(appSource, /function decorateMoneyText\(\) \{\s+if \(isV5\(\)\) return;/);
  assert.match(templateSource, /Testnet USDC is not a real USD card charge/);
  assert.match(templateSource, /contract_version == "V5".*USDC amount/);
});

test("V5 creation has one visible price and derives immutable token units", () => {
  assert.match(templateSource, /Price per basket \(\$\)/);
  assert.match(templateSource, /id="price-per-unit" name="price_per_unit" type="hidden"/);
  assert.match(appSource, /v5Price = usdcTools\.usdPrice\(listedPrice/);
  assert.match(appSource, /price_per_unit: priceYocto, listed_price_usd_cents: usdScaled\.toString\(\)/);
});
