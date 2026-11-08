# NEAR testnet deployment runbook

This project is testnet-only. Never set `NEAR_ENV=mainnet`, never use a mainnet account, and never put wallet secrets in the repository or Flask environment.

## Local verification

```sh
rustup target add wasm32-unknown-unknown
cargo test -p harvest-pool-contract
cd contract
cargo near build non-reproducible-wasm
cd ..
cargo test -p harvest-pool-contract --test integration -- --ignored --nocapture
```

The expected artifact is `target/near/harvest_pool_contract/harvest_pool_contract.wasm`.

## Testnet steps

Use the current NEAR CLI-RS login/keychain flow with a dedicated testnet contract account. The account must be funded only with testnet NEAR and must not share keys with the Flask service.

```sh
near deploy <dedicated-account.testnet> ./target/near/harvest_pool_contract.wasm
near view <dedicated-account.testnet> get_config '{}'
```

Initialize with the 20 member account IDs using a wallet-signed transaction. Record the deployment transaction hash, code hash, contract account, initialization transaction hash, and explorer links. Then run a small testnet scenario with disposable testnet accounts:

1. create an offer;
2. approve it with the configured supermajority;
3. make exact funded commitments;
4. verify an unpaid/incorrect/duplicate/oversubscribed call fails;
5. finalize after the deadline;
6. submit evidence and collect the funded-household vote;
7. release payment and verify the final state and transfer receipt;
8. run a failed order and claim each refund exactly once.

The deployer must provide real transaction evidence before this phase is considered deployed. This repository does not include credentials, secret keys, or a mainnet deployment.

## Recorded testnet evidence

The Phase 1 live smoke test used disposable testnet accounts and completed purchase `0` with two funded household commitments. Transaction links and the final on-chain read are recorded in [`docs/testnet-evidence.md`](testnet-evidence.md). These accounts and funds are for testnet verification only.
