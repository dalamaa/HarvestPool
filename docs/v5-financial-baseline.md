# V5 financial baseline

Verified on NEAR Testnet on 2026-11-10 before the product UX overhaul. This record contains
public account identifiers and receipt evidence only; it contains no wallet keys or credentials.

## Deployed contracts

- V5 escrow: `harvestpool-v5-usdc-dalamaa-20261109.testnet`
- V3-for-V5 decisions: `harvestpool-v3-v5-dalamaa-20261109.testnet`
- Circle Testnet USDC: `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`
- Supplier pilot account: `harvestpool-farmer-1.testnet`
- Funded buyers: `dalamaa.testnet`, `harvestpool-member-a-2026.testnet`

The deployed WASM code hashes match the local build artifacts:

| Contract | Bytes | SHA-256 |
| --- | ---: | --- |
| V5 | 273,067 | `37858d4e64be52f09bdf5541cd7379075eb69c08bb289edd1c7e090d81ddf8cf` |
| V3-for-V5 | 219,131 | `a0f1e9fd382288c7cc04ec362cd56fd869dba44425a7b88b24c66046704233a3` |

## Live financial result

- Deal #0 (Fresh tomatoes): `Completed`; two active funded commitments; 4,000,000 base units
  accepted and paid to the supplier; no liability remains.
- Deal #1 (Apples): `Failed`; one commitment from `harvestpool-member-a-2026.testnet` was
  refunded for exactly 2,000,000 base units; no supplier payment occurred.
- V5 Circle balance: `0`; outstanding liability: `0`.
- Outbound operations: exactly one successful supplier payment and one successful refund; no
  duplicate payout or refund.
- Stored post-payout reconciliation: observed balance `0`, reconciled liability `0`, `balanced`.
- V3-for-V5 Decision #0 reached the two-buyer Yes threshold, received supplier consent, and
  resolved Issue #0. It did not modify V5 terms or move USDC.

Refund transaction: [`G63ozfWnVsZRRUpZ4zrucMVYR7VErFTEF4NtfurCJy4N`](https://testnet.nearblocks.io/txns/G63ozfWnVsZRRUpZ4zrucMVYR7VErFTEF4NtfurCJy4N).
Its finalized receipt graph includes the Circle NEP-141 transfer of `2,000,000` units to the
original buyer and a successful V5 outbound-operation callback.

Supplier payout transaction: [`Gp32zhkmfXFqnL1c6zPPsoy55Fh1LVjjvk3EYiNqLHCm`](https://testnet.nearblocks.io/txns/Gp32zhkmfXFqnL1c6zPPsoy55Fh1LVjjvk3EYiNqLHCm).
Its receipt graph includes the Circle NEP-141 transfer of `4,000,000` units from V5 to
`harvestpool-farmer-1.testnet` and the successful V5 callback. The stored evidence for this deal
explicitly states `TESTNET SIMULATION - NO PHYSICAL DELIVERY OCCURRED - DEAL #0`; no physical
delivery is claimed.

## Verification baseline

- `node --test web/static/*.test.js`: 86 passed.
- `cargo test -p harvest-pool-v5-contract`: 4 unit tests passed; 4 Sandbox tests ignored by
  default because they require built WASMs and a local Sandbox.
- `cargo test -p harvest-pool-v3-v5-contract`: 4 unit tests passed.
- JavaScript syntax and `python3 -m py_compile web/app.py`: passed.
- V5 frontend on port 5011 and preserved V4 frontend on port 5010: HTTP 200.

The current default environment remains V4. V5 is isolated and explicitly configured through the
documented V5 environment variables; no contract was redeployed for this baseline.
