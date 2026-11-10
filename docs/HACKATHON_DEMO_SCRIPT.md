# HarvestPool hackathon demo script

**Tagline:** “Buy together. Save more. Without the trust issues.”

**Positioning:** “HarvestPool makes group purchases easier, safer, and fairer. Communities can
combine their purchasing power to get better bulk prices, make important decisions through fair
votes without uncomfortable confrontations, and protect their pooled funds from unilateral
withdrawals. Clear rules for commitments, payments, and refunds give both buyers and farmers
greater confidence.”

## What this demo may claim

The primary demo is the deployed V4 supplier-authorized purchase contract on NEAR Testnet, settled
in native Testnet NEAR, plus its separate V3-for-V4 decision contract. The app runs locally at
`http://127.0.0.1:5010`.

Do not say that HarvestPool is audited, production-ready, using USDC, protecting dollar value,
verifying a supplier's legal identity, automatically recovering every failed callback, or that the
full V4 customer journey has already completed on Testnet. The current V4 state is time-sensitive;
read it again before recording.

## Demo setup

Before recording:

1. Follow the [README](../README.md) from a clean clone and run `./status.sh`.
2. Confirm `.env` selects the exact pair below and contains no credentials:
   - `harvestpool-v4-dalamaa-20261109.testnet`
   - `harvestpool-v3-v4-dalamaa-20261109.testnet`
3. Open `/purchases` once and confirm public reads report V4. Do not continue if the app silently
   falls back to sample data; it is designed not to fabricate purchases.
4. Prepare separate Testnet wallets for organizer, allowlisted supplier, and funded members. Never
   import or expose a seed phrase on screen. Use only faucet Testnet NEAR.
5. Create a disposable demo purchase early enough for its join and fulfillment deadlines. A
   terminal lifecycle cannot be compressed without deliberately suitable timestamps.
6. Save each transaction hash and final contract read in a demo evidence sheet. A wallet approval,
   local pending banner, or RPC submission is not confirmation.
7. Keep a read-only backup recording of the UI plus the passing Sandbox tests. The deployed V3
   decision feature has a disclosed storage-availability defect, so it should not be allowed to
   block the core V4 escrow demonstration.

Creating the disposable purchase, contributing, voting, paying, or refunding are live Testnet
transactions and require separate authorization. This document does not perform them.

## Two-minute spoken narrative

> Communities can get a better price by buying together, but shared money creates a harder
> problem: who controls the funds, who can promise terms for a supplier, and what happens when the
> group disagrees?
>
> HarvestPool puts those rules into a NEAR contract. A supplier can publish an offer, or an
> organizer can prepare one that stays closed until the named supplier signs the complete terms.
> Buyers review the agreement and contribute the exact amount directly to the purchase contract—
> not to an organizer's wallet.
>
> A successful contribution makes that wallet a funded member. Buying more units changes the
> amount, not the number of votes. Funded members can approve fulfillment or resolve permitted
> group decisions through a separate decision contract, while the financial agreement remains
> unchanged.
>
> The supplier receives payment only after the agreed evidence and member approval. If the group
> misses its minimum or fulfillment expires, eligible members pull their own refunds. Pending
> transfers are not shown as complete until the contract callback and state confirm the result.
>
> We also found limits in our own design. Our deployed decision contract can retain rejected
> pending requests, and an absent financial callback is ambiguous. We disclose those issues rather
> than inventing recovery guarantees. Native NEAR also changes in dollar value, so our intended next
> payment version is native USDC on NEAR—but it is a separate planned contract, not a feature we
> claim today.
>
> NEAR supplies the signatures, public state, cross-contract verification, and enforceable payment
> rules. Customers see products, agreements, progress, votes, delivery, and refunds. Buy together.
> Save more. Without the trust issues.

## Exact demonstration sequence

The expected result column is an assertion to verify, not narration to use when the result has not
appeared. Stop on any uncertain transaction, refresh, and perform an authoritative contract reread;
do not resubmit blindly.

