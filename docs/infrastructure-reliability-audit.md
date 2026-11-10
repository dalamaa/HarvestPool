# HarvestPool infrastructure reliability audit and native USDC migration plan

Audit date: 2026-11-09. Scope: deployed V4 purchase contract, dedicated V3-for-V4 decision
contract, Flask customer app on port 5010, native-USDC feasibility, and NEAR HACKATHON screening.

> **V5 follow-up:** This audit captured the pre-implementation baseline. V5, corrected V3-for-V5,
> mock USDC, frontend routing, and four Sandbox journeys were subsequently implemented locally.
> They remain undeployed and lack an official-token Testnet journey. The current evidence and
> release recommendation are in [V5 readiness](v5-usdc.md), which supersedes this document's
> “not implemented” and faucet-availability statements.

Verdict: **V4 is the safe submission path, with required repository/documentation cleanup. Do not
replace it with USDC before the 2026-11-14 deadline.** The separately versioned V5 USDC candidate
is implemented and Sandbox-tested locally, but it is not deployed and must not be described as live
Circle-USDC support.

No contract source, deployment, account, token balance, or Testnet financial state was changed by
this audit. The only code changes are tests and documentation.

## 1. Findings

### P0 — the public repository cannot reproduce the current prototype (confirmed)

The public repository has one commit, `b54e7d12e4eebb453a841e466bad1c1e1f024687`, while the local
V3/V4 packages, frontend JavaScript, run scripts, and current deployment documents are untracked or
modified. A fresh clone therefore contains the earlier Phase 1 project, not the V4 app being judged.
The public README also describes only the earlier deployment.

Impact: automated screening cannot build or verify the submitted behavior. This is a submission
blocker even though the working tree itself runs.

Required action: review and commit the complete intended submission, include this audit and the
license, push only with explicit authorization, then clone into a new directory and execute the
README literally. Preserve a pre-submission tag and name the baseline/submission diff as required by
the hackathon rules.

### P1 — rejected V3 callbacks retain pending request storage (confirmed defect)

`resolve_issue_raise`, `resolve_group_vote_request`, and `resolve_issue_resolution` remove a pending
request and then use `require!` for expected validation failures. A panic rolls the callback receipt
back, including the removal. Rejected duplicate, unauthorized, expired, inactive-purchase, and
conflicting requests therefore retain their full pending payload. There is no cleanup method or
request cap.

Impact: repeated calls can consume the V3 account's storage reserve and eventually prevent new
issues or decisions. V3 has no financial authority, so this does not withdraw or redirect V4 funds,
but it can deny the voting feature.

Evidence: `rejected_v3_callback_leaves_pending_storage_allocated` reproduces the retained storage in
Sandbox. Existing tests already triggered rejected callbacks but previously checked only the public
issue/decision counts.

Required fix for a new V3 version: make callback validation non-panicking after taking the pending
entry; log and return on expected rejection so cleanup commits. Add bounded pending counts, explicit
cleanup/expiry for abandoned requests, and tests for every rejection branch. Do not upgrade the
deployed V3-for-V4 during the V4 demo without a separately reviewed deployment plan.

### P1 — a missing V4 transfer callback has no safe recovery path (confirmed design gap,
hypothetical trigger)

V4 correctly marks refunds and payouts pending before scheduling a native transfer. A callback that
runs and reports failure restores a retryable state. If the callback itself never executes, the
operation remains `RefundPending` or `PaymentPending` indefinitely. Blindly resetting it is unsafe
because the transfer may have succeeded and a retry could pay twice.

No missing callback was observed in the tests; ordinary failed transfers were recovered correctly.
This is therefore a real code-path gap with a hypothetical trigger, not an observed loss.

Safeguards for the prototype: use the tested gas budget, do not upgrade/delete the contract while
financial callbacks are outstanding, monitor receipt completion, and stop rather than retry when
outcome is ambiguous. A future version needs durable operation IDs and an explicitly reviewed
reconciliation/migration process; it must not promise automatic recovery from an unknowable receipt.

### P2 — native-NEAR escrow depends on a separate liquid NEAR reserve (confirmed architecture risk)

Contribution NEAR and the contract account's deployment/storage reserve share one account balance.
Writing purchases and commitments increases storage staking, while payout/refund transfers attempt
to send the full recorded contribution. Without separately funded liquid headroom, a correct transfer
can fail even though accounting says the amount is owed.

The deployed V4 was funded with substantial Testnet NEAR and the failure callback is retryable, so
the current one-commitment demo is not shown insolvent. The contract has no on-chain reserve or
liability view, however. Before each demo, compare account liquid balance, storage usage, active
liabilities, and pending transfers. Never count customer contributions as storage funding.

