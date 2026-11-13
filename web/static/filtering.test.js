const test = require("node:test");
const assert = require("node:assert/strict");

const {
  contributionEligibility,
  dashboardCategory,
  marketplaceCategory,
  filterPurchases,
} = require("./filtering.js");

test("dashboard categories preserve exact states while grouping local filters", () => {
  assert.equal(dashboardCategory({ state: "Open", deadline_ns: "3000000000" }, { nowNs: NOW_NS }), "active");
  assert.equal(dashboardCategory({ state: "Funded" }, { nowNs: NOW_NS }), "active");
  assert.equal(dashboardCategory({ state: "Completed" }, { nowNs: NOW_NS }), "completed");
  assert.equal(dashboardCategory({ state: "Failed" }, { nowNs: NOW_NS }), "unsuccessful");
  assert.equal(dashboardCategory({ state: "Open", deadline_ns: "1000000000" }, { nowNs: NOW_NS }), "unsuccessful");
});

const NOW_NS = "2000000000";
const purchases = [
  { id: "101", source: "live", state: "Open", supplier_agreement: { accepted_at_block_height: "1" }, join_deadline_ns: "3000000000", max_quantity: 10, total_quantity: 0, available_funded_member_slots: 5 },
  { id: "102", source: "live", state: "AwaitingSupplier", join_deadline_ns: "3000000000" },
  { id: "103", source: "live", state: "Funded" },
  { id: "104", source: "live", state: "Completed" },
  { id: "105", source: "live", state: "Failed" },
  { id: "106", source: "live", state: "Open", supplier_agreement: { accepted_at_block_height: "2" }, join_deadline_ns: "1000000000" },
  { id: "107", source: "live", state: "AwaitingSupplier", join_deadline_ns: "1000000000" },
];

function idsFor(filter, options = { nowNs: NOW_NS }) {
  return filterPurchases(purchases, filter, options).map((purchase) => (
    purchase.slug || purchase.id
  ));
}

test("marketplace filters separate available, in-progress, closed, and all", () => {
  assert.deepEqual(idsFor("available"), ["101"]);
  assert.deepEqual(idsFor("in-progress"), ["103"]);
  assert.deepEqual(idsFor("closed"), ["104", "105", "106"]);
  assert.deepEqual(idsFor("all"), ["101", "103", "104", "105", "106"]);
  assert.deepEqual(idsFor("open"), []);
  assert.deepEqual(idsFor("live"), []);
});

test("repeated marketplace tab switches stay deterministic and do not duplicate cards", () => {
  const expected = {
    available: ["101"],
    "in-progress": ["103"],
    closed: ["104", "105", "106"],
    all: ["101", "103", "104", "105", "106"],
  };
  const sequence = ["available", "in-progress", "closed", "all", "available", "closed"];

  sequence.forEach((filter) => {
    const result = idsFor(filter);
    assert.deepEqual(result, expected[filter]);
    assert.equal(new Set(result).size, result.length);
  });
});

test("available honors the exact join deadline boundary", () => {
  const deal = {
    state: "Open",
    supplier_agreement: { accepted_at_block_height: "1" },
    join_deadline_ns: NOW_NS,
  };
  assert.equal(marketplaceCategory({ ...deal, join_deadline_ns: "2000000001" }, { nowNs: NOW_NS }), "available");
  assert.equal(marketplaceCategory(deal, { nowNs: NOW_NS }), "closed");
  assert.equal(marketplaceCategory({ ...deal, join_deadline_ns: "1999999999" }, { nowNs: NOW_NS }), "closed");
});

test("pending supplier approval never appears under Available", () => {
  const proposal = { state: "AwaitingSupplier", join_deadline_ns: "3000000000" };
  assert.equal(marketplaceCategory(proposal, { nowNs: NOW_NS }), null);
  assert.deepEqual(filterPurchases([proposal], "available", { nowNs: NOW_NS }), []);
  assert.deepEqual(filterPurchases([proposal], "closed", { nowNs: NOW_NS }), []);
  assert.deepEqual(filterPurchases([proposal], "all", { nowNs: NOW_NS }), []);
  assert.deepEqual(filterPurchases([{ ...proposal, public_marketplace: true }], "all", { nowNs: NOW_NS }), [{ ...proposal, public_marketplace: true }]);
});

