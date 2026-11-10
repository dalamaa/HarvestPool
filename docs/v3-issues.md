# V3 issues and group decisions

V3 is a separate metadata and decision contract. It does not replace, upgrade, or mutate the
deployed `harvestpool-v2-dalamaa-20261108.testnet` contract.

## Trust boundary

V3 stores issue descriptions and binding decision outcomes. Before it writes a member issue or
opens a decision, it reads the V2 purchase view and verifies the signed caller against the V2
purchase's active commitments. When a decision opens, the Active funded accounts are copied into
an immutable voter snapshot. The organizer has no special entry in that snapshot.

The only decision scope exposed in V3 is `pickup_arrangement`. A V3 outcome is not a V2 purchase
update: V3 has no method to change price, quantity, supplier, refunds, deadlines, payment, or
withdrawals. Pickup decisions that affect the named supplier remain `AwaitingSupplier` until the
supplier agrees.

Voting is intentionally public. V3's `private_voting` config value is false and the UI does not
claim confidentiality.

The local contract intended for a new V4-dedicated instance supports two explicit formats:

- `YesNo`: the contract fixes the choices to `Yes` and `No`. Only `Yes` reaching two-thirds of
  every voter in the opening snapshot passes the proposed change. `No` can reject the proposal,
  but is never recorded as an approved replacement agreement.
- `MultipleChoice`: two to four distinct choices are allowed. A choice must independently reach
  the same two-thirds threshold; a plurality is not enough. A fully voted tie or split without a
  threshold winner becomes `NoConsensus`.

`Rejected`, `NoConsensus`, and `Expired` all reopen the issue and leave the original purchase
agreement unchanged. Supplier agree/decline calls are rejected until member voting has passed a
choice and the decision is `AwaitingSupplier`, and supplier consent cannot revive a proposal after
its deadline. These source/storage changes are for a separately
initialized V3-for-V4 account; the deployed V3-for-V2 account and its historical state must not be
upgraded or reinitialized.

## Methods

- `raise_issue` — verifies an Active V2 commitment asynchronously before writing an Open issue.
- `resolve_issue` — verifies the V2 organizer or named supplier before resolving a simple issue.
- `request_group_vote` — verifies a funded requester, snapshots funded voters, and opens one
  pickup-arrangement decision for the issue. V3 also permits only one active group decision for a
  purchase, so separate issues cannot create conflicting live ballots.
- `vote_on_decision` — accepts one public choice per snapshot voter until the immutable deadline
  and evaluates the selected vote format without plurality fallback.
- `agree_to_decision` — records named supplier agreement after the 2/3 matching-choice threshold.
- `decline_decision` — leaves the issue Open for a different safe proposal.
- `expire_decision` — closes an undecided or supplier-pending decision after its deadline.
- `get_issue`, `get_decision`, `get_issue_count`, and `get_decision_count` — public reads used by
  the browser for refresh-safe rendering.

The issue lifecycle is `Open → NeedsGroupDecision → Resolved`. A rejected or expired decision
returns its issue to `Open`; only one active decision can exist for an issue or purchase at a time.
Exact duplicate open issues are rejected and each purchase has a bounded active-issue limit.

## Browser configuration

The Flask process accepts:

```sh
HARVESTPOOL_CONTRACT_ID=harvestpool-v2-dalamaa-20261108.testnet
HARVESTPOOL_V3_CONTRACT_ID=<deployed-v3-account>
```

When `HARVESTPOOL_V3_CONTRACT_ID` is empty, the configured account cannot be read, or its
`get_config.v2_contract_id` does not match `HARVESTPOOL_CONTRACT_ID`, the UI keeps V2 purchase and
fulfillment functionality live and does not present an issue as submitted or a vote as available.
After a V3 transaction, the browser rereads the issue/decision record before showing a success
message; a wallet receipt alone is not treated as proof that the asynchronous V3 callback wrote
state.

## Testnet deployment evidence

Recorded 2026-11-09 after explicit authorization. The separate account is
`harvestpool-v3-dalamaa-20261109.testnet`; the preserved V2 account was not redeployed or
modified.

- WASM: `target/near/harvest_pool_v3_contract/harvest_pool_v3_contract.wasm`, 211,567 bytes
- SHA-256: `4efcc436aeae2e4e88fe875693d1e78124fd0e24e6e91c1143b995512de6b177`
- [Account creation](https://explorer.testnet.near.org/transactions/BYFr6UQbgy2aYXdmTPj8WqoQen88o14dncWyF4LTV2Yf)
- [WASM deployment](https://explorer.testnet.near.org/transactions/5VugjBibQT2pHqTqUgqFjTdH79Vf6Ti6ntzfwH84hyYk)
- [Initialization](https://explorer.testnet.near.org/transactions/tDAeb1wpoYiohRasAFuaUFnwoDNtFV5wKn8fmTEotvJ)

The verified `get_config` reports `version: V3`,
`v2_contract_id: harvestpool-v2-dalamaa-20261108.testnet`, `pickup_decisions_only: true`, and
`private_voting: false`. Initial `get_issue_count` and `get_decision_count` are both `0`.
The V3 unit and sandbox integration tests pass. The port-5010 app is configured with the V2 and
V3 IDs through the ignored local `.env`; no issue or decision transactions were submitted during
deployment verification.

After authorization, the frontend configuration is:

```sh
export HARVESTPOOL_CONTRACT_ID=harvestpool-v2-dalamaa-20261108.testnet
export HARVESTPOOL_V3_CONTRACT_ID=harvestpool-v3-dalamaa-20261109.testnet
```