USDC separates token escrow from NEAR storage/gas, but still requires a pre-funded NEAR operating
reserve because incoming `ft_transfer_call` does not fund HarvestPool's storage.

### P2 — deployed-source reproducibility and README evidence are stale (confirmed)

Before this audit, the V4 deployment document said zero purchases while final RPC reads found
purchase count `1` and an open purchase with one active native-NEAR commitment. The old README also
said V4 and V3-for-V4 were undeployed. Those local claims are now corrected/time-stamped. The
deployed WASM hashes match the recorded local artifacts, but the exact V3/V4 source is not in the
only public commit and the reproducible V3 build was not completed.

Required action: publish the exact source and hashes, preserve the working deployment, clearly mark
live reads as time-stamped, and avoid claiming publicly verifiable/reproducible source until a clean
native-Linux build is recorded.

### P2 — current USDC receiver is not token-storage registered (confirmed, expected)

Circle's official Testnet token returned `null` for `storage_balance_of` on the V4 account. V4 is a
native-NEAR contract and should not receive USDC. A future USDC contract must be registered on the
official token before any transfer test, and suppliers/refund recipients must be registered before
outbound transfers can complete.

### P3 — local process control briefly lost its PID record (observed and restored)

All eleven Flask routes returned HTTP 200, but an audit-environment start attempt briefly removed
the PID record while the existing debug-reloader remained on port 5010. The controlling PID was
verified without stopping either process, the ignored PID file was restored, and `status.sh` now
reports `RUNNING`. A judge-facing runbook should still start from a stopped process and must never
kill an unknown port owner.

## 2. What the contract audit did and did not find

### V4 controls verified

- No organizer, backend, or arbitrary-recipient withdrawal method exists. Supplier payment always
  targets the immutable named supplier and only after fulfillment approval.
- Supplier offers require an allowlisted supplier signature. Organizer requests cannot accept or
  decline themselves; only the named supplier can do so.
- Contributions require `Open`, a supplier agreement, a non-supplier caller, a pre-deadline call,
  one commitment per account, exact `price * quantity`, and both household and unit capacity.
- NEAR executes conflicting commitments serially. Sandbox submitted two final-slot calls
  concurrently and exactly one succeeded; there is no confirmed capacity race.
- Quantity and amount arithmetic uses checked operations; release builds enable overflow checks.
- Only active paid commitments vote on fulfillment, once per account. The threshold is
  `ceil(2n/3)` and supplier accounts cannot fund or vote on their own purchase.
- Finalization, evidence, voting, expiry, refund, and payout methods enforce their lifecycle states
  and deadlines. Terminal `Completed`/`Failed` purchases expose no transition back into funding or
  fulfillment.
- Refund/payment calls set pending state before the promise. A second call cannot schedule a
  duplicate transfer. A callback validates purchase/account/amount and restores the retryable state
  on an observed transfer failure.
- Purchases are capped at 500; commitments/votes are bounded at 20 per purchase; text, evidence,
  quantity, and fulfillment windows are bounded.

No unauthorized release, double refund, duplicate supplier payout, contribution mis-accounting, or
terminal-state mutation was reproduced.

### V3-for-V4 controls verified

- The configured purchase contract is immutable and is the only membership/authority source.
- Issue and decision callbacks use the purchase view rather than trusting browser-supplied voter or
  supplier identities.
- Decision eligibility is a fixed snapshot of active paid commitments. Outsiders and duplicate
  voters fail.
- Yes/No and multiple-choice decisions require one option to receive `ceil(2n/3)` matching votes;
  silence and split votes do not pass.
- Supplier consent is accepted only from the purchase's named supplier and only after a ballot
  passes. Expired or rejected decisions cannot later be approved.
- V3 has no method that can change V4 terms, commitments, refunds, payout, or state. Cross-contract
  compatibility tests showed V4 financial fields unchanged.

The pending-storage defect above remains material even though financial isolation is sound.

## 3. Tests and evidence

Run on 2026-11-09 against the working tree and recorded artifacts:

| Check | Result |
| --- | --- |
| `cargo test --workspace --all-targets` | 25 unit tests passed; 12 Sandbox tests correctly ignored by default |
| V4 Sandbox integration | 4/4 passed |
| V3-for-V4 Sandbox integration | 2/2 existing journeys passed |
| V3/V2 Sandbox regression | 2/2 passed |
| V3 rejected-callback storage characterization | Passed; reproduced 348 retained bytes for one duplicate request |
| V4 browser gas-budget regression | Added; refund/payment paths use 30 Tgas with 20-Tgas callbacks |
| `node --test web/static/*.test.js` | 23/23 passed |
| `node --check web/static/app.js` | Passed |
| `python3 -m py_compile web/app.py` | Passed |
| Flask route smoke test | 11/11 routes returned HTTP 200 |

