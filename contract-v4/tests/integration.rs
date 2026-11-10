//! Runtime coverage for the corrected V4 lifecycle.
//!
//! Build `target/near/harvest_pool_v4_contract/harvest_pool_v4_contract.wasm`, then run:
//! `cargo test -p harvest-pool-v4-contract --test integration -- --ignored --nocapture`

use anyhow::Result;
use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const WASM_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/near/harvest_pool_v4_contract/harvest_pool_v4_contract.wasm"
);
const DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;

fn terms(now: u64, price: NearToken) -> Value {
    json!({
        "product_name": "Family beef box",
        "description": "A twenty-pound mixed box",
        "quantity_unit": "box",
        "price_per_unit": price.as_yoctonear().to_string(),
        "listed_price_usd_cents": "12500",
        "min_quantity": 2,
        "max_quantity": 4,
        "max_quantity_per_household": 2,
        "max_funded_members": 4,
        "pickup_or_delivery": "Saturday pickup at the community center",
        "join_deadline_ns": (now + 60_000_000_000).to_string(),
        "fulfillment_deadline_ns": (now + 60_000_000_000 + DAY_NS).to_string(),
        "cancellation_and_refund_terms": "Full refund if the target is missed or the supplier does not fulfill."
    })
}

async fn purchase(contract: &near_workspaces::Contract, id: u64) -> Result<Value> {
    Ok(contract
        .call("get_purchase")
        .args_json(json!({ "purchase_id": id.to_string() }))
        .view()
        .await?
        .json()?)
}

