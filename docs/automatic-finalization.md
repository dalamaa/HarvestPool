# V5 automatic finalization

## Scope and contract rule

`automation/finalizer.py` is the portable Python implementation. It is a separate foreground
process, not part of Flask, and needs no buyer, supplier, organizer, or browser session. The
deployed V5 method `finalize_purchase(purchase_id)` is permissionless and accepts zero deposit only
after the join deadline:

| Authoritative state at cutoff | Contract result |
| --- | --- |
| `Open`, minimum reached | `Funded` |
| `Open`, below minimum | `Failed`; active commitments become `Refundable` |
| `AwaitingSupplier` | `Failed`; active commitments, if any, become `Refundable` |
| Any final or other state | Rejected; no lifecycle change |

Finalization never transfers USDC. It cannot release supplier payment, claim a refund, reconcile
escrow, approve fulfillment, or modify a deployed contract.

## Portable quick start for judges

From a fresh clone, Python 3.10+ runs the web app, worker tests, dry runs, and receipt verification;
Node.js runs the browser tests, and Rust is optional for contract tests. No NEAR credential is
needed:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r web/requirements.txt
python -m unittest -v automation.test_finalizer
node --test web/static/*.test.js
```

On Windows PowerShell, activate with `.venv\Scripts\Activate.ps1`; the remaining Python and Node
commands are identical.

On Linux/macOS, copy the public example configuration and use the root launcher:

```sh
cp .env.example .env
./start.sh
```

This starts the read-only V5 web app on `http://127.0.0.1:5011`. On any platform, set the public
values from `.env.example` in the current shell and run the same portable Flask command directly:

```sh
python -m flask --app web.app run --host 127.0.0.1 --port 5011 --no-debugger --no-reload
```

The browser reads public Testnet purchases from
`harvestpool-v5-usdc-dalamaa-20261109.testnet`. Flask has no signing key.

### Simulated logic versus real Testnet evidence

These tests are isolated simulations; they never contact Testnet or sign:

```sh
python -m unittest -v \
  automation.test_finalizer.FinalizerTests.test_expired_zero_buyer_deal_is_submitted_as_expected_failed \
  automation.test_finalizer.FinalizerTests.test_minimum_satisfied_deal_expects_funded \
  automation.test_finalizer.FinalizerTests.test_already_funded_and_failed_rows_confirm_without_submission
cargo test -p harvest-pool-v5-contract
```

The Python fixtures demonstrate worker selection and `Open` → expected `Failed`/`Funded`; the Rust
tests exercise contract lifecycle behavior. The ignored `contract-v5/tests/integration.rs` suite is
an optional NEAR Sandbox journey and requires the documented WASM prerequisites; it is not needed
for the default demonstration.

This command is a public, read-only verification of the real Deal #4 canary. It validates the
receipt's signer, exact V5 receiver, sole `finalize_purchase` action, Deal #4 arguments, zero
deposit, successful final outcome, and current authoritative final state:

```sh
python -m automation.verify_finalization
```

Historical Testnet transaction:
[`2wJwt7JuDW6NpTQjBh96TBRhiMY9jvVpMaRH9DDBEHzH`](https://testnet.nearblocks.io/txns/2wJwt7JuDW6NpTQjBh96TBRhiMY9jvVpMaRH9DDBEHzH).
It finalized Deal #4 from `Open` to `Failed` with zero contributions; it did not transfer USDC.

## Worker modes

Read-only one-shot (no credential, no database candidate, one purchase only):

```sh
python -m automation.finalizer --once --dry-run --purchase-id 4
```

Credentialed one-shot:

```sh
python -m automation.finalizer --once --purchase-id PURCHASE_ID
```

Portable foreground continuous process:

```sh
python -m automation.finalizer
```

`HARVESTPOOL_FINALIZER_POLL_SECONDS` controls the interval. SIGINT and SIGTERM stop polling,
shutdown the health server, and leave SQLite intact. The worker remains disabled unless
`HARVESTPOOL_FINALIZER_ENABLED=true`.

## Local root-script lifecycle

The root scripts provide one convenient local workflow while keeping Flask and the worker as
separate processes:

```sh
./start.sh    # start V5; start/verify finalizer only when explicitly enabled and configured
./restart.sh  # restart only V5; preserve an active finalizer and its SQLite state
./stop.sh     # gracefully stop V5 and any locally managed finalizer
./status.sh   # report V5 health and finalizer process/health/heartbeat separately
```

`HARVESTPOOL_FINALIZER_ENABLED=false` is the checked-in default. With that setting, the website
starts normally and `./status.sh` reports `Finalizer: disabled`. A credentials file never activates
the worker by itself. Setting `HARVESTPOOL_FINALIZER_ENABLED=true` is the explicit approval; root
startup then requires the credential file to exist with no group/world permissions and refuses to
start or adopt an unknown worker. The worker itself still validates the exact Testnet contract,
restricted function-call key, token configuration, and durable state before live work.

Root-script ownership is recorded in `.harvestpool-v5.pid` and `.harvestpool-finalizer.pid`; both
files are ignored by Git. `restart.sh` does not signal the finalizer, so a poll or an uncertain
transaction outcome is not interrupted by a web restart. `stop.sh` sends SIGTERM to the managed
worker process group and retains the SQLite database for crash recovery. An active worker is never
adopted based only on a port or health endpoint.

Every enabled poll validates the exact canonical V5 receiver, native Circle Testnet USDC token and
six decimals; reads final chain time and authoritative purchases; leases eligible work; persists
the exact signed bytes and hash before broadcast; and confirms `Funded`/`Failed` from chain state.
SQLite WAL storage retains operations and append-only events across restarts. Unknown responses
are reconciled by transaction hash and state before the identical signed bytes may be rebroadcast
a bounded number of times. The worker never signs a replacement while an outcome is uncertain.

## Credentials and fail-closed configuration

Live operation requires a private JSON file containing `account_id`, `public_key`, and
`private_key`, readable only by the service user (`0600` on POSIX). Keep it outside the clone,
container image, logs, and Git. Dry-run and tests do not read it.

The on-chain key must be a function-call key with:

- receiver exactly `harvestpool-v5-usdc-dalamaa-20261109.testnet`;
- method list exactly `finalize_purchase`;
- a finite, positive allowance; and
- only enough account balance for planned gas.

The worker rejects Full Access, missing/unlimited/zero allowance, another receiver, extra methods,
another contract, another token, an insecure credential-file mode, or a mismatched keypair.

Use deployment-owned paths rather than checked-in or machine-specific paths:

```dotenv
HARVESTPOOL_FINALIZER_ENABLED=false
HARVESTPOOL_FINALIZER_CONTRACT_ID=harvestpool-v5-usdc-dalamaa-20261109.testnet
HARVESTPOOL_FINALIZER_RPC_URL=https://rpc.testnet.fastnear.com
HARVESTPOOL_FINALIZER_RPC_TIMEOUT_SECONDS=10
# FASTNEAR_API_KEY is a hosted-service secret; omit it from Git and prefer secret injection.
HARVESTPOOL_FINALIZER_CREDENTIALS_FILE=/path-owned-by-service/finalizer.json
HARVESTPOOL_FINALIZER_DB=/path-on-persistent-storage/finalizer.sqlite3
HARVESTPOOL_FINALIZER_POLL_SECONDS=60
HARVESTPOOL_FINALIZER_HEALTH_HOST=127.0.0.1
HARVESTPOOL_FINALIZER_HEALTH_PORT=8091
HARVESTPOOL_FINALIZER_HEALTH_STALE_SECONDS=180
```

Do not run the same service key in two active processes. Database leases protect workers sharing
one database, but cannot coordinate copies using different databases. Use one key, one foreground
process, and one persistent database; provision a distinct restricted key for any independent
deployment.

## Health, restart, and emergency recovery

`GET http://127.0.0.1:8091/healthz` reports enabled/dry-run state, last poll/error, heartbeat age,
stale threshold, inspected purchases, and durable operation counts. It returns HTTP 503 for an
error or stale heartbeat. Alert on `stale: true`, `unknown`, or `contract_rejected`. An expired deal
remaining authoritative `Open` is not, by itself, evidence that the worker failed; the customer UI
keeps it visible as **Closed · final result pending** while automation resolves it.

The dependency-free operator probe applies the same alert conditions and exits nonzero for an
unavailable endpoint, HTTP 503, `ok=false`, a stale heartbeat, a last error, or durable `unknown`
or `contract_rejected` work:

```sh
python -m automation.healthcheck
```

It is suitable for a systemd timer, cron, or an external monitor. A nonzero exit and journal entry
are alert signals, not notification delivery; configure the deployment's email, pager, webhook, or
monitoring receiver separately and test that receiver before claiming operator notifications work.

After a crash or uncertain RPC result, preserve the original database and key. First stop the
supervised worker, then run the operator-only recovery command against the same database:

```sh
python -m automation.finalizer --once --reconcile-only --purchase-id PURCHASE_ID
```

This command requires enabled live configuration, the restricted credential, an allowlist, and a
previously persisted signed transaction. It refuses to create a new transaction. It may only
confirm chain state/status or perform the worker's bounded rebroadcast of the exact persisted
bytes. Restart continuous mode only after the durable row is reconciled. Never delete the database
to escape an uncertain state.

## Hosted operation

The generic command above works under any supervisor. Keep the web and worker as separate
processes and mount the SQLite directory on persistent storage.

- Linux: example service, health-check service/timer, and private environment templates live in
  `ops/systemd/`. The service uses `Restart=on-failure`, forwards SIGTERM, gives SQLite a persistent
  state directory, and holds a host-level `flock` for the full worker lifetime. Install exactly one
  copy for a signing key. Do not also let the root scripts manage that same worker; use either the
  root-script lifecycle or systemd as the sole supervisor.
- macOS: a launchd plist can run the same command with `KeepAlive`, a private environment/config
  file, and a persistent database path. launchd is optional, not required by the worker.
- Containers: run the module as the container's foreground process, inject the credential as a
  secret, mount the SQLite directory as a volume, and use `/healthz` for the health check. Never
  bake the key or database into the image.
- Other hosts: use any supervisor that forwards SIGTERM, restarts on failure, retains the database,
  and prevents duplicate instances.

For a conventional Linux/VPS layout, install the application at `/opt/harvestpool`, the restricted
credential at `/etc/harvestpool/finalizer.json` (owned by the `harvestpool` service user and mode
`0600`), the root-owned private environment at
`/etc/harvestpool/finalizer.env` (`0600`), and persistent state at
`/var/lib/harvestpool-finalizer`. Review the `User`, paths, and sandbox restrictions in the unit,
then install the templates and verify them while activation remains false:

```sh
sudo install -o root -g root -m 0644 ops/systemd/harvestpool-finalizer.service /etc/systemd/system/
sudo install -o root -g root -m 0644 ops/systemd/harvestpool-finalizer-healthcheck.service /etc/systemd/system/
sudo install -o root -g root -m 0644 ops/systemd/harvestpool-finalizer-healthcheck.timer /etc/systemd/system/
sudo install -o root -g root -m 0600 ops/systemd/finalizer.env.example /etc/harvestpool/finalizer.env
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/harvestpool-finalizer*.service /etc/systemd/system/harvestpool-finalizer-healthcheck.timer
```

Do not start or enable the service until activation is approved. After approval, set
`HARVESTPOOL_FINALIZER_ENABLED=true` in the private environment, start the service, then enable the
tested health timer. `systemctl restart harvestpool-finalizer` uses the same database and service
key; `flock` makes a second systemd-managed instance fail before Python starts.

### RPC policy

The supported FastNEAR Testnet endpoint is `https://rpc.testnet.fastnear.com`. Hosted operation
should inject `FASTNEAR_API_KEY`; the worker sends it only as an `Authorization: Bearer` header and
never includes it in the URL. Use the regular, non-archival endpoint because the worker needs only
current final state.

Keep polling at 60 seconds, the RPC timeout at 10 seconds, and the stale threshold at 180 seconds.
Calls are sequential; with eight purchases an idle poll uses about eleven RPC requests per minute.
The worker does not retry a failed view call within the same poll: HTTP/RPC failure makes health
unhealthy and the next poll retries after 60 seconds. A possibly accepted submission is different:
its exact signed bytes and hash are already durable, no replacement is signed, and only those same
bytes may be rebroadcast up to three total attempts after the reconciliation delay. This bounds
provider load and preserves transaction identity during 429, timeout, and unknown-result failures.

## Validation coverage and remaining production steps

`python -m unittest -v automation.test_finalizer` covers disabled/fresh configuration, one-shot and
dry-run allowlists, zero-buyer failure, minimum-satisfied funding, final states, missing credentials,
exact contract/token/key restrictions, finite allowance, RPC failure/recovery, uncertain response,
same-transaction rebroadcast, duplicate polls, concurrent leases, crash/restart, delayed chain
state, stale heartbeat, graceful shutdown, reconcile-only recovery, and historical receipt parsing.
JavaScript tests verify expired deals stay visible, joining is blocked, and no customer-facing
finalization control remains.

Before production-style continuous operation: provision a new restricted key per deployment,
independently inspect its live permission and allowance, select and back up persistent storage,
configure alerts and a trusted RPC policy, rehearse restore/recovery, and explicitly approve
activation. Continuous mode must remain disabled until then.
