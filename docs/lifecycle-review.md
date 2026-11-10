# Purchase lifecycle review

Status: current V2 behavior preserved; proposal only. No contract was redeployed.

## Verified current behavior

The deployed V2 contract at `harvestpool-v2-dalamaa-20261108.testnet` currently uses:

```text
create_open_purchase
  -> Proposed
  -> vote_on_offer (initialized community members, 2/3 yes threshold)
  -> Open
  -> commit (exact native-NEAR deposit)
  -> finalize_purchase after the deadline
  -> Funded when the minimum quantity was reached
  -> submit_fulfillment_evidence (named farmer)
  -> vote_on_fulfillment (active funded members only)
  -> FulfillmentApproved
  -> release_payment
  -> PaymentPending -> Completed after the transfer callback
```

Unsuccessful finalization or fulfillment enters `Failed` and makes active commitments
refundable. A cancellation during the immutable cancellation window also makes that member's
commitment refundable while the purchase remains `Open`.

The contract does not currently record supplier confirmation before the offer vote. The named
farmer can submit fulfillment evidence later, but that is not the same as confirming the offer
terms before contributions open.

It is unsafe to remove the offer-vote button from the current V2 UI without a contract change:
`Proposed` cannot become `Open` otherwise, and `commit` rejects contributions while the purchase
is not `Open`.

## Deposit and gas audit

The browser adapter uses 30 TGas for ordinary V2/direct methods. V3 methods that read V2 and then
run a V3 callback (`raise_issue`, `request_group_vote`, and `resolve_issue`) use 60 TGas: the V3
contract reserves 25 TGas for the V2 read and 25 TGas for its callback, leaving transaction-level
margin. These are configured gas limits/reservations, not guaranteed realized network fees; the
realized fee must be read from the transaction receipt. The V3 gas fix is frontend-only; the
deployed V3 WASM was not changed.

| Method | Attached deposit | Contract evidence |
| --- | ---: | --- |
| `create_purchase` / `create_open_purchase` | `0 yoctoNEAR` | `assert_no_attached_deposit` |
| `vote_on_offer` | `0 yoctoNEAR` | `assert_no_attached_deposit` |
| `commit` | Exactly `price_per_unit × quantity` | `#[payable]` and exact equality check |
| `cancel_commitment` | `0 yoctoNEAR` | `assert_no_attached_deposit` |
| `finalize_purchase` | `0 yoctoNEAR` | `assert_no_attached_deposit` |
| `submit_fulfillment_evidence` | `0 yoctoNEAR` | `assert_no_attached_deposit` |
| `vote_on_fulfillment` | `0 yoctoNEAR` | `assert_no_attached_deposit` |
| `expire_unfulfilled_purchase` | `0 yoctoNEAR` | `assert_no_attached_deposit` |
| `release_payment` | `0 yoctoNEAR` from caller; contract transfers the recorded funded amount to the farmer | no attached deposit; state is locked before transfer |
| `claim_refund` | `0 yoctoNEAR` from caller; contract transfers the member's recorded commitment amount | no attached deposit; `RefundPending` prevents a duplicate payout |

Voting therefore does not charge the purchase price again. The UI now says that voting attaches
`0 NEAR`; wallet/network gas may still apply.

The current deployed `PurchaseView` exposes aggregate vote counts, not the caller's individual
vote. The frontend therefore suppresses the active button after a confirmed transaction using a
wallet-scoped browser record and shows the current reread status. A future contract view should
expose the caller's recorded decision for durable cross-device verification.

## Smallest safe future lifecycle change

For a new contract version or an explicitly authorized upgrade:

1. Keep the immutable purchase record and use a separate, versioned consent record so existing
   Phase 1/V2 Borsh purchase data is not rewritten.
2. Add a `supplier_confirm_offer(purchase_id)` method callable only by the immutable `farmer_id`,
   with zero attached deposit, while the purchase is `Proposed`. The transaction itself is the
   verifiable supplier confirmation of the exact stored terms, and it transitions the purchase to
   `Open`.
3. Stop using community purchase-approval voting for new purchases. Keep fulfillment approval as
   the meaningful funded-member decision. Do not accept a purchase deposit on either vote method.
4. Keep the purchase `Open` through the contribution deadline unless cancellation and additional
   contribution rules are redesigned together. After the deadline, a permissionless advance call
   can move an Open purchase to `Funded` when the minimum is met or to `Failed` with refunds when
   it is not.

There is no autonomous timer on NEAR. “Automatic progression” therefore still needs a signed
permissionless transaction from the UI, a keeper, or another caller. Moving to `Funded` immediately
when the minimum is reached would be a larger behavioral change because it would also decide
whether later contributions and member cancellation are still allowed.

## Future dollar-denominated contributions

The current path is native Testnet NEAR, whose testnet asset has no cash value. The USD display is
an estimate from the cached NEAR/USD quote and does not change the immutable on-chain NEAR amount.

Future stablecoin support should use a separately reviewed NEP-141 flow: stablecoin-denominated
immutable terms, `ft_transfer_call` receiver validation, exact amount and capacity checks during
the receiver execution, idempotent transfer callbacks, and full unused-amount returns on failure.
The stablecoin amount—not a volatile NEAR quote—must be the financial commitment.
