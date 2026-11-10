# V2 Testnet deployment and scenario runbook

This runbook prepares a separate V2 contract account. It does not deploy, initialize, or
move any funds by itself. The existing `harvestpool-phase1-2026.testnet` account is preserved.

## Local verification

```sh
cargo test -p harvest-pool-contract
cd contract
cargo near build non-reproducible-wasm
cd ..
cargo test -p harvest-pool-contract --test integration -- --ignored --nocapture
```

The Sandbox suite covers funded-only fulfillment voting, failed-order refunds, and five
concurrent contributors competing for the final two funded-household spots. The contract
caps every V2 open purchase at 20 funded households and also enforces the purchased-unit cap.

## Prepare a separate account

Use a disposable Testnet account owned by the developer or a multisig. Do not reuse the Phase 1
account and do not place a private key in this repository or in Flask configuration. The proposed
new account for this run is `harvestpool-v2-dalamaa-20261108.testnet`; a read-only Testnet check
confirmed that it does not currently exist. Creating the account, deploying code, and initializing
state remain approval-gated actions.

```sh
export V2_CONTRACT="harvestpool-v2-dalamaa-20261108.testnet"
export ORGANIZER="dalamaa.testnet"
export FIRST_BUYER="harvestpool-buyer-20261108.testnet"
export FARMER="harvestpool-farmer-20261108.testnet"
export WASM="target/near/harvest_pool_contract/harvest_pool_contract.wasm"

# Run only after explicit deployment authorization.
near deploy "$V2_CONTRACT" "$WASM"
```

Initialize the V2 account with the fixed community used for offer approval. The organizer is
not given a special vote or a funded membership by creation; it must still satisfy the ordinary
offer-approval and contribution rules.

```sh
near call "$V2_CONTRACT" new \
  '{"members":["dalamaa.testnet"]}' \
  --accountId "$V2_CONTRACT"
near view "$V2_CONTRACT" get_config '{}'
```

The returned configuration must report `supports_open_membership: true` and
`max_funded_members: 20`. If it does not, stop and do not point the frontend at the account.

## First browser purchase: two households

For the first browser journey, initialize the separate V2 account with only the developer wallet
as the fixed community. This keeps offer approval explicit while the two funded households are
the developer wallet and a separate open-membership Testnet account. The organizer is not granted
an extra vote; with a one-account fixed community, the ordinary two-thirds threshold is one vote.

### Lifecycle check

An open purchase starts in `Proposed`. `create_open_purchase` requires the proposer to be a fixed
community member, `vote_on_offer` requires that same community membership but not a funded
commitment, and `commit` requires the purchase to be `Open`. Therefore offer approval must happen
before contribution, but there is no circular dependency: the fixed member can approve the offer
before any household has funded it. The frontend must preserve this order and must not mark a
purchase open locally.

Use `max_quantity: 2`, `max_funded_members: 2`, and a small `price_per_unit` of
`1000000000000000000000` yoctoNEAR (`0.001 NEAR`). Create and approve the offer with
`$ORGANIZER`, fund the first unit from `$FIRST_BUYER`, then connect `$ORGANIZER` in Meteor and
fund the second unit. Verify `open_membership: true`, `total_quantity: 2`,
`funded_member_count: 2`, and `available_funded_member_slots: 0` from `get_purchase` before
moving to fulfillment. No Flask action may mark either wallet funded.

The separate `$FARMER` account should submit the bounded fulfillment evidence. Both active funded
households may vote once; an account without an Active commitment must be rejected. After the
required approvals, `release_payment` may be called by any account, but the contract must transfer
only to the immutable `$FARMER` account and reach `Completed` only after the callback succeeds.

Create a second purchase with the same two-household limits, have only `$FIRST_BUYER` commit one
unit, let the contribution deadline pass, and finalize it as `Failed`. Verify the commitment is
`Refundable`, then claim the refund from `$FIRST_BUYER` and verify `Refunded`. Keep this failed
purchase separate from the successful browser scenario.

## Create a realistic open purchase