The first Sandbox attempt failed only because the restricted audit environment could not bind local
ports. The identical tests passed when allowed to bind loopback. No Testnet transaction was sent.

Read-only final RPC checks confirmed:

- V4 reports version `V4`, lifecycle `supplier-authorized-no-offer-vote`, and payment asset
  `native-testnet-near`.
- V4 purchase count is `1`; purchase `0` is `Open` with one active native-NEAR commitment.
- V3-for-V4 points exactly to `harvestpool-v4-dalamaa-20261109.testnet`, with zero issues and zero
  decisions at the observation time.
- Circle Testnet USDC reports `spec: ft-1.0.0`, symbol `USDC`, and `decimals: 6`.
- V4 has no storage registration on the Circle token, as expected for a native-NEAR version.

## 4. Required native-USDC architecture

Create a separate package and deployment (for example, `contract-usdc/`); do not upgrade or repoint
V4. The immutable contract configuration must contain exactly Circle's official NEAR Testnet token
account:

`3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`

Circle publishes that identity in its official contract-address list. The live token and Circle's
official source implement NEP-141 core transfers, resolver callbacks, metadata, and NEP-145 storage.
USDC uses six decimals: one USDC is raw amount `1_000_000`; `$50.00` is `50_000_000`. Store and
compare raw `u128` integers only—never floating-point values or NEAR's 24-decimal conversion.

### Inbound contribution

1. The member calls the official token's `ft_transfer_call`, attaching exactly 1 yoctoNEAR to the
   token call, with HarvestPool as `receiver_id`, an exact raw amount, and a versioned JSON message
   such as `{ "v": 1, "action": "commit", "purchase_id": "0", "quantity": 2 }`.
2. `ft_on_transfer(sender_id, amount, msg)` must compare
   `env::predecessor_account_id()` with the immutable `configured_usdc_contract_id`. A different
   token predecessor receives the entire amount back as unused and creates no state. Never accept a
   token account from `msg`, the browser, or `sender_id`.
3. Parse bounded input, checked-multiply raw price by quantity, and validate supplier agreement,
   `Open`, deadline, unique member, household limit, unit capacity, household capacity, and exact
   amount in the receiver execution.
4. On any invalid/malformed/wrong-amount request, make no membership/accounting change and return the
   **entire amount as unused**. Do not partially accept a household contribution.
5. On acceptance, atomically record the active commitment and increase tracked USDC liabilities,
   then return `0` unused. A pending wallet/RPC result is not confirmation; the client must wait for
   final transaction outcome and reread the commitment.
6. A repeated user call after an accepted commitment returns the full second amount unused because
   the account is already committed. Capacity conflicts remain serialized at the receiver; the
   losing transfer is returned by the token resolver.

NEP-141 defines `ft_transfer_call -> ft_on_transfer -> ft_resolve_transfer`; the token contract, not
HarvestPool, performs the unused-token resolution. HarvestPool must never claim that a transfer was
refunded until the final receipt and authoritative balances/state confirm it.

### Refund and supplier payout

- Keep explicit `Refundable -> RefundPending -> Refunded` and
  `FulfillmentApproved -> PaymentPending -> Completed` transitions.
- Create a monotonically increasing outbound operation ID and persist its purchase, recipient,
  amount, type, and state before calling the configured token's `ft_transfer` with exactly 1
  yoctoNEAR and a bounded memo.
- The private callback must match operation ID, expected state, recipient, token, and amount. On
  observed success, finalize once; on observed failure, restore retryability. Calls made while
  pending must fail.
- Verify recipient token storage registration before scheduling, or allow the transfer to fail and
  restore retryability with a clear instruction to register. Never redirect an unregistered
  recipient's money to another account.
- A missing callback is ambiguous. Do not reset or retry automatically. Freeze the operation,
  reconcile final receipts and the official token balance off-chain, and use only a reviewed,
  separately authorized recovery/migration path.

### Storage, gas, and reconciliation

- Register the new HarvestPool account with the official USDC contract using NEP-145 before any
  contribution. Verify `storage_balance_of` on-chain.
- Pre-register the pilot supplier. Contributors holding faucet USDC will normally be registered,
  but check registration before promising that a refund can be received.
- Pre-fund the HarvestPool contract with Testnet NEAR for its own state growth, gas, attached
  1-yocto token calls, and callback headroom. Incoming USDC does not fund these costs.
