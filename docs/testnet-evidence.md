# Phase 1 NEAR testnet evidence

Recorded 2026-11-08. Network: NEAR testnet. No mainnet deployment was performed.

## Deployed artifact

- Contract account: `harvestpool-phase1-2026.testnet`
- WASM size: 181,947 bytes
- SHA-256: `472c0b84240cf3a8f08bacae257250ea37d6e1437a26f98db1300e6802c13113`
- NEAR code hash: `5npuD6tsB9afogJ2WzU1qRZJeAxHokN9eFMbSuc9p2HQ`
- [Account creation transaction](https://explorer.testnet.near.org/transactions/AcuFguag98eip13girGjnWhcLJoFLbB4L1BxF1KnAB6a)
- [WASM deployment transaction](https://explorer.testnet.near.org/transactions/Ah3ievGTBDqns2riqqPekAM45vzVnLrg8VEjnhq8gAkT)
- [Contract initialization transaction](https://explorer.testnet.near.org/transactions/BN6MTcTTUXqyA1kBcZMQLcubcaLRe7Rc2xioesXvvj)

The initialized contract reported `member_count: 2`, `required_offer_yes_votes: 2`, and `testnet_only: true`.

## Live funded purchase path

Purchase `0` used a fixed minimum and maximum of 2 units at `0.1 NEAR` per unit. The offer received two member approvals, both households attached the exact price, and the purchase reached `Completed` after evidence approval and payment release.

- [Offer creation](https://explorer.testnet.near.org/transactions/9Z1WRULgaaVCPuGkRtwrKmgePhYiTbkcyJGVSv7yASX2)
- [Offer approval by household A](https://explorer.testnet.near.org/transactions/DGxC8rtknoqSaDZsLyetR4tqJSmrKLmpTNaAE8dmVYzp)
- Offer approval by household B: transaction was submitted successfully; the resulting read showed `offer_yes_votes: 2`.
- [Funded commitment by household A](https://explorer.testnet.near.org/transactions/7Zv3VxmPGFYeoSCie8mYXrjTWmtgNgGbvg4KaupEw4bH)
- [Funded commitment by household B](https://explorer.testnet.near.org/transactions/D9f7s7zmCZrHgpSzbgZWdD3xGJyNerMtE1hAjPHRw9hS)
- [Early finalization rejection](https://explorer.testnet.near.org/transactions/8z8yyMB9dWDVCHozfRAzYspcj7uPyXCSaBwJj4AKFuKi) — rejected because the contract deadline had not passed.
- [Finalization after the chain deadline](https://explorer.testnet.near.org/transactions/6HgDSPZFZSYCPAFjLbBs9d99mrcyQvTR3QQkL8VLA3H7)
- [Farmer fulfillment evidence](https://explorer.testnet.near.org/transactions/12BzXo1uvTahCBV2YAxztn5RXRsUnG5f12KuR3jHkXUW)
- [Fulfillment approval by household A](https://explorer.testnet.near.org/transactions/8hzUCAUNc7Zounmwrb9t2ZV4dLnqSkPEJrGzeC83QAJs)
- [Fulfillment approval by household B](https://explorer.testnet.near.org/transactions/9FdyaGWgtGPWxqyFu6SMtHBvHfAeVLVfk6U7yZUWpj)
- [Payment release and callback](https://explorer.testnet.near.org/transactions/3WiPvb4wK2CHVoFbaJtYdKbogVr4Lvwn26C6JqAhdAhU)

Final read of `get_purchase(0)`:

```json
{
  "state": "Completed",
  "total_quantity": 2,
  "total_funded_amount": "200000000000000000000000",
  "offer_yes_votes": 2,
  "fulfillment_yes_votes": 2,
  "fulfillment_evidence_hash": "sha256:harvestpool-testnet-delivery"
}
```

Sandbox integration tests separately cover the failed-order pull-refund path and failed payment callback retry behavior. The live smoke test does not claim private ballots or confidential order aggregation.

## V2 Testnet deployment

Recorded 2026-11-09. Network: NEAR testnet. No mainnet deployment was performed.

- Contract account: `harvestpool-v2-dalamaa-20261108.testnet`
- WASM size: 192,933 bytes
- Deployed artifact SHA-256: `3000d1636f7c1935be3d7adb8297c1e0a313f34744eeb89c4fb1c220d653aded`
- Current un-deployed source artifact: 198,405 bytes, SHA-256 `5f19ffa541c852a0d6705756a81ef4925941ea9e4fc3b9ebda66ea6db730f137`
- NEAR code hash: `4EPHzD7JTtQmLmFSGExZCoaRp1RoAZCbQChUhsdazHHN`
- [Account creation transaction](https://explorer.testnet.near.org/transactions/Bb6c6dcJNpf5jmVkEGrrVr2Jm6eaeJiWuGnzPDSh72UC)
- [WASM deployment transaction](https://explorer.testnet.near.org/transactions/58HZFinViLSp3XB9Fan6DVV74dy8YNHh5B48H6AGAv8j)
- [Contract initialization transaction](https://explorer.testnet.near.org/transactions/Ei5YyyiqYi4fYim2PXcyRU6WLnPvP69YxzNmeFbHeCHY)

The verified configuration reports `member_count: 1`, `required_offer_yes_votes: 1`,
`max_funded_members: 20`, `supports_open_membership: true`, and `testnet_only: true`.
`get_purchase_count` currently reports `0`; no fabricated purchase state has been inserted.
The local frontend default now points to this V2 account, and the preserved Phase 1 account
was only read for comparison.

The first real purchase scenario required `dalamaa.testnet` to sign the organizer transaction
and offer approval in Meteor Wallet. The V2 account has no authority to sign for that user
account, so those signatures were intentionally not automated. A separate funded Testnet
account then left exactly one funded household slot open for `dalamaa.testnet` to contribute
manually.

## V2 purchase 0: one funded spot remains

Verified on-chain after the NAJ wallet adapter fix:

- Purchase ID: `0`
- [Create open purchase](https://explorer.testnet.near.org/transactions/8NC4Db3Sd1Q2H3kgvPkXQtGQ2LUyTkAv6riZHvP9kkef)
- [Approve offer](https://explorer.testnet.near.org/transactions/PpcrPA7sxbhMn9WXWbR26CWcJACkmYbY4zGB7Ypvy9j)
- [Rejected wrong-deposit attempt](https://explorer.testnet.near.org/transactions/6cPxgyJxxnTzLBc6jDgB4whjaUDKi9DqvD7SsChyE5HF) — `1 NEAR` rejected; the contract required exactly `0.001 NEAR`
- [Successful exact buyer commitment](https://explorer.testnet.near.org/transactions/B8T1HoNFwmRuNzN4Lfqq9G3KTFGKrBLU6t55Qv3qDSS)

Current read-only `get_purchase(0)` state:

```json
{
  "state": "Open",
  "total_quantity": 2,
  "total_funded_amount": "2000000000000000000000",
  "funded_member_count": 2,
  "available_funded_member_slots": 0,
  "max_funded_members": 2,
  "price_per_unit": "1000000000000000000000",
  "offer_yes_votes": 1,
  "required_offer_yes_votes": 1,
  "fulfillment_evidence_hash": null,
  "fulfillment_yes_votes": 0,
  "required_fulfillment_yes_votes": 2,
  "commitments": ["harvestpool-member-a-2026.testnet", "dalamaa.testnet"]
}
```

The separate read `is_funded_member(0, "dalamaa.testnet")` returned `true`. The purchase remains
`Open`; no evidence, fulfillment vote, or farmer payment has been submitted. Its immutable
contribution deadline remains `1794817500000000000` nanoseconds and was not bypassed.

The current source also adds `get_offer_vote` and `get_fulfillment_vote` so a browser can reread
an individual member's recorded vote from V2 rather than trusting local storage. Those additive
views are not present in the preserved deployed WASM (`get_offer_vote` currently returns
`MethodNotFound`), and no V2 redeploy was authorized or performed. The live UI therefore cannot
claim cross-device V2 per-account vote history until that separately authorized upgrade occurs;
the local source and sandbox artifact are ready for it.

## V3 Testnet deployment

Recorded 2026-11-09. Network: NEAR testnet. V3 is a separate metadata and decision contract; the
existing V2 and Phase 1 deployments were preserved.

- Contract account: `harvestpool-v3-dalamaa-20261109.testnet`
- WASM size: 211,567 bytes
- SHA-256: `4efcc436aeae2e4e88fe875693d1e78124fd0e24e6e91c1143b995512de6b177`
- [Account creation](https://explorer.testnet.near.org/transactions/BYFr6UQbgy2aYXdmTPj8WqoQen88o14dncWyF4LTV2Yf)
- [WASM deployment](https://explorer.testnet.near.org/transactions/5VugjBibQT2pHqTqUgqFjTdH79Vf6Ti6ntzfwH84hyYk)
- [Initialization](https://explorer.testnet.near.org/transactions/tDAeb1wpoYiohRasAFuaUFnwoDNtFV5wKn8fmTEotvJ)

The initialized read-only configuration reports `version: "V3"`,
`v2_contract_id: "harvestpool-v2-dalamaa-20261108.testnet"`, `pickup_decisions_only: true`, and
`private_voting: false`. Both issue and decision counts are currently `0`. The port-5010 app
embeds the verified V2/V3 Testnet IDs on both the Raise an Issue and My Decisions routes. No V3
issue or decision transaction was submitted during deployment verification.
