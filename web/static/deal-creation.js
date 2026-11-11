/* Role-specific creation behavior shared by the form and wallet authorization flow. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HarvestPoolDealCreation = factory();
}(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const MODES = Object.freeze({
    supplier_offer: Object.freeze({
      value: "supplier_offer",
      cta: "Publish Group Deal",
      methodName: "create_supplier_offer",
      help: "Publish only when the connected wallet belongs to the named supplier.",
      review: "Review the complete terms before publishing them as the supplier.",
      progress: "Publishing your Group Deal…",
      success: "Your Group Deal is live!",
      connected: "Wallet connected. This Group Deal has not been published. Review the restored terms, then choose Publish Group Deal again to request wallet authorization.",
    }),
    organizer_request: Object.freeze({
      value: "organizer_request",
      cta: "Send Request to Supplier",
      methodName: "create_purchase_request",
      help: "The supplier must accept these terms before customers can join.",
      review: "Review the complete terms before sending them to the supplier.",
      progress: "Sending your request to the supplier…",
      success: "Your request was sent to the supplier.",
      connected: "Wallet connected. No supplier request has been sent. Review the restored terms, then choose Send Request to Supplier again to request wallet authorization.",
    }),
  });

  function mode(value) {
    return MODES[value] || MODES.organizer_request;
  }

  function transaction(value, terms, supplierId, connectedAccountId) {
    const selected = mode(value);
    const supplier = String(supplierId || "").trim();
    const signer = String(connectedAccountId || "").trim();
    if (selected.value === "supplier_offer") {
      if (!signer || supplier !== signer) {
        throw new Error("Supplier mode must use the connected supplier wallet named in the deal.");
      }
      return { methodName: selected.methodName, args: { terms } };
    }
    return { methodName: selected.methodName, args: { supplier_id: supplier, terms } };
  }

  function validateDeadlines(joinDeadlineNs, fulfillmentDeadlineNs, nowMs = Date.now()) {
    const join = BigInt(String(joinDeadlineNs));
    const fulfillment = BigInt(String(fulfillmentDeadlineNs));
    const minimumLead = BigInt(Math.trunc(Number(nowMs))) * 1000000n + 5n * 60n * 1000000000n;
    if (join <= minimumLead) {
      throw new Error("Choose a last day to join at least five minutes in the future.");
    }
    if (fulfillment <= join) {
      throw new Error("Fulfillment must be after the last day to join.");
    }
    return true;
  }

  const CONNECTION_INTENT_KEY = "harvestpool:create-connect-intent:v1";

  function markConnectionIntent(storage, value) {
    if (!storage || typeof storage.setItem !== "function") return false;
    try {
      storage.setItem(CONNECTION_INTENT_KEY, JSON.stringify({ version: 1, mode: mode(value).value }));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function consumeConnectionIntent(storage) {
    if (!storage || typeof storage.getItem !== "function") return null;
    try {
      const raw = storage.getItem(CONNECTION_INTENT_KEY);
      if (!raw) return null;
      storage.removeItem(CONNECTION_INTENT_KEY);
      const parsed = JSON.parse(raw);
      return parsed?.version === 1 ? mode(parsed.mode) : null;
    } catch (_error) {
      try { storage.removeItem(CONNECTION_INTENT_KEY); } catch (_ignored) { /* no-op */ }
      return null;
    }
  }

  return { CONNECTION_INTENT_KEY, MODES, consumeConnectionIntent, markConnectionIntent, mode, transaction, validateDeadlines };
}));
