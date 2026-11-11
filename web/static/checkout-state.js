(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HarvestPoolCheckoutState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function commitmentFor(purchase, accountId) {
    if (!purchase || !accountId) return null;
    return (purchase.commitments || []).find((commitment) => String(commitment.account_id) === String(accountId)) || null;
  }

  function resolve({ purchase, accountId, pending = false, phase = null }) {
    const commitment = commitmentFor(purchase, accountId);
    if (commitment?.state === "Active") return { kind: "confirmed", commitment };
    if (pending || ["wallet", "awaiting"].includes(phase?.kind)) return { kind: "confirming", commitment };
    if (["failed", "wallet-rejected", "full"].includes(phase?.kind)) return { kind: phase.kind, commitment };
    return { kind: "ready", commitment };
  }

  return { commitmentFor, resolve };
});
