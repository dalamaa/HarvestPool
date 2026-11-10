const test = require("node:test");
const assert = require("node:assert/strict");

const {
  contributionEligibility,
  filterPurchases,
} = require("./filtering.js");

const purchases = [
  { id: "101", source: "live", state: "Open" },
  { id: "102", source: "live", state: "FulfillmentPending" },
  { id: "103", source: "live", state: "Completed" },
];

function idsFor(filter) {
  return filterPurchases(purchases, filter).map((purchase) => (
    purchase.slug || purchase.id
  ));
}

test("contract purchases use the same status filters", () => {
  assert.deepEqual(idsFor("all"), ["101", "102", "103"]);
  assert.deepEqual(idsFor("open"), ["101"]);
  assert.deepEqual(idsFor("funded"), ["102"]);
  assert.deepEqual(idsFor("completed"), ["103"]);
  assert.deepEqual(idsFor("live"), ["101", "102", "103"]);
});

test("repeated tab switches stay deterministic and do not duplicate cards", () => {
  const expected = {
    all: ["101", "102", "103"],
    open: ["101"],
    funded: ["102"],
    completed: ["103"],
    live: ["101", "102", "103"],
  };
  const sequence = ["all", "open", "funded", "completed", "live", "all", "open"];

  sequence.forEach((filter) => {
    const result = idsFor(filter);
    assert.deepEqual(result, expected[filter]);
    assert.equal(new Set(result).size, result.length);
  });
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
