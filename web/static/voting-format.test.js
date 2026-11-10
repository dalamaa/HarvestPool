const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeRequest } = require("./voting-format.js");

test("Yes/No requests let the contract supply the protected labels", () => {
  assert.deepEqual(normalizeRequest("yes_no", ["changed", "labels"]), {
    voteType: "YesNo",
    options: [],
  });
});

test("three-option decisions preserve all distinct choices", () => {
  assert.deepEqual(normalizeRequest("multiple_choice", [" Saturday ", "Sunday", "Tuesday", ""]), {
    voteType: "MultipleChoice",
    options: ["Saturday", "Sunday", "Tuesday"],
  });
});

test("multiple-choice decisions require at least two choices", () => {
  assert.throws(() => normalizeRequest("multiple_choice", ["Saturday", "", ""]), /two to four/i);
});

test("multiple-choice decisions reject duplicate choices", () => {
  assert.throws(() => normalizeRequest("multiple_choice", ["Saturday", " saturday "]), /different/i);
});
