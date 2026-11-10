(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.HarvestPoolFiltering = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const FUNDED_STATUSES = new Set([
    "funded",
    "fulfillmentpending",
    "fulfillmentapproved",
    "paymentpending",
  ]);

  function normalizeFilter(value) {
    return String(value || "all").trim().toLowerCase();
  }

  function purchaseStatus(purchase) {
    return normalizeFilter(purchase && purchase.state);
  }

  function purchaseMatchesFilter(purchase, filter) {
    const normalizedFilter = normalizeFilter(filter);
    if (normalizedFilter === "all") return true;
    if (normalizedFilter === "live") return true;
    if (normalizedFilter === "open") return purchaseStatus(purchase) === "open";
    if (normalizedFilter === "funded") return FUNDED_STATUSES.has(purchaseStatus(purchase));
    if (normalizedFilter === "completed") return purchaseStatus(purchase) === "completed";
    return false;
  }

  function filterPurchases(purchases, filter) {
    return (Array.isArray(purchases) ? purchases : []).filter((purchase) => (
      purchaseMatchesFilter(purchase, filter)
    ));
  }

  function contributionEligibility(purchase, options = {}) {
    const accountId = String(options.accountId || "");
    const activeCommitment = options.commitment && options.commitment.state === "Active";
    const hasCommitment = Boolean(options.commitment);
    const openMembership = purchase && purchase.open_membership === true;
    const member = Boolean(options.member);
    const stateIsOpen = purchase && purchase.state === "Open";
    const availableUnits = Math.max(0, Number(purchase?.max_quantity || 0) - Number(purchase?.total_quantity || 0));
    const fundedMemberCount = Number.isFinite(Number(purchase?.funded_member_count))
      ? Number(purchase.funded_member_count)
      : (Array.isArray(purchase?.commitments)
        ? purchase.commitments.filter((commitment) => commitment.state === "Active").length
        : 0);
    const maxFundedMembers = Number(purchase?.max_funded_members || options.memberCount || 0);
    const availableFundedMemberSlots = Math.max(0, maxFundedMembers - fundedMemberCount);
    const eligibleBeforeAgreement = Boolean(
      accountId
      && (openMembership || member)
      && stateIsOpen
      && availableUnits > 0
      && availableFundedMemberSlots > 0
      && !hasCommitment,
    );

    return {
      availableUnits,
      availableFundedMemberSlots,
      eligibleBeforeAgreement,
      eligible: Boolean(eligibleBeforeAgreement && options.agreementAccepted === true),
      activeCommitment: Boolean(activeCommitment),
    };
  }

  return {
    contributionEligibility,
    filterPurchases,
    normalizeFilter,
    purchaseMatchesFilter,
    purchaseStatus,
  };
});
