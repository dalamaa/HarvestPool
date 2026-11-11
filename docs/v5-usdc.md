# V5 native-USDC architecture and readiness

Status: implemented, Sandbox-tested, deployed to isolated Testnet accounts, and verified through
the low-value Circle USDC journey. V4 remains the configured Testnet demonstration and fallback;
the verified live state is recorded in [the V5 financial baseline](v5-financial-baseline.md).

## Verified token identity

[Circle's official USDC-on-NEAR page](https://www.circle.com/multi-chain-usdc/near) identifies the
native Testnet [NEP-141](https://github.com/near/NEPs/blob/master/neps/nep-0141.md) contract as:

`3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`

A finality=`final` read-only RPC call on 2026-11-09 at block 276,992,294 returned metadata
`{"spec":"ft-1.0.0","name":"USDC","symbol":"USDC","decimals":6}`. Identity must still be
supplied explicitly to V5 initialization; V5 rejects every other predecessor in `ft_on_transfer`.
Do not substitute bridged USDC.e.

At final block 276,992,297, the
[NEP-145](https://github.com/near/NEPs/blob/master/neps/nep-0145.md)
`storage_balance_bounds` call returned an exact minimum/maximum of
`1,250,000,000,000,000,000,000` yoctoNEAR (**0.00125 NEAR**) per registered account.

[Circle's official public faucet](https://faucet.circle.com/) now explicitly lists **Near Testnet**.
It advertises 20 test USDC per request and a two-hour limit per address/blockchain. This verifies an
official acquisition route, but it is not evidence that HarvestPool has claimed or transferred the
token. The project must not claim an official-token journey until an authorized operator records
the resulting token and HarvestPool receipts.

## Safe faucet claim procedure

Use a buyer account that is controlled in Meteor on **Near Testnet**, has enough test NEAR for
registration and transaction gas, and is not a mainnet account. Registration belongs to the NEAR
account, not to the wallet application.

1. Copy the complete buyer account ID from Meteor. Use the `.testnet` account ID, not a public key,
   an EVM `0x` address, the V5 contract, or the token contract.
2. Before claiming, call Circle USDC's `storage_balance_of` with
   `{"account_id":"<buyer>.testnet"}`. If it returns `null`, call `storage_deposit` on the exact
   Circle token with `{"account_id":"<buyer>.testnet","registration_only":true}` and attach exactly
   `0.00125 NEAR`. Confirm that the resulting receipt succeeded and re-read `storage_balance_of`.
3. Open `https://faucet.circle.com/` directly. Select asset **USDC**, network **Near Testnet**, paste
   the buyer account ID, complete the challenge, recheck the network and account, and request the
   20-USDC drip. Do this separately for each buyer, respecting Circle's displayed rate limit.
4. Wait for finality. Query `ft_balance_of` on
   `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` with
   `{"account_id":"<buyer>.testnet"}`. A full fresh drip is returned as the JSON string
   `"20000000"`, because the token has six decimals. Record the faucet transaction and receipt IDs.
5. Repeat `ft_balance_of` immediately before each smoke contribution. Never infer a token balance
   from a wallet popup or from a decimal display.

An existing Meteor-controlled Testnet account can receive the token once registered and can sign
the standard `ft_transfer_call` used by HarvestPool. Automatic display of this long token account
in Meteor's token list has not been verified; that display is not a protocol requirement. Use
`ft_balance_of` as the authority and the HarvestPool dApp (or reviewed NEAR CLI calls) to initiate
the transfer if Meteor does not expose a direct token-send control.

## Contract boundaries

- `contract-v5`: isolated V4-derived purchase contract. Its contribution asset is configured native
  USDC, never attached NEAR.
- `contract-v3-v5`: isolated decision contract configured to read membership from that exact V5
  account. It has no token-transfer authority.
- `mock-usdc`: standards-based local NEP-141/NEP-145 fixture with six decimals and deliberate
  outbound failure injection. It is test infrastructure, not Circle's contract.
- `contract-v4` and the deployed V3-for-V4 remain unchanged and usable.

## Inbound contribution protocol

The buyer calls the configured token's `ft_transfer_call` with one yoctoNEAR, the exact base-unit
amount, V5 as `receiver_id`, and this versioned message:

```json
{"v":1,"action":"commit","purchase_id":"7","quantity":2}
```

`ft_on_transfer` accepts only the configured predecessor, valid message, supplier-approved open
purchase, unexpired deadline, eligible buyer, unused account, remaining unit/member capacity, and
exact `price_per_unit × quantity`. It returns `0` only after recording the commitment. Every reject
path returns the full incoming amount so the token resolver refunds the sender. No floating-point
or display-unit arithmetic is used.

The browser checks `storage_balance_of` and `ft_balance_of` before prompting, but those checks are
advisory. Contract execution is the authority and performs the final capacity/amount validation.

## Refund and payout state machine

1. Lock the commitment/purchase in a pending state and allocate a monotonic operation ID.
2. Read `storage_balance_of(recipient)` from the configured token.
3. If registered, call `ft_transfer` with exactly one yoctoNEAR; otherwise record an observed
   registration failure and restore the retryable financial state.
4. A private callback tied to the operation ID marks success or observed failure. Duplicate or late
   callbacks cannot initiate another transfer.
5. An observed transfer failure restores `Refundable` or `FulfillmentApproved`, allowing an explicit
   retry. A missing storage-read callback can be safely unlocked after one hour because no transfer
   was scheduled.
6. A missing transfer callback is **not** automatically retried. It becomes
   `ReconciliationRequired`, because the transfer may have succeeded. Operators must compare the
   operation, token balance, and receipts before any future resolution mechanism is considered.

There is intentionally no generic withdrawal, admin sweep, or optimistic “success” based on a
wallet return. Direct token transfers into V5 are possible under NEP-141 and appear as reconciliation
surplus; they do not create membership.

## Accounting and reconciliation

V5 exposes total accepted, total successfully refunded, total successfully paid to suppliers,
outstanding liability, operation records, and the last observed contract token balance. Expected
balance is `accepted - refunded - supplier_paid`. A lower observed balance is a shortfall signal; a
higher balance may be a direct/untracked transfer. Reconciliation is evidence, not a guarantee of
solvency or a substitute for receipt investigation.

The V5 account must be registered with the token before the first inbound transfer. Every refund or
payout recipient must also be registered. Deployment funding must cover contract storage, token
storage registration, and NEAR gas; USDC never pays NEAR gas.

At NEAR's current protocol storage price of `10^19` yoctoNEAR/byte, the 273,067-byte V5 WASM alone
reserves about **2.73067 NEAR**, and the 219,131-byte V3-for-V5 WASM about **2.19131 NEAR**. The
proposed prototype funding is **10 NEAR on the new V5 account** and **5 NEAR on the new V3-for-V5
account**, plus the V5 token registration deposit of **0.00125 NEAR**. Those balances include
development headroom; actual initialization/state usage and gas must be measured after deployment.

## V3-for-V5 compatibility

The decision API remains compatible with funded-member checks and immutable purchase economics.
The corrected V3-for-V5 version additionally timestamps pending cross-contract validations, caps
pending requests at 100, cleans rejected callbacks without panicking, and permits cleanup after one
hour. Late callbacks no-op. Sandbox coverage confirms Yes/No, multiple choice, supplier consent,
duplicate request rejection, and that V5 financial fields remain unchanged.

## Test evidence

Local Sandbox uses real cross-contract receipts with the mock token. It covers exact 50 USDC,
wrong amount, wrong token, supplier rejection, duplicate contribution, concurrent final capacity,
cancel/refund, failed-order refund, injected refund/payout failure and retry, duplicate transfer
guards, outsider and premature payout rejection, balance reconciliation, and V3-for-V5 voting.

This does not prove Circle contract compatibility on Testnet. Required authorized deployment gate:

Host-built, non-reproducible artifacts from Rust/Cargo 1.99.1 and `cargo-near` 0.23.0:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `harvest_pool_v5_contract.wasm` | 273,067 | `37858d4e64be52f09bdf5541cd7379075eb69c08bb289edd1c7e090d81ddf8cf` |
| `harvest_pool_v3_v5_contract.wasm` | 219,131 | `a0f1e9fd382288c7cc04ec362cd56fd869dba44425a7b88b24c66046704233a3` |
| `harvest_pool_mock_usdc.wasm` | 178,309 | `f577570882cc937d132b677c076af68a99493e194c81aa8792f17b0af2877f7f` |

These hashes are build evidence, not reproducible-build claims.

Deployed accounts:

- V5: `harvestpool-v5-usdc-dalamaa-20261109.testnet`
- V3-for-V5: `harvestpool-v3-v5-dalamaa-20261109.testnet`

Exact initialization payloads:

```json
{
  "v5": {
    "account": "harvestpool-v5-usdc-dalamaa-20261109.testnet",
    "method": "new",
    "args": {
      "suppliers": [{
        "account_id": "harvestpool-farmer-1.testnet",
        "business_name": "HarvestPool Pilot Supplier",
        "location": "Not provided",
        "public_contact": "Not provided"
      }],
      "token_contract_id": "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
      "token_decimals": 6
    }
  },
  "v3_for_v5": {
    "account": "harvestpool-v3-v5-dalamaa-20261109.testnet",
    "method": "new",
    "args": {"v2_contract_id": "harvestpool-v5-usdc-dalamaa-20261109.testnet"}
  }
}
```

Before initialization, deploy `target/near/harvest_pool_v5_contract/harvest_pool_v5_contract.wasm`
and `target/near/harvest_pool_v3_v5_contract/harvest_pool_v3_v5_contract.wasm` without an init call,
then invoke each `new` as its own contract account. Fund V5 with 10 NEAR and V3-for-V5 with 5 NEAR.
Register V5 and the supplier with Circle USDC by calling the token's `storage_deposit` for each
account with `registration_only:true` and exactly 0.00125 NEAR. Buyers must also be registered,
whether by this explicit step or by a successful, independently verified faucet registration.

The reviewed near-cli-rs 0.31 command sequence is below. Account creation and any balance top-up
remain authorization-gated; inspect the faucet-created balance and transfer only the difference
needed to reach the stated 10/5-NEAR targets from an explicitly named funding account.

```sh
V5_CONTRACT='harvestpool-v5-usdc-dalamaa-20261109.testnet'
V3_V5_CONTRACT='harvestpool-v3-v5-dalamaa-20261109.testnet'
USDC_CONTRACT='3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af'
V5_WASM='target/near/harvest_pool_v5_contract/harvest_pool_v5_contract.wasm'
V3_V5_WASM='target/near/harvest_pool_v3_v5_contract/harvest_pool_v3_v5_contract.wasm'

near account create-account sponsor-by-faucet-service "$V5_CONTRACT" \
  autogenerate-new-keypair save-to-keychain network-config testnet create
near account create-account sponsor-by-faucet-service "$V3_V5_CONTRACT" \
  autogenerate-new-keypair save-to-keychain network-config testnet create
near account view-account-summary "$V5_CONTRACT" network-config testnet now
near account view-account-summary "$V3_V5_CONTRACT" network-config testnet now

near contract deploy "$V5_CONTRACT" use-file "$V5_WASM" without-init-call \
  network-config testnet sign-with-keychain send
near contract call-function as-transaction "$V5_CONTRACT" new json-args \
  '{"suppliers":[{"account_id":"harvestpool-farmer-1.testnet","business_name":"HarvestPool Pilot Supplier","location":"Not provided","public_contact":"Not provided"}],"token_contract_id":"3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af","token_decimals":6}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$V5_CONTRACT" \
  network-config testnet sign-with-keychain send

near contract deploy "$V3_V5_CONTRACT" use-file "$V3_V5_WASM" without-init-call \
  network-config testnet sign-with-keychain send
near contract call-function as-transaction "$V3_V5_CONTRACT" new json-args \
  '{"v2_contract_id":"harvestpool-v5-usdc-dalamaa-20261109.testnet"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$V3_V5_CONTRACT" \
  network-config testnet sign-with-keychain send

near contract call-function as-transaction "$USDC_CONTRACT" storage_deposit json-args \
  '{"account_id":"harvestpool-v5-usdc-dalamaa-20261109.testnet","registration_only":true}' \
  prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$V5_CONTRACT" \
  network-config testnet sign-with-keychain send
near contract call-function as-transaction "$USDC_CONTRACT" storage_deposit json-args \
  '{"account_id":"harvestpool-farmer-1.testnet","registration_only":true}' \
  prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$V5_CONTRACT" \
  network-config testnet sign-with-keychain send

near contract call-function as-read-only "$V5_CONTRACT" get_config json-args '{}' \
  network-config testnet now
near contract call-function as-read-only "$V5_CONTRACT" get_suppliers json-args '{}' \
  network-config testnet now
near contract call-function as-read-only "$V3_V5_CONTRACT" get_config json-args '{}' \
  network-config testnet now
near contract call-function as-read-only "$USDC_CONTRACT" storage_balance_of json-args \
  '{"account_id":"harvestpool-v5-usdc-dalamaa-20261109.testnet"}' network-config testnet now
```

Stop if an account unexpectedly exists, a deployed bytecode hash differs, initialization views do
not match, or a storage-registration receipt fails. Do not retry an initializer.

Only after deployment views and the smoke test pass should a separate local process use:

```dotenv
HARVESTPOOL_CONTRACT_ID=harvestpool-v5-usdc-dalamaa-20261109.testnet
HARVESTPOOL_CONTRACT_VERSION=V5
HARVESTPOOL_V3_CONTRACT_ID=harvestpool-v3-v5-dalamaa-20261109.testnet
HARVESTPOOL_USDC_TOKEN_ID=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
```

Do not replace the checked-in V4 defaults or the public V4 process during this exercise.

## Authorized 2-USDC smoke-test runbook

Use `price_per_unit:"2000000"`, `listed_price_usd_cents:"200"`, quantity one per buyer,
`min_quantity:2`, `max_quantity:2`, `max_quantity_per_household:1`, and
`max_funded_members:2`. Set a join deadline at least 30 minutes ahead and a fulfillment deadline
after it but within 30 days. Use separate supplier-signed offers for the success and failure cases.

1. Supplier `harvestpool-farmer-1.testnet` creates the successful offer. Verify `Open`, the supplier
   agreement, immutable terms hash, and zero funding before continuing.
2. Buyers A and B each call Circle's `ft_transfer_call` to V5 for exactly `"2000000"`, one yoctoNEAR,
   100 Tgas, and message
   `{"v":1,"action":"commit","purchase_id":"<success-id>","quantity":1}`. After every call,
   inspect all receipts, the buyer/V5 `ft_balance_of` values, and `get_purchase`. Both commitments
   must be `Active`; V5 must hold `"4000000"` and report the same outstanding liability.
3. Buyer A raises a V3 issue, requests a `pickup_arrangement`/`YesNo` decision with a future
   deadline, and both snapshotted buyers vote option `0`. Required votes must be 2. The supplier
   calls `agree_to_decision`; the decision must become `Approved`, pending-request count must return
   to zero, and all V5 financial fields must remain unchanged.
4. After the join deadline, finalize the successful offer. The supplier submits a nonempty evidence
   reference; both funded members approve fulfillment. Only then may `release_payment` be called.
   Inspect the token transfer and callback receipts: the supplier gains exactly `"4000000"`, the
   purchase becomes `Completed`, and the supplier-payment operation becomes `Succeeded` once.
5. Supplier creates the failure offer with the same limits. Only Buyer A contributes `"2000000"`.
   After its join deadline, finalize it; the deal must be `Failed` and that commitment `Refundable`.
   Buyer A calls `claim_refund`. Inspect both receipts; the buyer regains exactly `"2000000"`, the
   commitment becomes `Refunded`, and its operation is `Succeeded` once.
6. Call `reconcile_token_balance`, wait for its callback, and read `get_accounting` plus Circle's
   `ft_balance_of(V5)`. With no unrelated direct transfers, totals across these two deals must be
   accepted `"6000000"`, supplier-paid `"4000000"`, refunded `"2000000"`, outstanding liability
   `"0"`, observed V5 balance `"0"`, and reconciliation status `balanced`.
7. Negative checks: a duplicate contribution must return the entire `"2000000"` as unused and add
   no commitment; an outsider and the supplier cannot vote as funded members; payout before
   approval fails; a second fulfillment vote, refund, or payout fails; the wrong token and wrong
   amount return fully unused. A successful top-level `ft_transfer_call` can still mean rejection,
   so prove the unused-token refund from receipts and final balances.

Capture transaction hashes, every receipt status, before/after raw balances, operation IDs, and the
final purchase/accounting views. A wallet return or top-level transaction alone is not acceptance
evidence.

1. keep V5 isolated from the default V4 configuration;
2. preserve the exact Circle token identity and registered participants;
3. capture final receipt graphs, operation records, and `ft_balance_of` values for every future
   authorized Testnet action;
4. investigate any missing callback or balance mismatch before authorizing another financial call.

## Recommendation

**The low-value Circle-USDC Testnet smoke test is complete. NO-GO for replacing the hackathon V4
demo or treating this prototype as production payment/delivery infrastructure.** Preserve V4 as the
public default while the isolated V5 path proceeds through the next UX review.
