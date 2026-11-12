const test = require("node:test");
const assert = require("node:assert/strict");

const fund = require("./community-fund.js");

function safePolicy() {
  return {
    roles: [
      { name: "all", kind: "Everyone", permissions: [], vote_policy: {} },
      {
        name: "community",
        kind: { Group: ["alice.testnet", "bob.testnet", "carol.testnet"] },
        permissions: [
          "transfer:AddProposal",
          "transfer:VoteApprove",
          "transfer:VoteReject",
          "transfer:VoteRemove",
          "transfer:Finalize",
          "factory_info_update:AddProposal",
          "factory_info_update:VoteApprove",
          "factory_info_update:VoteReject",
          "factory_info_update:VoteRemove",
          "factory_info_update:Finalize",
        ],
        vote_policy: {},
      },
    ],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
    proposal_bond: "100000000000000000000000",
  };
}

test("strict policy analysis proves a two-of-three transfer boundary", () => {
  const result = fund.analyzePolicy(
    safePolicy(),
    { factory_id: "sputnikv2.testnet", auto_update: false },
    [],
    { codeHash: "reviewed", expectedCodeHash: "reviewed", version: "2.3.1" },
  );
  assert.equal(result.ready, true);
  assert.equal(result.requiredVotes, 2);
  assert.equal(result.memberCount, 3);
  assert.deepEqual(result.members, ["alice.testnet", "bob.testnet", "carol.testnet"]);
  assert.equal(result.proposerAccounts.has("alice.testnet"), true);
});

test("access keys, factory upgrades, and wildcard authority all fail closed", () => {
  const policy = safePolicy();
  policy.roles[1].permissions.push("*:*", "call:VoteApprove", "policy:AddProposal");
  const result = fund.analyzePolicy(
    policy,
    { factory_id: "sputnikv2.testnet", auto_update: true },
    [{ public_key: "ed25519:example" }],
    { codeHash: "reviewed", expectedCodeHash: "reviewed", version: "2.3.1" },
  );
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /auto-updates/i);
  assert.match(result.reasons.join(" "), /access key/i);
  assert.match(result.reasons.join(" "), /wildcard/i);
});

test("a one-member council cannot pass the safety gate", () => {
  const policy = safePolicy();
  policy.roles[1].kind.Group = ["alice.testnet"];
  const result = fund.analyzePolicy(
    policy,
    { auto_update: false },
    [],
    { codeHash: "reviewed", expectedCodeHash: "reviewed", version: "2.3.1" },
  );
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /at least two/i);
  assert.match(result.reasons.join(" "), /one account/i);
});

test("a second transfer role cannot hide a unilateral approval path", () => {
  const policy = safePolicy();
  policy.roles.push({
    name: "organizer",
    kind: { Group: ["organizer.testnet"] },
    permissions: ["transfer:VoteApprove"],
    vote_policy: { transfer: { weight_kind: "RoleWeight", quorum: "0", threshold: "1" } },
  });
  const result = fund.analyzePolicy(
    policy,
    { auto_update: false },
    [],
    { codeHash: "reviewed", expectedCodeHash: "reviewed", version: "2.3.1" },
  );
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /multiple roles|unilateral/i);
});

test("factory authority cannot be hidden in another role or use a one-person override", () => {
  const splitPolicy = safePolicy();
  splitPolicy.roles.push({
    name: "factory-admin",
    kind: { Group: ["organizer.testnet"] },
    permissions: ["factory_info_update:AddProposal", "factory_info_update:VoteApprove"],
    vote_policy: {},
  });
  let result = fund.analyzePolicy(
    splitPolicy,
    { auto_update: false },
    [],
    { codeHash: "reviewed", expectedCodeHash: "reviewed", version: "2.3.1" },
  );
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /every retained DAO permission/i);

  const overridePolicy = safePolicy();
  overridePolicy.roles[1].vote_policy.factory_info_update = {
    weight_kind: "RoleWeight", quorum: "0", threshold: "1",
  };
  result = fund.analyzePolicy(
    overridePolicy,
    { auto_update: false },
    [],
    { codeHash: "reviewed", expectedCodeHash: "reviewed", version: "2.3.1" },
  );
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /factory authority/i);
});

test("native NEAR allocation payload uses Sputnik Transfer and structured purpose", () => {
  const amount = fund.decimalToYocto("1.25");
  const proposal = fund.transferProposal("recipient.testnet", amount, "Buy shared garden tools");
  assert.equal(amount, "1250000000000000000000000");
  assert.deepEqual(proposal.kind.Transfer, {
    token_id: "",
    receiver_id: "recipient.testnet",
    amount,
    msg: null,
  });
  assert.equal(fund.decodeDescription(proposal.description), "Buy shared garden tools");
});

test("USDC allocation payload and reads stay separate from historical NEAR", () => {
  const tokenId = "usdc.testnet";
  const proposal = fund.transferProposal("recipient.testnet", "800000", "Buy shared tools", tokenId);
  assert.deepEqual(proposal.kind.Transfer, {
    token_id: tokenId,
    receiver_id: "recipient.testnet",
    amount: "800000",
    msg: null,
  });
  const stored = { ...proposal, id: 4, status: "InProgress", proposer: "alice.testnet", votes: {}, submission_time: "1" };
  assert.equal(fund.allocationFromProposal(stored), null);
  assert.equal(fund.allocationFromProposal(stored, tokenId).tokenId, tokenId);
  assert.equal(fund.sumAllocations([stored], ["InProgress"]), "0");
  assert.equal(fund.sumAllocations([stored], ["InProgress"], tokenId), "800000");
});

