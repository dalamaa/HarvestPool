const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const templateSource = fs.readFileSync(path.join(__dirname, "../templates/index.html"), "utf8");
const flaskSource = fs.readFileSync(path.join(__dirname, "../app.py"), "utf8");
const stylesSource = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8");

test("deals is the preferred marketplace route while purchase links remain compatible", () => {
  assert.match(flaskSource, /@app\.get\("\/deals"\)[\s\S]*@app\.get\("\/purchases\/<int:purchase_id>"\)/);
  assert.match(flaskSource, /@app\.get\("\/deals\/<int:purchase_id>"\)/);
  assert.match(templateSource, /href="\/deals">Explore Deals/);
  assert.match(appSource, /const detailsUrl = `\/deals\/\$\{encodeURIComponent\(purchase\.id\)\}`/);
});

test("verified supplier selection presents the business before its wallet identifier", () => {
  assert.match(templateSource, /<select id="farmer-account"[\s\S]*Choose a verified supplier/);
  assert.match(appSource, /supplier\.business_name[\s\S]*supplier\.location[\s\S]*supplier\.account_id/);
  assert.match(appSource, /function updateSupplierSelection\(\)/);
});

test("pickup terms are collected as structured fields without changing contract storage", () => {
  assert.match(templateSource, /name="fulfillment_method"/);
  assert.match(templateSource, /name="handoff_time"/);
  assert.match(templateSource, /name="fulfillment_location"/);
  assert.match(templateSource, /name="fulfillment_method" type="hidden" value="Pickup"/);
  assert.match(appSource, /const pickup = `\$\{fulfillmentMethod\} · \$\{handoffLabel\} · \$\{fulfillmentLocation\}\$\{pickupInstructions/);
  assert.match(appSource, /pickup_or_delivery: pickup/);
  assert.match(appSource, /encode\(pickup\)\.length > 2000/);
});

test("supplier proposals are distinct eligible actions with deep links", () => {
  assert.match(appSource, /supplier-invitation[\s\S]*#supplier-response/);
  assert.match(appSource, /Proposals awaiting your response/);
  assert.match(appSource, /Orders and fulfillment/);
  assert.match(templateSource, />My Sales</);
});

test("accept and decline have distinct labels and an explicit application review", () => {
  assert.match(appSource, /button-accept[^>]*>Accept Proposal/);
  assert.match(appSource, /button-reject[^>]*>Decline Proposal/);
  assert.match(appSource, /handleSupplierRequestAction[\s\S]*reviewTransaction/);
  assert.match(appSource, /Declining cannot be undone on this proposal/);
  assert.doesNotMatch(appSource, /\bconfirm\s*\(/);
});

test("wallet restoration and live state refresh are explicit and bounded", () => {
  assert.match(appSource, /walletStatus: "initializing"/);
  assert.match(appSource, /state\.walletStatus = state\.accountId \? "connected" : "disconnected"/);
  assert.match(appSource, /async function refreshLiveData/);
  assert.match(appSource, /Date\.now\(\) - state\.lastLiveRefreshAt < 12_000/);
  assert.match(appSource, /window\.addEventListener\("focus"/);
  assert.doesNotMatch(appSource, /setInterval\(\(\) => \{[\s\S]*reconcilePendingActions/);
});

test("summary values are left aligned in stable two-column grids", () => {
  assert.match(stylesSource, /\.term-row \{ display: grid; grid-template-columns:/);
  assert.match(stylesSource, /\.term-row dd \{[^}]*text-align: left/);
  assert.doesNotMatch(stylesSource, /\.term-row dd \{[^}]*text-align: right/);
});

test("marketplace cards use a stable content and action structure", () => {
  assert.match(appSource, /purchase-card-main/);
  assert.match(appSource, /purchase-card-actions/);
  assert.match(appSource, /deal-outcome-success/);
  assert.match(appSource, /deal-outcome-failed/);
  assert.match(stylesSource, /\.purchase-card \{ display: flex;/);
  assert.match(stylesSource, /\.purchase-card-actions \.button[^{]*\{[^}]*white-space: nowrap/);
});

test("homepage preview badges stay in the card flow without collision-prone orbit labels", () => {
  assert.doesNotMatch(templateSource, /orbit-note/);
  assert.match(templateSource, /<h2>One shared order<\/h2><span class="preview-badge">Clear from day one<\/span>/);
  assert.match(templateSource, /<div class="preview-badge-row"><span class="preview-badge">Funded buyers <strong>/);
  assert.match(stylesSource, /\.preview-badge-row \{ display: flex; flex-wrap: wrap; gap: 8px;/);
  assert.match(stylesSource, /\.preview-badge \{ display: inline-flex;[^{]*padding: 6px 10px;[^{]*border-radius: 999px;[^{]*background: var\(--mist\);/);
  assert.doesNotMatch(stylesSource, /\.preview-badge \{[^}]*position:\s*absolute/);
});
