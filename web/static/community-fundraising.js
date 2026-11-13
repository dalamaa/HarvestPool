/* Shared Community Fund fundraising-stage rules. Treasury spending is intentionally excluded. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HarvestPoolCommunityFundraising = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function stage(confirmedUnits, targetUnits) {
    if (!/^\d+$/.test(String(confirmedUnits ?? "")) || !/^\d+$/.test(String(targetUnits ?? ""))) return "unknown";
    const target = BigInt(String(targetUnits));
    if (target <= 0n) return "unknown";
    return BigInt(String(confirmedUnits)) >= target ? "completed" : "open";
  }

  function status(confirmedUnits, targetUnits) {
    const value = stage(confirmedUnits, targetUnits);
    if (value === "completed") return "Goal reached";
    if (value === "open") return "Open for contributions";
    return "Verification pending";
  }

  function progressPercent(confirmedUnits, targetUnits) {
    const value = stage(confirmedUnits, targetUnits);
    if (value === "unknown") return null;
    const confirmed = BigInt(String(confirmedUnits));
    const target = BigInt(String(targetUnits));
    const hundredths = confirmed >= target ? 10_000n : (confirmed * 10_000n) / target;
    return Number(hundredths) / 100;
  }

  return { progressPercent, stage, status };
}));
