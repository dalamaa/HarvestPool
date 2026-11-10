const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assertNajFunctionCall,
  buildFunctionCallTransaction,
  gasForMethod,
} = require("./transaction-actions.js");

const METHODS = [
  "create_supplier_offer",
  "create_purchase_request",
  "accept_supplier_request",
  "decline_supplier_request",
  "create_open_purchase",
  "create_purchase",
  "vote_on_offer",
  "commit",
  "cancel_commitment",
  "finalize_purchase",
  "submit_fulfillment_evidence",
  "vote_on_fulfillment",
  "expire_unfulfilled_purchase",
  "release_payment",
  "claim_refund",
  "ft_transfer_call",
];

function najActionCreators() {
  return {
    functionCall(methodName, args, gas, deposit) {
      return {
        enum: "functionCall",
        functionCall: { methodName, args: new Uint8Array(), gas, deposit },
      };
    },
  };
}

test("shared adapter builds NAJ actions for every wallet-signed method", () => {
  const actionCreators = najActionCreators();

  for (const methodName of METHODS) {
    const transaction = buildFunctionCallTransaction({
      actionCreators,
      signerId: "dalamaa.testnet",
      receiverId: "harvestpool-v2-dalamaa-20261108.testnet",
      methodName,
      args: { purchase_id: "0" },
      depositYocto: methodName === "commit" ? "1000000000000000000000" : "0",
    });
    const [action] = transaction.actions;

    assert.equal(transaction.signerId, "dalamaa.testnet");
    assert.equal(transaction.receiverId, "harvestpool-v2-dalamaa-20261108.testnet");
    assert.equal(action.enum, "functionCall");
    assert.equal(action.type, undefined);
    assert.equal(action.functionCall.methodName, methodName);
    assert.equal(typeof action.functionCall.gas, "bigint");
    assert.equal(typeof action.functionCall.deposit, "bigint");
  }
});

test("legacy action objects are rejected before reaching the wallet", () => {
  assert.throws(() => assertNajFunctionCall({
    type: "FunctionCall",
    params: { methodName: "commit", args: {}, gas: "30000000000000", deposit: "0" },
  }), /NAJ action/);

  assert.throws(() => buildFunctionCallTransaction({
    actionCreators: {
      functionCall: () => ({
        type: "FunctionCall",
        params: { methodName: "commit", args: {}, gas: "30000000000000", deposit: "0" },
      }),
    },
    signerId: "buyer.testnet",
    receiverId: "contract.testnet",
    methodName: "commit",
  }), /NAJ action/);
});

test("gas and deposits never accept JavaScript Number values", () => {
  assert.throws(() => buildFunctionCallTransaction({
    actionCreators: najActionCreators(),
    signerId: "buyer.testnet",
    receiverId: "contract.testnet",
    methodName: "commit",
    gasYocto: 30000000000000,
  }), /decimal string or BigInt/);
});

test("only V3 async read-and-callback methods receive the larger gas budget", () => {
  const v3 = "harvestpool-v3.testnet";
  assert.equal(gasForMethod(v3, v3, "raise_issue"), "60000000000000");
  assert.equal(gasForMethod(v3, v3, "request_group_vote"), "60000000000000");
  assert.equal(gasForMethod(v3, v3, "resolve_issue"), "60000000000000");
  assert.equal(gasForMethod(v3, v3, "vote_on_decision"), "30000000000000");
  assert.equal(gasForMethod("harvestpool-v2.testnet", v3, "raise_issue"), "30000000000000");
  assert.equal(gasForMethod("usdc.testnet", v3, "ft_transfer_call"), "100000000000000");
  assert.equal(gasForMethod("v5.testnet", v3, "claim_refund"), "100000000000000");
  assert.equal(gasForMethod("v5.testnet", v3, "release_payment"), "100000000000000");
});
