# HarvestPool agent instructions

## Canonical local application

- V5 is the canonical development application.
- Root `start.sh`, `restart.sh`, `stop.sh`, and `status.sh` manage V5 on `127.0.0.1:5011`; they
  manage the independent finalizer only when `HARVESTPOOL_FINALIZER_ENABLED=true` is explicitly
  configured and its credential file passes the local permission check.
- V4 on port `5010` is legacy. Do not use V4 values as a fallback for V5.
- The explicit legacy launcher is `scripts/restart-v4.sh`; its managed shutdown helper is
  `scripts/stop-v4.sh`.
- The canonical V5 process uses the existing Flask command shape:
  `python -m flask --app web.app run --host 127.0.0.1 --port 5011`, with debug/reload disabled by
  the root scripts.
- Root scripts load `.env`, require the exact V5 values, refuse V4/V2 configuration, refuse an
  unrelated listener on port 5011, and use `.harvestpool-v5.pid` for process ownership.

## Canonical deployed Testnet configuration

- Purchase/escrow: `harvestpool-v5-usdc-dalamaa-20261109.testnet`
- Governance: `harvestpool-v3-v5-dalamaa-20261109.testnet`
- Circle Testnet USDC: `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`
- Network: `testnet`; V5 token decimals: `6`

Never replace these values with V4, V2, mock-USDC, or another token. Do not change deployed
contracts, redeploy, or submit wallet/blockchain transactions as part of ordinary local UI or
startup work.

## Startup and shutdown

From the repository root, with the existing Python environment active:

```sh
./start.sh
./restart.sh
./stop.sh
./status.sh
```

`status.sh` reports the managed V5 PID and HTTP health plus separate finalizer process, health, and
heartbeat status. If port 5011 is occupied by a process that
is not recorded and fingerprinted by `.harvestpool-v5.pid`, do not kill it by port; inspect the
owner and stop it through its own supervisor, or choose an explicitly separate development setup.

Automatic finalization remains a separate, disabled-by-default service with its own restricted key,
database, health endpoint, and runbook in `docs/automatic-finalization.md`. `restart.sh` restarts
only V5 and preserves an active worker; `stop.sh` gracefully stops both locally managed services.

## Financial and wallet safety

- Flask is a read-only presentation shell; browser transactions are signed by the user’s wallet.
- Do not add private keys, seed phrases, credentials, or wallet secrets to scripts, `.env`, client
  code, logs, or Git.
- Do not claim that Testnet USDC is production money, a card charge, delivery evidence, or bank
  settlement. V5 fulfillment smoke tests use explicitly labeled simulation evidence.
- Treat every contribution, refund, reconciliation, payout, finalization, and wallet prompt as a
  financial boundary. Verify the full receiver, method, arguments, amount, deposit, and current
  on-chain state before any intentionally authorized transaction.

## Focused checks and documentation

Relevant focused checks include:

```sh
node --test web/static/*.test.js
node --check web/static/app.js
python -m py_compile web/app.py
python -m unittest -v automation.test_finalizer
cargo test -p harvest-pool-v5-contract
cargo test -p harvest-pool-v3-v5-contract
```

Do not run opt-in Sandbox journeys unless their WASM/build prerequisites and scope are intentional.
The V5 architecture and token boundary are documented in `docs/v5-usdc.md`; verified public
financial evidence is in `docs/v5-financial-baseline.md`; the finalizer boundary is in
`docs/automatic-finalization.md`; legacy V4 behavior is documented in `docs/v4-lifecycle.md` and
`docs/v4-deployment.md`.
