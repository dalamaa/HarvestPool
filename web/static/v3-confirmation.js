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

  async function waitForWalletResult(walletPromise, options = {}) {
    const timeoutMs = Math.max(1, Number(options.timeoutMs ?? 15_000));
    const pause = options.sleep || sleep;
    const timeout = pause(timeoutMs).then(() => ({ state: "pending" }));
    const returned = Promise.resolve(walletPromise).then(
      (value) => ({ state: "returned", value }),
      (error) => ({ state: "rejected", error }),
    );
    const first = await Promise.race([returned, timeout]);
    if (first.state === "pending" && typeof options.onLateResult === "function") {
      returned.then((result) => Promise.resolve(options.onLateResult(result)).catch(() => null));
    }
    return first;
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

  function transactionHash(value) {
    if (!value) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const hash = transactionHash(item);
        if (hash) return hash;
      }
      return null;
    }
    const direct = value?.transaction?.hash
      || value?.final_execution_outcome?.transaction?.hash
      || value?.finalExecutionOutcome?.transaction?.hash
      || value?.transaction_outcome?.id;
    if (direct) return direct;
    for (const key of ["outcomes", "final_execution_outcomes", "finalExecutionOutcomes", "result"]) {
      const hash = transactionHash(value?.[key]);
      if (hash) return hash;
    }
    return null;
  }

  function errorKind(error) {
    if (error?.transactionState === "pending") return "unknown-outcome";
    const message = String(error?.message || error || "").toLowerCase();
    if (/reject|denied|cancelled|canceled|user rejected|declined/.test(message)) return "wallet-rejected";
    if (/access key|permission|not allowed.*method|method.*not allowed|unauthorized/.test(message)) return "wallet-permission";
    if (/not enough.*near|insufficient.*near|insufficient balance|lack balance|gas.*balance/.test(message)) return "network-fees";
    if (/capacity|full|oversubscribed|last spot|already has a commitment|duplicate/.test(message)) return "state-changed";
    if (error?.transactionState === "failed" || /smart contract panicked|contract rejected|functioncallerror/.test(message)) return "contract-rejected";
    if (/failed to fetch|network error|rpc|timeout|timed out|connection/.test(message)) return "network-error";
    return "failed";
  }

  function contractReason(error) {
    return String(error?.message || error || "")
      .replace(/^Error:\s*/i, "")
      .replace(/^Smart contract panicked:\s*/i, "")
      .trim()
      .slice(0, 400);
  }

  function friendlyError(error, fallback) {
    const kind = errorKind(error);
    if (kind === "unknown-outcome" && error?.networkFailure) return "We haven't confirmed the result yet because the wallet or Testnet connection was interrupted. Please don't submit again while we check.";
    if (kind === "unknown-outcome") return "We haven't confirmed the result yet. Please don't submit again while we check.";
    if (kind === "wallet-rejected") return "Meteor declined or cancelled this action. No deal was published, and your draft is safe.";
    if (kind === "wallet-permission") return "Meteor is connected but does not have permission for this contract action. Reconnect the intended Testnet account, then review the draft again.";
    if (kind === "network-fees") return "This wallet does not have enough Testnet NEAR for network fees. No deal was published.";
    if (kind === "state-changed") return "The latest contract state no longer permits this action. Your draft is safe; refresh the live state before trying again.";
    if (kind === "contract-rejected") return `The contract rejected this action: ${contractReason(error) || "no contract reason was returned"}. Your draft is safe.`;
    if (kind === "network-error") return "The wallet or Testnet RPC could not be reached. The result is not being treated as successful; check on-chain state before trying again.";
    return fallback || "The action failed before blockchain confirmation. Your draft is safe.";
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

  function actionGate() {
    const active = new Set();
    return {
      begin(target) {
        if (!target || active.has(target)) return false;
        active.add(target);
        return true;
      },
      finish(target, options = {}) {
        if (!options.keepLocked) active.delete(target);
      },
      isLocked(target) { return active.has(target); },
    };
  }

  function walletCallbackHashes(search = "") {
    const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    return String(params.get("transactionHashes") || params.get("transactionHash") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  function issueMatches(issue, expected = {}) {
    return Boolean(issue)
      && String(issue.purchase_id) === String(expected.purchaseId)
      && String(issue.raised_by) === String(expected.requesterId)
      && String(issue.subject) === String(expected.subject)
      && String(issue.description) === String(expected.description)
      && (expected.suggestedSolution === undefined
        || String(issue.suggested_solution || "") === String(expected.suggestedSolution || ""));
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

  function pendingForWalletCallback(actions = []) {
    return actions
      .filter((item) => !item.transactionHash)
      .sort((left, right) => Number(right.savedAt || 0) - Number(left.savedAt || 0))[0] || null;
  }

  function persistTransactionHash(store, action, value) {
    if (!store || !action?.id) return null;
    const hash = typeof value === "string" ? value.trim() : transactionHash(value);
    if (!hash) return null;
    const current = store.list(action.signerId).find((item) => item.id === action.id);
    if (!current) return null;
    return store.save({ ...current, phase: "confirming", transactionHash: hash });
  }

  return { actionGate, actionId, classifyOutcome, errorKind, friendlyError, issueMatches, pendingForWalletCallback, pendingStore, persistTransactionHash, transactionHash, waitForState, waitForWalletResult, walletCallbackHashes };
}));
