const test = require("node:test");
const assert = require("node:assert/strict");

const directory = require("./community-directory-logic.js");

const funds = [
  { title: "Setup", status: "Awaiting Fund Setup", isMine: true, needsVote: false },
  { title: "Open", status: "Open for Contributions", raisedUnits: "999999", targetUnits: "1000000", isMine: false, needsVote: false },
  { title: "Vote", status: "In Progress", isMine: false, needsVote: true, voteEligibleAccountIds: ["member.testnet"] },
  { title: "Done", status: "Completed", raisedUnits: "1000000", targetUnits: "1000000", isMine: false, needsVote: false },
  { title: "Contributed", status: "Goal reached", raisedUnits: "1250000", targetUnits: "1000000", verifiedContributorIds: ["member.testnet"] },
];

test("community directory filters represent distinct fund states", () => {
  const titles = (filter, accountId = "member.testnet") => funds.filter((fund) => directory.matchesFilter(fund, filter, { accountId })).map((fund) => fund.title);
  assert.deepEqual(titles("all"), ["Setup", "Open", "Vote", "Done", "Contributed"]);
  assert.deepEqual(titles("open"), ["Open"]);
  assert.deepEqual(titles("vote"), ["Vote"]);
  assert.deepEqual(titles("completed"), ["Done", "Contributed"]);
  assert.deepEqual(titles("mine"), ["Setup", "Contributed"]);
  assert.deepEqual(titles("vote", "other.testnet"), []);
  assert.deepEqual(titles("mine", "other.testnet"), ["Setup"]);
});

test("fundraising stage uses confirmed lifetime totals and ignores display status", () => {
  assert.equal(directory.fundraisingStage("999999", "1000000"), "open");
  assert.equal(directory.fundraisingStage("1000000", "1000000"), "completed");
  assert.equal(directory.fundraisingStage("1250000", "1000000"), "completed");
  assert.equal(directory.fundraisingStage(null, "1000000"), "unknown");
  assert.equal(directory.matchesFilter({ status: "Goal reached", raisedUnits: "999999", targetUnits: "1000000" }, "completed"), false);
  assert.equal(directory.matchesFilter({ status: "Open for contributions", raisedUnits: "1000000", targetUnits: "1000000" }, "completed"), true);
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
