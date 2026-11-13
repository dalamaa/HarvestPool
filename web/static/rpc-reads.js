(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HarvestPoolRpcReads = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function transientStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  function transientRpcPayload(payload) {
    const code = Number(payload?.error?.code);
    const message = String(payload?.error?.message || "");
    return [-32000, -32001, -32002, -32603].includes(code) || /timeout|temporar|unavailable|overloaded/i.test(message);
  }

  async function fetchJsonWithRetry(fetchImpl, url, options, { attempts = 2, delayMs = 150, retryPayload = null } = {}) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetchImpl(url, options);
        if (!response.ok) {
          const error = new Error(`The testnet read returned HTTP ${response.status}.`);
          error.status = response.status;
          throw error;
        }
        const payload = await response.json();
        if (retryPayload?.(payload)) {
          const error = new Error(payload.error?.message || "The testnet read failed temporarily.");
          error.code = "RPC_TRANSIENT";
          throw error;
        }
        return payload;
      } catch (error) {
        lastError = error;
        const retryable = !error?.status || transientStatus(Number(error.status));
        if (!retryable || attempt === attempts - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
      }
    }
    throw lastError;
  }

  return { fetchJsonWithRetry, transientRpcPayload, transientStatus };
}));
