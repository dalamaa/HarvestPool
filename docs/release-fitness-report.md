# Release fitness checkpoint · 2026-11-11

## Evidence boundary

This checkpoint separates three kinds of evidence:

- **Live Testnet read:** public RPC/accounting state and linked historical receipts.
- **Local contract/Sandbox test:** isolated accounts and a mock six-decimal token.
- **Mocked worker/browser test:** deterministic RPC, wallet, restart, and race fixtures.

No contract was deployed or modified and no live transaction was submitted during this pass.

## Live V5 state preserved

Read-only RPC at blocks `277209501`–`277209565` reported the expected V5 contract, Circle Testnet
USDC token account, six decimals, and five purchases. Financial records remained:

- Deal #0 `Completed`, two active commitments, 4,000,000 accepted and supplier-paid units;
- Deal #1 `Failed`, its 2,000,000-unit commitment `Refunded`;
- total accepted 6,000,000; total supplier paid 4,000,000; total refunded 2,000,000;
- outstanding liability 0; observed token balance 0; reconciliation `balanced`; and
- Deal #4 still `Open`, zero commitments, expired, and unfinalized.

The successful 4,000,000-unit supplier transfer is rooted at
[`Gp32zhkmfXFqnL1c6zPPsoy55Fh1LVjjvk3EYiNqLHCm`](https://testnet.nearblocks.io/txns/Gp32zhkmfXFqnL1c6zPPsoy55Fh1LVjjvk3EYiNqLHCm).
The successful 2,000,000-unit buyer refund is rooted at
[`G63ozfWnVsZRRUpZ4zrucMVYR7VErFTEF4NtfurCJy4N`](https://testnet.nearblocks.io/txns/G63ozfWnVsZRRUpZ4zrucMVYR7VErFTEF4NtfurCJy4N).
The original end-to-end fulfillment reference explicitly says
`TESTNET SIMULATION - NO PHYSICAL DELIVERY OCCURRED - DEAL #0`; it is not proof of delivery.

## Workflow fitness

The implemented UI and contract tests cover public marketplace/details, supplier offers, organizer
requests, supplier accept/decline, exact six-decimal USDC contributions, minimum/capacity rules,
Funded/Failed presentation, funded-member voting, fulfillment evidence, payout/refund eligibility,
duplicate guards, wallet restoration, transaction feedback/recovery, and bounded live refresh.
Automatic finalization adds 20 mocked failure/race/restart cases and remains separate from payment.

Historical Testnet receipts prove one payout and one refund. New financial variants use contract
unit/Sandbox tests; this pass did not create another live deal or payment. Responsive CSS and the
focused UX regressions cover narrow layouts, but final hosted-browser checks at 320/375px, 200%
zoom, keyboard, screen reader, and real Meteor popup/redirect remain release gates.

Final local results were 118/118 JavaScript tests, 21/21 finalizer tests, 33/33 Rust unit tests, and
13/13 explicitly enabled Sandbox integration journeys (4 V5, 4 V4, 3 V3-for-V4, 2 legacy V3).
Python/JavaScript compilation passed. The isolated V5 Flask process returned HTTP 200 for all 11
documented customer routes and exposed the intended V5/V3-for-V5 identifiers. The first Sandbox
invocation could not bind a localhost port inside the restricted command sandbox; the identical
suite passed when localhost binding was permitted. That was an environment restriction, not a
contract assertion failure.

## Current blockers and SputnikDAO readiness

The code boundary is suitable for beginning an isolated SputnikDAO design: purchase escrow and
governance are already separate, and no DAO integration should receive direct V5 token authority.
The application is not yet safe to call production-ready or to put real funds at risk. Blockers are:

1. provision and supervise the dedicated `finalize_purchase`-only Testnet key before enabling the
   worker, then run a controlled canary that does not alter preserved evidence;
2. complete the real-wallet multi-role browser and accessibility matrix;
3. rerun/record all opt-in Sandbox journeys from a clean checkout on the release host;
4. add external role notifications and production monitoring/backups;
5. design a future contract for the 72-hour review/dispute fallback and ambiguous settlement; and
6. obtain an independent contract/security review before any real-value use.
