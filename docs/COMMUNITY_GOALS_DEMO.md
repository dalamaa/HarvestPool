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

## USDC follow-up — authorization pending

This is the next customer-facing journey. It has not occurred, so every transaction reference below
is intentionally blank. Recheck balances, registrations, policy, and the token storage minimum at
finality immediately before asking for authorization.

- [ ] Member A registers `harvestpool-community.sputnikv2.testnet` with the canonical Circle Testnet
  USDC contract using `storage_deposit`; transaction: **pending**
- [ ] Member A contributes **1.00 USDC** with `ft_transfer` to the DAO; transaction: **pending**
- [ ] Member A proposes **0.80 USDC** to `harvestpool-farmer-1.testnet` with the existing **0.1 NEAR**
  proposal bond; proposal transaction and ID: **pending**
- [ ] Member A casts the first approval and the UI confirms no outgoing USDC event; transaction:
  **pending**
- [ ] Member B casts the second approval; deciding-vote transaction: **pending**
- [ ] Verify the successful exact-token transfer event/receipt, recipient balance change, approving
  accounts, and final DAO USDC balance; payment receipt: **pending**

The completed native-NEAR evidence above remains historical and is never added to USDC progress or
balances.
