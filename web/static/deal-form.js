/* Shared form language for product units. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HarvestPoolDealForm = factory();
}(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const PACKAGED_UNITS = new Set(["basket", "box", "bag", "pack", "crate", "carton", "sack", "bundle", "bunch"]);
  const ABBREVIATIONS = new Set(["lb", "kg", "L", "dozen"]);

  function selectedUnit(value, customValue = "") {
    const selected = String(value || "unit").trim();
    return selected === "custom" ? String(customValue || "unit").trim() || "unit" : selected;
  }

  function pluralUnit(value, count = 2) {
    const unit = String(value || "unit").trim();
    if (Number(count) === 1 || ABBREVIATIONS.has(unit)) return unit;
    if (/[^aeiou]y$/i.test(unit)) return `${unit.slice(0, -1)}ies`;
    if (/(s|x|z|ch|sh)$/i.test(unit)) return `${unit}es`;
    return unit.endsWith("s") ? unit : `${unit}s`;
  }

  function labels(value, customValue = "") {
    const singular = selectedUnit(value, customValue);
    const plural = pluralUnit(singular);
    return {
      singular,
      plural,
      price: `Price per ${singular} ($)`,
      minimum: `Minimum ${plural} needed`,
      maximum: `Total ${plural} available`,
      perBuyer: `Maximum ${plural} per buyer`,
      contents: `What does each ${singular} contain?`,
    };
  }

  function supportsPackageContents(value) {
    return PACKAGED_UNITS.has(String(value || "")) || value === "custom";
  }

  return { labels, pluralUnit, selectedUnit, supportsPackageContents };
}));
