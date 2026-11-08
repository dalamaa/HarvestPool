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