async fn init(contract: &Contract, suppliers: &[&Account]) -> Result<()> {
    let profiles: Vec<Value> = suppliers
        .iter()
        .enumerate()
        .map(|(index, supplier)| {
            json!({
                "account_id": supplier.id(),
                "business_name": format!("Prairie Family Farm {}", index + 1),
                "location": "Illinois",
                "public_contact": format!("farm{}@example.test", index + 1),
            })
        })
        .collect();
    contract
        .call("new")
        .args_json(json!({ "suppliers": profiles }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn supplier_offer(
    worker: &Worker<Sandbox>,
    contract: &Contract,
    supplier: &Account,
    price: NearToken,
) -> Result<u64> {
    let now = worker.view_block().await?.timestamp();
    let id: String = supplier
        .call(contract.id(), "create_supplier_offer")
        .args_json(json!({ "terms": terms(now, price) }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    Ok(id.parse()?)
}

#[tokio::test]
#[ignore = "sandbox integration test; build the V4 WASM and opt in with --ignored"]
async fn organizer_request_requires_supplier_then_completes_safely() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&std::fs::read(WASM_PATH)?).await?;
    let organizer = worker.dev_create_account().await?;
    let supplier = worker.dev_create_account().await?;
    let household_a = worker.dev_create_account().await?;
    let household_b = worker.dev_create_account().await?;
    let price = NearToken::from_millinear(1);

    init(&contract, &[&supplier]).await?;

    let now = worker.view_block().await?.timestamp();
    let id: String = organizer
        .call(contract.id(), "create_purchase_request")
        .args_json(json!({ "supplier_id": supplier.id(), "terms": terms(now, price) }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    let id: u64 = id.parse()?;
    assert_eq!(purchase(&contract, id).await?["state"], "AwaitingSupplier");
    assert!(organizer
        .call(contract.id(), "accept_supplier_request")
        .args_json(json!({ "purchase_id": id.to_string() }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    supplier
        .call(contract.id(), "accept_supplier_request")
        .args_json(json!({ "purchase_id": id.to_string() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(purchase(&contract, id).await?["state"], "Open");

    for household in [&household_a, &household_b] {
        household
            .call(contract.id(), "commit")
            .args_json(json!({ "purchase_id": id.to_string(), "quantity": 1 }))
            .deposit(price)
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    worker.fast_forward(1_000).await?;
    organizer
        .call(contract.id(), "finalize_purchase")
        .args_json(json!({ "purchase_id": id.to_string() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    supplier
        .call(contract.id(), "submit_fulfillment_evidence")
        .args_json(json!({ "purchase_id": id.to_string(), "evidence_hash": "sha256:delivery" }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    for household in [&household_a, &household_b] {
        household
            .call(contract.id(), "vote_on_fulfillment")
            .args_json(json!({ "purchase_id": id.to_string(), "approve": true }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    organizer
        .call(contract.id(), "release_payment")
        .args_json(json!({ "purchase_id": id.to_string() }))
        // Match the browser adapter's standard transaction budget. This call must
        // leave enough gas for both the transfer receipt and the 20 Tgas callback.
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(purchase(&contract, id).await?["state"], "Completed");
    eprintln!("request lifecycle: unauthorized accept rejected; exact agreement funded, approved, and paid once");
    Ok(())
}

#[tokio::test]
#[ignore = "sandbox integration test; build the V4 WASM and opt in with --ignored"]
async fn supplier_offer_request_decline_and_authorization_edges() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&std::fs::read(WASM_PATH)?).await?;
    let organizer = worker.dev_create_account().await?;
    let supplier = worker.dev_create_account().await?;
    let outsider = worker.dev_create_account().await?;
    let price = NearToken::from_millinear(1);
    init(&contract, &[&supplier]).await?;

    let offer_id = supplier_offer(&worker, &contract, &supplier, price).await?;
    let offer = purchase(&contract, offer_id).await?;
    assert_eq!(offer["state"], "Open");
    assert_eq!(offer["origin"], "SupplierOffer");
    assert_eq!(
        offer["supplier_agreement"]["terms_hash"],
        offer["terms_hash"]
    );
    assert!(outsider
        .call(contract.id(), "vote_on_offer")
        .args_json(json!({ "purchase_id": offer_id.to_string(), "approve": true }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    assert!(supplier
        .call(contract.id(), "commit")
        .args_json(json!({ "purchase_id": offer_id.to_string(), "quantity": 1 }))
        .deposit(price)
        .max_gas()
        .transact()
        .await?
        .is_failure());

    let now = worker.view_block().await?.timestamp();
    let request_id: String = organizer
        .call(contract.id(), "create_purchase_request")
        .args_json(json!({ "supplier_id": supplier.id(), "terms": terms(now, price) }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert!(organizer
        .call(contract.id(), "commit")
        .args_json(json!({ "purchase_id": request_id, "quantity": 1 }))
        .deposit(price)
        .max_gas()
        .transact()
        .await?
        .is_failure());
    assert!(outsider
        .call(contract.id(), "accept_supplier_request")
        .args_json(json!({ "purchase_id": request_id }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    supplier
        .call(contract.id(), "decline_supplier_request")
        .args_json(json!({ "purchase_id": request_id }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        purchase(&contract, request_id.parse()?).await?["state"],
        "Declined"
    );
    eprintln!("authorization edges: supplier offer opened without vote; pre-authorization funding and wrong signer rejected; supplier decline recorded");
    Ok(())
}

#[tokio::test]
#[ignore = "sandbox integration test; build the V4 WASM and opt in with --ignored"]
async fn contribution_limits_cutoff_failure_refunds_and_conflicts() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&std::fs::read(WASM_PATH)?).await?;
    let supplier = worker.dev_create_account().await?;
    let organizer = worker.dev_create_account().await?;
    let member = worker.dev_create_account().await?;
    let contender_a = worker.dev_create_account().await?;
    let contender_b = worker.dev_create_account().await?;
    let price = NearToken::from_millinear(1);
    init(&contract, &[&supplier]).await?;

    let cancellable = supplier_offer(&worker, &contract, &supplier, price).await?;
    assert!(organizer
        .call(contract.id(), "commit")
        .args_json(json!({ "purchase_id": cancellable.to_string(), "quantity": 1 }))
        .deposit(NearToken::from_yoctonear(price.as_yoctonear() - 1))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    assert!(organizer
        .call(contract.id(), "commit")
        .args_json(json!({ "purchase_id": cancellable.to_string(), "quantity": 3 }))
        .deposit(NearToken::from_millinear(3))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    organizer
        .call(contract.id(), "commit")
        .args_json(json!({ "purchase_id": cancellable.to_string(), "quantity": 1 }))
        .deposit(price)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        contract
            .call("is_funded_member")
            .args_json(
                json!({ "purchase_id": cancellable.to_string(), "account_id": organizer.id() })
            )
            .view()
            .await?
            .json::<bool>()?,
        true
    );
    assert_eq!(
        contract
            .call("is_funded_member")
            .args_json(json!({ "purchase_id": cancellable.to_string(), "account_id": member.id() }))
            .view()
            .await?
            .json::<bool>()?,
        false
    );
    organizer
        .call(contract.id(), "cancel_commitment")
        .args_json(json!({ "purchase_id": cancellable.to_string() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    for household in [&member, &contender_a] {
        household
            .call(contract.id(), "commit")
            .args_json(json!({ "purchase_id": cancellable.to_string(), "quantity": 1 }))
            .deposit(price)
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    worker.fast_forward(1_000).await?;
    organizer
        .call(contract.id(), "finalize_purchase")
        .args_json(json!({ "purchase_id": cancellable.to_string() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(purchase(&contract, cancellable).await?["state"], "Funded");
    organizer
        .call(contract.id(), "claim_refund")
        .args_json(json!({ "purchase_id": cancellable.to_string() }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        purchase(&contract, cancellable).await?["commitments"][0]["state"],
        "Refunded"
    );
    assert!(organizer
        .call(contract.id(), "claim_refund")
        .args_json(json!({ "purchase_id": cancellable.to_string() }))
        .max_gas()
        .transact()
        .await?
        .is_failure());

    let failed = supplier_offer(&worker, &contract, &supplier, price).await?;
    member
        .call(contract.id(), "commit")
        .args_json(json!({ "purchase_id": failed.to_string(), "quantity": 1 }))
        .deposit(price)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    worker.fast_forward(1_000).await?;
    assert!(member
        .call(contract.id(), "cancel_commitment")
        .args_json(json!({ "purchase_id": failed.to_string() }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    organizer
        .call(contract.id(), "finalize_purchase")
        .args_json(json!({ "purchase_id": failed.to_string() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(purchase(&contract, failed).await?["state"], "Failed");
    member
        .call(contract.id(), "claim_refund")
        .args_json(json!({ "purchase_id": failed.to_string() }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()?;
    assert!(member
        .call(contract.id(), "claim_refund")
        .args_json(json!({ "purchase_id": failed.to_string() }))
        .max_gas()
        .transact()
        .await?
        .is_failure());

    let now = worker.view_block().await?.timestamp();
    let mut one_slot_terms = terms(now, price);
    one_slot_terms["min_quantity"] = json!(1);
    one_slot_terms["max_quantity"] = json!(1);
    one_slot_terms["max_quantity_per_household"] = json!(1);
    one_slot_terms["max_funded_members"] = json!(1);
    let one_slot: String = supplier
        .call(contract.id(), "create_supplier_offer")
        .args_json(json!({ "terms": one_slot_terms }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    let first = contender_a
        .call(contract.id(), "commit")
        .args_json(json!({ "purchase_id": one_slot, "quantity": 1 }))
        .deposit(price)
        .max_gas()
        .transact();
    let second = contender_b
        .call(contract.id(), "commit")
        .args_json(json!({ "purchase_id": one_slot, "quantity": 1 }))
        .deposit(price)
        .max_gas()
        .transact();
    let (first, second) = tokio::join!(first, second);
    let first = first?;
    let second = second?;
    assert_ne!(first.is_success(), second.is_success());
    let one_slot_view = purchase(&contract, one_slot.parse()?).await?;
    assert_eq!(one_slot_view["funded_member_count"], 1);
    assert_eq!(one_slot_view["total_quantity"], 1);
    eprintln!("financial edges: exact deposit/household limit enforced; cancellation cutoff honored; failed group refunded once; concurrent final-slot commits admitted exactly one");
    Ok(())
}

#[tokio::test]
#[ignore = "sandbox integration test; build the V4 WASM and opt in with --ignored"]
async fn approval_payment_idempotency_gas_and_failed_callback() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&std::fs::read(WASM_PATH)?).await?;
    let supplier = worker.dev_create_account().await?;
    let failing_supplier = worker.dev_create_account().await?;
    let organizer = worker.dev_create_account().await?;
    let member = worker.dev_create_account().await?;
    let outsider = worker.dev_create_account().await?;
    let price = NearToken::from_millinear(1);
    init(&contract, &[&supplier, &failing_supplier]).await?;

    async fn approved_purchase(
        worker: &Worker<Sandbox>,
        contract: &Contract,
        supplier: &Account,
        organizer: &Account,
        member: &Account,
        price: NearToken,
    ) -> Result<u64> {
        let id = supplier_offer(worker, contract, supplier, price).await?;
        for household in [organizer, member] {
            household
                .call(contract.id(), "commit")
                .args_json(json!({ "purchase_id": id.to_string(), "quantity": 1 }))
                .deposit(price)
                .max_gas()
                .transact()
                .await?
                .into_result()?;
        }
        worker.fast_forward(1_000).await?;
        organizer
            .call(contract.id(), "finalize_purchase")
            .args_json(json!({ "purchase_id": id.to_string() }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        supplier
            .call(contract.id(), "submit_fulfillment_evidence")
            .args_json(json!({ "purchase_id": id.to_string(), "evidence_hash": "sha256:delivery" }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        for household in [organizer, member] {
            household
                .call(contract.id(), "vote_on_fulfillment")
                .args_json(json!({ "purchase_id": id.to_string(), "approve": true }))
                .max_gas()
                .transact()
                .await?
                .into_result()?;
        }
        Ok(id)
    }

    let id = supplier_offer(&worker, &contract, &supplier, price).await?;
    for household in [&organizer, &member] {
        household
            .call(contract.id(), "commit")
            .args_json(json!({ "purchase_id": id.to_string(), "quantity": 1 }))
            .deposit(price)
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    worker.fast_forward(1_000).await?;
    organizer
        .call(contract.id(), "finalize_purchase")
        .args_json(json!({ "purchase_id": id.to_string() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    supplier
        .call(contract.id(), "submit_fulfillment_evidence")
        .args_json(json!({ "purchase_id": id.to_string(), "evidence_hash": "sha256:delivery" }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert!(outsider
        .call(contract.id(), "vote_on_fulfillment")
        .args_json(json!({ "purchase_id": id.to_string(), "approve": true }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    assert!(organizer
        .call(contract.id(), "vote_on_fulfillment")
        .args_json(json!({ "purchase_id": id.to_string(), "approve": true }))
        .gas(Gas::from_gas(1))
        .transact()
        .await?
        .is_failure());
    assert!(organizer
        .call(contract.id(), "release_payment")
        .args_json(json!({ "purchase_id": id.to_string() }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    for household in [&organizer, &member] {
        household
            .call(contract.id(), "vote_on_fulfillment")
            .args_json(json!({ "purchase_id": id.to_string(), "approve": true }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    let supplier_balance_before = supplier.view_account().await?.balance.as_yoctonear();
    organizer
        .call(contract.id(), "release_payment")
        .args_json(json!({ "purchase_id": id.to_string() }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(purchase(&contract, id).await?["state"], "Completed");
    let supplier_balance_after = supplier.view_account().await?.balance.as_yoctonear();
    assert_eq!(
        supplier_balance_after - supplier_balance_before,
        price.as_yoctonear() * 2
    );
    assert!(organizer
        .call(contract.id(), "release_payment")
        .args_json(json!({ "purchase_id": id.to_string() }))
        .max_gas()
        .transact()
        .await?
        .is_failure());

    let failed_callback_id = approved_purchase(
        &worker,
        &contract,
        &failing_supplier,
        &organizer,
        &member,
        price,
    )
    .await?;
    failing_supplier
        .clone()
        .delete_account(organizer.id())
        .await?
        .into_result()?;
    organizer
        .call(contract.id(), "release_payment")
        .args_json(json!({ "purchase_id": failed_callback_id.to_string() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        purchase(&contract, failed_callback_id).await?["state"],
        "FulfillmentApproved"
    );
    eprintln!("payment safety: outsider/low-gas/premature actions rejected; payment completed once; failed native-transfer callback restored the approved state for retry");
    Ok(())
}
