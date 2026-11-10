//! V3 issue and decision coverage. Build both WASMs, then opt in with:
//! `cargo test -p harvest-pool-v3-contract --test integration -- --ignored --nocapture`

use anyhow::Result;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

const V2_WASM_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/near/harvest_pool_contract/harvest_pool_contract.wasm"
);
const V3_WASM_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/near/harvest_pool_v3_contract/harvest_pool_v3_contract.wasm"
);

async fn view(contract: &Contract, method: &str, args: Value) -> Result<Value> {
    Ok(contract.call(method).args_json(args).view().await?.json()?)
}

async fn call(account: &Account, contract: &Contract, method: &str, args: Value) -> Result<()> {
    call_with_gas(account, contract, method, args, Gas::from_tgas(1_000)).await
}

async fn call_with_gas(
    account: &Account,
    contract: &Contract,
    method: &str,
    args: Value,
    gas: Gas,
) -> Result<()> {
    account
        .call(contract.id(), method)
        .args_json(args)
        .gas(gas)
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn create_purchase(
    now: u64,
    v2: &Contract,
    organizer: &Account,
    farmer: &Account,
    member: &Account,
) -> Result<u64> {
    let deadline = now + 120 * 1_000_000_000;
    let id: String = organizer
        .call(v2.id(), "create_open_purchase")
        .args_json(json!({
            "min_quantity": 2,
            "max_quantity": 2,
            "max_funded_members": 2,
            "price_per_unit": NearToken::from_millinear(1).as_yoctonear().to_string(),
            "deadline_ns": deadline.to_string(),
            "cancellation_deadline_ns": deadline.to_string(),
            "fulfillment_evidence_deadline_ns": (deadline + 10 * 1_000_000_000).to_string(),
            "farmer_id": farmer.id(),
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    let purchase_id: u64 = id.parse()?;
    call(
        organizer,
        v2,
        "vote_on_offer",
        json!({ "purchase_id": id, "approve": true }),
    )
    .await?;
    organizer
        .call(v2.id(), "commit")
        .args_json(json!({ "purchase_id": id, "quantity": 1 }))
        .deposit(NearToken::from_millinear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    member
        .call(v2.id(), "commit")
        .args_json(json!({ "purchase_id": id, "quantity": 1 }))
        .deposit(NearToken::from_millinear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(purchase_id)
}

async fn raise_issue(
    v3: &Contract,
    member: &Account,
    purchase_id: u64,
    subject: &str,
) -> Result<()> {
    call(
        member,
        v3,
        "raise_issue",
        json!({
            "purchase_id": purchase_id.to_string(),
            "subject": subject,
            "description": "The proposed pickup time no longer works for our household.",
            "suggested_solution": "Move pickup to Saturday morning.",
        }),
    )
    .await
}

#[tokio::test]
#[ignore = "sandbox integration test; build both WASMs and opt in with --ignored"]
async fn funded_issue_decision_and_supplier_agreement_journey() -> Result<()> {
    let v2_wasm = std::fs::read(V2_WASM_PATH)?;
    let v3_wasm = std::fs::read(V3_WASM_PATH)?;
    let worker = near_workspaces::sandbox().await?;
    let v2 = worker.dev_deploy(&v2_wasm).await?;
    let v3 = worker.dev_deploy(&v3_wasm).await?;
    let organizer = worker.dev_create_account().await?;
    let member = worker.dev_create_account().await?;
    let unfunded = worker.dev_create_account().await?;
    let farmer = worker.dev_create_account().await?;

    v2.call("new")
        .args_json(json!({ "members": [organizer.id()] }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    v3.call("new")
        .args_json(json!({ "v2_contract_id": v2.id() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let purchase_id = create_purchase(
        worker.view_block().await?.timestamp(),
        &v2,
        &organizer,
        &farmer,
        &member,
    )
    .await?;

    assert!(unfunded
        .call(v3.id(), "raise_issue")
        .args_json(json!({
            "purchase_id": purchase_id.to_string(),
            "subject": "Unfunded concern",
            "description": "This account has not funded the purchase.",
            "suggested_solution": null,
        }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    assert_eq!(
        view(&v3, "get_issue_count", json!({})).await?,
        Value::String("0".to_string())
    );

    let issue_args = json!({
        "purchase_id": purchase_id.to_string(),
        "subject": "Pickup time",
        "description": "The proposed pickup time no longer works for our household.",
        "suggested_solution": "Move pickup to Saturday morning.",
    });
    assert!(member
        .call(v3.id(), "raise_issue")
        .args_json(issue_args.clone())
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .is_failure());
    assert_eq!(
        view(&v3, "get_issue_count", json!({})).await?,
        Value::String("0".to_string())
    );
    member
        .call(v3.id(), "raise_issue")
        .args_json(issue_args)
        .gas(Gas::from_tgas(60))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        view(&v3, "get_issue_count", json!({})).await?,
        Value::String("1".to_string())
    );
    assert!(member
        .call(v3.id(), "raise_issue")
        .args_json(json!({
            "purchase_id": purchase_id.to_string(),
            "subject": "Pickup time",
            "description": "The proposed pickup time no longer works for our household.",
            "suggested_solution": "Move pickup to Saturday morning.",
        }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    assert_eq!(
        view(&v3, "get_issue_count", json!({})).await?,
        Value::String("1".to_string())
    );

    let issue = view(&v3, "get_issue", json!({ "issue_id": "0" })).await?;
    let now = worker.view_block().await?.timestamp();
    assert!(member
        .call(v3.id(), "request_group_vote")
        .args_json(json!({
            "issue_id": "0",
            "decision_type": "price_change",
            "vote_type": "MultipleChoice",
            "proposal": "A protected financial change should never be a V3 decision.",
            "options": ["Saturday 9am", "Sunday 10am"],
            "deadline_ns": (now + 60 * 1_000_000_000).to_string(),
        }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    call_with_gas(
        &member,
        &v3,
        "request_group_vote",
        json!({
            "issue_id": "0",
            "decision_type": "pickup_arrangement",
            "vote_type": "MultipleChoice",
            "proposal": "Choose a pickup arrangement for this order.",
            "options": ["Saturday 9am", "Sunday 10am"],
            "deadline_ns": (now + 60 * 1_000_000_000).to_string(),
        }),
        Gas::from_tgas(60),
    )
    .await?;
    let _ = member
        .call(v3.id(), "request_group_vote")
        .args_json(json!({
            "issue_id": "0",
            "decision_type": "pickup_arrangement",
            "vote_type": "MultipleChoice",
            "proposal": "A conflicting proposal should not open beside the issue's active ballot.",
            "options": ["Saturday 9am", "Sunday 10am"],
            "deadline_ns": (now + 60 * 1_000_000_000).to_string(),
        }))
        .max_gas()
        .transact()
        .await?;
    assert_eq!(
        view(&v3, "get_decision_count", json!({})).await?,
        Value::String("1".to_string())
    );
    raise_issue(&v3, &member, purchase_id, "Another pickup concern").await?;
    let _ = member
        .call(v3.id(), "request_group_vote")
        .args_json(json!({
            "issue_id": "1",
            "decision_type": "pickup_arrangement",
            "vote_type": "MultipleChoice",
            "proposal": "A second issue cannot open a conflicting ballot for this purchase.",
            "options": ["Saturday 9am", "Sunday 10am"],
            "deadline_ns": (now + 60 * 1_000_000_000).to_string(),
        }))
        .max_gas()
        .transact()
        .await?;
    assert_eq!(
        view(&v3, "get_decision_count", json!({})).await?,
        Value::String("1".to_string())
    );
    let decision = view(&v3, "get_decision", json!({ "decision_id": "0" })).await?;
    assert_eq!(decision["required_yes_votes"], 2);
    assert_eq!(decision["eligible_voters"].as_array().unwrap().len(), 2);
    assert_eq!(
        view(&v3, "get_issue", json!({ "issue_id": "0" })).await?["state"],
        "NeedsGroupDecision"
    );

    assert!(unfunded
        .call(v3.id(), "vote_on_decision")
        .args_json(json!({ "decision_id": "0", "option": 0 }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    call(
        &member,
        &v3,
        "vote_on_decision",
        json!({ "decision_id": "0", "option": 0 }),
    )
    .await?;
    assert!(member
        .call(v3.id(), "vote_on_decision")
        .args_json(json!({ "decision_id": "0", "option": 1 }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    assert!(organizer
        .call(v3.id(), "vote_on_decision")
        .args_json(json!({ "decision_id": "0", "option": 0 }))
        .max_gas()
        .transact()
        .await?
        .is_success());
    assert_eq!(
        view(&v3, "get_decision", json!({ "decision_id": "0" })).await?["state"],
        "AwaitingSupplier"
    );
    assert!(organizer
        .call(v3.id(), "agree_to_decision")
        .args_json(json!({ "decision_id": "0" }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    assert_eq!(
        view(
            &v2,
            "get_purchase",
            json!({ "purchase_id": purchase_id.to_string() })
        )
        .await?["price_per_unit"],
        NearToken::from_millinear(1).as_yoctonear().to_string()
    );
    call(
        &farmer,
        &v3,
        "agree_to_decision",
        json!({ "decision_id": "0" }),
    )
    .await?;
    assert_eq!(
        view(&v3, "get_decision", json!({ "decision_id": "0" })).await?["state"],
        "Approved"
    );
    assert_eq!(
        view(&v3, "get_issue", json!({ "issue_id": "0" })).await?["state"],
        "Resolved"
    );
    let now = worker.view_block().await?.timestamp();
    call(
        &member,
        &v3,
        "request_group_vote",
        json!({
            "issue_id": "1",
            "decision_type": "pickup_arrangement",
            "vote_type": "MultipleChoice",
            "proposal": "The supplier can decline this alternate pickup plan.",
            "options": ["Saturday 9am", "Sunday 10am"],
            "deadline_ns": (now + 60 * 1_000_000_000).to_string(),
        }),
    )
    .await?;
    assert!(farmer
        .call(v3.id(), "decline_decision")
        .args_json(json!({ "decision_id": "1" }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    call(
        &member,
        &v3,
        "vote_on_decision",
        json!({ "decision_id": "1", "option": 0 }),
    )
    .await?;
    call(
        &organizer,
        &v3,
        "vote_on_decision",
        json!({ "decision_id": "1", "option": 0 }),
    )
    .await?;
    call(
        &farmer,
        &v3,
        "decline_decision",
        json!({ "decision_id": "1" }),
    )
    .await?;
    assert_eq!(
        view(&v3, "get_decision", json!({ "decision_id": "1" })).await?["state"],
        "Rejected"
    );
    assert_eq!(
        view(&v3, "get_issue", json!({ "issue_id": "1" })).await?["state"],
        "Open"
    );
    assert_eq!(
        view(
            &v2,
            "get_purchase",
            json!({ "purchase_id": purchase_id.to_string() })
        )
        .await?["price_per_unit"],
        NearToken::from_millinear(1).as_yoctonear().to_string()
    );
    let _ = issue;
    Ok(())
}

#[tokio::test]
#[ignore = "sandbox integration test; build both WASMs and opt in with --ignored"]
async fn simple_resolution_and_expired_decision_are_safe() -> Result<()> {
    let v2_wasm = std::fs::read(V2_WASM_PATH)?;
    let v3_wasm = std::fs::read(V3_WASM_PATH)?;
    let worker = near_workspaces::sandbox().await?;
    let v2 = worker.dev_deploy(&v2_wasm).await?;
    let v3 = worker.dev_deploy(&v3_wasm).await?;
    let organizer = worker.dev_create_account().await?;
    let member = worker.dev_create_account().await?;
    let unfunded = worker.dev_create_account().await?;
    let farmer = worker.dev_create_account().await?;
    v2.call("new")
        .args_json(json!({ "members": [organizer.id()] }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    v3.call("new")
        .args_json(json!({ "v2_contract_id": v2.id() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let purchase_id = create_purchase(
        worker.view_block().await?.timestamp(),
        &v2,
        &organizer,
        &farmer,
        &member,
    )
    .await?;
    raise_issue(&v3, &member, purchase_id, "Clarification").await?;
    assert!(unfunded
        .call(v3.id(), "resolve_issue")
        .args_json(json!({ "issue_id": "0" }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    call_with_gas(
        &organizer,
        &v3,
        "resolve_issue",
        json!({ "issue_id": "0" }),
        Gas::from_tgas(60),
    )
    .await?;
    assert_eq!(
        view(&v3, "get_issue", json!({ "issue_id": "0" })).await?["state"],
        "Resolved"
    );

    raise_issue(&v3, &member, purchase_id, "Second concern").await?;
    let now = worker.view_block().await?.timestamp();
    call(
        &member,
        &v3,
        "request_group_vote",
        json!({
            "issue_id": "1",
            "decision_type": "pickup_arrangement",
            "vote_type": "MultipleChoice",
            "proposal": "Choose a second pickup arrangement.",
            "options": ["Saturday 9am", "Sunday 10am"],
            "deadline_ns": (now + 2 * 1_000_000_000).to_string(),
        }),
    )
    .await?;
    worker.fast_forward(1_000).await?;
    assert!(member
        .call(v3.id(), "vote_on_decision")
        .args_json(json!({ "decision_id": "0", "option": 0 }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    call(
        &organizer,
        &v3,
        "expire_decision",
        json!({ "decision_id": "0" }),
    )
    .await?;
    assert_eq!(
        view(&v3, "get_decision", json!({ "decision_id": "0" })).await?["state"],
        "Expired"
    );
    assert_eq!(
        view(&v3, "get_issue", json!({ "issue_id": "1" })).await?["state"],
        "Open"
    );

    raise_issue(&v3, &member, purchase_id, "Third concern").await?;
    let now = worker.view_block().await?.timestamp();
    call(
        &member,
        &v3,
        "request_group_vote",
        json!({
            "issue_id": "2",
            "decision_type": "pickup_arrangement",
            "vote_type": "MultipleChoice",
            "proposal": "Choose the alternate pickup arrangement.",
            "options": ["Saturday 9am", "Sunday 10am"],
            "deadline_ns": (now + 60 * 1_000_000_000).to_string(),
        }),
    )
    .await?;
    call(
        &member,
        &v3,
        "vote_on_decision",
        json!({ "decision_id": "1", "option": 1 }),
    )
    .await?;
    call(
        &organizer,
        &v3,
        "vote_on_decision",
        json!({ "decision_id": "1", "option": 1 }),
    )
    .await?;
    let no_decision = view(&v3, "get_decision", json!({ "decision_id": "1" })).await?;
    assert_eq!(no_decision["state"], "AwaitingSupplier");
    assert_eq!(no_decision["selected_option"], 1);
    call(
        &farmer,
        &v3,
        "agree_to_decision",
        json!({ "decision_id": "1" }),
    )
    .await?;
    assert_eq!(
        view(&v3, "get_decision", json!({ "decision_id": "1" })).await?["state"],
        "Approved"
    );
    assert_eq!(
        view(&v3, "get_issue", json!({ "issue_id": "2" })).await?["state"],
        "Resolved"
    );
    assert_eq!(
        view(
            &v2,
            "get_purchase",
            json!({ "purchase_id": purchase_id.to_string() })
        )
        .await?["price_per_unit"],
        NearToken::from_millinear(1).as_yoctonear().to_string()
    );
    Ok(())
}
