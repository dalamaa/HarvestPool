# V4 Testnet deployment handoff

The verified standard artifacts were deployed and initialized on Testnet on 2026-11-09 after
explicit authorization. The existing V2 (`harvestpool-v2-dalamaa-20261108.testnet`) and original
V3 (`harvestpool-v3-dalamaa-20261109.testnet`) accounts remain separate and unchanged.

## Deployed accounts

- Purchase contract: `harvestpool-v4-dalamaa-20261109.testnet`
- Issues and decisions for V4: `harvestpool-v3-v4-dalamaa-20261109.testnet`

The second account must be a new V3 instance. The deployed V3 belongs to V2 and must not be
reinitialized, upgraded, or repointed.

## Reviewed artifacts

- V4: `target/near/harvest_pool_v4_contract/harvest_pool_v4_contract.wasm`
  - 225,332 bytes
  - SHA-256: `f6da1eb2dc4584045614c2dfdf094f51cc8e7a5845855d6f0127dcd7f4056a3c`
- V3-for-V4: `target/near/harvest_pool_v3_contract/harvest_pool_v3_contract.wasm`
  - 217,903 bytes
  - SHA-256: `179e07f5aedf6a639dda1cc872007b963637446ba70014bf09465aa3e5e8aa30`

These are deployable optimized host-build artifacts produced with `cargo near build
non-reproducible-wasm`, Rust 1.99.1, the workspace release profile (`overflow-checks`, LTO, one
codegen unit, abort-on-panic), and cargo-near's `wasm-opt -O` post-step. They are tied to the
current working-tree source rather than a committed release revision:

- V4 source SHA-256: `3d9c517a0356082fc1e6f98bd966adea4bbba0c43eba32ef59f606a831e6680c`
- V3 source SHA-256: `f02ddb2a6a2441a28781e90fd4ed42beb378d1c1bf9cad0a14560d0ee450c1a5`
- workspace lockfile SHA-256: `c15122377f33ca7518252a215eee06dea0fe69e3ff8d4100ada6aeaf31edf796`

The current Git HEAD (`b54e7d12e4eebb453a841e466bad1c1e1f024687`) predates V3/V4 and cannot be
claimed as their source revision. A clean isolated snapshot was committed locally as
`80544b8c6f34af9265dd24d6935b9dd2c630de07` only to test the reproducible pipeline. It produced a
225,738-byte V4 artifact with SHA-256
`f4efc659f2112bb0cdc3e73e2a6a7144158cc4412082fcfe06079f645461b647`; the 406-byte difference is
embedded NEP-330 build/source provenance, not a contract-logic change. That snapshot revision was
not pushed and must not be deployed as publicly verifiable source. The matching V3 container build
failed when Docker stopped with `unexpected EOF` and produced no artifact. Do not repeat the
amd64/QEMU build on Apple Silicon; use native x86_64 Linux CI after committing the exact release
source, update the stale image metadata, and record both CI hashes before a reproducible release.

## Testnet deployment record

The official Testnet faucet created each account with 10 NEAR. No existing HarvestPool contract
account funded this deployment.

| Operation | Transaction |
| --- | --- |
| Create/fund V4 | `GN6TAgC1Q23oxqEJ2irNeYpqYrPtMZE61tZSwECP2ZLU` |
| Deploy V4 | `Ce43KPJDu1G2eHGovtx6iy2f7pXmC19tTsXiNMX4NbLo` |
| Initialize V4 | `E3UWqgGaae1G5QPnUMSotHiMhKYKAdUMs8YDcysPCQxq` |
| Create/fund V3-for-V4 | `CRXLFZ7qw57GsGDdoKeU9sChppEuZwZB8EzpwdaNtjMM` |
| Deploy V3-for-V4 | `5DHXDhopP1BpvfE4BHBd8kxqMpLRKzzX3RDQPSBSJw5D` |
| Initialize V3-for-V4 | `51BoT98rkuVhsCDZNRWQfPftz1pH5fhnsw6MghA56KpV` |

Read-back of each account's deployed bytecode produced the reviewed SHA-256 values above. At
initialization time V4 reported the controlled pilot supplier and zero purchases. A later read-only
audit on 2026-11-09 found purchase count `1` and one open native-NEAR purchase; this document does
not claim the deployment remains empty. V3-for-V4 reports V4 as its membership
authority, supports `YesNo` and `MultipleChoice`, describes voting as public, and has zero issues
and decisions.