Use future timestamps in nanoseconds. The following values describe the one-spot-left test
scenario used by the browser UI: 20-unit maximum, 20 funded-household maximum, 19 existing
commitments, and one remaining funded spot. Create the purchase with a future deadline, then
approve it from the required fixed community members before accepting contributions.

```sh
NOW_NS="$(python3 - <<'PY'
import time
print(int((time.time() + 7 * 24 * 60 * 60) * 1_000_000_000))
PY
)"
REVIEW_NS="$(python3 - <<'PY'
import time
print(int((time.time() + 14 * 24 * 60 * 60) * 1_000_000_000))
PY
)"

near call "$V2_CONTRACT" create_open_purchase \
  "{\"min_quantity\":20,\"max_quantity\":20,\"max_funded_members\":20,\"price_per_unit\":\"1000000000000000000000000\",\"deadline_ns\":\"$NOW_NS\",\"cancellation_deadline_ns\":\"$NOW_NS\",\"fulfillment_evidence_deadline_ns\":\"$REVIEW_NS\",\"farmer_id\":\"$FARMER\"}" \
  --accountId "$ORGANIZER"
```

Approve the offer from the required community accounts, then make nineteen exact one-unit
commitments. The twentieth account should be a disposable Testnet account. Five accounts may
attempt the final two spots concurrently; at most two commitments can become Active because
the contract serializes state changes and checks capacity before recording the payment.

After each transaction, verify the contract rather than trusting a wallet redirect:

```sh
near view "$V2_CONTRACT" get_purchase '{"purchase_id":"0"}'
near view "$V2_CONTRACT" get_funded_members '{"purchase_id":"0"}'
near view "$V2_CONTRACT" is_funded_member \
  '{"purchase_id":"0","account_id":"dalamaa.testnet"}'
```

The browser is ready for this scenario by setting `HARVESTPOOL_CONTRACT_ID` to the deployed V2
account before starting `./start.sh`. Customer-facing amounts show a cached CoinGecko NEAR/USD
estimate first and the exact native-NEAR amount alongside it. The quote is display-only: it does
not change the immutable on-chain amount, and Testnet NEAR has no cash value.

## Scenario set for the deployed V2 account

Prepare these scenarios with real Testnet accounts and successful contract calls after deployment.
Do not insert participants, balances, memberships, or lifecycle states through Flask or a browser
fixture. Keep the scenario IDs and transaction hashes with the deployment evidence.

| Scenario | Contract state to verify | Browser behavior |
| --- | --- | --- |
| One spot left | `Open`, 19 Active funded commitments, `max_funded_members: 20`, `available_funded_member_slots: 1` | Show `1 spot left`; reread capacity before authorization; one racing contribution can succeed and the others must be rejected without retaining principal. |
| Multiple spots | `Open`, at least two funded-member slots remaining, future contribution deadline | Show the current household count and remaining spots; each successful exact contribution adds one Active commitment. |
| Funded, next action pending | `Funded` after the contribution deadline and minimum quantity are satisfied, with no fulfillment evidence yet | Show the farmer handoff as the next action; no payment or voting action appears until the farmer submits evidence. |
| Completed | `Completed` only after bounded fulfillment evidence, the required Active-member approvals, and a successful payment callback | Show the completed purchase and confirmed funded members; do not show a contribution or vote action. |

For every scenario, verify `get_purchase`, `get_funded_members`, and `is_funded_member` after each
state-changing transaction. Also verify duplicate contributions, wrong deposits, capacity races,
refund callbacks, and the absence of voting rights for accounts without an Active commitment.

## Final deployment checklist

- Record the deployment transaction, code hash, initialization transaction, and explorer links.
- Re-run the Sandbox suite against the exact built artifact.
- Verify duplicate contribution rejection, wrong-deposit rejection, capacity rejection, cancellation,
  failed-order refunds, funded-only fulfillment votes, and the no-organizer-vote path.
- Point the frontend to V2 only after the configuration view and one complete test purchase are
  verified.
- Do not modify or redeploy `harvestpool-phase1-2026.testnet` as part of this milestone.
