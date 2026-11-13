const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "community-directory.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8");

test("failed external cover images become a designed placeholder", () => {
  assert.match(source, /community-image-placeholder/);
  assert.match(source, /addEventListener\("error", fallback/);
  assert.match(source, /image\.complete && image\.naturalWidth === 0/);
  assert.match(styles, /\.community-card-media\.image-unavailable \.community-card-image \{ display: none/);
  assert.match(styles, /\.community-card-media\.image-unavailable \.community-image-placeholder \{ display: grid/);
});

test("verified fund cards render first and hydrate finalized activity independently", () => {
  assert.match(source, /hydrateVerifiedFunds/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /activity\?\.complete/);
  assert.match(source, /last-verified/);
  assert.match(source, /fund\.activityUrl/);
});

test("directory never presents unavailable verification as a zero balance", () => {
  assert.match(source, /Raised amount pending verification/);
  assert.match(source, /progressPercent\(fund\.raisedUnits, fund\.targetUnits\)/);
  assert.doesNotMatch(source, /Math\.round\(\(raised \/ target\) \* 100\)/);
  assert.match(source, /verifiedContributorIds/);
  assert.match(source, /sessionStorage/);
});

test("directory filters respond immediately and use wallet-aware verified associations", () => {
  assert.match(source, /harvestpool:wallet-account/);
  assert.match(source, /aria-pressed/);
  assert.match(source, /No verified votes need your action/);
  assert.match(source, /No verified funds are associated with this wallet/);
  assert.match(source, /Reaching a fundraising goal does not by itself mark a fund completed/);
});