| Account | Balance | Storage usage | Code hash |
| --- | ---: | ---: | --- |
| V4 | 9.9981179488585121 NEAR | 225,980 bytes | `HccCbqDiF9pB41LAPLxRoGZjvwqcpSLTWa6WyQu6pzFd` |
| V3-for-V4 | 9.998219309441286 NEAR | 218,367 bytes | `2bC99oanPpfpbXR6NK1DkyHB3Xnr1iWk5xDjkAmQUAJj` |

## Initialization

V4 accepts a fixed supplier list at initialization. The controlled pilot account is
`harvestpool-farmer-1.testnet`, displayed as `HarvestPool Pilot Supplier`. This is an allowlisted
Testnet identity, not an independently verified business. The current schema requires nonempty
location and public-contact strings even though neither fact is available; use the explicit
`Not provided` sentinel for each rather than inventing data. A later optional-field migration is
not required for this pilot deployment.

V4 input shape:

```json
{
  "suppliers": [
    {
      "account_id": "harvestpool-farmer-1.testnet",
      "business_name": "HarvestPool Pilot Supplier",
      "location": "Not provided",
      "public_contact": "Not provided"
    }
  ]
}
```

V3-for-V4 input is exact:

```json
{
  "v2_contract_id": "harvestpool-v4-dalamaa-20261109.testnet"
}
```

`v2_contract_id` is a historical field name. This new V3 instance reads the configured V4 contract
only; it never receives financial authority.

## Application environment

Keep port 5010 and use only public/read-only values:

```dotenv
PORT=5010
NEAR_NETWORK=testnet
HARVESTPOOL_CONTRACT_ID=harvestpool-v4-dalamaa-20261109.testnet
HARVESTPOOL_CONTRACT_VERSION=V4
HARVESTPOOL_V3_CONTRACT_ID=harvestpool-v3-v4-dalamaa-20261109.testnet
HARVESTPOOL_PUBLIC_BASE_URL=
```

Never put a seed phrase, private key, or wallet credential in the Flask environment.

`HARVESTPOOL_PUBLIC_BASE_URL` may remain empty for localhost testing. A public website URL is not
required to create, deploy, or initialize either contract.

## Testnet balance and fee budget

Read-only RPC checks on 2026-11-09 found both proposed account IDs absent and the controlled
supplier account present. Testnet protocol version 88 reports storage staking of
`0.00001 NEAR/byte`; storage is locked in the contract account, not paid to HarvestPool.

| Account | WASM bytes | Code storage stake | Estimated minimum after account/key/init | Recommended pilot balance |
| --- | ---: | ---: | ---: | ---: |
| V4 | 225,332 | 2.25332 NEAR | 2.27 NEAR | 5 NEAR |
| V3-for-V4 | 217,903 | 2.17903 NEAR | 2.20 NEAR | 5 NEAR |

The extra recommended balance is storage headroom for purchases, commitments, issues, and votes;
it is not a storage deposit attached to initialization. At the observed gas price of 100,000,000
yoctoNEAR/gas, protocol deploy-action estimates are about 25.881 Tgas / 0.00259 NEAR for V4 and
25.047 Tgas / 0.00250 NEAR for V3. Reserve up to 0.003 NEAR for each 30-Tgas initialization call.
Account creation has a 0.007 NEAR protocol charge plus approximately 0.00084 NEAR base gas and key
bytes. Budget 0.02 NEAR of fees per account in addition to its balance. The likely funding wallet
`dalamaa.testnet` held about 1.89583 NEAR at the check and cannot self-fund the recommended 10 NEAR;
use the authorized Testnet faucet flow or fund that wallet separately after explicit authorization.

## Deployment checklist status

1. Approve the two account IDs and the controlled pilot supplier profile above.
2. Deferred by explicit authorization: commit the exact release source and run both reproducible
   builds on native x86_64 Linux CI before claiming public source reproducibility.
3. Create/fund the two new Testnet accounts using an authorized wallet.
4. Deploy V4, compare the deployed code hash, initialize once with the approved supplier JSON, and
   verify `get_config`, `get_suppliers`, and `get_purchase_count` (`0`).
