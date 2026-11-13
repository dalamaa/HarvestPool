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
  assert.doesNotMatch(appSource, /The wallet review identifies/);
  assert.match(appSource, /This contribution exceeds the remaining/);
  assert.match(appSource, /application-level restriction/);
});

test("Community Fund summary uses the customer-facing goal hierarchy", () => {
  assert.match(appSource, /goal-summary-figures/);
  assert.match(appSource, /<dt>Goal<\/dt>/);
  assert.match(appSource, /<dt>Confirmed<\/dt>/);
  assert.match(appSource, /<dt>Awaiting confirmation<\/dt>/);
  assert.doesNotMatch(appSource, /<dt>In the fund<\/dt>/);
  assert.match(appSource, /% confirmed/);
  assert.match(appSource, /left to reach the goal/);
  assert.match(appSource, />Support this fund</);
  assert.doesNotMatch(appSource, /class="goal-details"/);
  assert.match(appSource, /community-fund-primary/);
  assert.match(appSource, /id="community-contribution-form"/);
  assert.doesNotMatch(appSource, /data-community-action="support"/);
  assert.match(appSource, /fund-contribution-amount/);
});

test("Community Fund persisted receipts render before wallet restoration and live reads", () => {
  assert.match(appSource, /loadPersistedCommunityActivity\(\)/);
  assert.match(appSource, /loadCommunityFundData\(\{ loadActivity: false \}\)/);
  assert.match(appSource, /document\.body\.classList\.remove\("wallet-session-loading"\);[\s\S]*renderCurrentPage\(\);[\s\S]*await walletPromise/);
  assert.match(appSource, /activityPromise/);
});

test("finalized contribution recovery uses durable exact receipt verification", () => {
  assert.match(appSource, /contributions\/verify/);
  assert.match(appSource, /action\.context\?\.daoId/);
  assert.match(appSource, /startedAtNs: action\.startedAtNs/);
  assert.match(appSource, /pendingActionStore\.remove\(action\.id\)/);
  assert.match(appSource, /addEventListener\("pageshow",[\s\S]*reconcilePendingActions\(\)/);
  assert.match(appSource, /configuredContributionFund\(appConfig\.communityFunds/);
  assert.match(appSource, /onMatchingFundPage/);
  assert.doesNotMatch(appSource, /expectedMinimum/);
});

test("manual pending checks always explain hashless, unavailable, or confirmed state", () => {
  assert.match(appSource, /async function checkPendingAction/);
  assert.match(appSource, /Meteor returned no hash/);
  assert.match(appSource, /one unambiguous finalized transaction/);
  assert.match(appSource, /data-pending-check-result/);
  assert.match(appSource, /On-chain verification could not finish:/);
  assert.match(appSource, /pendingActionStore\.remove\(action\.id\)/);
  assert.match(appSource, /data-pending-action-id/);
  assert.match(appSource, /waitForActionConfirmation[\s\S]*community_contribute_usdc[\s\S]*!action\.transactionHash[\s\S]*return readActionConfirmation\(action\)/);
  assert.match(appSource, /Paint the personal outcome immediately[\s\S]*renderCurrentPage\(\);[\s\S]*waitForActionConfirmation/);
});

test("Community Fund progress rendering never passes a BigInt to Math.floor", () => {
  assert.doesNotMatch(appSource, /Math\.floor\(\(BigInt\(/);
  assert.match(appSource, /communityProgressPercent/);
});

test("contribution review names the exact asset, network, recipient, and no-refund boundary", () => {
  assert.match(appSource, /Review Community Goal contribution/);
  assert.match(appSource, /USDC on NEAR Testnet/);
  assert.match(appSource, /The recipient treasury is/);
  assert.match(appSource, /Testnet only\. This public transfer goes to/);
  assert.match(appSource, /receiver,/);
  assert.match(appSource, /method,/);
  assert.match(appSource, /1 yoctoNEAR/);
  assert.match(appSource, /cannot be personally withdrawn or automatically refunded/);
});

test("Community Fund contribution uses persistent duplicate protection and authoritative confirmation", () => {
  assert.match(appSource, /performVerifiedAction\([\s\S]*community_contribute_usdc/);
  assert.match(appSource, /contributions\/verify/);
  assert.match(appSource, /persistTransactionHash/);
  assert.match(appSource, /confirmationAttempts: 30/);
});

test("Community Fund separates lifetime receipts from the current treasury balance", () => {
  assert.match(appSource, /verifiedContributionSubtotal/);
  assert.match(appSource, /Confirmed is never inferred from the current treasury balance/);
  assert.match(appSource, /Finalized token balance; distinct from lifetime raised/);
});

test("personal contribution status checks strict state without resubmitting", () => {
  assert.match(appSource, /function personalContributionMarkup/);
  assert.match(appSource, />Your contribution</);
  assert.match(appSource, /Checking your payment/);
  assert.match(appSource, /Meteor did not respond/);
  assert.match(appSource, /Wallet launch failed/);
  assert.doesNotMatch(appSource, /Outcome unresolved/);
  assert.match(appSource, /Check payment status/);
  assert.match(appSource, /Technical transaction details/);
  assert.match(appSource, /data-pending-action-id/);
  assert.match(appSource, /savePersonalContributionOutcome/);
  assert.match(appSource, /confirmedHashes[\s\S]*visiblePending/);
  assert.match(appSource, /trustworthy submission evidence/);
  assert.match(appSource, /included in the community awaiting total/);
  assert.match(appSource, /Previous contributions \(\$\{previousConfirmed\.length\}\)/);
  assert.match(appSource, /<button class="button button-primary" type="submit">Contribute<\/button>\$\{personalContribution\}/);
  assert.match(appSource, /startManualPaymentCheckCooldown\(actionButton, 5\)/);
  assert.match(appSource, /Check again in \$\{remaining\}s/);
});

test("contribution review uses the durable local summary instead of slow forced RPC fan-out", () => {
  assert.match(appSource, /Checking contribution total…/);
  assert.match(appSource, /const freshActivity = await fetchCommunityActivity\(false\)/);
  assert.doesNotMatch(appSource, /Refreshing fund totals…/);
  assert.match(appSource, /suppressToast: methodName === "community_contribute_usdc"/);
});

test("automatic contribution reconciliation continues after the initial confirmation window", () => {
  assert.match(appSource, /function scheduleCommunityReconciliation/);
  assert.match(appSource, /scheduleCommunityReconciliation\(remaining\)/);
  assert.match(appSource, /}, 5000\)/);
  assert.match(appSource, /fetchCommunityActivity\(false\)\.then/);
  assert.match(appSource, /wallet-unresponsive/);
  assert.match(appSource, /walletResponseTimedOut/);
});

test("goal review warns that known pending payments can overfund concurrently", () => {
  assert.match(appSource, /awaitingBeforeApproval/);
  assert.match(appSource, /Known pending payments plus this payment could exceed the goal/);
  assert.match(appSource, /cap is not enforced atomically/);
});

test("disconnected visitors get a wallet action and unsupported requests stay disabled", () => {
  assert.match(appSource, /Connect wallet to contribute or vote/);
  assert.match(directorySource, /Contributions, payment requests, and votes are disabled/);
  assert.match(directorySource, /Individual fund treasuries and broader member governance are planned for a future release/);
});
