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

async fn try_commit(
    contract: &near_workspaces::Contract,
    member: &Account,
    id: u64,
    price: NearToken,
) -> Result<bool> {
    let result = member
        .call(contract.id(), "commit")
        .args_json(json!({ "purchase_id": id.to_string(), "quantity": 1 }))
        .deposit(price)
        .max_gas()
        .transact()
        .await?;
    Ok(result.is_success())
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
    assert_eq!(
        contract
            .call("get_offer_vote")
            .args_json(json!({ "purchase_id": id.to_string(), "account_id": member_a.id() }))
            .view()
            .await?
            .json::<Value>()?,
        Value::Bool(true)
    );
    assert_eq!(
        contract
            .call("get_offer_vote")
            .args_json(json!({ "purchase_id": id.to_string(), "account_id": member_c.id() }))
            .view()
            .await?
            .json::<Value>()?,
        Value::Null
    );

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

    worker.fast_forward(1_000).await?;
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
    assert!(member_c
        .call(contract.id(), "vote_on_fulfillment")
        .args_json(json!({ "purchase_id": id.to_string(), "approve": true }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    member_a
        .call(contract.id(), "vote_on_fulfillment")
        .args_json(json!({ "purchase_id": id.to_string(), "approve": true }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        contract
            .call("get_fulfillment_vote")
            .args_json(json!({ "purchase_id": id.to_string(), "account_id": member_a.id() }))
            .view()
            .await?
            .json::<Value>()?,
        Value::Bool(true)
    );
    assert!(member_a
        .call(contract.id(), "vote_on_fulfillment")
        .args_json(json!({ "purchase_id": id.to_string(), "approve": false }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
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

    worker.fast_forward(1_000).await?;
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

#[tokio::test]
#[ignore = "sandbox integration test; build the WASM and opt in with --ignored"]
async fn open_purchase_accepts_at_most_the_remaining_funded_household_spots() -> Result<()> {
    let wasm = std::fs::read(WASM_PATH)?;
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm).await?;

    let mut members = Vec::new();
    for _ in 0..18 {
        members.push(worker.dev_create_account().await?);
    }
    let mut competitors = Vec::new();
    for _ in 0..5 {
        competitors.push(worker.dev_create_account().await?);
    }

    contract
        .call("new")
        .args_json(json!({
            "members": members.iter().map(|member| member.id()).collect::<Vec<_>>()
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let now = worker.view_block().await?.timestamp();
    let deadline = now + 60 * 1_000_000_000;
    let fulfillment_deadline = deadline + DAY_NS;
    let price = NearToken::from_near(1);
    let purchase_id: String = members[0]
        .call(contract.id(), "create_open_purchase")
        .args_json(json!({
            "min_quantity": 20,
            "max_quantity": 100,
            "max_funded_members": 20,
            "price_per_unit": price.as_yoctonear().to_string(),
            "deadline_ns": deadline.to_string(),
            "cancellation_deadline_ns": deadline.to_string(),
            "fulfillment_evidence_deadline_ns": fulfillment_deadline.to_string(),
            "farmer_id": members[0].id(),
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    let id: u64 = purchase_id.parse()?;

    for member in members.iter().take(12) {
        vote_on_offer(&contract, member, id).await?;
    }

    for member in &members {
        member
            .call(contract.id(), "commit")
            .args_json(json!({ "purchase_id": id.to_string(), "quantity": 1 }))
            .deposit(price)
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }

    let mut before = Vec::new();
    for account in &competitors {
        before.push(account.view_account().await?);
    }

    let (a, b, c, d, e) = tokio::join!(
        try_commit(&contract, &competitors[0], id, price),
        try_commit(&contract, &competitors[1], id, price),
        try_commit(&contract, &competitors[2], id, price),
        try_commit(&contract, &competitors[3], id, price),
        try_commit(&contract, &competitors[4], id, price),
    );
    let outcomes = vec![a?, b?, c?, d?, e?];
    assert_eq!(outcomes.iter().filter(|accepted| **accepted).count(), 2);

    let purchase = view_purchase(&contract, id).await?;
    assert_eq!(purchase["open_membership"], true);
    assert_eq!(purchase["max_quantity"], 100);
    assert_eq!(purchase["total_quantity"], 20);
    assert_eq!(purchase["funded_member_count"], 20);
    assert_eq!(purchase["available_funded_member_slots"], 0);
    assert_eq!(
        purchase["commitments"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|commitment| commitment["state"] == "Active")
            .count(),
        20
    );

    let fee_buffer = NearToken::from_millinear(10).as_yoctonear();
    for (index, accepted) in outcomes.iter().enumerate() {
        if !accepted {
            let after = competitors[index]
                .view_account()
                .await?
                .balance
                .as_yoctonear();
            let before = before[index].balance.as_yoctonear();
            assert!(
                after >= before.saturating_sub(fee_buffer),
                "rejected contribution retained principal for competitor {index}"
            );
        }
    }

    Ok(())
}
