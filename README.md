# HarvestPool

> **Buy together. Save more. Without the trust issues.**

HarvestPool makes group purchases easier, safer, and fairer. Communities can combine their
purchasing power to get better bulk prices, make important decisions through fair votes without
uncomfortable confrontations, and protect their pooled funds from unilateral withdrawals. Clear
rules for commitments, payments, and refunds give both buyers and farmers greater confidence.

This is a working NEAR Testnet hackathon prototype, not an audited production marketplace. The
canonical local application is V5 on **Circle Testnet USDC**, with its dedicated V3-for-V5 governance
contract. Both are deployed on Testnet and have completed a low-value financial journey. V4 uses
native Testnet NEAR and remains available only as a legacy application. See the [verified V5
financial baseline](docs/v5-financial-baseline.md).

The release boundaries are intentional:

- **V5** is the canonical local application and is deployed and verified with Circle Testnet USDC
  for a successful supplier payout and a failed-purchase refund; local Sandbox coverage remains
  part of the regression suite.
- **V4** is a legacy application on NEAR Testnet with native Testnet NEAR.
- **V3-for-V5** is deployed and verified with funded-member voting and supplier consent against V5.
- **Circle USDC Testnet payments** are verified for the documented low-value Testnet journey only;
  this is not production-payment or delivery evidence.
- Card payments and US bank payouts are not implemented.

## Quick Start

Public browsing needs Git, Python **3.10 or newer**, and internet access. Node.js 20+ is needed only
for browser tests; Rust/Cargo is needed only for contract tests. No npm install, Docker, NEAR CLI,
private key, or local finalizer is required.

### Windows PowerShell

```powershell
git clone https://github.com/dalamaa/HarvestPool.git
cd HarvestPool
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r web\requirements.txt
.\.venv\Scripts\python.exe run.py
```

### macOS or Linux

```sh
git clone https://github.com/dalamaa/HarvestPool.git
cd HarvestPool
python3 -m venv .venv
.venv/bin/python -m pip install -r web/requirements.txt
.venv/bin/python run.py
```

Open <http://127.0.0.1:5011>, then choose **Explore Deals**. The launcher prints the network and
purchase contract at startup and uses these public defaults even when `.env` is absent:

- network: `testnet`;
- purchase/escrow: `harvestpool-v5-usdc-dalamaa-20261109.testnet`;
- decisions: `harvestpool-v3-v5-dalamaa-20261109.testnet`;
- Circle Testnet USDC: `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`.

The portable launcher reads an optional repository-root `.env`; copy `.env.example` only when you
need to change a public setting such as the local port. It refuses legacy V4/V2 or mismatched token
configuration. Never put a seed phrase, private key, or wallet credential in `.env`.

Browsing deals, states, public votes, issues, and decisions needs no wallet. Existing receipt links
in the documentation can also be checked directly in a Testnet explorer. Signed actions need a
Meteor-compatible NEAR Testnet wallet and free Testnet NEAR for gas. Joining additionally needs
Circle Testnet USDC in that wallet and any token storage registration requested by the flow.
Creating, proposing, joining, voting, refunding, reconciling, and paying are real Testnet
transactions; inspect the receiver, method, arguments, amount, and explorer result before approval.

### Common setup problems

- **`py` or `python3` is not found:** install Python 3.10+ with `venv`, reopen the terminal, and
  rerun the commands above. Python 3.11 and 3.13 have been exercised locally.
- **Port 5011 is busy:** stop the service that owns it, or append `--port 5511` to the platform
  startup command and open the printed URL. The launcher never kills another process.
- **Package installation fails:** confirm internet access and that a corporate proxy or certificate
  policy permits PyPI. Do not use `sudo pip`.
- **Deals or wallet controls do not load:** allow HTTPS access to FastNEAR and `esm.sh`, allow wallet
  popups/redirects for the local URL, and confirm the wallet is on Testnet—not Mainnet.
- **The launcher rejects configuration:** compare `.env` with `.env.example`; the default launcher
  intentionally runs only the canonical V5 contract pair and Circle Testnet token.

On macOS/Linux, the existing managed scripts remain available:

```sh
cp .env.example .env
. .venv/bin/activate
./start.sh
./status.sh
```

Use `./restart.sh` and `./stop.sh` for the managed process. These scripts require `lsof`, always
manage V5 on port 5011, and refuse an unrelated listener. Windows does not need Git Bash or WSL;
use `run.py` in the foreground and stop it with `Ctrl+C`.

