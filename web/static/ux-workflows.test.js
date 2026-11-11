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

test("Explore uses only the four customer-facing marketplace filters", () => {
  assert.match(templateSource, /data-filter="available"[^>]*>Available/);
  assert.match(templateSource, /data-filter="in-progress"[^>]*>In Progress/);
  assert.match(templateSource, /data-filter="closed"[^>]*>Closed/);
  assert.match(templateSource, /data-filter="all"[^>]*>All/);
  assert.match(templateSource, /data-filter="available"[^>]*aria-pressed="true"/);
  assert.doesNotMatch(templateSource, /data-filter="(?:live|open|funded|completed)"/);
  assert.doesNotMatch(appSource, /dataset\.filter = "live"/);
  assert.match(appSource, /Authoritative Testnet state/);
});

test("Explore polls authoritative state so delayed finalization moves cards without a manual refresh", () => {
  assert.match(appSource, /const EXPLORE_REFRESH_INTERVAL_MS = 15_000/);
  assert.match(appSource, /function scheduleExploreRefresh\(\)/);
  assert.match(appSource, /refreshLiveData\(\{ force: true \}\)/);
  assert.match(appSource, /function stopExploreRefresh\(\)/);
  assert.match(appSource, /document\.visibilityState !== "visible"/);
  assert.match(appSource, /if \(state\.refreshingLiveData\) return state\.refreshingLiveData/);
  assert.match(appSource, /scheduleExploreRefresh\(\);/);
});

test("create forms start empty and offer explicit draft restoration", () => {
  assert.match(templateSource, /id="create-purchase-form" data-draft-form="create-purchase"/);
  ["product-name", "product-description", "custom-unit", "package-contents", "listed-usd-price", "fulfillment-location", "pickup-terms"].forEach((id) => {
    assert.match(templateSource, new RegExp(`id="${id}"[^>]*placeholder=""`), id);
  });
  assert.doesNotMatch(templateSource, /placeholder="(?:Fresh tomatoes|Ripe local tomatoes|half-share|About 10 lb|50\.00|Community center|Bring your order confirmation)/);
  assert.match(appSource, /if \(contentsInput\) contentsInput\.placeholder = ""/);
  assert.doesNotMatch(templateSource, /name="min_quantity"[^>]*value="10"/);
  assert.doesNotMatch(templateSource, /name="max_quantity"[^>]*value="20"/);
  assert.doesNotMatch(templateSource, /name="cancellation_and_refund_terms"[^>]*>Members receive/);
  assert.match(appSource, /isCreateForm && savedDraft/);
  assert.match(appSource, /data-action="restore-draft"/);
  assert.match(appSource, /CREATE_SUBMITTED_KEY/);
  assert.match(appSource, /window\.sessionStorage\.setItem\(CREATE_SUBMITTED_KEY, "true"\)/);
});

test("create validation gives linked inline errors and visible invalid borders", () => {
  assert.match(appSource, /function showCreateValidationErrors\(form, errors\)/);
  assert.match(appSource, /id: field\?\.id \|\| error\.id \|\| error\.name/);
  assert.match(appSource, /function focusCreateErrorLink\(link\)/);
  assert.match(appSource, /fieldContainer\.scrollIntoView/);
  assert.match(appSource, /target\.focus\(\{ preventScroll: true \}\)/);
  assert.match(appSource, /aria-invalid/);
  assert.match(appSource, /field-error/);
  assert.match(stylesSource, /\.field-invalid input, \.field-invalid select, \.field-invalid textarea/);
  assert.match(stylesSource, /\.field-error/);
});

test("Action Center uses accessible hash-aware tabs and deduplicates issues", () => {
  assert.match(appSource, /role="tablist" aria-label="Action Center views"/);
  assert.match(appSource, /role="tab" aria-selected=/);
  assert.match(appSource, /role="tabpanel" aria-labelledby=/);
  assert.match(appSource, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
  assert.match(appSource, /hash === "#issues" \|\| hash === "#raise-an-issue"/);
  assert.match(appSource, /window\.addEventListener\("hashchange"/);
  assert.match(appSource, /seenIssueIds\.has\(id\)/);
  assert.doesNotMatch(appSource, /Confirmed records/);
  assert.doesNotMatch(appSource, /Pending, history, and issues/);
  assert.match(appSource, /No active funded purchases are currently eligible for a new issue/);
  assert.match(appSource, /href="\/dashboard">My Group Buys/);
});

test("normal views keep wallet and transaction internals out of the main reading path", () => {
  assert.match(stylesSource, /#agreement-content \.technical-details/);
  assert.match(stylesSource, /#supplier-invitation-content \.technical-details/);
  assert.match(appSource, /Approve only after checking the account, amount, and action/);
  assert.match(templateSource, /Testnet USDC is not a real USD card charge or redeemable dollars/);
});

test("supplier response colors are explicit and tooltips stay compact and dark", () => {
  assert.match(stylesSource, /\.button-accept \{[^}]*background: var\(--success\)/);
  assert.match(stylesSource, /\.supplier-invitation-actions \.button-reject \{[^}]*background: var\(--danger\)/);
  assert.match(stylesSource, /\.info-tooltip-content \{[^}]*width: min\(240px/);
  assert.match(stylesSource, /\.info-tooltip-content \{[^}]*background: #17251f/);
  assert.match(stylesSource, /\.info-tooltip-content \{[^}]*font-size: 12px/);
  assert.match(stylesSource, /\.info-tooltip-button \{[^}]*width: 44px;[^}]*height: 44px;[^}]*background: transparent;[^}]*font-size: 17px/);
  assert.match(stylesSource, /\.info-tooltip-button::before \{[^}]*width: 24px;[^}]*border-radius: 6px;[^}]*background: transparent/);
  assert.doesNotMatch(stylesSource, /\.info-tooltip-button::before \{[^}]*border:/);
  assert.match(templateSource, /aria-label="About the maximum quantity"[^>]*>\?<\/button>/);
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

test("homepage preview keeps one title, useful progress, and centered steps", () => {
  assert.doesNotMatch(templateSource, /orbit-note/);
  assert.match(templateSource, /<h2>One shared order<\/h2>/);
  assert.doesNotMatch(templateSource, /<div class="ticket-price">|<span class="live-card-label">Terms first<\/span>|<span class="mini-label">Community order<\/span>|<span class="preview-badge">Clear from day one<\/span>/);
  assert.match(templateSource, /<div class="preview-badge-row"><span class="preview-badge">Funded buyers <strong>/);
  assert.match(stylesSource, /\.ticket-stats div \{[^}]*justify-items: center;[^}]*text-align: center/);
  assert.match(stylesSource, /\.preview-badge-row \{ display: flex; flex-wrap: wrap; gap: 8px;/);
  assert.match(stylesSource, /\.preview-badge \{ display: inline-flex;[^{]*padding: 6px 10px;[^{]*border-radius: 999px;[^{]*background: var\(--mist\);/);
  assert.doesNotMatch(stylesSource, /\.preview-badge \{[^}]*position:\s*absolute/);
});
