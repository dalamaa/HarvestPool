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

  function formatDollars(value, decimals = 6) {
    const formatted = formatUnits(value, decimals);
    if (formatted === "—") return "$—";
    const [whole, fraction = ""] = formatted.split(".");
    const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const visibleFraction = fraction.length > 2 ? fraction : fraction.padEnd(2, "0");
    return `$${groupedWhole}.${visibleFraction}`;
  }

  function paymentAsset(version, tokenDecimals = 6) {
    const isUsdc = String(version || "").toUpperCase() === "V5";
    return isUsdc
      ? { symbol: "USDC", displayName: "Native Testnet USDC", decimals: Number(tokenDecimals) }
      : { symbol: "NEAR", displayName: "Native Testnet NEAR", decimals: 24 };
  }

  function formatPayment(value, version, tokenDecimals = 6) {
    const asset = paymentAsset(version, tokenDecimals);
    return `${formatUnits(value, asset.decimals)} ${asset.symbol === "NEAR" ? "Testnet NEAR" : asset.symbol}`;
  }

  function usdPrice(value, tokenDecimals = 6) {
    const decimals = Number(tokenDecimals);
    if (!Number.isInteger(decimals) || decimals < 2) return null;
    const cents = parseUnits(value, 2);
    if (cents === null || BigInt(cents) <= 0n) return null;
    return {
      cents,
      tokenUnits: (BigInt(cents) * (10n ** BigInt(decimals - 2))).toString(),
    };
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

  function reconciliationSnapshot(accounting, balance, liability, checkedAtMs = Date.now(), maxAgeMs = 300_000) {
    const observed = String(accounting?.last_observed_token_balance ?? "");
    const reconciledLiability = String(accounting?.last_reconciled_liability ?? "");
    const expectedBalance = String(balance ?? "");
    const expectedLiability = String(liability ?? "");
    const matches = accounting?.reconciliation_status === "balanced"
      && observed === expectedBalance
      && reconciledLiability === expectedLiability;
    let reconciledAtMs = null;
    try {
      const raw = BigInt(String(accounting?.last_reconciled_at_ns ?? ""));
      reconciledAtMs = Number(raw / 1_000_000n);
    } catch (_error) {
      reconciledAtMs = null;
    }
    const ageMs = reconciledAtMs === null ? null : Number(checkedAtMs) - reconciledAtMs;
    const fresh = ageMs !== null && ageMs >= -60_000 && ageMs <= Number(maxAgeMs);
    return { matches, fresh, ready: matches && fresh, reconciledAtMs, ageMs };
  }

  return { contributionMessage, formatDollars, formatPayment, formatUnits, parseUnits, paymentAsset, reconciliationSnapshot, transferCall, usdPrice };
}));
