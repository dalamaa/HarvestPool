# Community Goals Testnet demo

This checklist records a future Testnet demonstration. No transaction below has occurred until its
real transaction or receipt hash is recorded and independently verified.

## Demo setup

- DAO: `harvestpool-community.sputnikv2.testnet`
- Member A: `harvestpool-member-a-2026.testnet`
- Member B: `harvestpool-member-b-2026.testnet`
- Member C: `harvestpool-farmer-2026.testnet`
- Goal: **Shared Community Equipment**
- Target: **0.25 Testnet NEAR**
- Payment: **0.20 Testnet NEAR**
- Recipient: `harvestpool-farmer-1.testnet`

Before recording, confirm the DAO exists, has exactly these three members, requires two approvals,
has factory auto-updates disabled, has no access keys, and the Community Goals page reads this DAO.

## Screen-recorded customer journey

- [ ] Open `/community-goals` and show the goal, purpose, target, recipient, status, DAO treasury
  balance, and empty or current expenditure history.
- [ ] Connect Member A and contribute exactly **0.25 Testnet NEAR**.
- [ ] Wait for finality, refresh authoritative data, and show the verified contribution and goal
  progress at **0.25 / 0.25 NEAR**.
- [ ] As Member A, propose an expense of exactly **0.20 Testnet NEAR** to the configured recipient
  and show its reason and required two-member threshold.
- [ ] As Member A, cast the first approval. Show that the proposal remains in progress and that the
  recipient has not been paid.
- [ ] Connect Member B and cast the second approval.
- [ ] Wait for finality and verify the successful **0.20 Testnet NEAR** transfer receipt to
  `harvestpool-farmer-1.testnet`.
- [ ] Show the completed proposal, Member A and Member B approvals, recipient, payment receipt,
  expenditure entry, and authoritative remaining treasury balance. Member C does not vote.

## Testnet evidence

Fill these fields only from finalized Testnet records:

- DAO creation transaction: `PENDING`
- Factory hardening proposal transaction: `PENDING`
- Factory hardening approvals: Member A `PENDING`; Member B `PENDING`
- Contribution transaction: `PENDING`
- Expense proposal transaction and proposal ID: `PENDING`
- First approval transaction: `PENDING`
- Second approval transaction: `PENDING`
- Recipient payment receipt: `PENDING`
- Final treasury balance and verification block: `PENDING`