- Expose tracked accepted USDC, successful refunds, successful payout, current liabilities, and
  pending outbound operations. Off-chain monitoring must compare those totals with the official
  token's `ft_balance_of(contract_id)` at finality.
- Direct `ft_transfer` donations can increase token balance without a commitment. Treat surplus as
  unattributed and unusable; never add a generic sweep to the prototype. If actual balance is below
  liabilities, stop new contributions and payouts and investigate.
- Circle's token can be paused and accounts can be blocklisted. A pause or blocklist can delay
  contributions, refunds, or payout. HarvestPool cannot guarantee availability or redemption and
  must state that limitation.

## 5. V3 migration compatibility

The existing V3 interface consumes `get_purchase` fields `proposer`, `farmer_id`, `state`, and
commitments containing `account_id` plus string state `Active`. A USDC purchase contract can remain
compatible by preserving that view shape and `get_funded_members`/`is_funded_member` behavior.
Voting does not need token transfer authority and must remain a separate contract.

Do not repoint or reinitialize the deployed V3-for-V4; it has no setter and belongs to V4. Deploy a
new decision instance for the USDC contract. Before doing so, fix the callback-storage defect in a
new V3 source version and rerun the V4 plus USDC compatibility suites. The token version should also
return an explicit `payment_asset` and token account in `get_config`, while retaining the legacy
field aliases V3 reads.

## 6. USDC feasibility and test matrix

Genuine tests are feasible. Circle's public faucet lists NEAR Testnet and supplies 20 test USDC per
address/network every two hours. Circle's official address list identifies the token contract, and
read-only RPC confirmed live six-decimal metadata. No faucet request or token transfer was made in
this audit.

Minimum test matrix for the new version:

- official token accepted; any other NEP-141 token rejected with 100% unused return;
- malformed message, zero quantity, wrong amount, too many decimals, overflow, duplicate member,
  supplier self-funding, expired purchase, missing agreement, household cap, and unit/household
  contention all return the full amount and write no commitment;
- concurrent final-slot `ft_transfer_call` executions accept exactly one and refund the loser;
- cancellation, failed minimum, and unfulfilled purchases refund the exact raw micro-USDC amount;
- unregistered, paused, blocklisted, deleted, or failing recipients restore retryable outbound state;
- duplicate refund/payout calls and duplicate callbacks transfer at most once;
- low gas fails safely; normal frontend gas completes the transfer and callback;
- missing/ambiguous callback remains frozen and is never presented as success;
- tracked liabilities equal accepted deposits minus confirmed outbound transfers; direct token
  donations do not create members or withdrawable surplus;
- V3 accepts only active USDC-funded members, snapshots voters, enforces thresholds/expiry/supplier
  consent, and has no token authority;
- real Testnet smoke: storage registration, faucet funding, valid/invalid contribution, finality
  reread, refund failure/retry, and payout failure/retry. Save receipt links and final balances.

Estimated focused effort after design freeze: 1.5–2 days contract and unit tests; 1.5–2 days token
Sandbox/failure tests; 1–1.5 days frontend/wallet changes; 0.5–1 day deployment, genuine Testnet
smoke, reconciliation, and docs. Total: roughly 4.5–6.5 engineering days, with Circle token edge
behavior and wallet integration as the largest risks.

## 7. Safe implementation order

1. Freeze and tag the current V4 fallback. Commit/publish the exact current source only after review.
2. Repair judge reproducibility: license, clean install, tracked assets, CI, README claims, and a
   hosted or video-backed V4 demo.
3. Fix V3 pending cleanup in a new version and prove all rejection branches release storage.
4. Write the USDC accounting/state-machine specification and invariants before contract code.
5. Build a mock NEP-141 plus hostile/failing token fixtures; implement receiver identity and full
   unused-return behavior.
6. Implement outbound operation IDs, pending callbacks, storage checks, reserve/accounting views,
   and reconciliation tests.
7. Run full Sandbox contention, failure, gas, duplicate, and V3 compatibility suites.
8. Only if all local gates pass, request authorization for new Testnet accounts, storage
   registration, faucet tokens, deployment, and genuine transaction tests.
9. Keep the UI on V4 until the USDC deployment has complete receipt/balance evidence. Switching the
   demo is a separate go/no-go decision.

## 8. NEAR HACKATHON automated-screening checklist

