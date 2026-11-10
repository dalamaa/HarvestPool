# HarvestPool V5 implementation report

Date: 2026-11-09. Scope: isolated native-USDC V5 candidate, corrected V3-for-V5, local frontend
integration, read-only Circle/NEAR verification, and local Sandbox testing. No account creation,
deployment, token transfer, Testnet state mutation, Git push, or V4/V3-for-V4 source change was
performed.

## 1. Files created or changed

Created:

- `contract-v5/`: V4-derived native-USDC purchase contract plus Sandbox suite.
- `contract-v3-v5/`: V3-derived voting contract with bounded and cleanable pending requests.
- `mock-usdc/`: six-decimal NEP-141/NEP-145 Sandbox fixture with transfer-failure injection.
- `web/static/usdc-payments.js` and test: exact base-unit parsing/formatting and transfer-call payloads.
- `docs/v5-usdc.md`: identity, accounting, artifacts, deployment configuration, and release gates.

Changed for isolated integration: workspace Cargo membership/lockfile, frontend transaction adapter,
frontend configuration/rendering, `.env.example`, README, and associated JavaScript tests/docs. V4
remains the default environment. The preserved V4 and V3 sources still hash to:

- `contract-v4/src/lib.rs`: `3d9c517a0356082fc1e6f98bd966adea4bbba0c43eba32ef59f606a831e6680c`
- `contract-v3/src/lib.rs`: `f02ddb2a6a2441a28781e90fd4ed42beb378d1c1bf9cad0a14560d0ee450c1a5`

## 2. Contribution, refund, and payout logic

V5 accepts only `ft_transfer_call` receipts from the configured token. On `.testnet`, initialization
also requires Circle's exact official account. `ft_on_transfer` validates the versioned message,
actual sender, supplier agreement, state, exact amount, deadline, duplicate status, unit capacity,
household limit, and funded-member capacity. A rejected transfer writes no membership and returns
the full amount as unused.

Refunds and payouts allocate monotonic operation IDs, lock state, read recipient registration, call
`ft_transfer` with one yoctoNEAR, and finalize only in a private matched callback. Observed failure
restores retryability. A missing transfer callback becomes `ReconciliationRequired`; it is never
blindly retried.

## 3. Reused versus rewritten logic

Reused from V4: supplier allowlist/profile, supplier-created offers, organizer requests and supplier
acceptance, agreement fingerprints, immutable terms, quantity/member limits, cancellation cutoff,
finalization, fulfillment evidence, funded-member votes, two-thirds approval, failed-order refunds,
and terminal lifecycle guards.

Rewritten for V5: inbound native-NEAR `commit` became NEP-141 receiver acceptance; native promises
became token registration checks plus `ft_transfer`; operation/accounting/reconciliation records
were added; ambiguous callback handling was made explicit. No swap, bridge, fiat, card, or alternate
token path was added.

## 4. Security and accounting protections

- Official Testnet token identity pin plus predecessor authentication.
- Six-decimal integer arithmetic with checked multiply/add; no JavaScript or Rust floating point.
- Contract-execution capacity checks make concurrent final-slot acceptance atomic.
- One commitment per account and supplier self-funding rejection.
- Pending-before-promise state and operation-ID callbacks prevent duplicate refund/payout calls.
- Private callbacks and promise-result checks; wallet return is not financial confirmation.
- Accepted/refunded/paid totals, outstanding liability, observed token balance, and explicit
  balanced/shortfall/surplus status.
- Direct token transfers do not create membership and surface as reconciliation surplus.
- No organizer withdrawal, arbitrary recipient, or generic sweep method.

## 5. Sandbox results

Final serial run against the final V5 artifact: **4 passed, 0 failed** in 87.32 seconds.

Covered: exact 50 USDC; wrong amount/full unused return; wrong token; malformed/duplicate/supplier
rejection; expiry; concurrent final spot; cancellation; missed minimum; recipient unregistered then
registered retry; injected token-transfer failure and retry; exact refund; duplicate refund guard;
outsider/supplier vote rejection; premature payout rejection; exact supplier payout; duplicate
payout guard; and balance/liability reconciliation.

