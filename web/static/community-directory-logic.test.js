const test = require("node:test");
const assert = require("node:assert/strict");

const directory = require("./community-directory-logic.js");

const funds = [
  { title: "Setup", status: "Awaiting Fund Setup", isMine: true, needsVote: false },
  { title: "Open", status: "Open for Contributions", isMine: false, needsVote: false },
  { title: "Vote", status: "In Progress", isMine: false, needsVote: true, voteEligibleAccountIds: ["member.testnet"] },
  { title: "Done", status: "Completed", isMine: false, needsVote: false },
  { title: "Contributed", status: "Goal reached", verifiedContributorIds: ["member.testnet"] },
];

test("community directory filters represent distinct fund states", () => {
  const titles = (filter, accountId = "member.testnet") => funds.filter((fund) => directory.matchesFilter(fund, filter, { accountId })).map((fund) => fund.title);
  assert.deepEqual(titles("all"), ["Setup", "Open", "Vote", "Done", "Contributed"]);
  assert.deepEqual(titles("open"), ["Open"]);
  assert.deepEqual(titles("vote"), ["Vote"]);
  assert.deepEqual(titles("completed"), ["Done"]);
  assert.deepEqual(titles("mine"), ["Setup", "Contributed"]);
  assert.deepEqual(titles("vote", "other.testnet"), []);
  assert.deepEqual(titles("mine", "other.testnet"), ["Setup"]);
});

test("unknown filters fail closed instead of showing every fund", () => {
  assert.equal(directory.matchesFilter(funds[0], "unknown"), false);
});

test("verified directory progress preserves sub-one-percent contributions and unknown state", () => {
  assert.equal(directory.progressPercent("100000", "100000000"), 0.1);
  assert.equal(directory.progressLabel(0.1), "0.1% funded");
  assert.equal(directory.progressPercent(null, "100000000"), null);
  assert.equal(directory.progressLabel(null), "Verification pending");
  assert.equal(directory.progressPercent("100000000", "100000000"), 100);
});

test("contributor identities are deduplicated only from verified records", () => {
  assert.deepEqual(directory.verifiedContributors([
    { contributor: "dalamaa.testnet" },
    { contributor: "dalamaa.testnet" },
    { account: "member.testnet" },
    {},
  ]), ["dalamaa.testnet", "member.testnet"]);
});
