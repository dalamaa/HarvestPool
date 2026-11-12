const test = require("node:test");
const assert = require("node:assert/strict");

const directory = require("./community-directory-logic.js");

const funds = [
  { title: "Setup", status: "Awaiting Fund Setup", isMine: true, needsVote: false },
  { title: "Open", status: "Open for Contributions", isMine: false, needsVote: false },
  { title: "Vote", status: "In Progress", isMine: false, needsVote: true },
  { title: "Done", status: "Completed", isMine: false, needsVote: false },
];

test("community directory filters represent distinct fund states", () => {
  const titles = (filter) => funds.filter((fund) => directory.matchesFilter(fund, filter)).map((fund) => fund.title);
  assert.deepEqual(titles("all"), ["Setup", "Open", "Vote", "Done"]);
  assert.deepEqual(titles("open"), ["Open"]);
  assert.deepEqual(titles("vote"), ["Vote"]);
  assert.deepEqual(titles("completed"), ["Done"]);
  assert.deepEqual(titles("mine"), ["Setup"]);
});

test("unknown filters fail closed instead of showing every fund", () => {
  assert.equal(directory.matchesFilter(funds[0], "unknown"), false);
});
