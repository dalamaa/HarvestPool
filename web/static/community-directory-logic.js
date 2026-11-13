(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HarvestPoolCommunityDirectory = factory();
}(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  function accountSet(values) {
    return new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean));
  }

  function matchesFilter(fund, filter, context = {}) {
    const accountId = String(context.accountId || "").trim();
    if (filter === "open") return ["Open for contributions", "Open for Contributions"].includes(fund?.status);
    if (filter === "vote") return Boolean(accountId)
      && fund?.needsVote === true
      && accountSet(fund.voteEligibleAccountIds).has(accountId);
    if (filter === "completed") return fund?.status === "Completed";
    if (filter === "mine") return fund?.isMine === true || (Boolean(accountId) && (
      accountSet(fund?.verifiedContributorIds).has(accountId)
      || accountSet(fund?.verifiedMemberIds).has(accountId)
    ));
    return filter === "all";
  }

  function progressPercent(raisedUnits, targetUnits) {
    if (!/^\d+$/.test(String(raisedUnits ?? "")) || !/^\d+$/.test(String(targetUnits ?? ""))) return null;
    const raised = BigInt(String(raisedUnits));
    const target = BigInt(String(targetUnits));
    if (target <= 0n) return null;
    const hundredths = raised >= target ? 10_000n : (raised * 10_000n) / target;
    return Number(hundredths) / 100;
  }

  function progressLabel(value) {
    if (!Number.isFinite(value)) return "Verification pending";
    return `${value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}% funded`;
  }

  function verifiedContributors(contributions) {
    return [...accountSet((contributions || []).map((item) => item?.contributor || item?.account))];
  }

  return { matchesFilter, progressLabel, progressPercent, verifiedContributors };
}));
