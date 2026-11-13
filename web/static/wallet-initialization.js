(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    root.HarvestPoolWalletInitialization = api;
    if (root.document) api.installWatchdog(root.document, root);
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const WATCHDOG_TIMEOUT_MS = 25_000;

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

  function recoverStalledUi(documentRef, reload = () => {}) {
    const button = documentRef?.querySelector?.("#wallet-button");
    if (!button || button.getAttribute("aria-busy") !== "true") return false;
    button.textContent = "Retry wallet";
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.title = "Wallet setup did not start or finish. Reload and retry wallet initialization.";
    button.setAttribute("aria-label", "Wallet setup stalled. Reload and retry wallet initialization.");
    button.dataset.walletWatchdogRecovery = "true";
    button.addEventListener("click", (event) => {
      if (button.dataset.walletWatchdogRecovery !== "true") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      reload();
    }, { capture: true, once: true });
    const account = documentRef.querySelector?.("#wallet-account");
    const copy = documentRef.querySelector?.("#wallet-panel-copy");
    if (account) account.textContent = "Wallet unavailable";
    if (copy) copy.textContent = "Wallet setup stalled before it could finish. Reload the page, then retry.";
    return true;
  }

  function installWatchdog(documentRef, windowRef, timeoutMs = WATCHDOG_TIMEOUT_MS) {
    const schedule = () => windowRef.setTimeout(
      () => recoverStalledUi(documentRef, () => windowRef.location.reload()),
      timeoutMs,
    );
    if (documentRef.readyState === "loading") {
      documentRef.addEventListener("DOMContentLoaded", schedule, { once: true });
    } else {
      schedule();
    }
  }

  return { failureMessage, installWatchdog, recoverStalledUi, withTimeout };
});
