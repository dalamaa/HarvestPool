/* Wallet Selector v10 transaction helpers. No wallet or signing authority lives here. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.HarvestPoolTransactions = factory();
  }
}(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const STANDARD_TRANSACTION_GAS = "30000000000000";
  const V3_ASYNC_TRANSACTION_GAS = "60000000000000";
  const RECONCILIATION_TRANSACTION_GAS = "50000000000000";
  const TOKEN_ASYNC_TRANSACTION_GAS = "100000000000000";
  const V3_ASYNC_METHODS = new Set(["raise_issue", "request_group_vote", "resolve_issue"]);
  const TOKEN_ASYNC_METHODS = new Set(["ft_transfer_call", "claim_refund", "release_payment"]);

  function yoctoBigInt(value, label) {
    if (typeof value === "bigint") return value;
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
      throw new TypeError(`${label} must be a non-negative decimal string or BigInt.`);
    }
    return BigInt(value);
  }

  function assertNajFunctionCall(action) {
    if (action && (action.type === "FunctionCall" || action.params)) {
      throw new TypeError("Wallet Selector v10 requires a NAJ action, not a legacy action object.");
    }
    if (!action || action.enum !== "functionCall" || !action.functionCall) {
      throw new TypeError("Wallet Selector v10 did not return a NAJ function-call action.");
    }
    if (typeof action.functionCall.gas !== "bigint" || typeof action.functionCall.deposit !== "bigint") {
      throw new TypeError("NAJ function-call gas and deposit must be BigInt values.");
    }
    return action;
  }

  function functionCallAction(actionCreators, methodName, args, gasYocto, depositYocto) {
    if (!actionCreators || typeof actionCreators.functionCall !== "function") {
      throw new Error("Wallet Selector v10 action creators are unavailable.");
    }
    const gas = yoctoBigInt(gasYocto, "Gas");
    const deposit = yoctoBigInt(depositYocto, "Deposit");
    return assertNajFunctionCall(actionCreators.functionCall(methodName, args, gas, deposit));
  }

  function transferAction(actionCreators, amountYocto) {
    if (!actionCreators || typeof actionCreators.transfer !== "function") {
      throw new Error("Wallet Selector v10 transfer action creator is unavailable.");
    }
    const action = actionCreators.transfer(yoctoBigInt(amountYocto, "Transfer amount"));
    if (!action || action.enum !== "transfer" || !action.transfer || typeof action.transfer.deposit !== "bigint") {
      throw new TypeError("Wallet Selector v10 did not return a NAJ transfer action.");
    }
    return action;
  }

  function buildFunctionCallTransaction({
    actionCreators,
    signerId,
    receiverId,
    methodName,
    args = {},
    gasYocto = "30000000000000",
    depositYocto = "0",
  }) {
    if (!signerId || !receiverId || !methodName) {
      throw new Error("A signer, receiver, and method are required for a wallet transaction.");
    }
    return {
      signerId,
      receiverId,
      actions: [functionCallAction(actionCreators, methodName, args, gasYocto, depositYocto)],
    };
  }

  function buildTransferTransaction({ actionCreators, signerId, receiverId, amountYocto }) {
    if (!signerId || !receiverId) throw new Error("A signer and receiver are required for a wallet transfer.");
    return {
      signerId,
      receiverId,
      actions: [transferAction(actionCreators, amountYocto)],
    };
  }

  function gasForMethod(receiverId, v3ContractId, methodName) {
    if (TOKEN_ASYNC_METHODS.has(methodName)) return TOKEN_ASYNC_TRANSACTION_GAS;
    if (methodName === "reconcile_token_balance") return RECONCILIATION_TRANSACTION_GAS;
    return receiverId === v3ContractId && V3_ASYNC_METHODS.has(methodName)
      ? V3_ASYNC_TRANSACTION_GAS
      : STANDARD_TRANSACTION_GAS;
  }

  return {
    assertNajFunctionCall,
    buildFunctionCallTransaction,
    buildTransferTransaction,
    functionCallAction,
    gasForMethod,
    yoctoBigInt,
    transferAction,
  };
}));
