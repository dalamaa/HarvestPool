const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const templateSource = fs.readFileSync(path.join(__dirname, "..", "templates", "index.html"), "utf8");

test("all important forms enter the shared guard before asynchronous work", () => {
  assert.match(appSource, /runGuardedSubmission\(event\.currentTarget, \(\) => handleCreate/);
  assert.match(appSource, /runGuardedSubmission\(event\.target, \(\) => handleEvidence/);
  assert.match(appSource, /runGuardedSubmission\(event\.target, \(\) => handleRaiseIssue/);
  assert.match(appSource, /runGuardedSubmission\(event\.target, \(\) => handleRequestDecision/);
});

test("all wallet-action buttons use the shared guarded dispatcher", () => {
  for (const action of [
    "contribute", "vote", "finalize", "claim-refund", "reconcile-escrow", "release-payment",
    "decision-vote", "agree-decision",
  ]) {
    assert.match(appSource, new RegExp(action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(appSource, /GUARDED_TRANSACTION_ACTIONS\.has\(action\)/);
  assert.match(appSource, /runGuardedSubmission\(actionButton, \(\) => dispatchGuardedTransaction/);
});

test("confirmed issue replaces the form with durable success details and next action", () => {
  assert.match(appSource, /Your issue has been submitted!/);
  assert.match(appSource, /Issue subject<\/dt>/);
  assert.match(appSource, /Issue ID<\/dt>/);
  assert.match(appSource, /Current issue status<\/dt>/);
  assert.match(appSource, /Submitted by<\/dt>/);
  assert.match(appSource, />Request Group Vote<\/a>/);
  assert.match(appSource, /state\.confirmedIssueId = String\(issue\.id\)/);
});

test("lost callbacks and refresh recovery retain the pending lock and reconcile authoritative state", () => {
  assert.match(appSource, /captureWalletCallbackHash\(\)/);
  assert.match(appSource, /pendingForWalletCallback\(pending\)/);
  assert.match(appSource, /affectedPurchaseIds/);
  assert.match(appSource, /action\.methodName === "raise_issue".*state\.confirmedIssueId/s);
  assert.match(appSource, /We haven't confirmed the result yet\. Please don't submit again while we check\./);
});

test("ordinary wallet and callback confirmation do not show an unknown-outcome warning", () => {
  assert.match(appSource, /phase: "wallet"/);
  assert.match(appSource, /phase: "confirming"/);
  assert.match(appSource, /phase: "unresolved"/);
  assert.match(appSource, /Your request was submitted\. Confirming the authoritative contract state and callbacks/);
});

test("a lost Meteor promise cannot prevent authoritative polling", () => {
  assert.match(appSource, /waitForWalletResult/);
  assert.match(appSource, /WALLET_RESULT_TIMEOUT_MS/);
  assert.match(appSource, /walletWait\.state === "pending"/);
  assert.match(appSource, /if \(!outcome && transactionError\?\.transactionState !== "pending"\)/);
});

test("a pending action reloads safely when a newer transaction bundle is served", () => {
  assert.match(appSource, /TRANSACTION_BUNDLE_VERSION/);
  assert.match(appSource, /recoverIfTransactionBundleChanged/);
  assert.match(appSource, /window\.location\.reload\(\)/);
  assert.match(appSource, /pendingActionStore\.list\(state\.accountId\)\.length/);
});

test("reconciliation recovery accepts only a matching callback snapshot newer than the action", () => {
  assert.match(appSource, /startedAtNs/);
  assert.match(appSource, /const valuesMatch/);
  assert.match(appSource, /changedFromBaseline \|\| newerThanAction/);
});

test("shared recovery reloads affected purchase context without an out-of-scope loop variable", () => {
  assert.match(appSource, /const affectedPurchaseIds = new Set\(\)/);
  assert.match(appSource, /const purchaseId = \[\.\.\.affectedPurchaseIds\]\[0\]/);
  assert.doesNotMatch(appSource, /const purchaseId = action\.context\?\.purchaseId \?\? state\.currentPurchase/);
});

test("submit and discard controls stay disabled while a transaction is unresolved", () => {
  assert.match(appSource, /function setTransactionSurfaceBusy/);
  assert.match(appSource, /setTransactionSurfaceBusy\(surface, true\)/);
  assert.match(appSource, /setTransactionSurfaceBusy\(surface, keepLocked\)/);
});

test("authoritative recovery clears only the draft attached to the confirmed action", () => {
  assert.match(appSource, /const reference = draftReference\(button\)/);
  assert.match(appSource, /\.\.\.\(reference \? \{ draft: reference \} : \{\}\)/);
  assert.match(appSource, /result\?\.state === "confirmed"[\s\S]*clearDraftReference\(action\.context\?\.draft\)/);
  assert.doesNotMatch(appSource, /localStorage\.clear\(/);
});

test("financial operations are absent from public deal rendering and owner-gated in management", () => {
  assert.match(appSource, /Contract-wide escrow controls intentionally stay off public purchase pages/);
  assert.match(appSource, /state\.config\?\.owner_id/);
  assert.match(appSource, /data-action="open-financial-operations"/);
});

test("native confirmation popups are replaced by the application review dialog", () => {
  assert.doesNotMatch(appSource, /window\.confirm\(/);
  assert.match(appSource, /title: `Finalize Deal/);
  assert.match(appSource, /title: `Submit Testnet evidence/);
});

test("expired open deals are presented as awaiting finalization and cannot render a join action", () => {
  assert.match(appSource, /function presentationState\(purchase\)/);
  assert.match(appSource, /DeadlinePassed:\s*"Closed · final result pending"/);
  assert.match(appSource, /const canJoin = !alreadyJoined && purchase\.state === "Open" && !deadlineHasPassed/);
  assert.match(appSource, /verifyContributionEligibility[\s\S]*if \(deadlineHasPassed\(purchase\.deadline_ns\)\) throw/);
});

test("failed deals preserve participant counts and expose eligible refund actions", () => {
  assert.match(appSource, /function participantCount\(purchase\)/);
  assert.match(appSource, /function failureReason\(purchase\)/);
  assert.match(appSource, /commitment\.state === "Refundable"/);
  assert.match(appSource, /Claim refund/);
});

test("transaction phases distinguish Meteor handoff, submission, and confirmation", () => {
  assert.match(appSource, /Sending this action through Meteor/);
  assert.match(appSource, /matching limited Testnet permission/);
  assert.match(appSource, /without opening (?:a new|another) popup/);
  assert.doesNotMatch(appSource, /Approve this action in your wallet\./);
  assert.match(appSource, /Your request was submitted\./);
  assert.match(appSource, /Confirming your request against authoritative contract state\./);
});

test("reconciliation has a durable success state and a complete pre-wallet review", () => {
  assert.match(appSource, /Escrow reconciliation successful/);
  assert.match(appSource, /Observed balance:/);
  assert.match(appSource, /Next action: review supplier payment/);
  assert.match(appSource, /const successMarkup = reconciliation\.matches/);
  assert.match(appSource, /Post-payment escrow is recorded at zero balance and zero liability/);
  assert.match(appSource, /title: `Reconcile Deal #\$\{freshPurchase\.id\} escrow`/);
  assert.match(appSource, /method: "reconcile_token_balance"/);
  assert.match(appSource, /gas: "50 Tgas \(50000000000000 gas\)"/);
  assert.match(templateSource, /data-review-field="signer"/);
  assert.match(templateSource, /data-review-field="receiver"/);
  assert.match(templateSource, /data-review-field="arguments"/);
});

test("payment remains blocked for missing, stale, mismatched, or unresolved reconciliation", () => {
  assert.match(appSource, /reconciliationSnapshot\(/);
  assert.match(appSource, /RECONCILIATION_MAX_AGE_MS/);
  assert.match(appSource, /pendingFinancialAction/);
  assert.match(appSource, /await loadFinancialReadiness\(freshPurchase\)/);
  assert.match(appSource, /await loadFinancialReadiness\(finalPurchase\)/);
  assert.match(appSource, /if \(!payoutSafetyState\(finalPurchase, finalReadiness\)\.safe\)/);
});

test("financial success waits for the outbound callback operation, not only purchase state", () => {
  assert.match(appSource, /item\.kind === "SupplierPayment"/);
  assert.match(appSource, /purchase\?\.state === "Completed" && operation\?\.state === "Succeeded"/);
  assert.match(appSource, /item\.kind === "Refund"/);
  assert.match(appSource, /commitment\?\.state === "Refunded" && operation\?\.state === "Succeeded"/);
});

test("reconciliation refresh recovery reloads the affected purchase from pending context", () => {
  assert.match(appSource, /context: \{ previousReconciledAt:.*purchaseId: String\(freshPurchase\.id\)/s);
  assert.match(appSource, /action\.context\?\.purchaseId \?\?/);
  assert.match(appSource, /await refreshLiveData\(\{ force: true \}\)/);
});