The official 2026 event runs through **2026-11-14 23:59 UTC**. The repository must be public; the
human must publish an X demo post naming NEAR HACKATHON, tagging `@NEARProtocol` and
`#NEARHackathon`, and submit the public repository plus demo link. Claude Code and Codex first check
that the project runs and does what the README says. Testnet-only projects are eligible, and a local
demo is allowed if the public README is reproducible and the X post contains a video. Official
sources: <https://nearhackathon.com/> and <https://nearhackathon.com/HACKATHON.md>.

### Repository and install

- [ ] Commit all intended V3/V4/frontend/run-script/docs files; `git status --short` is clean.
- [ ] Preserve a baseline/submission tag or branch and link the diff in README.
- [x] Add a repository license.
- [ ] Clone the public repository into a clean directory; do not reuse `target`, `.venv`, `.env`,
      local wallet state, or ignored artifacts.
- [ ] Follow README prerequisites and commands exactly on a second machine/environment.
- [ ] Add CI for Rust non-ignored tests, frontend tests, Python compile, and formatting.

### Configuration and build

- [x] `.env.example` contains public values only and selects the V4/V3-for-V4 pair.
- [ ] Verify no private keys, seed phrases, personal submission payload, or credentials are tracked.
- [ ] Pin/document Rust, `cargo-near`, Python, and Node versions used for the final evidence.
- [ ] Build V4 and V3 from the committed revision and record artifact sizes/hashes.
- [ ] Run a reproducible native-Linux build or describe the current non-reproducible artifact
      limitation accurately.

### Tests and app

- [x] Unit, frontend, syntax, and local Sandbox suites pass in the audit workspace.
- [ ] Rerun all suites from the clean public clone and save the exact output.
- [ ] Start with `./start.sh`; `./status.sh` must report a controlled healthy process.
- [ ] Verify every judge-facing route and public contract read without a wallet.
- [ ] Run the browser wallet journey manually: connect, exact contribution, authoritative reread,
      issue/decision, fulfillment approval, refund state, and failed/uncertain transaction recovery.
- [ ] Complete keyboard, 375px mobile, 200% zoom, and wallet popup/redirect checks.

### Testnet and demo

- [x] V4 and dedicated V3-for-V4 configuration verified by final read-only RPC.
- [ ] Reconcile V4 account reserve and the active purchase before any live demo action.
- [ ] Do not mutate purchase `0` deadlines or state outside user-authorized demo transactions.
- [ ] Keep V4 as fallback; label all money as Testnet NEAR with no cash value.
- [ ] Host the app through judging (preferred), or record a complete local demo video.
- [ ] Demo one complete user action to visible final on-chain state; avoid architecture-only footage.

### README and submission claims

- [x] State plainly that V5 is local-only, Circle USDC is not live-verified, and V4 uses native
      Testnet NEAR.
- [x] State that V4/V3-for-V4 are deployed and identify the correct paired accounts.
- [x] Remove or time-stamp stale “zero purchase,” undeployed, and current-state claims across the
      current README and V4 documents.
- [ ] Disclose prototype limits: public data, upgrade keys, callback ambiguity, storage reserve,
      no independent delivery verification, one-account/household assumption, and no production
      audit.
- [ ] Confirm project name, lead, email, team size, tracks, **mainnet** payout account, public repo,
      demo link, 20–2,000 character description, and consent with the human.
- [ ] Submit once only after explicit confirmation. Do not push, publish, post, create accounts,
      transfer tokens, deploy, or submit from this checklist automatically.

## 9. Go/no-go recommendation

**No-go for making USDC the submission-critical path before the deadline.** The remaining window is
shorter than the realistic 4.5–6.5-day implementation/test estimate, and the current repository has
more urgent screening blockers. A rushed token receiver would add asynchronous refund, storage,
registration, wallet, and reconciliation risks to a V4 demonstration that already works.

**Go for a separate, non-default USDC branch/version only if it cannot delay the P0 repository fix.**
By an internal cutoff no later than 2026-11-12, require all mock-token Sandbox tests, fixed V3
cleanup, frontend finality handling, and contract accounting invariants to pass. Without that gate,
submit V4, describe the verified Circle contract/faucet feasibility as future work, and make no claim
that HarvestPool accepts USDC.

## Primary external references

- Circle official USDC contract addresses:
  <https://developers.circle.com/stablecoins/usdc-contract-addresses>
- Circle public Testnet faucet: <https://faucet.circle.com/>
- Circle's official NEAR stablecoin source: <https://github.com/circlefin/stablecoin-near>
- NEAR fungible-token standard guide: <https://docs.near.org/primitives/ft/standard>
- NEP-141 specification: <https://github.com/near/NEPs/blob/master/neps/nep-0141.md>
- Official NEAR HACKATHON instructions: <https://nearhackathon.com/HACKATHON.md>