5. Deploy V3-for-V4, compare its code hash, initialize it with the V4 account, and verify
   `get_config().v2_contract_id` exactly equals the new V4 account,
   `supported_vote_types` is `["YesNo", "MultipleChoice"]`, and `private_voting` is `false`.
6. Run a disposable Testnet smoke journey: supplier offer, organizer request and supplier response,
   two exact contributions, cutoff/finalization, issue/decision, evidence, fulfillment approvals,
   one payment, one failed group, and one refund. Save every transaction and receipt link.
7. Completed: the local app reports V4 and the dedicated V3 account on port 5010.
8. Complete the desktop and 375px mobile manual checklist in `docs/v4-lifecycle.md`, including real
   wallet popup/redirect recovery and a screen-reader/keyboard pass.

## Exact near-cli 0.31 deployment sequence

These are the commands used for the authorized standard-build Testnet deployment. Do not rerun the
initializers or redeploy without a separately reviewed upgrade authorization.

```sh
export PATH="$HOME/.cargo/bin:$PATH"
export V4_CONTRACT="harvestpool-v4-dalamaa-20261109.testnet"
export V3_V4_CONTRACT="harvestpool-v3-v4-dalamaa-20261109.testnet"
export V4_WASM="target/near/harvest_pool_v4_contract/harvest_pool_v4_contract.wasm"
export V3_V4_WASM="target/near/harvest_pool_v3_contract/harvest_pool_v3_contract.wasm"

near account create-account sponsor-by-faucet-service "$V4_CONTRACT" \
  autogenerate-new-keypair save-to-keychain network-config testnet create
near account create-account sponsor-by-faucet-service "$V3_V4_CONTRACT" \
  autogenerate-new-keypair save-to-keychain network-config testnet create

near account view-account-summary "$V4_CONTRACT" network-config testnet now
near account view-account-summary "$V3_V4_CONTRACT" network-config testnet now
# Stop if either available balance is below the recommended 5 NEAR pilot balance.

near contract deploy "$V4_CONTRACT" use-file "$V4_WASM" without-init-call \
  network-config testnet sign-with-keychain send
near contract call-function as-transaction "$V4_CONTRACT" new json-args \
  '{"suppliers":[{"account_id":"harvestpool-farmer-1.testnet","business_name":"HarvestPool Pilot Supplier","location":"Not provided","public_contact":"Not provided"}]}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$V4_CONTRACT" \
  network-config testnet sign-with-keychain send

near contract deploy "$V3_V4_CONTRACT" use-file "$V3_V4_WASM" without-init-call \
  network-config testnet sign-with-keychain send
near contract call-function as-transaction "$V3_V4_CONTRACT" new json-args \
  '{"v2_contract_id":"harvestpool-v4-dalamaa-20261109.testnet"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$V3_V4_CONTRACT" \
  network-config testnet sign-with-keychain send

near contract call-function as-read-only "$V4_CONTRACT" get_config json-args '{}' \
  network-config testnet now
near contract call-function as-read-only "$V4_CONTRACT" get_suppliers json-args '{}' \
  network-config testnet now
near contract call-function as-read-only "$V4_CONTRACT" get_purchase_count json-args '{}' \
  network-config testnet now
near contract call-function as-read-only "$V3_V4_CONTRACT" get_config json-args '{}' \
  network-config testnet now
near contract call-function as-read-only "$V3_V4_CONTRACT" get_issue_count json-args '{}' \
  network-config testnet now
near contract call-function as-read-only "$V3_V4_CONTRACT" get_decision_count json-args '{}' \
  network-config testnet now

# Download the deployed bytecode through read-only RPC and compare these SHA-256 values with the
# authorized local artifacts. Run once for each account.
curl --fail --silent --show-error https://rpc.testnet.near.org \
  -H 'Content-Type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":\"code\",\"method\":\"query\",\"params\":{\"request_type\":\"view_code\",\"finality\":\"final\",\"account_id\":\"$V4_CONTRACT\"}}" \
  | jq -r '.result.code_base64' | openssl base64 -d -A | openssl dgst -sha256
curl --fail --silent --show-error https://rpc.testnet.near.org \
  -H 'Content-Type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":\"code\",\"method\":\"query\",\"params\":{\"request_type\":\"view_code\",\"finality\":\"final\",\"account_id\":\"$V3_V4_CONTRACT\"}}" \
  | jq -r '.result.code_base64' | openssl base64 -d -A | openssl dgst -sha256
```
