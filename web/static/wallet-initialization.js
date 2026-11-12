(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.HarvestPoolWalletInitialization = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function withTimeout(promise, timeoutMs, message = "Wallet initialization timed out.") {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(message);
        error.code = "WALLET_INITIALIZATION_TIMEOUT";
        reject(error);
      }, timeoutMs);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
  }

  function failureMessage(error) {
    if (error?.code === "WALLET_INITIALIZATION_TIMEOUT") {
      return "Wallet setup timed out. Check your connection or browser blocker, then retry.";
    }
    return "Wallet setup could not finish. Check your connection and browser permissions, then retry.";
  }

  return { failureMessage, withTimeout };
});