### Focused checks

Run the Python and JavaScript checks after installing Node.js 20+:

```sh
python -m unittest -v web.test_portable_startup automation.test_finalizer automation.test_healthcheck automation.test_rpc_config
node --test web/static/*.test.js
node --check web/static/app.js
```

On Windows, replace `python` with `.\.venv\Scripts\python.exe`. Contract developers can additionally
run `cargo test -p harvest-pool-v5-contract` and
`cargo test -p harvest-pool-v3-v5-contract`; Rust is not needed to run the website.

### Finalization and independent deployments

Every local client reads and writes the same public V5 Testnet contract. Because
`finalize_purchase` is permissionless, one separately hosted worker can finalize eligible deals
created by any client; each local UI then sees the result through fresh authoritative contract
reads. The judge's Flask process, SQLite file, browser, and computer do not participate in that
state change.

The shared worker is currently **disabled**, and no continuously running hosted worker has been
verified. Automatic finalization is therefore not currently live or guaranteed. Normal local use
does not need finalizer credentials. Running an independent worker requires a separately
provisioned restricted Testnet key and durable SQLite storage; continuously hosting the shared
worker additionally requires a VPS supervisor, health monitoring, backups, and explicit
activation. See [Automatic finalization](docs/automatic-finalization.md) for the reproducible
credential, foreground, systemd, health, and recovery setup. See [V5 readiness](docs/v5-usdc.md)
for an independent contract deployment; never reuse the project's private credentials or point a
new governance deployment at the wrong purchase contract.

## What problem it solves

An informal group buy often makes the organizer the bank, bookkeeper, and final decision-maker.
Members must trust that person not to redirect pooled money. A supplier can also be named without
accepting the proposed terms, and the people who actually contributed may have no fair way to
resolve later coordination questions.

HarvestPool assigns those responsibilities to explicit NEAR contract rules:

- a supplier signs before an organizer's proposed deal can open;
- a V5 contribution counts only when the exact Testnet USDC amount reaches the purchase contract;
- one active paid commitment creates one funded membership, regardless of quantity;
- only eligible funded members approve fulfillment and participate in supported group decisions;
- the organizer has no withdrawal, arbitrary payout, or generic sweep method;
- supplier payment and member refunds follow explicit pending/callback states.

The Flask application presents the marketplace. It does not sign for users, hold pooled funds,
decide eligibility, or release payment.

### V5 native-USDC application

- Exact six-decimal NEP-141 contributions through the configured token's `ft_transfer_call` and
  V5 `ft_on_transfer`; wrong token/message/amount returns the full unused amount.
- Pending operation IDs, recipient storage checks, one-yocto `ft_transfer`, private callbacks,
  observed-failure retry, and frozen reconciliation state for ambiguous missing callbacks.
- Contract balance/liability reconciliation and a dedicated V3-for-V5 with bounded, cleanable
  pending membership validations.
- Local Sandbox coverage with a standards-based mock USDC token, plus the separately documented
  Circle Testnet payout/refund baseline.

See [V5 native-USDC architecture and readiness](docs/v5-usdc.md) for the identity check, state
machine, artifacts, and isolated-account runbook. The current verified state is recorded in the
[V5 financial baseline](docs/v5-financial-baseline.md).

## Why NEAR

NEAR is the enforceable trust boundary rather than an add-on payment badge. Wallet signatures
identify the caller; attached deposits make contributions atomic with contract accounting; public
state exposes the agreement and progress; cross-contract reads let the decision contract verify
funded membership; and promises/callbacks let financial transfers distinguish pending, observed
success, and observed failure.

These capabilities do not prove delivery, legal identity, dollar value, or perfect callback
recovery. Those limits are stated below and in
[Engineering decisions](docs/engineering-decisions.md).

## Implemented features

### V4 purchase and escrow contract

- Allowlisted supplier offers, or organizer requests that remain `AwaitingSupplier` until the named
  supplier accepts.
- SHA-256 agreement fingerprint bound to the purchase and immutable financial/fulfillment terms.
- Exact native-Testnet-NEAR commitments with one commitment per account, unit limits, and a maximum
  funded-household limit.
