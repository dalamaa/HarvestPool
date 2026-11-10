/* Exact native-USDC helpers. Values stay decimal strings/BigInt; JavaScript Number is never used for money. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HarvestPoolUsdc = factory();
}(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  function parseUnits(value, decimals = 6) {
    const normalized = String(value ?? "").trim();
    if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
    const [whole, fraction = ""] = normalized.split(".");
    if (fraction.length > decimals) return null;
    return (BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fraction.padEnd(decimals, "0") || "0")).toString();
  }

  function formatUnits(value, decimals = 6) {
    try {
      const scale = 10n ** BigInt(decimals);
      const raw = BigInt(String(value));
      const fraction = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
      return fraction ? `${raw / scale}.${fraction}` : String(raw / scale);
    } catch (_error) { return "—"; }
  }

  function contributionMessage(purchaseId, quantity) {
    return JSON.stringify({ v: 1, action: "commit", purchase_id: String(purchaseId), quantity: Number(quantity) });
  }

  function transferCall({ receiverId, purchaseId, quantity, amount }) {
    return {
      receiver_id: String(receiverId),
      amount: String(amount),
      memo: `HarvestPool V5 purchase ${purchaseId}`,
      msg: contributionMessage(purchaseId, quantity),
    };
  }

  return { contributionMessage, formatUnits, parseUnits, transferCall };
}));
