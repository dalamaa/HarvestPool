# HarvestPool phase 1 security review

Verdict: the contract foundation is suitable for testnet experimentation after the checks below, but it is not audited or ready to hold production value.

## Implemented controls

- No contract method can withdraw to an organizer or arbitrary recipient.
- Flask is deliberately outside the signing and custody boundary.
- Callers are derived from `env::predecessor_account_id()`; member and farmer arguments are not trusted as identities.
- Membership and purchase counts, quantities, evidence strings, community size, and fulfillment window are bounded.
- Duplicate member IDs, duplicate votes, duplicate commitments, wrong deposits, oversubscription, and invalid states fail before state changes.
- Refund and farmer payment states are marked pending before NEAR transfers. Private callbacks check the expected state and amount; failed transfers are retryable without paying twice.
- Overflow-checked release arithmetic is enabled and business arithmetic uses checked operations.

## Residual risks and required next work

### High — deployment-key upgrade authority

The NEAR account that owns the contract account can deploy replacement code. That is outside this contract's methods and can defeat its guarantees if the key is compromised. Before any meaningful funds: use a multisig/DAO-controlled deployment account, publish reproducible WASM and hashes, define an audited migration policy, and test rollback/upgrade behavior.

### High — no independent audit

The contract handles pooled money but has only local unit/sandbox coverage in this phase. Commission an independent review, fuzz/property testing, and a transfer/callback failure audit before production.

### High — callback failure can strand funds

NEAR callbacks can themselves fail. The code keeps a failed refund retryable and keeps a failed farmer payment in `PaymentPending` if its callback never executes. That prevents double payout but can strand a pending operation. Add an explicitly safe, time-delayed recovery design after testnet experiments; do not add a blind retry that could double-pay.

### Medium — public ballots and quantities

NEAR state and transaction activity are public. This phase does not provide private ballots, private order quantities, or anonymity. The app must not market those properties. See `docs/confidential-compute.md`.

## V3 issue and decision boundary

V3 issue text and decision outcomes are public on NEAR. `raise_issue`, `request_group_vote`, and
`resolve_issue` use asynchronous reads of the immutable V2 purchase view; the callback is the only
path that writes the verified result. A decision captures the active funded accounts at open time,
counts one choice per account, requires a 2/3 matching-choice threshold, rejects votes after
the deadline, and allows only one active decision per purchase. A supplier-facing pickup decision
remains pending until the named supplier agrees.

V3 deliberately has no V2 update, withdrawal, payment, refund, price, quantity, supplier, or
deadline method. Separate V3 instances are deployed on Testnet for V2 and V4; V3 is not a privacy
layer and is not audited or approved for production use.

Rejected V3 callbacks currently panic after attempting to remove their pending request. Receipt
rollback restores that request, creating a persistent storage leak that a caller can repeat. This is
an availability defect, not a path into V4 funds. A new V3 version must use non-panicking rejection
cleanup and bounded/expiring pending requests before it replaces the deployed prototype.
Deployment must use a separately controlled account and must verify its configured V2 contract
before the browser is pointed at it. Callback-backed browser actions must reread V3 state before
claiming that an asynchronous issue or decision write succeeded.

### Medium — fulfillment evidence is a claim plus member vote

The contract checks that the named farmer submitted a bounded evidence reference and that funded members approved it; it does not verify a photo, delivery record, GPS, or oracle result. Define evidence formats, dispute handling, and a Sybil-resistant membership process before production.

### Medium — fixed membership and Sybil assumptions

One NEAR account equals one vote only because membership is fixed at initialization. The contract does not prove that an account maps to one real household. Onboarding, account recovery, lost keys, household eligibility, and membership changes require a separately governed contract upgrade or registry.

The additive V2 open-purchase path does not change the global community registry. It gives a purchase-level membership only after an exact native-NEAR commitment succeeds, enforces the funded-household cap during execution, and uses that active commitment for one fulfillment vote. The existing Phase 1 deployment remains fixed-membership until a reviewed upgrade is deployed. The V2/V4 path does not implement NEP-141/USDC; the separate V5 candidate has its own tested `ft_resolve_transfer` unused-token path but remains undeployed and unverified with Circle's live token.

### Medium — native NEAR price volatility

Price is denominated in yoctoNEAR. A farmer who needs USD or a stable asset is exposed to price movement. A future FT/stablecoin implementation must be reviewed independently.

### Low — state/storage economics

The prototype caps members, purchases, quantities, evidence size, and review windows. It does not charge a storage deposit, so the fixed purchase cap is part of the safety budget. Increase limits only with measured state costs and a user-funded storage policy.
