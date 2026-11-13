const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const directorySource = fs.readFileSync(path.join(__dirname, "community-directory.js"), "utf8");

test("Community Garden closes its contribution action at the application target", () => {
  assert.match(appSource, /Goal Reached\. HarvestPool has disabled additional contributions/);
  assert.match(appSource, />Contribute USDC</);
  assert.match(appSource, /This contribution exceeds the remaining/);
  assert.match(appSource, /application-level restriction/);
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
