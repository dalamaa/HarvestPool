/* Pure eligibility rules for account-specific actions. Contract reads remain authoritative. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HarvestPoolActionCenter = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function commitmentFor(purchase, accountId) {
    return (purchase?.commitments || []).find((item) => String(item.account_id) === String(accountId)) || null;
  }

  function issueForDecision(decision, issues = []) {
    return issues.find((issue) => String(issue.id) === String(decision?.issue_id)) || null;
  }

  function eligibleTasks({ accountId, purchases = [], issues = [], decisions = [], votes = new Map(), pending = [], isMember = false }) {
    if (!accountId) return [];
    const tasks = [];
    purchases.forEach((purchase) => {
      const commitment = commitmentFor(purchase, accountId);
      const funded = commitment?.state === "Active";
      const supplierId = purchase.supplier_id || purchase.farmer_id;
      if (purchase.state === "AwaitingSupplier" && String(supplierId) === String(accountId)) {
        tasks.push({ id: `invitation-${purchase.id}`, kind: "supplier-invitation", purchaseId: String(purchase.id) });
      }
      if (purchase.state === "Proposed" && isMember && !votes.get(`offer:${purchase.id}`)) {
        tasks.push({ id: `offer-${purchase.id}`, kind: "offer-vote", purchaseId: String(purchase.id) });
      }
      if (purchase.state === "FulfillmentPending" && funded && !votes.get(`fulfillment:${purchase.id}`)) {
        tasks.push({ id: `fulfillment-${purchase.id}`, kind: "fulfillment-vote", purchaseId: String(purchase.id) });
      }
      if (commitment?.state === "Refundable") {
        tasks.push({ id: `refund-${purchase.id}`, kind: "refund", purchaseId: String(purchase.id), amount: commitment.amount });
      }
    });
    decisions.forEach((decision) => {
      const recorded = (decision.votes || []).some((vote) => String(vote.voter) === String(accountId));
      const eligible = (decision.eligible_voters || []).some((voter) => String(voter) === String(accountId));
      const issue = issueForDecision(decision, issues);
      const purchaseId = String(decision.purchase_id ?? issue?.purchase_id ?? "");
      if (decision.state === "Open" && eligible && !recorded) {
        tasks.push({ id: `community-${decision.id}`, kind: "community-vote", purchaseId, decisionId: String(decision.id), issueId: String(decision.issue_id) });
      }
      if (decision.state === "AwaitingSupplier" && decision.requires_supplier_consent
          && String(decision.supplier_id) === String(accountId)) {
        tasks.push({ id: `supplier-${decision.id}`, kind: "supplier-consent", purchaseId, decisionId: String(decision.id), issueId: String(decision.issue_id) });
      }
    });
    pending.filter((action) => String(action.signerId) === String(accountId)).forEach((action) => {
      const purchaseId = String(action.context?.purchaseId ?? action.args?.purchase_id ?? "");
      const supersededId = action.methodName === "claim_refund" ? `refund-${purchaseId}`
        : ["accept_supplier_request", "decline_supplier_request"].includes(action.methodName) ? `invitation-${purchaseId}`
        : action.methodName === "vote_on_fulfillment" ? `fulfillment-${purchaseId}`
          : action.methodName === "vote_on_offer" ? `offer-${purchaseId}`
            : action.methodName === "vote_on_decision" ? `community-${action.args?.decision_id}`
              : ["agree_to_decision", "decline_decision"].includes(action.methodName) ? `supplier-${action.args?.decision_id}`
                : null;
      if (supersededId) {
        const index = tasks.findIndex((task) => task.id === supersededId);
        if (index >= 0) tasks.splice(index, 1);
      }
      tasks.push({
        id: `pending-${action.id}`,
        kind: "pending-transaction",
        purchaseId,
        methodName: action.methodName,
      });
    });
    return tasks;
  }

  return { commitmentFor, eligibleTasks, issueForDecision };
}));
