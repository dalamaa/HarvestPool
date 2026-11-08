# HarvestPool

> HarvestPool makes group purchases easier, safer, and fairer. Communities can combine their purchasing power to get better bulk prices, make important decisions through fair votes without uncomfortable confrontations, and protect their pooled funds from unilateral withdrawals. Clear rules for commitments, payments, and refunds give both buyers and farmers greater confidence.

## The customer problem

Group buying can improve purchasing power, but the usual arrangement makes one organizer the informal bank and decision-maker. Members must trust that person with everyone’s money, accept decisions they may not have fairly influenced, and negotiate refunds when an order changes or fails. Farmers also need confidence that a group’s order is actually funded and that payment rules are clear.

HarvestPool’s first pilot is a neighborhood buying weekly produce boxes from one local farmer. The product is the shared purchasing and decision process—not a fresh-food marketplace and not a generic blockchain escrow.

## Why NEAR is essential

The NEAR contract is the enforceable trust boundary. It authenticates the wallet account making each call, stores immutable purchase terms, counts only attached payments as commitments, enforces one-member-one-vote rules, controls state transitions, and records refund and payment outcomes. A member does not have to trust the Flask server or an organizer to apply those rules correctly.

Flask is only a presentation and metadata layer. It cannot hold pooled funds, sign member transactions, change contract terms, approve fulfillment, redirect payment, or decide refund eligibility. Wallet transactions are signed by users and submitted to the contract.

## Phase 1 features

- Fixed community membership with a two-thirds offer-approval threshold.
- Immutable minimum quantity, maximum quantity, price, deadline, cancellation, and fulfillment-review terms.
- Exact-funded household commitments: no unpaid reservations count toward an order.
- Duplicate commitment, duplicate vote, unauthorized caller, oversubscription, and invalid-transition rejection.
- Funded-household voting on bounded farmer fulfillment evidence.
- Pull-based refunds with pending states and retry behavior after failed transfers.
- Farmer payment only after fulfillment evidence and the required member approval.
- No organizer withdrawal, generic sweep, backend withdrawal, or arbitrary payout method.

## Architecture

| Layer | Responsibility | Authority over pooled funds |
| --- | --- | --- |
| Rust NEAR contract | Terms, commitments, votes, state machine, payment, refunds | Sole authority |
| NEAR wallet | Member/farmer identity and transaction signatures | User-controlled |
| Flask | Read-only presentation and future metadata views | None |
| SQLite | Nonfinancial prototype metadata only | None |

The purchase state machine is `Proposed → Open → Funded → FulfillmentPending → FulfillmentApproved → PaymentPending → Completed`, with unsuccessful paths entering `Failed` and exposing pull refunds. Payment and refund transfers mark state as pending before scheduling an outgoing promise, so a repeated call cannot create a second payout.

## Testnet evidence

The deployed Phase 1 contract is `harvestpool-phase1-2026.testnet`. A live test purchase reached `Completed` after two exact-funded commitments, a deadline finalization, farmer evidence, two household approvals, and a successful payment callback. The artifact checksum and complete explorer links are in [docs/testnet-evidence.md](docs/testnet-evidence.md).

This project has not been deployed to mainnet, pushed to a production environment, or submitted to a hackathon. Do not use the testnet deployment for real funds.

## Known limitations and security status

This is a working hackathon MVP foundation, not an audited production payment system.

- The contract account’s deployment authority can replace the contract code. Production custody requires multisig/DAO-controlled upgrades and an audited migration policy.
- A failed or missing asynchronous callback can leave a payment or refund in a pending state. Recovery must be designed without creating a double-payout path.
- Fulfillment evidence is a public bounded reference plus member approval; the contract does not independently verify delivery.
- Ballots, quantities, and transaction activity are public. HarvestPool does not currently provide private voting or confidential order aggregation.
- Membership is fixed at initialization and does not prove that one NEAR account represents one real household.
- Prices use native NEAR and are exposed to exchange-rate volatility.

See [docs/security-risks.md](docs/security-risks.md) and [docs/confidential-compute.md](docs/confidential-compute.md) for the full review.

## Next MVP milestone

Build the responsive web flow around the existing contract without moving authority into Flask: testnet wallet connection, purchase dashboard, member commitment and voting views, farmer evidence submission, and clear refund status. The next milestone should end with a complete browser-driven testnet journey for one neighborhood purchase.

## Layout

- `contract/` — Rust NEAR smart contract, unit tests, and sandbox integration tests.
- `web/` — minimal Flask metadata shell; no financial authority.
- `docs/architecture.md` — architecture and state machine.
- `docs/security-risks.md` — threat model and residual risks.
- `docs/confidential-compute.md` — current NEAR confidential-compute investigation.
- `docs/deployment.md` — testnet-only build/deploy/runbook and evidence checklist.
- `docs/testnet-evidence.md` — recorded deployment, live transaction links, and final state read.

## Test

```sh
cargo test -p harvest-pool-contract
```

Build the contract from `contract/` with `cargo near build non-reproducible-wasm`, then opt into the sandbox tests:

```sh
cargo test -p harvest-pool-contract --test integration -- --ignored --nocapture
```

The integration tests require a local `near-sandbox` binary, which `near-workspaces` manages. They do not use testnet or mainnet funds.