test("an expired unapproved proposal stays private while an explicitly public proposal can be closed", () => {
  const expired = { state: "AwaitingSupplier", join_deadline_ns: "1000000000" };
  assert.equal(marketplaceCategory(expired, { nowNs: NOW_NS }), null);
  assert.equal(marketplaceCategory({ ...expired, public_listing: true }, { nowNs: NOW_NS }), "closed");
});

test("confirmed finalization places success in progress and failure in closed", () => {
  assert.equal(marketplaceCategory({ state: "Funded" }, { nowNs: NOW_NS }), "in-progress");
  assert.equal(marketplaceCategory({ state: "Failed" }, { nowNs: NOW_NS }), "closed");
  assert.equal(marketplaceCategory({ state: "Completed" }, { nowNs: NOW_NS }), "closed");
});

test("worker delay keeps an expired Open deal closed-pending until authoritative finalization", () => {
  const expired = {
    state: "Open",
    supplier_agreement: { accepted_at_block_height: "1" },
    join_deadline_ns: "1000000000",
  };
  assert.equal(marketplaceCategory(expired, { nowNs: NOW_NS }), "closed");
  assert.equal(marketplaceCategory({ ...expired, state: "Funded" }, { nowNs: NOW_NS }), "in-progress");
  assert.equal(marketplaceCategory({ ...expired, state: "Failed" }, { nowNs: NOW_NS }), "closed");
});

test("contribution eligibility requires agreement acceptance and live capacity", () => {
  const purchase = {
    state: "Open",
    open_membership: true,
    max_quantity: 20,
    total_quantity: 19,
    max_funded_members: 20,
    funded_member_count: 19,
    commitments: [],
  };

  const beforeAgreement = contributionEligibility(purchase, {
    accountId: "buyer.testnet",
    agreementAccepted: false,
  });
  assert.equal(beforeAgreement.availableFundedMemberSlots, 1);
  assert.equal(beforeAgreement.eligibleBeforeAgreement, true);
  assert.equal(beforeAgreement.eligible, false);

  const accepted = contributionEligibility(purchase, {
    accountId: "buyer.testnet",
    agreementAccepted: true,
  });
  assert.equal(accepted.eligible, true);

  const full = contributionEligibility({
    ...purchase,
    total_quantity: 20,
    funded_member_count: 20,
  }, {
    accountId: "another-buyer.testnet",
    agreementAccepted: true,
  });
  assert.equal(full.availableFundedMemberSlots, 0);
  assert.equal(full.eligibleBeforeAgreement, false);
});

test("a funded member cannot contribute again", () => {
  const result = contributionEligibility({
    state: "Open",
    open_membership: true,
    max_quantity: 20,
    total_quantity: 2,
    max_funded_members: 20,
    funded_member_count: 2,
  }, {
    accountId: "buyer.testnet",
    commitment: { state: "Active" },
    agreementAccepted: true,
  });
  assert.equal(result.activeCommitment, true);
  assert.equal(result.eligible, false);
});

test("a V4 open purchase accepts funded membership without a fixed community", () => {
  const result = contributionEligibility({
    version: "V4",
    state: "Open",
    open_membership: true,
    max_quantity: 10,
    total_quantity: 0,
    max_funded_members: 5,
    funded_member_count: 0,
  }, {
    accountId: "neighbor.testnet",
    member: false,
    agreementAccepted: true,
  });
  assert.equal(result.eligible, true);
});

test("a V5 open purchase uses the same purchase-level membership rule", () => {
  const purchase = {
    version: "V5",
    state: "Open",
    open_membership: true,
    total_quantity: 0,
    max_quantity: 2,
    funded_member_count: 0,
    max_funded_members: 2,
    commitments: [],
  };
  assert.equal(contributionEligibility(purchase, {
    accountId: "buyer.testnet",
    member: false,
    agreementAccepted: true,
  }).eligible, true);
});