- Contract-execution capacity checks; concurrent final-slot attempts accept at most one.
- Voluntary cancellation before the cutoff and pull refunds after cancellation or purchase failure.
- Named-supplier fulfillment evidence and one vote per active funded member.
- Supplier payout only after the required `ceil(2n/3)` fulfillment approval.
- Pending states before outgoing transfers, private callbacks, duplicate-transfer guards, and retry
  after an observed transfer failure.

### Dedicated V3-for-V4 decision contract

- Issues and Yes/No or multiple-choice group decisions.
- Cross-contract membership validation against the configured V4 contract.
- Frozen active-funded-member voter snapshots, one public choice per account, and a
  `ceil(2n/3)` matching-choice threshold.
- Rejected, expired, and `NoConsensus` outcomes; named-supplier consent for supported pickup
  arrangements after the ballot passes.
- No authority to change V4 price, quantity, supplier, commitments, refunds, payout, or lifecycle.

### Customer application

- Public Home and Explore pages; deal details, share links, Deal Terms, and contribution flow.
- Organizer/supplier creation modes and named-supplier invitation review.
- Wallet-scoped **My Group Buys**, **My Decisions**, issue creation, fulfillment review, refunds,
  and supplier dashboard.
- NEAR Wallet Selector 10.1.4 with Meteor Wallet for signed Testnet calls; read-only FastNear RPC
  for browser-compatible public reads.
- Wallet-scoped pending actions and authoritative state rereads before displaying completion.

## Architecture

```mermaid
flowchart LR
    U[Customer / organizer / supplier] --> A[Flask + Jinja UI<br/>127.0.0.1:5011]
    U -->|authorizes| W[NEAR wallet]
    A -->|read-only RPC| P[V5 purchase + escrow<br/>Circle Testnet USDC]
    W -->|signed change call| P
    A -->|read-only RPC| D[V3-for-V5 decisions]
    W -->|signed issue / vote / consent| D
    D -->|verify purchase + funded members| P
    P --> N[NEAR Testnet state + receipts]
    D --> N
```

| Layer | Authority |
| --- | --- |
| Flask/Jinja and SQLite | Presentation, public configuration, nonfinancial metadata; no signing or custody |
| NEAR wallet | User-controlled account authorization |
| V4 contract | Supplier agreement, contributions, membership, lifecycle, refund and payout rules |
| V3-for-V4 contract | Issues, voter snapshots, thresholds and decision outcomes; no financial authority |
| V5 contract | Isolated Circle Testnet USDC purchase, accounting, refund and supplier payout rules |
| V3-for-V5 contract | Issues, voter snapshots, thresholds and supplier consent for V5; no financial authority |
| NEAR Testnet | Public contract state and transaction/receipt evidence |

The contracts use Rust, `near-sdk` 5.30.1, Borsh, promises and callbacks. Integration tests use
`near-workspaces` 0.24.0-rc.2 with local NEAR Sandbox. The browser uses public JSON-RPC and NEAR
Wallet Selector. The canonical V5 app uses NEP-141/NEP-145. V4 uses native NEAR and is kept
separate as a legacy configuration.

## Current Testnet contracts

