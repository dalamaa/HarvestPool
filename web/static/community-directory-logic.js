(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./community-fundraising.js"));
  else root.HarvestPoolCommunityDirectory = factory(root.HarvestPoolCommunityFundraising);
}(typeof self !== "undefined" ? self : globalThis, function (fundraising) {
  "use strict";

  if (!fundraising) throw new Error("HarvestPool Community Fundraising helpers did not load.");

  function accountSet(values) {
    return new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean));
  }

  function matchesFilter(fund, filter, context = {}) {
    const accountId = String(context.accountId || "").trim();
    if (filter === "open") return fundraising.stage(fund?.raisedUnits, fund?.targetUnits) === "open";
    if (filter === "vote") return Boolean(accountId)
      && fund?.needsVote === true
      && accountSet(fund.voteEligibleAccountIds).has(accountId);
    if (filter === "completed") return fundraising.stage(fund?.raisedUnits, fund?.targetUnits) === "completed";
    if (filter === "mine") return fund?.isMine === true || (Boolean(accountId) && (
      accountSet(fund?.verifiedContributorIds).has(accountId)
      || accountSet(fund?.verifiedMemberIds).has(accountId)
    ));
    return filter === "all";
  }

  function progressPercent(raisedUnits, targetUnits) {
    return fundraising.progressPercent(raisedUnits, targetUnits);
  }

  function progressLabel(value) {
    if (!Number.isFinite(value)) return "Verification pending";
    return `${value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}% funded`;
  }

  function verifiedContributors(contributions) {
    return [...accountSet((contributions || []).map((item) => item?.contributor || item?.account))];
  }

  return {
    fundraisingStage: fundraising.stage,
    fundraisingStatus: fundraising.status,
    matchesFilter,
    progressLabel,
    progressPercent,
    verifiedContributors,
  };
}));
