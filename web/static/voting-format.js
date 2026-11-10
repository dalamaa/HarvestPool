(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.HarvestPoolVoting = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function normalizeRequest(inputType, rawOptions) {
    if (inputType !== "multiple_choice") {
      return { voteType: "YesNo", options: [] };
    }

    const options = (rawOptions || []).map((value) => String(value || "").trim()).filter(Boolean);
    if (options.length < 2 || options.length > 4) {
      throw new Error("Add two to four choices.");
    }
    if (new Set(options.map((option) => option.toLocaleLowerCase())).size !== options.length) {
      throw new Error("Each choice must be different.");
    }
    return { voteType: "MultipleChoice", options };
  }

  return { normalizeRequest };
});