| # | Exact screen | Action | Expected contract result | Evidence to show/save |
| ---: | --- | --- | --- | --- |
| 1 | **Home** `/` | Read the headline, then select **Explore Deals**. | No transaction. The page does not create a purchase or membership. | URL on port 5010; browser network/public read may be shown briefly. |
| 2 | **Explore Deals** `/purchases` | Open the prepared V4 deal. Point out supplier, listed USD context, exact Testnet NEAR, target, funded buyers, cutoff, and status. | Read-only `get_purchase`; displayed state matches V4. | Contract ID in app configuration; read-only V4 config showing `supplier-authorized-no-offer-vote` and `native-testnet-near`. |
| 3 | **Post a Group Deal** `/create` | Select **I’m organizing and need the supplier to approve**, enter all terms, and choose **Continue with these terms** with the organizer wallet. | `create_purchase_request` creates `AwaitingSupplier`; it is not open for contributions. | Final transaction hash, new purchase ID, state reread, and agreement fingerprint. |
| 4 | **Supplier invitation** `/supplier-invitations/<id>` | First show that another wallet has no valid acceptance action. Connect the named supplier, review every term, then select **Accept and open contributions**. | Only the immutable named supplier can call `accept_supplier_request`; state becomes `Open`. | Final receipt, signer account, `Open` state, unchanged fingerprint/financial terms. |
| 5 | **Deal details** `/purchases/<id>` | Explain that the organizer has no withdrawal control. Open the agreement/contribution action. | Read-only only. No organizer payout method exists in V4. | Optional technical details and source link; do not claim the UI alone proves absence of a method. |
| 6 | **Deal Terms / Join This Deal** `/purchases/<id>/join` | As buyer A, choose quantity, check the agreement acknowledgement, select **Join This Deal**, review the exact native Testnet NEAR amount in the wallet, and approve. | A correct exact deposit records one `Active` commitment, increments quantity/amount, and creates one funded membership. | Final transaction outcome, `get_purchase`, `is_funded_member`, and buyer A commitment. |
| 7 | Same contribution screen | Refresh after confirmation. Explain that a duplicate commitment, wrong amount, supplier contribution, expired call, or over-capacity call is rejected. Do not spend demo time intentionally failing a live financial call unless planned. | Existing commitment remains singular; UI derives current state from the contract. | Sandbox test name/output for rejection cases and last-slot concurrency; avoid presenting a local test as a Testnet receipt. |
| 8 | **My Group Buys** `/dashboard` | Connect buyer A. Show the joined deal, funded status, and available next action. | Read-only wallet-scoped filtering; opening a link alone never creates membership. | Account shown in wallet panel and matching on-chain commitment. |
| 9 | **Raise an Issue** `/purchases/<id>/issue` | As a funded member, enter a permitted pickup/coordination issue and request a Yes/No or multiple-choice decision. | V3 asynchronously rereads V4 before recording. Submission is pending until the callback writes the issue/decision. | Final receipts plus reread of V3 issue/decision; disclose V3's rejected-callback storage defect. |
| 10 | **My Decisions** `/decisions` | Cast one choice from each prepared funded-member wallet. Show that one wallet has one vote even if it bought multiple units. | Only the snapshotted active funded accounts vote. One option must reach `ceil(2n/3)`; split full participation yields `NoConsensus`; expired ballots cannot pass later. | Eligible voter list, required vote count, each final receipt, final V3 outcome. Use Sandbox evidence if a second result type is not live. |
| 11 | **Supplier dashboard** `/farmer` | Connect the named supplier and submit the prepared bounded delivery reference for the funded purchase. | Only the named supplier can submit evidence in the correct lifecycle state; purchase enters fulfillment review. | Final receipt and V4 purchase reread showing the evidence reference/state. Explain that HarvestPool does not independently verify delivery. |
| 12 | **Deal details / fulfillment review** `/purchases/<id>` | From funded-member wallets, approve fulfillment. | Each active funded account votes once. When Yes reaches `ceil(2n/3)`, state becomes `FulfillmentApproved`. | Signers, final receipts, vote count, required threshold, and state. |
| 13 | **Deal details / supplier payment** `/purchases/<id>` | Select **Release supplier payment** only after approval. Wait through pending, then refresh and reread. | State changes to `PaymentPending` before transfer. Only a successful private callback changes it to `Completed`; observed failure returns it to the retryable approved state. Recipient is the immutable supplier. | Transaction and all receipt outcomes, final `Completed` state, supplier recipient, and amount. Never call pending a payment. |
| 14 | Prepared failed deal on **My Group Buys** | Open buyer A's refundable commitment and select **Claim Refund** once. Wait for final confirmation. | Commitment changes `Refundable → RefundPending → Refunded`; observed failure restores `Refundable`; a second call while pending/refunded cannot schedule another transfer. | Final receipt graph, commitment state, recipient account, exact recorded amount. Use a separate prepared failed purchase—not the completed payment deal. |
| 15 | README / `docs/engineering-decisions.md` | End on the architecture diagram and the implemented/planned table. | No transaction. | Source, Sandbox results, V4/V3 deployment hashes, known defects, and the explicit “V5 is local-only; Circle USDC is not live-verified” statement. |