test("USDC registration and direct contribution payloads are exact", () => {
  assert.deepEqual(fund.storageRegistration("community.sputnikv2.testnet"), {
    account_id: "community.sputnikv2.testnet",
    registration_only: true,
  });
  assert.deepEqual(fund.tokenContribution("community.sputnikv2.testnet", "1000000", "Shared Equipment"), {
    receiver_id: "community.sputnikv2.testnet",
    amount: "1000000",
    memo: "Contribution toward Shared Equipment",
  });
});

test("USDC payment proof requires the configured token receipt", () => {
  const allocation = { id: 8, receiverId: "recipient.testnet", amount: "200000", tokenId: "usdc.testnet" };
  const activity = { proposalTransactions: { 8: [{
    action: "VoteApprove",
    transactionHash: "vote-hash",
    transfers: [
      { receiver: "recipient.testnet", amount: "200000", tokenId: "" },
      { receiver: "recipient.testnet", amount: "200000", tokenId: "usdc.testnet", receiptId: "ft-receipt" },
    ],
  }] } };
  assert.equal(fund.verifiedPayment(allocation, activity).transfer.receiptId, "ft-receipt");
});

test("authoritative proposal totals include only requested statuses", () => {
  const base = (id, status, amount) => ({
    id,
    status,
    description: fund.encodeDescription(`Reason ${id}`),
    proposer: "alice.testnet",
    kind: { Transfer: { token_id: "", receiver_id: "recipient.testnet", amount, msg: null } },
    votes: {},
    vote_counts: {},
    submission_time: "1",
  });
  const proposals = [base(0, "Approved", "20"), base(1, "InProgress", "30"), base(2, "Rejected", "40")];
  assert.equal(fund.sumAllocations(proposals, ["Approved"]), "20");
  assert.equal(fund.sumAllocations(proposals, ["InProgress"]), "30");
});

test("payment proof requires the exact proposal action, recipient, and amount receipt", () => {
  const allocation = {
    id: 7,
    status: "InProgress",
    receiverId: "recipient.testnet",
    amount: "100",
  };
  const activity = {
    proposalTransactions: {
      7: [
        { action: "VoteReject", transfers: [{ receiver: "recipient.testnet", amount: "100" }] },
        { action: "VoteApprove", transfers: [{ receiver: "other.testnet", amount: "100" }] },
        {
          action: "Finalize",
          transactionHash: "payment-hash",
          transfers: [{ receiver: "recipient.testnet", amount: "100", receiptId: "receipt" }],
        },
      ],
    },
  };
  const payment = fund.verifiedPayment(allocation, activity);
  assert.equal(payment.transactionHash, "payment-hash");
  assert.equal(payment.transfer.receiptId, "receipt");
  assert.equal(fund.verifiedPayment({ ...allocation, amount: "101" }, activity), null);
});

test("proposal sections expose only actions available to the connected member", () => {
  const proposal = (id, status, votes = {}) => ({
    id,
    status,
    description: fund.encodeDescription(`Reason ${id}`),
    proposer: "alice.testnet",
    kind: { Transfer: { token_id: "", receiver_id: "recipient.testnet", amount: "100", msg: null } },
    votes,
    vote_counts: {},
    submission_time: "1",
  });
  const safety = { ready: true, voterAccounts: new Set(["alice.testnet", "bob.testnet"]) };
  const activity = {
    proposalTransactions: {
      3: [{ action: "VoteApprove", transfers: [{ receiver: "recipient.testnet", amount: "100" }] }],
    },
  };
  const sections = fund.proposalSections([
    proposal(1, "InProgress"),
    proposal(2, "InProgress", { "alice.testnet": "Approve" }),
    proposal(3, "Approved"),
    proposal(4, "Rejected"),
  ], activity, safety, "alice.testnet");
  assert.deepEqual(sections.needsVote.map(({ id }) => id), [1]);
  assert.deepEqual(sections.open.map(({ id }) => id), [1, 2]);
  assert.deepEqual(sections.completed.map(({ id }) => id), [3, 4]);
  assert.equal(fund.proposalSections([proposal(1, "InProgress")], activity, safety, null).needsVote.length, 0);
});

test("one-goal progress uses verified direct contributions and matching recipient payments", () => {
  const goal = { configured: true, recipient: "school.testnet", targetYocto: "1000" };
  const allocations = [
    { id: 1, receiverId: "school.testnet", amount: "600", status: "Approved" },
    { id: 2, receiverId: "other.testnet", amount: "900", status: "Approved" },
  ];
  const activity = {
    proposalTransactions: {
      1: [{ action: "VoteApprove", transfers: [{ receiver: "school.testnet", amount: "600" }] }],
      2: [{ action: "VoteApprove", transfers: [{ receiver: "other.testnet", amount: "900" }] }],
    },
  };
  const snapshot = fund.goalSnapshot(goal, "1250", allocations, activity);
  assert.equal(snapshot.contributed, "1250");
  assert.equal(snapshot.progressBasisPoints, 10000);
  assert.equal(snapshot.spent, "600");
  assert.equal(snapshot.status, "In Progress");
  assert.equal(fund.goalSnapshot(goal, null, allocations, activity), null);
});

test("USDC goal progress uses targetUnits without a NEAR target", () => {
  const snapshot = fund.goalSnapshot({ configured: true, recipient: "recipient.testnet", targetUnits: "1000000" }, "250000", [], {});
  assert.equal(snapshot.target, "1000000");
  assert.equal(snapshot.contributed, "250000");
  assert.equal(snapshot.progressBasisPoints, 2500);
});
