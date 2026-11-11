# V5 automatic finalization: design, operation, and limits

## Contract rule verified from source

The deployed V5 contract's `finalize_purchase(purchase_id)` method is a permissionless,
zero-deposit lifecycle call. It accepts only `Open` or `AwaitingSupplier` after the join deadline.
It cannot finalize early, even when the minimum has already been reached.

| Authoritative state at/after cutoff | Result |
| --- | --- |
| `Open` and `total_quantity >= min_quantity` | `Funded` |
| `Open` below the minimum | `Failed`; active commitments become `Refundable` |
| `AwaitingSupplier` | `Failed`; active commitments, if any, become `Refundable` |
| `Funded`, `Failed`, `Completed`, or any other state | Call rejects with no lifecycle change |

Anyone may call the method; there is no organizer or owner check. Finalization itself never sends
USDC. It does not release supplier payment, claim a buyer refund, reconcile escrow, or approve
fulfillment. Those separations are why a narrowly restricted automation key is safe for this one
operation.

## Worker behavior

`automation/finalizer.py` is an independent polling process. It does not run inside Flask and does
not require a customer browser to be open. Every poll:

1. verifies the target reports the expected Testnet V5 native-USDC configuration;
2. reads finalized chain time, purchase count, and every purchase through JSON-RPC;
3. records only deadline-passed `Open`/`AwaitingSupplier` purchases in SQLite;
4. obtains a database lease, then rereads the purchase before signing;
5. verifies the service key is a function-call key restricted to the configured V5 account and
   exactly `finalize_purchase`;
6. writes the signed transaction bytes and hash to SQLite before broadcasting;
7. confirms the final result from authoritative purchase state, never from submission alone; and
8. records transitions and errors in `finalizations` and append-only `finalization_events` tables.

Two workers sharing the same SQLite database cannot acquire the same purchase lease or global
signer lease. Only one transaction may remain in flight for the service key, preventing nonce
collisions even when different deals become eligible together. A restart sees the persisted
transaction hash. When an RPC response is lost, the worker checks both transaction status
and purchase state before doing anything else. It may rebroadcast the exact same signed bytes a
bounded number of times; it never signs a second transaction while the first outcome is unknown.
A confirmed contract rejection is retained for operator review rather than retried blindly.

The `/healthz` endpoint reports whether automation is enabled, the last poll/error, and durable row
counts by status. Logs are structured JSON events inside ordinary timestamped process logs.

## Configuration and key boundary

The checked-in default is disabled. A read-only smoke check therefore needs no credential:

```sh
python -m automation.finalizer --once
```

Intentional activation requires a dedicated service account and a function-call access key whose
on-chain permission has:

- receiver: `harvestpool-v5-usdc-dalamaa-20261109.testnet`;
- method names: exactly `finalize_purchase`;
- no attached-deposit capability (inherent to a NEAR function-call key); and
- a deliberately funded gas allowance/account balance appropriate for Testnet operations.

Store the standard NEAR credential JSON outside the repository with filesystem mode `0600`. The
worker refuses group/world-readable credential files, Full Access keys, another receiver, an empty
method list, or any additional method such as `release_payment`.

```dotenv
HARVESTPOOL_FINALIZER_ENABLED=true
HARVESTPOOL_FINALIZER_CONTRACT_ID=harvestpool-v5-usdc-dalamaa-20261109.testnet
HARVESTPOOL_FINALIZER_RPC_URL=https://test.rpc.fastnear.com
HARVESTPOOL_FINALIZER_CREDENTIALS_FILE=/absolute/private/path/finalizer.json
HARVESTPOOL_FINALIZER_DB=/var/lib/harvestpool/finalizer.sqlite3
HARVESTPOOL_FINALIZER_POLL_SECONDS=60
HARVESTPOOL_FINALIZER_HEALTH_HOST=127.0.0.1
HARVESTPOOL_FINALIZER_HEALTH_PORT=8091
```

Run `python -m automation.finalizer` under the existing process supervisor. Back up the SQLite
database, alert on `ok: false`, `unknown`, or `contract_rejected`, and retain logs. Do not put the
credential in Flask, JavaScript, the public `.env`, a container image, or Git.

## Verification scope

`python -m unittest -v automation.test_finalizer` covers the pre-deadline case, zero/below-minimum
failure, minimum-satisfied funding, `AwaitingSupplier`, already Funded/Failed/Completed, missing
credentials, restricted-key enforcement, RPC failure, lost response, duplicate polls, two-worker
races, crash/restart, state races, confirmed rejection, delayed authoritative confirmation, and
same-transaction rebroadcast. Contract unit and Sandbox suites remain the authority for lifecycle
and token behavior.

Deal #4 is intentionally read-only evidence: it was still `Open`, expired, and unfinalized at the
2026-11-11 checkpoint. No transaction was submitted to change it during this work.

This implementation is operationally cautious, but it is not production-ready merely because its
unit tests pass. It still needs a provisioned restricted Testnet key, supervised deployment,
multi-RPC/alerting policy, backup/restore rehearsal, and a controlled non-preserved Testnet canary.

## Settlement operations that remain manual

| Operation | V5 today | Why it is not automated here |
| --- | --- | --- |
| Join-cutoff finalization | Automated by this worker when enabled | Permissionless, deterministic, no token transfer |
| Failed-purchase refund | Buyer calls `claim_refund` | V5 binds refund to the contributing account and schedules a token transfer/callback |
| Escrow balance reconciliation | An account calls `reconcile_token_balance` | It is a separate cross-contract observation, not finalization |
| Supplier payment release | A caller invokes `release_payment` after approval | It moves USDC and must remain outside this worker's key authority |
| Ambiguous outbound transfer | Operator investigates; contract can freeze as `ReconciliationRequired` | Retrying without evidence could pay twice |
| Supplier non-fulfillment | Someone calls `expire_unfulfilled_purchase` after cutoff | Separate lifecycle action, not authorized to this service |
| Fulfillment approval | Funded buyers vote | Current V5 requires a two-thirds approval threshold; silence does not approve |

## Future perishable-goods settlement policy (not in V5)

A future contract version should disclose before contribution and enforce: a 72-hour problem-report
window after contractual review starts; early release when all required buyers approve; automatic
authorization after the review deadline only if no eligible dispute exists; a valid dispute that
pauses the relevant settlement; and a dispute ballot with a deadline and safe fallback so inactive
voters cannot lock funds forever. V5 does none of this. Adding it requires a new reviewed contract,
not frontend wording or broader keeper credentials.
