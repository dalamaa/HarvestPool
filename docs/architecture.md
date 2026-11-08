# HarvestPool phase 1 architecture

## Scope and trust boundary

The Rust contract is the only authority over purchase terms, eligibility, commitments, votes, state transitions, refunds, and farmer payment. NEAR wallet signatures establish the caller account. The Flask app may cache public metadata in SQLite and prepare wallet transaction arguments, but it cannot sign, withdraw, redirect, alter terms, or impersonate a member.

There is no organizer key in the contract. The proposer is recorded for attribution only. The farmer can submit evidence but cannot release its own payment. A deployment account can technically replace contract code through NEAR account permissions; a production deployment must put that permission behind a multisig/DAO and require an audited migration policy.

The prototype uses native NEAR, not an FT. A future stable-currency flow must add a separately reviewed NEP-141 accounting and callback model.

## Purchase state machine

```text
Proposed --(2/3 member offer approvals)--> Open
Proposed --(deadline, not approved)-------> Failed
Open ------(deadline, min not met)--------> Failed
Open ------(deadline, min met)------------> Funded
Funded ----(farmer submits evidence)------> FulfillmentPending
Funded ----(evidence deadline)------------> Failed
FulfillmentPending --(2/3 funded voters)-> FulfillmentApproved
FulfillmentPending --(evidence deadline)-> Failed
FulfillmentApproved --(payment call)-----> PaymentPending
PaymentPending --(transfer success)------> Completed
PaymentPending --(transfer failure)------> FulfillmentApproved
```

`Failed` makes every active commitment `Refundable`. A member cancellation during the immutable cancellation window also makes that commitment refundable while the purchase remains `Open`. `claim_refund` changes `Refundable -> RefundPending` before scheduling a transfer; its private callback changes it to `Refunded` on success or back to `Refundable` on failure.

## Rules

- The community membership set is unique and bounded at initialization (maximum 100).
- Offer approval is `ceil(2 * member_count / 3)` yes votes. Each fixed member may vote once; no voter argument is accepted from the client.
- Commitments require `quantity > 0`, exact `quantity * price_per_unit` attached, one commitment per account, and `total_quantity <= max_quantity`.
- Terms are stored on the purchase and there is no update method. Terms include minimum/maximum quantity, price, deadline, cancellation deadline, evidence deadline, and full-refund policies.
- Fulfillment evidence is a bounded public hash/reference. It is not private and is not independently verified by the contract.
- Fulfillment approval is `ceil(2 * funded_households / 3)` yes votes. Only active funded commitment holders can vote once.
- `release_payment` is permissionless after approval. The state becomes `PaymentPending` before the transfer; the private callback is the only code path that marks success or restores a retryable approval state.
- There is no generic withdraw, sweep, organizer payout, or backend-authorized transfer method.

## First-use-case parameters

The first neighborhood can initialize 20 member accounts and approve weekly offers with a 14-member supermajority. A typical offer sets `min_quantity = 20`, `max_quantity` to the farmer's cap, a fixed price per box, the order deadline, member cancellation deadline, and a bounded fulfillment review window. Each household can commit one or more boxes as long as the total stays within the cap.
