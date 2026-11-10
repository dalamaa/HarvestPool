# HarvestPool phase 1 architecture

## Scope and trust boundary

The Rust contract is the only authority over purchase terms, eligibility, commitments, votes, state transitions, refunds, and farmer payment. NEAR wallet signatures establish the caller account. The Flask app may cache public metadata in SQLite and prepare wallet transaction arguments, but it cannot sign, withdraw, redirect, alter terms, or impersonate a member.

The separate V3 Rust contract is the authority for issue authorization, fixed voter snapshots,
group-decision thresholds, supplier agreement, and issue/decision outcomes. It reads the V2
purchase view asynchronously and stores issue narrative separately from V2 financial state. V3
allows only one active decision per purchase and does not expose a method that can alter V2
purchase terms or transfer funds.

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
- V2 open purchases keep `max_quantity` (purchased units) separate from `max_funded_members` (funded households). The current state is checked inside each `commit` execution; no reservation is used. A failed native-NEAR call does not write a commitment, and NEAR returns the attached deposit apart from transaction fees.
- V2 open purchases still require the initialized community's offer approval before they open. After approval, any account may become a purchase member only through one successful exact-funded commitment; that active commitment is the account's one vote on fulfillment.
- Terms are stored on the purchase and there is no update method. Terms include minimum/maximum quantity, price, deadline, cancellation deadline, evidence deadline, and full-refund policies.
- Fulfillment evidence is a bounded public hash/reference. It is not private and is not independently verified by the contract.
- Fulfillment approval is `ceil(2 * funded_households / 3)` yes votes. Only active funded commitment holders can vote once.
- `release_payment` is permissionless after approval. The state becomes `PaymentPending` before the transfer; the private callback is the only code path that marks success or restores a retryable approval state.
- There is no generic withdraw, sweep, organizer payout, or backend-authorized transfer method.

## First-use-case parameters

The first neighborhood can initialize 20 member accounts and approve weekly offers with a 14-member supermajority. A typical offer sets `min_quantity = 20`, `max_quantity` to the farmer's cap, a fixed price per box, the order deadline, member cancellation deadline, and a bounded fulfillment review window. Each household can commit one or more boxes as long as the total stays within the cap.

### Token payment boundary

The implemented V2 path accepts native NEAR only. A future NEP-141/USDC path must use the token standard's `ft_transfer_call`/`ft_resolve_transfer` flow: validate the exact token amount, deadline, duplicate account, unit capacity, and current funded-household capacity in the receiver execution; write membership only after the transfer is accepted; and return the full amount as unused when the last spot, deadline, or any other validation fails. Partial acceptance is not allowed for a household commitment. A pending transfer receipt must be idempotent so a failed callback cannot create membership or strand tokens. This path is intentionally not enabled until it has its own sandbox balance/refund and concurrency tests.
