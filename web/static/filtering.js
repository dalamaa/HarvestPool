(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.HarvestPoolFiltering = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const IN_PROGRESS_STATUSES = new Set([
    "funded",
    "fulfillmentpending",
    "fulfillmentapproved",
    "paymentpending",
  ]);
  const FINAL_STATUSES = new Set(["completed", "failed", "declined"]);
  const FINALIZATION_ELIGIBLE_STATUSES = new Set(["open", "awaitingsupplier"]);

  function normalizeFilter(value) {
    return String(value || "all").trim().toLowerCase();
  }

  function purchaseStatus(purchase) {
    return normalizeFilter(purchase && purchase.state);
  }

  function joinDeadline(purchase) {
    return purchase?.join_deadline_ns ?? purchase?.deadline_ns;
  }

  function deadlineHasPassed(purchase, nowNs) {
    const deadline = joinDeadline(purchase);
    if (deadline === null || deadline === undefined || String(deadline).trim() === "") return false;
    try {
      const now = nowNs === undefined ? BigInt(Date.now()) * 1000000n : BigInt(String(nowNs));
      return now >= BigInt(String(deadline));
    } catch (_error) {
      return false;
    }
  }

  function hasSupplierApproval(purchase) {
    return Boolean(purchase && (
      purchase.supplier_agreement
      || purchase.supplier_approved === true
      || purchase.supplierApproved === true
    ));
  }

  function hasExplicitPublicListing(purchase) {
    return Boolean(purchase && (
      purchase.public_marketplace === true
      || purchase.public_listing === true
      || purchase.is_public === true
    ));
  }

  function isPublicMarketplaceDeal(purchase) {
    // AwaitingSupplier is an organizer/supplier proposal. It is not a public
    // marketplace record unless the contract explicitly marks it public.
    return purchaseStatus(purchase) !== "awaitingsupplier" || hasExplicitPublicListing(purchase);
  }

  function hasRemainingCapacity(purchase) {
    const maxQuantity = Number(purchase?.max_quantity);
    const totalQuantity = Number(purchase?.total_quantity);
    if (Number.isFinite(maxQuantity) && Number.isFinite(totalQuantity) && maxQuantity > 0 && totalQuantity >= maxQuantity) {
      return false;
    }
    const availableSlots = Number(purchase?.available_funded_member_slots);
    if (Number.isFinite(availableSlots) && availableSlots <= 0) return false;
    const maxMembers = Number(purchase?.max_funded_members);
    const fundedMembers = Number(purchase?.funded_member_count);
    if (Number.isFinite(maxMembers) && Number.isFinite(fundedMembers) && maxMembers > 0 && fundedMembers >= maxMembers) {
      return false;
    }
    return true;
  }

  function isAvailable(purchase, options = {}) {
    return purchaseStatus(purchase) === "open"
      && hasSupplierApproval(purchase)
      && joinDeadline(purchase) !== null
      && joinDeadline(purchase) !== undefined
      && String(joinDeadline(purchase)).trim() !== ""
      && !deadlineHasPassed(purchase, options.nowNs)
      && hasRemainingCapacity(purchase);
  }

  function isClosed(purchase, options = {}) {
    const status = purchaseStatus(purchase);
    return FINAL_STATUSES.has(status)
      || (FINALIZATION_ELIGIBLE_STATUSES.has(status) && deadlineHasPassed(purchase, options.nowNs));
  }

  function marketplaceCategory(purchase, options = {}) {
    if (!isPublicMarketplaceDeal(purchase)) return null;
    if (isAvailable(purchase, options)) return "available";
    if (IN_PROGRESS_STATUSES.has(purchaseStatus(purchase))) return "in-progress";
    if (isClosed(purchase, options)) return "closed";
    return null;
  }

  function purchaseMatchesFilter(purchase, filter, options = {}) {
    const normalizedFilter = normalizeFilter(filter);
    if (normalizedFilter === "all") return isPublicMarketplaceDeal(purchase);
    return marketplaceCategory(purchase, options) === normalizedFilter;
  }

  function filterPurchases(purchases, filter, options = {}) {
    return (Array.isArray(purchases) ? purchases : []).filter((purchase) => (
      purchaseMatchesFilter(purchase, filter, options)
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
    deadlineHasPassed,
    filterPurchases,
    isAvailable,
    isClosed,
    isPublicMarketplaceDeal,
    marketplaceCategory,
    normalizeFilter,
    purchaseMatchesFilter,
    purchaseStatus,
  };
});
