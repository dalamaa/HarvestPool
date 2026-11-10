/* Shared, bounded confirmation for wallet-authorized contract actions. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    const tools = factory();
    root.HarvestPoolTransactionConfirmation = tools;
    root.HarvestPoolV3Confirmation = tools;
  }
}(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function waitForState(readState, predicate, options = {}) {
    const attempts = Math.max(1, Number(options.attempts ?? 8));
    const delayMs = Math.max(0, Number(options.delayMs ?? 750));
    const pause = options.sleep || sleep;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let state = null;
      try {
        state = await readState();
      } catch (_error) {
        // A final RPC node can briefly lag or be unavailable after a wallet redirect.
      }
      const match = state === null ? null : predicate(state);
      if (match) return match;
      if (attempt + 1 < attempts) await pause(delayMs);
    }
    return null;
  }

  function finalOutcome(value) {
    return value?.final_execution_outcome || value?.finalExecutionOutcome || value?.transaction_outcome || value;
  }

  function classifyOutcome(value) {
    const outcome = finalOutcome(value);
    const status = outcome?.status;
    if (!status) return { state: "uncertain", outcome };
    if (status === "Failure" || status.Failure) {
      const failure = status.Failure || status;
      const message = failure?.ActionError?.kind?.FunctionCallError?.ExecutionError
        || failure?.TransactionExecutionError?.kind?.ActionError?.kind?.FunctionCallError?.ExecutionError
        || "The Testnet transaction failed on-chain.";
      return { state: "failed", outcome, message };
    }
    if (status.SuccessValue !== undefined || status.SuccessReceiptId !== undefined) {
      return { state: "accepted", outcome };
    }
    return { state: "uncertain", outcome };
  }

  function stableValue(value) {
    if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function actionId(action) {
    return [action.networkId || "testnet", action.signerId, action.receiverId, action.methodName, stableValue(action.args || {})].join("|");
  }

  function pendingStore(storage, key = "harvestpool:pending-actions:v1") {
    function read() {
      try {
        const value = JSON.parse(storage?.getItem(key) || "[]");
        return Array.isArray(value) ? value : [];
      } catch (_error) {
        return [];
      }
    }
    function write(actions) {
      try { storage?.setItem(key, JSON.stringify(actions)); } catch (_error) { /* storage unavailable */ }
    }
    return {
      list(signerId = null) {
        return read().filter((item) => !signerId || String(item.signerId) === String(signerId));
      },
      save(action) {
        const item = { ...action, id: action.id || actionId(action), savedAt: action.savedAt || Date.now() };
        write([...read().filter((entry) => entry.id !== item.id), item]);
        return item;
      },
      remove(id) { write(read().filter((item) => item.id !== id)); },
    };
  }

  return { actionId, classifyOutcome, pendingStore, waitForState };
}));