Repository checks: **32 Rust unit tests passed**, 16 opt-in Sandbox tests correctly ignored in the
default workspace run, **26/26 JavaScript tests passed**, JavaScript syntax passed, Python compiled,
and all 12 Flask routes returned HTTP 200 under V5 placeholder configuration.

## 6. V3-for-V5 compatibility

The dedicated contract reads V5's authoritative commitments and grants one vote to each active
funded account. Sandbox verifies funded-only issue creation, two-of-three-style ceiling threshold
logic (2 required for two active voters in the exercised journey), Yes/No and three-option voting,
supplier consent, duplicate request rejection, and unchanged V5 financial fields.

The V3 storage leak is corrected: callbacks remove pending records before validation, rejection
returns without panicking, pending requests are capped at 100, records carry timestamps, and a
permissionless one-hour cleanup makes late callbacks no-op.

## 7. Frontend status

V5 is explicit configuration only; `.env.example` remains V4. The V5 path displays six-decimal USDC,
checks `storage_balance_of` and `ft_balance_of`, sends one-yocto `ft_transfer_call`, uses a 100-Tgas
budget for token/outbound chains, prevents duplicate submissions, persists pending confirmations,
and confirms membership by rereading V5. It separately reports insufficient USDC, missing token
registration, and insufficient Testnet NEAR network fees.

Pure helper/adapter tests and Flask route rendering pass. A real Meteor wallet + Circle token browser
journey remains unperformed and is a release gate.

## 8. Remaining defects and risks

- **Release blocker:** no authorized Circle-token Testnet contribution/refund/payout receipts.
- **Resolved acquisition question:** Circle's public faucet now explicitly offers Near Testnet,
  20 test USDC per request, subject to its displayed two-hour address/blockchain limit. No claim
  was made during this review.
- **High operational caution:** an absent transfer callback is safely frozen but has no automatic
  on-chain resolution method. Receipt/balance investigation is required; adding an override without
  proof would create double-transfer risk.
- **Medium availability:** purchase/operation state is bounded but contract-subsidized. Arbitrary
  organizer requests can consume the 500-purchase prototype cap; deployment should use a controlled
  pilot account policy or reviewed storage-deposit design before broader exposure.
- **Medium verification:** mock USDC follows the standard but does not reproduce Circle issuer
  pause/blocklist/admin behavior or every gas profile.
- **Medium release tooling:** WASMs are host-built non-reproducible artifacts; reproduce on the
  submission build environment before deployment.
- **Manual checks:** Meteor popup/redirect, mobile/accessibility, public hosting, RPC delay behavior,
  and final transaction-outcome UX still need an authorized browser exercise.

## 9. Artifacts and deployment proposal

| Contract | Bytes | SHA-256 |
| --- | ---: | --- |
| V5 | 273,067 | `37858d4e64be52f09bdf5541cd7379075eb69c08bb289edd1c7e090d81ddf8cf` |
| V3-for-V5 | 219,131 | `a0f1e9fd382288c7cc04ec362cd56fd869dba44425a7b88b24c66046704233a3` |
| mock USDC | 178,309 | `f577570882cc937d132b677c076af68a99493e194c81aa8792f17b0af2877f7f` |

Circle Testnet token:
`3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`, metadata `USDC`, 6 decimals,
NEP-141 `ft-1.0.0`, storage registration 0.00125 NEAR. Proposed new-account balances are 10 NEAR for
V5 and 5 NEAR for V3-for-V5. Initialize V5 with the exact token and `token_decimals: 6`; initialize
V3-for-V5 with the new V5 account. Exact JSON and the later smoke sequence are in `v5-usdc.md`.

## 10. Verdict

**GO for preserving and presenting V4 as the hackathon-critical public demo.**

**GO for code review and local Sandbox demonstration of the isolated V5 candidate.**

**GO for an explicitly authorized, low-value Circle-USDC Testnet smoke test after isolated-account
deployment and token-registration checks. NO-GO for activating V5 as the default or claiming live
USDC support.** The faucet route is now verified, but real Testnet contribution/refund/payout
receipts and the browser-wallet E2E remain unperformed. V4 stays the fallback until that gate passes.