## Short path when live signers or deadlines are unavailable

Do not improvise fake state. Use this truthful fallback:

1. Show the public V4 purchase and supplier agreement read-only.
2. Show the contribution screen and wallet prompt only if an authorized disposable contribution is
   available; otherwise stop before signing.
3. Show **My Group Buys**, **My Decisions**, and **Supplier dashboard** to explain role-gated actions.
4. Run or show saved output from the V4 Sandbox journey and V3-for-V4 compatibility journey,
   explicitly labeling it **local NEAR Sandbox evidence**.
5. Open the deployment record for actual Testnet accounts, hashes, initialization receipts, and the
   time-stamped live state.
6. Close with the known-defect and USDC-plan section. Credibility is more valuable than staging an
   unsupported “successful” payment.

## Technical evidence appendix for judge questions

| Judge question | Concise answer | Evidence |
| --- | --- | --- |
| Can the organizer withdraw? | No V4 method pays an organizer or arbitrary address. Supplier payout is bound to the agreed supplier after fulfillment approval; refunds return to contributors. | V4 source plus Sandbox payout/refund journeys. |
| What prevents oversubscription? | Unit and household capacity are checked in contract execution. Concurrent receipts serialize; the later last-slot attempt fails. | V4 concurrent final-slot Sandbox test. |
| Who can vote? | Active paid commitments, snapshotted for V3 decisions; one account, one vote. | V4 membership views and V3 compatibility tests. |
| Can a vote change price or recipient? | No. V3 has no V4 financial method or transfer authority. | V3 API and unchanged-field Sandbox assertions. |
| Is the supplier verified? | The supplier wallet is allowlisted and signs the agreement. Real-world business identity is not independently verified. | V4 initialization and supplier authorization checks. |
| Are transfers synchronous? | No. Pending state is written first; callbacks finalize observed success/failure. A missing callback remains an unresolved design gap. | V4 callbacks and reliability audit. |
| Does USDC work? | No. Native Testnet NEAR works in V4. A separate six-decimal NEP-141/NEP-145 USDC architecture and test matrix are documented. | V4 config and engineering decisions. |
| Was this formally audited? | No. It received an internal reliability review and local test coverage; production use requires independent review. | Reliability audit and README limitations. |

## Recording checklist

- [ ] Contract IDs and Testnet banner are readable.
- [ ] Every signer role uses a visibly different account.
- [ ] Exact Testnet NEAR is shown separately from any USD estimate.
- [ ] No seed phrase, private key, local credential, or browser secret appears.
- [ ] “Submitted,” “pending,” and “confirmed” are spoken as different states.
- [ ] Explorer links or receipt hashes are saved for every claimed live change.
- [ ] Sandbox evidence is labeled Sandbox; historical V2/Phase 1 evidence is not called V4 evidence.
- [ ] V3 storage leakage and V4 missing-callback recovery limits are disclosed.
- [ ] V5 is described as local-only, and Circle USDC is described as not live-verified.
- [ ] The final video shows the public repository revision that can reproduce the demo.