| Role | Account | Verified configuration |
| --- | --- | --- |
| V4 purchase/escrow | [`harvestpool-v4-dalamaa-20261109.testnet`](https://explorer.testnet.near.org/accounts/harvestpool-v4-dalamaa-20261109.testnet) | `V4`, `supplier-authorized-no-offer-vote`, `native-testnet-near` |
| V3 decisions for V4 | [`harvestpool-v3-v4-dalamaa-20261109.testnet`](https://explorer.testnet.near.org/accounts/harvestpool-v3-v4-dalamaa-20261109.testnet) | Configured only for the V4 account; public Yes/No and multiple-choice voting |
| V5 USDC purchase/escrow | [`harvestpool-v5-usdc-dalamaa-20261109.testnet`](https://explorer.testnet.near.org/accounts/harvestpool-v5-usdc-dalamaa-20261109.testnet) | Isolated V5; Circle Testnet USDC; live payout/refund baseline verified |
| V3 decisions for V5 | [`harvestpool-v3-v5-dalamaa-20261109.testnet`](https://explorer.testnet.near.org/accounts/harvestpool-v3-v5-dalamaa-20261109.testnet) | Reads V5 funded membership; live two-buyer decision baseline verified |

Earlier V4 and V2 observation evidence remains in [V4 deployment evidence](docs/v4-deployment.md)
and [Testnet evidence](docs/testnet-evidence.md); it is not the canonical V5 judge configuration.

## Legacy V4 application

V4 on port 5010 is preserved for comparison and historical workflows. It is not controlled by the
root scripts and is never a V5 fallback. Use the explicitly named legacy launcher only when V4 is
intentionally required:

```sh
scripts/restart-v4.sh
scripts/stop-v4.sh
```

The legacy launcher uses the documented V4 purchase and V3-for-V4 contracts, its own port, and the
legacy PID file. Keep V4 and V5 processes separate.

### Local NEAR Sandbox journeys

Build the current V4 and V3 WASM artifacts first:

```sh
cargo install cargo-near --version 0.23.0 --locked
(cd contract-v4 && cargo near build non-reproducible-wasm)
(cd contract-v3 && cargo near build non-reproducible-wasm)
```

Then run the financial and compatibility suites:

```sh
cargo test -p harvest-pool-v4-contract --test integration -- --ignored --nocapture
cargo test -p harvest-pool-v3-contract --test v4_integration -- --ignored --nocapture
cargo test -p harvest-pool-v3-contract --test integration -- --ignored --nocapture
```

Build and run the isolated V5 suite separately:

```sh
(cd contract-v5 && cargo near build non-reproducible-wasm)
(cd contract-v3-v5 && cargo near build non-reproducible-wasm)
(cd mock-usdc && cargo near build non-reproducible-wasm)
cargo test -p harvest-pool-v5-contract --test integration -- --ignored --nocapture
```

The V5 result on 2026-11-09 was 4/4 Sandbox journeys passed. These use the local mock token; the
subsequent Circle Testnet financial result is recorded in the [V5 financial baseline](docs/v5-financial-baseline.md).

These use local `near-sandbox`; they do not deploy or transact on Testnet/Mainnet. The audit run
passed V4 4/4, the two existing V3-for-V4 journeys 2/2, and V3/V2 regressions 2/2. A separate V3
characterization test passed by reproducing—not fixing—the rejected-callback storage leak (348
retained bytes). See [the reliability audit](docs/infrastructure-reliability-audit.md) for exact
scope and outcomes.

Legacy Phase 1 tests remain available:

```sh
cargo test -p harvest-pool-contract
```

## Demo walkthrough

1. Open **Explore Deals** and inspect the product, supplier, target, deadline, funded progress, and
   exact Testnet NEAR separately from the USD estimate.
2. On **Post a Group Deal**, show that an organizer request remains closed until the named supplier
   accepts the complete Deal Terms.
3. On **Join This Deal**, connect a buyer wallet, review the agreement and exact attached amount,
   then wait for the final outcome and contract reread.
4. Open **My Group Buys** to show that confirmed paid commitments—not page visits—create membership.
5. Open **My Decisions** to show funded-member eligibility and one-wallet-one-vote thresholds.
6. Use **Supplier dashboard** for delivery evidence; then show funded-member fulfillment approval.
7. Show a prepared successful supplier payout and a separate failed-purchase pull refund. Never
   describe `PaymentPending` or `RefundPending` as complete.
8. End with the architecture, known defects, and the verified isolated V5 USDC baseline. Do not
   present the Testnet smoke result as production payment or delivery evidence.

The exact screens, actions, expected contract changes, evidence, spoken narrative, and truthful
fallback path are in the [Hackathon demo script](docs/HACKATHON_DEMO_SCRIPT.md).

## Engineering challenges

[Engineering decisions](docs/engineering-decisions.md) explains, with implementation and evidence:

- protecting pooled contributions without organizer custody;
- supplier-authorized agreements and the boundary between wallet authorization and business
  identity;
- the evolution from pre-contribution voting to funded-member decisions;
- concurrent capacity, exact accounting, refunds, duplicate-transfer protection, and callbacks;
- the confirmed V3 callback storage leak and unresolved V4 missing-callback recovery gap;
- why native NEAR volatility led to a separate USDC architecture;
- keeping products, agreements, progress, votes, refunds, and delivery primary in the UI.

## Known limitations

- No formal independent audit; Testnet only; do not use real funds.
- The deployment account's keys can replace code. Production requires governed upgrades and a
  reviewed migration policy.
- The deployed V3 can retain pending request storage when an expected callback validation panics.
  This is a confirmed availability defect, not authority over V4 funds.
- A V4 callback that runs and reports transfer failure restores retryability. A callback that never
  runs can leave an ambiguous pending state; automatic retry would risk paying twice.
- Contribution NEAR and storage reserve share the same account. V4 has no on-chain liability/reserve
  view, so liquid headroom requires external monitoring.
- Supplier wallet allowlisting is not independent business/representative identity verification.
- Fulfillment evidence is a bounded supplier claim plus member approval, not independent proof of
  delivery.
- Votes, purchase quantities, accounts, and transaction activity are public. One wallet is not
  proof of one human or household.
- Native NEAR market value can change. USD estimates are display context and do not alter the exact
  on-chain amount.
- Final wallet popup/redirect, mobile, keyboard, screen-reader, and hosted-public-app verification
  remain manual release checks.
- External RPC, wallet, CDN, faucet, and price services can be delayed or unavailable.

## Isolated native-USDC V5 architecture

The intended stable contribution asset is Circle native USDC on NEAR. V5 is built as a **new local
contract**, never as an untested replacement for V4. It:

- pin the official token account in immutable configuration and reject every other predecessor;
- accept commitments only through NEP-141 `ft_transfer_call` / `ft_on_transfer`;
- store six-decimal raw integer amounts (`1 USDC = 1_000_000`) with checked exact arithmetic;
- return the full amount as unused for malformed, wrong-amount, duplicate, expired, or
  capacity-losing transfers;
- register HarvestPool and outbound recipients under NEP-145;
- persist unique refund/payout operation IDs before `ft_transfer`, finalizing only in matched
  callbacks;
- keep ambiguous missing callbacks frozen for evidence-based reconciliation;
- pre-fund NEAR for gas/storage and reconcile tracked liabilities with the official token balance;
- preserve V4 membership views for a new, fixed V3 decision instance.

The implementation, risks, Sandbox evidence, and required Testnet matrix are in
[V5 readiness](docs/v5-usdc.md). USDC reduces native-asset price
volatility; it does not guarantee issuer availability, redemption, fulfillment, or recovery.

## Repository map

| Path | Purpose |
| --- | --- |
| `contract/` | Earlier Phase 1/V2 purchase lifecycle and regressions |
| `contract-v3/` | Separate issue/decision contract and V2/V4 compatibility tests |
| `contract-v4/` | Current supplier-authorized native-NEAR purchase/escrow contract |
| `contract-v5/` | Isolated native-USDC purchase contract, tests, and Sandbox journeys |
| `contract-v3-v5/` | Corrected, isolated decision contract for V5 membership |
| `mock-usdc/` | Local six-decimal NEP-141/NEP-145 test fixture; not Circle's contract |
| `web/` | Flask/Jinja application, browser wallet/RPC adapter, frontend tests |
| `start.sh`, `restart.sh`, `stop.sh`, `status.sh` | Canonical V5 local process controls on port 5011 |
| `scripts/restart-v4.sh`, `scripts/stop-v4.sh` | Explicit legacy V4 process controls on port 5010 |
| `AGENTS.md` | Permanent V5, wallet-safety, process, and test instructions for coding agents |
| `automation/` | Disabled-by-default, permission-limited V5 finalization worker and tests |
| `docs/automatic-finalization.md` | Worker security boundary, runbook, retries, and settlement limits |
| `docs/release-fitness-report.md` | Clean-checkout, workflow, live-state, and release-gate evidence |
| `docs/engineering-decisions.md` | Evidence-grounded challenge and NEAR innovation story |
| `docs/HACKATHON_DEMO_SCRIPT.md` | Exact demo narrative, actions, results, and evidence |
| `docs/infrastructure-reliability-audit.md` | Contract findings, test outcomes, USDC plan, screening checklist |
| `docs/ux-issue-register.md` | Deferred findings retained for the final visual-cleanup pass |
| `docs/v5-financial-baseline.md` | Verified V5/V3-for-V5 Testnet financial state and artifact hashes |
| `docs/v4-deployment.md` | V4/V3-for-V4 accounts, transactions, artifacts, and hashes |
| `docs/testnet-evidence.md` | Historical Phase 1/V2/V3 evidence |

## Submission status

The local prototype and documentation are not the same as a submitted project. Before claiming the
repository is judge-ready: commit/push the intended files with authorization, scan the tracked tree
for secrets, clone it into a clean directory, execute this README literally, record a native-Linux
build and test run, verify the public app/video, and update time-sensitive Testnet state. The
remaining release checklist is in the [reliability audit](docs/infrastructure-reliability-audit.md).

Licensed under Apache-2.0. See [LICENSE](LICENSE).
