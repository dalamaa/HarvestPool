# Community Goals Testnet demo

This checklist records the completed native-NEAR Testnet demonstration. The hashes below were
reconciled against finalized NEAR Testnet state; the page screenshot is retained at
`docs/demo-evidence/community-goals/final-payment.png`.

## Demo setup

- DAO: `harvestpool-community.sputnikv2.testnet`
- Member A: `harvestpool-member-a-2026.testnet`
- Member B: `dalamaa.testnet`
- Member C: `harvestpool-farmer-2026.testnet`
- Goal: **Shared Community Equipment**
- Target: **0.25 Testnet NEAR**
- Payment: **0.20 Testnet NEAR**
- Recipient: `harvestpool-farmer-1.testnet`

The DAO has exactly these three members, requires two approvals, has factory auto-updates disabled,
has no access keys, and uses pinned code hash
`AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH`.

## Screen-recorded customer journey

- [x] Open `/community-goals` and show the goal, purpose, target, recipient, status, DAO treasury
  balance, and empty or current expenditure history.
- [x] Connect Member A and contribute exactly **0.25 Testnet NEAR**.
- [x] Wait for finality, refresh authoritative data, and show the verified contribution and goal
  progress at **0.25 / 0.25 NEAR**.
- [x] As Member A, propose an expense of exactly **0.20 Testnet NEAR** to the configured recipient
  and show its reason and required two-member threshold.
- [x] As Member A, cast the first approval. Show that the proposal remains in progress and that the
  recipient has not been paid.
- [x] Connect Member B and cast the second approval.
- [x] Wait for finality and verify the successful **0.20 Testnet NEAR** transfer receipt to
  `harvestpool-farmer-1.testnet`.
- [x] Show the completed proposal, Member A and Member B approvals, recipient, payment receipt,
  expenditure entry, and authoritative remaining treasury balance. Member C does not vote.

## Testnet evidence

Finalized Testnet records:

- DAO creation transaction: `68fHXrgWe2emLXF8VW1DAC6EFmppUCUnTuev75PLRh5Q`
- Factory hardening proposal transaction: `F3RRRPKeJcpUMCiRouEjDHxoCRDeQFLBf64ZU5Ag6iUx`
- Factory hardening approvals: Member A
  `7Z6ZmpNxZUjv5SsKE7FLM7ECv6jt4Srgj6HFo3VBbh8K`; Member B
  `3eanUQt3fpHUPuvRX4ezDrmn1sD7vJ5MbfRTGj2NCUZm`
- Contribution transaction: `8nAPVTsG2uAkNJ26WmqMzymwiGfH4eZmua2Nf59dN8Ed`
- Expense proposal transaction and proposal ID:
  `5ZUDmbAMEWwFTc6P3sVo9EUFoWF3cJkXexiGthNJe5Xn`, proposal `#1`
- First approval transaction: `GjzP4NheQs3FFe51oB91MqKXnvxMFWtyoUGHRo5xyR8n`; proposal
  remained in progress and no recipient transfer occurred.
- Second approval transaction: `E42nuNjmrsUDiRUZ3RnVc2sx7APiqk53RURiaRZp9Uad`
- Recipient payment receipt: `Epq9xCvgMrgpkJSpuvtTebdNVjiurDffjcMYnBjcMyJ9`
- Final DAO account balance: `6.05 NEAR`; final contract-reported available amount:
  `0.63632 NEAR`, verified at Testnet block `277330049` on 2026-11-12.

## Completed USDC customer journey

The customer-facing journey was subsequently completed with the canonical Circle Testnet USDC
contract. No part of the historical native-NEAR balance or transfer is included in these totals.

- [x] Registered `harvestpool-community.sputnikv2.testnet` with the canonical token contract:
  `Gc7gZ24Z5V6tCyosRyFrg1joximjt2n1WGGE1PbSPctX`.
- [x] Member A contributed exactly **1.00 Testnet USDC**:
  `JD8WYyoGFAxxNdApXDNrRfKpia59RAN41SWGDwZSGbE6`.
- [x] Member A proposed exactly **0.80 Testnet USDC** to
  `harvestpool-farmer-1.testnet`; proposal transaction
  `UuxG3XFUra2CDM1wKaT28UGmRGsZMbScVfezRrBEoiX`, proposal `#2`.
- [x] Member A cast the first approval. The proposal remained open and no USDC moved:
  `pyRs5SKSNPW4A33E9nxsxMjv9YNB6vWMZFeS8oEGr7Y`.
- [x] Member B cast the deciding approval:
  `DNBNDTgi6bEHsjnWX92WaS9v8U1nyhYiqxfKYKsnfA2p`.
- [x] Finalized NEAR RPC confirmed receipt
  `FwHKdUzhMXmfH1Ha6HHRTPBrid2MFVVS92JtCjKGrbHf`: the canonical token contract transferred exactly
  **0.80 Testnet USDC** from the DAO to the configured recipient. The DAO retained exactly
  **0.20 Testnet USDC**.

The completed native-NEAR evidence above remains historical and is never added to USDC progress or
balances.
