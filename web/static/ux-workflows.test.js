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
  assert.match(appSource, /WALLET_INITIALIZATION_TIMEOUT_MS = 15_000/);
  assert.match(appSource, /WALLET_SESSION_RESTORE_TIMEOUT_MS = 3_000/);
  assert.match(appSource, /\/static\/wallet-selector-bundle\.js/);
  assert.match(appSource, /walletButton\.textContent = "Retry wallet"/);
  assert.doesNotMatch(appSource, /https:\/\/esm\.sh/);
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
  assert.match(appSource, /filter=all/);
  assert.match(appSource, /history.replaceState/);
});

test("failed refreshes preserve verified records and never authorize from stale wallet state", () => {
  assert.match(appSource, /lastVerifiedRefreshAt: 0/);
  assert.match(appSource, /invalid JSON-RPC response/);
  assert.match(appSource, /Previously confirmed records were retained/);
  assert.match(appSource, /Showing the last verified deals/);
  assert.match(appSource, /accountDataVerified: false/);
  assert.match(appSource, /Restricted actions remain disabled until Refresh succeeds/);
  assert.match(appSource, /const accountVerified = accountAuthorityReady()/);
});

test("Explore distinguishes first-load failure from a degraded refresh", () => {
  assert.match(appSource, /const initialLoadFailed = state\.purchaseDiscoveryStatus === "error" && !state\.dataLoaded/);
  assert.match(appSource, /We couldn't load the deals/);
  assert.match(appSource, /if \(chainRead\) chainRead\.hidden = true/);
  assert.match(appSource, /Some latest data needs a retry/);
  assert.match(appSource, /Showing the last verified deals/);
  assert.doesNotMatch(appSource, /Purchases are temporarily unavailable/);
});

test("account pages share one readable refresh status without false empty records", () => {
  assert.match(appSource, /function liveReadWarningMarkup\(\)/);
  assert.doesNotMatch(appSource, /function accountReadWarningMarkup\(\)/);
  assert.doesNotMatch(appSource, /function purchaseReadWarningMarkup\(\)/);
  assert.match(appSource, /const accountRecordsUnavailable = state\.liveDataError \|\| state\.accountDataError/);
  assert.match(appSource, /\$\{liveReadWarningMarkup\(\)\}\$\{liveRefreshStatusMarkup\(\)\}/);
});

test("confirmed actions refresh affected state and make a verified vote non-repeatable", () => {
  assert.match(appSource, /async function refreshAffectedAction\(action\)/);
  assert.match(appSource, /refreshAffectedAction\(submittedAction\)/);
  assert.match(appSource, /voteButton\.textContent = voteButton === button && args\.approve \? "Approved" : "Recorded"/);
  assert.match(appSource, /ACTION_CENTER_REFRESH_INTERVAL_MS = 30_000/);
  assert.match(appSource, /scheduleActionCenterRefresh/);
});

test("deal navigation keeps dashboard context and names the three time concepts", () => {
  assert.match(flaskSource, /navigation_context=request.args.get\("from", ""\)/);
  assert.match(templateSource, /navigation_context == 'dashboard'/);
  assert.match(appSource, /url.searchParams.set\("from", "dashboard"\)/);
  assert.match(appSource, /Joining deadline/);
  assert.match(appSource, /Fulfillment deadline/);
  assert.match(appSource, /Pickup or delivery time/);
});

test("Explore renders public purchases before wallet and governance enrichment finishes", () => {
  assert.match(templateSource, /id="purchase-grid"[^>]*aria-busy="true"[\s\S]*Loading Group Deals/);
  assert.match(appSource, /async function loadPublicPurchaseData\(\)/);
  assert.match(appSource, /state\.dataLoaded = true;[\s\S]*state\.purchaseDiscoveryStatus = "ready";[\s\S]*renderExplore\(\);/);
  assert.match(appSource, /async function loadBaseData\(\) \{\s*await loadPublicPurchaseData\(\);\s*await Promise\.all\(\[loadWalletState\(\), loadV3Data\(\)\]\);/);
  assert.match(appSource, /appConfig\.page === "decisions" \|\| appConfig\.page === "explore"/);
  assert.match(appSource, /harvestpoolFirstPurchaseCardMs/);
});

test("Create loads the public supplier directory without waiting for Meteor", () => {
  assert.match(appSource, /async function loadCreatePublicData\(\)/);
  assert.match(appSource, /const config = await view\("get_config"\);[\s\S]*view\("get_suppliers"\)/);
  assert.match(appSource, /appConfig\.page === "create"[\s\S]*loadCreatePublicData\(\), loadNearPrice\(\), walletPromise/);
  assert.match(appSource, /harvestpoolSupplierReadyMs/);
});

test("Explore retains supplier roles without making the directory block first cards", () => {
  assert.match(appSource, /const supplierPromise = isV4[\s\S]*view\("get_suppliers"\)/);
  assert.match(appSource, /if \(appConfig\.page !== "explore"\) await supplierPromise/);
  assert.match(appSource, /state\.suppliers\.some[\s\S]*state\.purchases\.some\(\(purchase\) => String\(supplierAccount\(purchase\)\)/);
});

test("Direct deals render before strict wallet and governance enrichment", () => {
  assert.match(appSource, /async function loadDetailData\(purchaseId, \{ render = true, walletReady = null \} = \{\}/);
  assert.match(appSource, /state\.dataLoaded = true;[\s\S]*if \(render\) renderCurrentPage\(\);[\s\S]*loadWalletState\(\{ strict: true \}\)/);
  assert.match(appSource, /detailAuthorityReady/);
  assert.match(appSource, /appConfig\.page === "details"[\s\S]*Boolean\(state\.accountId\)/);
});

test("fully reserved open deals use the same display label on cards and detail pages", () => {
  assert.match(appSource, /FullyReserved: "Fully reserved"/);
  assert.match(appSource, /state === "Open" && availableCapacity\(purchase\) === 0 \? "FullyReserved"/);
  assert.match(appSource, /statusPill\(purchaseDisplayState\(purchase\)\)/);
  assert.match(appSource, /\.funding-panel \.status/);
});

test("Community-only pending actions do not reload unrelated purchase directories", () => {
  assert.match(appSource, /const requiresPurchaseRefresh = pending\.some\(\(action\) => action\.methodName !== "community_contribute_usdc"\)/);
  assert.match(appSource, /requiresPurchaseRefresh \? loadBaseData\(\) : Promise\.resolve\(\)/);
  assert.match(appSource, /methodName === "community_contribute_usdc"[\s\S]*appConfig\.page === "community_fund"/);
});

test("Public reads are bounded, deduplicated, and retain confirmed records on partial failure", () => {
  assert.match(appSource, /async function readIndexedRecords\(readRecord, count, concurrency = 8\)/);
  assert.match(appSource, /Math\.min\(count, concurrency\)/);
  assert.match(appSource, /function mergeIndexedRecords\(previous, reads\)/);
  assert.match(appSource, /Previously confirmed records were retained/);
  assert.match(appSource, /if \(publicPurchaseDataRun\) return publicPurchaseDataRun/);
  assert.match(appSource, /if \(v3DataRun\) return v3DataRun/);
});

test("Account views do not turn unavailable reads into false empty states", () => {
  assert.match(appSource, /function accountDataLoadingMarkup\(title, message\)/);
  assert.match(appSource, /No empty account result is being shown/);
  assert.match(appSource, /No empty sales result is being shown/);
  assert.match(appSource, /Some joined deals need a retry/);
  assert.match(appSource, /Loading decisions is temporarily unavailable/);
  assert.match(appSource, /Latest issue and decision data could not be refreshed/);
});

test("Expired supplier fulfillment does not offer a contract-rejected evidence submission", () => {
  assert.match(appSource, /const fulfillmentExpired = purchase\.state === "Funded" && deadlineHasPassed/);
  assert.match(appSource, /The contract will reject new evidence/);
  assert.match(appSource, /data-action="expire-unfulfilled"/);
});

test("Stale supplier wallet reads disable supplier-only controls", () => {
  assert.match(appSource, /purchase\.state === "AwaitingSupplier" && namedWallet && accountAuthorityReady\(\)/);
  assert.match(appSource, /Supplier wallet state is still being verified/);
  assert.match(appSource, /!accountAuthorityReady\(\)\s*\? `<div class="eligibility-callout warning"/);
});

test("Pending wallet handoff status is cleared into a durable unresolved state on reload", () => {
  assert.match(appSource, /action\.phase === "wallet" \? "unresolved"/);
  assert.match(appSource, /phase: !action\.transactionHash && action\.phase === "wallet-unresponsive"/);
  assert.match(appSource, /No action is complete until the deal record confirms it/);
});

test("Targeted refreshes avoid a duplicate purchase read after the public directory load", () => {
  assert.match(appSource, /!state\.currentPurchase \|\| String\(state\.currentPurchase\.id\) !== String\(purchaseId\)/);
  assert.match(appSource, /await loadPurchase\(purchaseId\)\.catch\(\(\) => null\)/);
  assert.match(appSource, /if \(id && !state\.currentPurchase\) await loadPurchase\(id\)/);
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
  assert.match(appSource, /Saved draft available[\s\S]*data-action="discard-draft"/);
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
  assert.match(appSource, /const ACTION_CENTER_TABS = \["active", "archived", "history", "issues"\]/);
  assert.match(appSource, /labels = \{ active: "Active", archived: "Archived", history: "History", issues: "Issues" \}/);
  assert.match(appSource, /data-action="archive-pending-alert"/);
  assert.match(appSource, /Automatic verification and duplicate protection continue/);
  assert.match(stylesSource, /@media \(max-width: 420px\)[\s\S]*\.action-center-tabs \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); overflow: visible; \}/);
  assert.match(appSource, /window\.addEventListener\("hashchange"/);
  assert.match(appSource, /window\.addEventListener\("popstate"/);
  assert.match(appSource, /popstate[\s\S]*syncWalletAccount\(\)[\s\S]*refreshLiveData\(\{ force: true \}\)/);
  assert.match(appSource, /Previously confirmed records have not been replaced by an empty result/);
  assert.match(appSource, /seenIssueIds\.has\(id\)/);
  assert.doesNotMatch(appSource, /Confirmed records/);
  assert.doesNotMatch(appSource, /Pending, history, and issues/);
  assert.match(appSource, /No active funded purchases are currently eligible for a new issue/);
  assert.match(appSource, /href="\/dashboard">My Group Buys/);
});

test("small manual-test usability fixes stay local to the frontend", () => {
  assert.match(templateSource, /Who will receive the funds\? For example, the veterinary clinic, supplier, or person responsible for the expense\./);
  assert.match(templateSource, /Use a direct public HTTPS image URL, not a webpage URL/);
  assert.match(stylesSource, /\.nav-link \{[^}]*white-space: nowrap/);
  assert.match(appSource, /data-dashboard-filter="\$\{value\}"/);
  assert.match(appSource, /\["all", "All"\][\s\S]*\["active", "Active"\][\s\S]*\["completed", "Completed"\][\s\S]*\["unsuccessful", "Unsuccessful"\]/);
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
