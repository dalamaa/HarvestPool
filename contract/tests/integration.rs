//! Sandbox integration coverage for the runtime-dependent contract behavior.
//!
//! Run after producing `target/near/harvest_pool_contract.wasm`:
//! `cargo test -p harvest-pool-contract --test integration -- --ignored --nocapture`

use anyhow::Result;
use near_workspaces::types::NearToken;
use near_workspaces::Account;
use serde_json::{json, Value};

const WASM_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/near/harvest_pool_contract/harvest_pool_contract.wasm"
);
const DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;

async fn view_purchase(contract: &near_workspaces::Contract, id: u64) -> Result<Value> {
    Ok(contract
        .call("get_purchase")
        .args_json(json!({ "purchase_id": id.to_string() }))
        .view()
        .await?
        .json()?)
}

async fn vote_on_offer(
    contract: &near_workspaces::Contract,
    member: &Account,
    id: u64,
) -> Result<()> {
    member
        .call(contract.id(), "vote_on_offer")
        .args_json(json!({ "purchase_id": id.to_string(), "approve": true }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

#[tokio::test]
#[ignore = "sandbox integration test; build the WASM and opt in with --ignored"]
async fn funded_purchase_requires_evidence_vote_before_payment() -> Result<()> {
    let wasm = std::fs::read(WASM_PATH)?;
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm).await?;
    let member_a = worker.dev_create_account().await?;
    let member_b = worker.dev_create_account().await?;
    let member_c = worker.dev_create_account().await?;
    let farmer = worker.dev_create_account().await?;

    contract
        .call("new")
        .args_json(json!({
            "members": [member_a.id(), member_b.id(), member_c.id()]
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let now = worker.view_block().await?.timestamp();
    let deadline = now + 60 * 1_000_000_000;
    let fulfillment_deadline = deadline + DAY_NS;
    let purchase_id: String = member_a
        .call(contract.id(), "create_purchase")
        .args_json(json!({
            "min_quantity": 2,
            "max_quantity": 2,
            "price_per_unit": NearToken::from_millinear(1).as_yoctonear().to_string(),
            "deadline_ns": deadline.to_string(),
            "cancellation_deadline_ns": deadline.to_string(),
            "fulfillment_evidence_deadline_ns": fulfillment_deadline.to_string(),
            "farmer_id": farmer.id(),
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    let id: u64 = purchase_id.parse()?;

    vote_on_offer(&contract, &member_a, id).await?;
    vote_on_offer(&contract, &member_b, id).await?;

    let price = NearToken::from_millinear(1);
    for member in [&member_a, &member_b] {
        member
            .call(contract.id(), "commit")
            .args_json(json!({ "purchase_id": id.to_string(), "quantity": 1 }))
            .deposit(price)
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    assert_eq!(view_purchase(&contract, id).await?["state"], "Open");

    worker.fast_forward(10_000).await?;
    member_a
        .call(contract.id(), "finalize_purchase")
        .args_json(json!({ "purchase_id": id.to_string() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(view_purchase(&contract, id).await?["state"], "Funded");

    farmer
        .call(contract.id(), "submit_fulfillment_evidence")
        .args_json(json!({
            "purchase_id": id.to_string(),
            "evidence_hash": "sha256:weekly-box-delivery"
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    member_a
        .call(contract.id(), "vote_on_fulfillment")
        .args_json(json!({ "purchase_id": id.to_string(), "approve": true }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        view_purchase(&contract, id).await?["state"],
        "FulfillmentPending"
    );

    member_b
        .call(contract.id(), "vote_on_fulfillment")
        .args_json(json!({ "purchase_id": id.to_string(), "approve": true }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        view_purchase(&contract, id).await?["state"],
        "FulfillmentApproved"
    );

    member_c
        .call(contract.id(), "release_payment")
        .args_json(json!({ "purchase_id": id.to_string() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(view_purchase(&contract, id).await?["state"], "Completed");
    Ok(())
}

#[tokio::test]
#[ignore = "sandbox integration test; build the WASM and opt in with --ignored"]
async fn failed_order_exposes_only_pull_refunds() -> Result<()> {
    let wasm = std::fs::read(WASM_PATH)?;
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm).await?;
    let member_a = worker.dev_create_account().await?;
    let member_b = worker.dev_create_account().await?;
    let member_c = worker.dev_create_account().await?;

    contract
        .call("new")
        .args_json(json!({
            "members": [member_a.id(), member_b.id(), member_c.id()]
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let now = worker.view_block().await?.timestamp();
    let deadline = now + 60 * 1_000_000_000;
    let purchase_id: String = member_a
        .call(contract.id(), "create_purchase")
        .args_json(json!({
            "min_quantity": 2,
            "max_quantity": 2,
            "price_per_unit": NearToken::from_millinear(1).as_yoctonear().to_string(),
            "deadline_ns": deadline.to_string(),
            "cancellation_deadline_ns": deadline.to_string(),
            "fulfillment_evidence_deadline_ns": (deadline + DAY_NS).to_string(),
            "farmer_id": member_c.id(),
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    let id: u64 = purchase_id.parse()?;
    vote_on_offer(&contract, &member_a, id).await?;
    vote_on_offer(&contract, &member_b, id).await?;
    member_a
        .call(contract.id(), "commit")
        .args_json(json!({ "purchase_id": id.to_string(), "quantity": 1 }))
        .deposit(NearToken::from_millinear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    worker.fast_forward(10_000).await?;
    member_b
        .call(contract.id(), "finalize_purchase")
        .args_json(json!({ "purchase_id": id.to_string() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let purchase = view_purchase(&contract, id).await?;
    assert_eq!(purchase["state"], "Failed");
    assert_eq!(purchase["commitments"][0]["state"], "Refundable");

    member_a
        .call(contract.id(), "claim_refund")
        .args_json(json!({ "purchase_id": id.to_string() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        view_purchase(&contract, id).await?["commitments"][0]["state"],
        "Refunded"
    );
    Ok(())
}
