(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HarvestPoolCommunityDirectory = factory();
}(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  function matchesFilter(fund, filter) {
    if (filter === "open") return fund?.status === "Open for Contributions";
    if (filter === "vote") return fund?.needsVote === true;
    if (filter === "completed") return fund?.status === "Completed";
    if (filter === "mine") return fund?.isMine === true;
    return filter === "all";
  }

  return { matchesFilter };
}));
