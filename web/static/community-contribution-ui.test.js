const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const directorySource = fs.readFileSync(path.join(__dirname, "community-directory.js"), "utf8");

test("Community Garden closes its contribution action at the application target", () => {
  assert.match(appSource, /Goal reached\. HarvestPool has disabled additional contributions/);
  assert.match(appSource, />Contribute</);
  assert.match(appSource, /Amount \(\$\)/);
  assert.match(appSource, /Small amounts such as \$0\.01 or \$0\.10 are supported/);
  assert.match(appSource, /This contribution exceeds the remaining/);
  assert.match(appSource, /application-level restriction/);
});

test("Community Fund summary uses the customer-facing goal hierarchy", () => {
  assert.match(appSource, /goal-summary-figures/);
  assert.match(appSource, /<dt>Goal<\/dt>/);
  assert.match(appSource, /<dt>Raised<\/dt>/);
  assert.match(appSource, /<dt>Remaining<\/dt>/);
  assert.match(appSource, /% funded/);
  assert.match(appSource, />Support this fund</);
  assert.doesNotMatch(appSource, /class="goal-details"/);
});

test("Community Fund progress rendering never passes a BigInt to Math.floor", () => {
  assert.doesNotMatch(appSource, /Math\.floor\(\(BigInt\(/);
  assert.match(appSource, /Math\.floor\(goalSnapshot\.progressBasisPoints \/ 100\)/);
});

test("contribution review names the exact asset, network, recipient, and no-refund boundary", () => {
  assert.match(appSource, /Review Community Goal contribution/);
  assert.match(appSource, /USDC on NEAR Testnet/);
  assert.match(appSource, /The recipient treasury is/);
  assert.match(appSource, /canonical Testnet USDC/);
  assert.match(appSource, /receiver,/);
  assert.match(appSource, /method,/);
  assert.match(appSource, /1 yoctoNEAR/);
  assert.match(appSource, /cannot be personally withdrawn or automatically refunded/);
});

test("Community Fund contribution uses persistent duplicate protection and authoritative confirmation", () => {
  assert.match(appSource, /performVerifiedAction\([\s\S]*community_contribute_usdc/);
  assert.match(appSource, /verifyTokenContributionOutcome/);
  assert.match(appSource, /previousTreasuryBalance/);
  assert.match(appSource, /confirmationAttempts: 30/);
});

test("disconnected visitors get a wallet action and unsupported requests stay disabled", () => {
  assert.match(appSource, /Connect wallet to contribute or vote/);
  assert.match(directorySource, /Contributions, payment requests, and votes are disabled/);
  assert.match(directorySource, /Individual fund treasuries and broader member governance are planned for a future release/);
});
