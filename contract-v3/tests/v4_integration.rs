//! Dedicated V3-for-V4 compatibility coverage using real Sandbox cross-contract calls.

use anyhow::Result;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

const V4_WASM_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/near/harvest_pool_v4_contract/harvest_pool_v4_contract.wasm"
);
const V3_WASM_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/near/harvest_pool_v3_contract/harvest_pool_v3_contract.wasm"
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
        "join_deadline_ns": (now + 120_000_000_000).to_string(),
        "fulfillment_deadline_ns": (now + 120_000_000_000 + DAY_NS).to_string(),
        "cancellation_and_refund_terms": "Full refund if the target is missed or the supplier does not fulfill."
    })
}

async fn view(contract: &Contract, method: &str, args: Value) -> Result<Value> {
    Ok(contract.call(method).args_json(args).view().await?.json()?)
}

async fn init_v4(contract: &Contract, supplier: &Account) -> Result<()> {
    contract
        .call("new")
        .args_json(json!({ "suppliers": [{
            "account_id": supplier.id(),
            "business_name": "Prairie Family Farm",
            "location": "Illinois",
            "public_contact": "farm@example.test"
        }] }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn create_funded_v4_purchase(
    worker: &near_workspaces::Worker<near_workspaces::network::Sandbox>,
    v4: &Contract,
    supplier: &Account,
    first: &Account,
    second: &Account,
) -> Result<u64> {
    let price = NearToken::from_millinear(1);
    let now = worker.view_block().await?.timestamp();
    let id: String = supplier
        .call(v4.id(), "create_supplier_offer")
        .args_json(json!({ "terms": terms(now, price) }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    for member in [first, second] {
        member
            .call(v4.id(), "commit")
            .args_json(json!({ "purchase_id": id, "quantity": 1 }))
            .deposit(price)
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    Ok(id.parse()?)
}

async fn raise_issue(
    v3: &Contract,
    member: &Account,
    purchase_id: u64,
    subject: &str,
) -> Result<()> {
    member
        .call(v3.id(), "raise_issue")
        .args_json(json!({
            "purchase_id": purchase_id.to_string(),
            "subject": subject,
            "description": "The pickup arrangement needs a clear group decision.",
            "suggested_solution": "Choose a safe pickup plan."
        }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn request_vote(
    worker: &near_workspaces::Worker<near_workspaces::network::Sandbox>,
    v3: &Contract,
    member: &Account,
    issue_id: u64,
    vote_type: &str,
    proposal: &str,
    options: Value,
    window_ns: u64,
) -> Result<()> {
    let now = worker.view_block().await?.timestamp();
    member
        .call(v3.id(), "request_group_vote")
        .args_json(json!({
            "issue_id": issue_id.to_string(),
            "decision_type": "pickup_arrangement",
            "vote_type": vote_type,
            "proposal": proposal,
            "options": options,
            "deadline_ns": (now + window_ns).to_string()
        }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn vote(v3: &Contract, member: &Account, decision_id: u64, option: u8) -> Result<()> {
    member
        .call(v3.id(), "vote_on_decision")
        .args_json(json!({ "decision_id": decision_id.to_string(), "option": option }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// Audit characterization: callback validation currently panics after removing the pending
/// request. NEAR rolls the entire callback receipt back on panic, including that removal, so a
/// rejected duplicate leaves its pending payload in contract storage. Keep this test until a new
/// (separately deployed) V3 version converts expected validation failures into non-panicking
/// cleanup paths.
#[tokio::test]
#[ignore = "sandbox audit regression; build V3 and V4 WASMs and opt in with --ignored"]
async fn rejected_v3_callback_leaves_pending_storage_allocated() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let v4 = worker.dev_deploy(&std::fs::read(V4_WASM_PATH)?).await?;
    let v3 = worker.dev_deploy(&std::fs::read(V3_WASM_PATH)?).await?;
    let supplier = worker.dev_create_account().await?;
    let organizer = worker.dev_create_account().await?;
    let member = worker.dev_create_account().await?;

    init_v4(&v4, &supplier).await?;
    v3.call("new")
        .args_json(json!({ "v2_contract_id": v4.id() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let purchase_id =
        create_funded_v4_purchase(&worker, &v4, &supplier, &organizer, &member).await?;

    let issue_args = json!({
        "purchase_id": purchase_id.to_string(),
        "subject": "Duplicate storage probe",
        "description": "This exact issue is submitted twice to exercise callback cleanup.",
        "suggested_solution": "Keep only the first issue."
    });
    member
        .call(v3.id(), "raise_issue")
        .args_json(issue_args.clone())
        .gas(Gas::from_tgas(60))
        .transact()
        .await?
        .into_result()?;
    let storage_before = v3.view_account().await?.storage_usage;

    let duplicate = member
        .call(v3.id(), "raise_issue")
        .args_json(issue_args)
        .gas(Gas::from_tgas(60))
        .transact()
        .await?;
    assert!(duplicate.is_failure());
    assert_eq!(view(&v3, "get_issue_count", json!({})).await?, "1");

    let storage_after = v3.view_account().await?.storage_usage;
    assert!(
        storage_after > storage_before,
        "a rejected callback unexpectedly cleaned up its pending request; revisit the audit finding"
    );
    eprintln!(
        "V3 audit reproduction: rejected duplicate retained {} bytes of pending storage",
        storage_after - storage_before
    );
    Ok(())
}

#[tokio::test]
#[ignore = "sandbox integration test; build V3 and V4 WASMs and opt in with --ignored"]
async fn dedicated_v3_reads_v4_authority_without_financial_power_or_id_confusion() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let v4 = worker.dev_deploy(&std::fs::read(V4_WASM_PATH)?).await?;
    let other_v4 = worker.dev_deploy(&std::fs::read(V4_WASM_PATH)?).await?;
    let v3 = worker.dev_deploy(&std::fs::read(V3_WASM_PATH)?).await?;
    let supplier = worker.dev_create_account().await?;
    let organizer = worker.dev_create_account().await?;
    let member = worker.dev_create_account().await?;
    let outsider = worker.dev_create_account().await?;
    let other_member = worker.dev_create_account().await?;

    init_v4(&v4, &supplier).await?;
    init_v4(&other_v4, &supplier).await?;
    v3.call("new")
        .args_json(json!({ "v2_contract_id": v4.id() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let purchase_id =
        create_funded_v4_purchase(&worker, &v4, &supplier, &organizer, &member).await?;
    let other_purchase_id =
        create_funded_v4_purchase(&worker, &other_v4, &supplier, &other_member, &outsider).await?;
    assert_eq!(purchase_id, other_purchase_id);

    let issue_args = json!({
        "purchase_id": purchase_id.to_string(),
        "subject": "Pickup time",
        "description": "The proposed pickup time no longer works for our household.",
        "suggested_solution": "Move pickup to Saturday morning."
    });
    assert!(outsider
        .call(v3.id(), "raise_issue")
        .args_json(issue_args.clone())
        .max_gas()
        .transact()
        .await?
        .is_failure());
    assert_eq!(view(&v3, "get_issue_count", json!({})).await?, "0");
    member
        .call(v3.id(), "raise_issue")
        .args_json(issue_args)
        .gas(Gas::from_tgas(60))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(view(&v3, "get_issue_count", json!({})).await?, "1");

    let before = view(
        &v4,
        "get_purchase",
        json!({ "purchase_id": purchase_id.to_string() }),
    )
    .await?;
    let now = worker.view_block().await?.timestamp();
    member
        .call(v3.id(), "request_group_vote")
        .args_json(json!({
            "issue_id": "0",
            "decision_type": "pickup_arrangement",
            "vote_type": "MultipleChoice",
            "proposal": "Choose a pickup arrangement for this order.",
            "options": ["Saturday 9am", "Sunday 10am"],
            "deadline_ns": (now + 60_000_000_000).to_string()
        }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?
        .into_result()?;
    let decision = view(&v3, "get_decision", json!({ "decision_id": "0" })).await?;
    assert_eq!(decision["eligible_voters"].as_array().unwrap().len(), 2);
    assert_eq!(decision["required_yes_votes"], 2);
    assert_eq!(decision["supplier_id"], supplier.id().as_str());
    assert!(outsider
        .call(v3.id(), "vote_on_decision")
        .args_json(json!({ "decision_id": "0", "option": 0 }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    member
        .call(v3.id(), "vote_on_decision")
        .args_json(json!({ "decision_id": "0", "option": 0 }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert!(member
        .call(v3.id(), "vote_on_decision")
        .args_json(json!({ "decision_id": "0", "option": 0 }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    organizer
        .call(v3.id(), "vote_on_decision")
        .args_json(json!({ "decision_id": "0", "option": 0 }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
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
    supplier
        .call(v3.id(), "agree_to_decision")
        .args_json(json!({ "decision_id": "0" }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        view(&v3, "get_decision", json!({ "decision_id": "0" })).await?["state"],
        "Approved"
    );
    assert!(organizer
        .call(v3.id(), "release_payment")
        .args_json(json!({ "purchase_id": purchase_id.to_string() }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    let after = view(
        &v4,
        "get_purchase",
        json!({ "purchase_id": purchase_id.to_string() }),
    )
    .await?;
    for field in [
        "price_per_unit",
        "listed_price_usd_cents",
        "total_funded_amount",
        "terms_hash",
        "state",
    ] {
        assert_eq!(
            before[field], after[field],
            "V3 changed protected field {field}"
        );
    }
    eprintln!("V3-for-V4: authoritative membership and supplier read from its configured V4; two-thirds/one-vote rules enforced; same numeric ID on another V4 rejected; V4 financial state unchanged");
    Ok(())
}

#[tokio::test]
#[ignore = "sandbox integration test; build V3 and V4 WASMs and opt in with --ignored"]
async fn yes_no_and_three_choice_ballots_require_real_consensus() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let v4 = worker.dev_deploy(&std::fs::read(V4_WASM_PATH)?).await?;
    let v3 = worker.dev_deploy(&std::fs::read(V3_WASM_PATH)?).await?;
    let supplier = worker.dev_create_account().await?;
    let organizer = worker.dev_create_account().await?;
    let member = worker.dev_create_account().await?;
    let late_member = worker.dev_create_account().await?;
    let outsider = worker.dev_create_account().await?;
    init_v4(&v4, &supplier).await?;
    v3.call("new")
        .args_json(json!({ "v2_contract_id": v4.id() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let purchase_id =
        create_funded_v4_purchase(&worker, &v4, &supplier, &organizer, &member).await?;
    let protected_before = view(
        &v4,
        "get_purchase",
        json!({ "purchase_id": purchase_id.to_string() }),
    )
    .await?;
    assert_eq!(
        view(&v3, "get_config", json!({})).await?["private_voting"],
        false
    );

    raise_issue(&v3, &organizer, purchase_id, "Approve Saturday pickup").await?;
    request_vote(
        &worker,
        &v3,
        &organizer,
        0,
        "YesNo",
        "Approve Saturday morning pickup?",
        json!([]),
        60_000_000_000,
    )
    .await?;
    let first = view(&v3, "get_decision", json!({ "decision_id": "0" })).await?;
    assert_eq!(first["options"], json!(["Yes", "No"]));
    assert_eq!(first["required_yes_votes"], 2);
    assert_eq!(first["eligible_voters"].as_array().unwrap().len(), 2);
    assert!(supplier
        .call(v3.id(), "agree_to_decision")
        .args_json(json!({ "decision_id": "0" }))
        .max_gas()
        .transact()
        .await?
        .is_failure());

    late_member
        .call(v4.id(), "commit")
        .args_json(json!({ "purchase_id": purchase_id.to_string(), "quantity": 1 }))
        .deposit(NearToken::from_millinear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    for ineligible in [&late_member, &outsider] {
        assert!(ineligible
            .call(v3.id(), "vote_on_decision")
            .args_json(json!({ "decision_id": "0", "option": 0 }))
            .max_gas()
            .transact()
            .await?
            .is_failure());
    }
    vote(&v3, &organizer, 0, 0).await?;
    assert!(organizer
        .call(v3.id(), "vote_on_decision")
        .args_json(json!({ "decision_id": "0", "option": 0 }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    vote(&v3, &member, 0, 0).await?;
    assert_eq!(
        view(&v3, "get_decision", json!({ "decision_id": "0" })).await?["state"],
        "AwaitingSupplier"
    );
    supplier
        .call(v3.id(), "agree_to_decision")
        .args_json(json!({ "decision_id": "0" }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        view(&v3, "get_decision", json!({ "decision_id": "0" })).await?["state"],
        "Approved"
    );

    raise_issue(&v3, &member, purchase_id, "Reject Sunday pickup").await?;
    request_vote(
        &worker,
        &v3,
        &member,
        1,
        "YesNo",
        "Replace the agreed pickup with Sunday?",
        json!([]),
        60_000_000_000,
    )
    .await?;
    vote(&v3, &organizer, 1, 1).await?;
    vote(&v3, &member, 1, 1).await?;
    assert_eq!(
        view(&v3, "get_decision", json!({ "decision_id": "1" })).await?["state"],
        "Rejected"
    );
    assert!(supplier
        .call(v3.id(), "agree_to_decision")
        .args_json(json!({ "decision_id": "1" }))
        .max_gas()
        .transact()
        .await?
        .is_failure());

    raise_issue(
        &v3,
        &late_member,
        purchase_id,
        "Choose among three pickup times",
    )
    .await?;
    request_vote(
        &worker,
        &v3,
        &late_member,
        2,
        "MultipleChoice",
        "Choose one of three pickup times.",
        json!(["Saturday 9am", "Sunday 10am", "Tuesday 6pm"]),
        60_000_000_000,
    )
    .await?;
    vote(&v3, &organizer, 2, 2).await?;
    vote(&v3, &member, 2, 2).await?;
    let three_choice = view(&v3, "get_decision", json!({ "decision_id": "2" })).await?;
    assert_eq!(three_choice["state"], "AwaitingSupplier");
    assert_eq!(three_choice["selected_option"], 2);
    supplier
        .call(v3.id(), "agree_to_decision")
        .args_json(json!({ "decision_id": "2" }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    raise_issue(
        &v3,
        &organizer,
        purchase_id,
        "Tie across three pickup times",
    )
    .await?;
    request_vote(
        &worker,
        &v3,
        &organizer,
        3,
        "MultipleChoice",
        "Choose one of three other pickup times.",
        json!(["Friday 6pm", "Saturday 6pm", "Sunday 6pm"]),
        60_000_000_000,
    )
    .await?;
    vote(&v3, &organizer, 3, 0).await?;
    vote(&v3, &member, 3, 1).await?;
    vote(&v3, &late_member, 3, 2).await?;
    assert_eq!(
        view(&v3, "get_decision", json!({ "decision_id": "3" })).await?["state"],
        "NoConsensus"
    );
    assert!(supplier
        .call(v3.id(), "agree_to_decision")
        .args_json(json!({ "decision_id": "3" }))
        .max_gas()
        .transact()
        .await?
        .is_failure());

    raise_issue(&v3, &member, purchase_id, "Expiring pickup proposal").await?;
    request_vote(
        &worker,
        &v3,
        &member,
        4,
        "YesNo",
        "Approve a pickup plan before this short deadline?",
        json!([]),
        10_000_000_000,
    )
    .await?;
    vote(&v3, &organizer, 4, 0).await?;
    vote(&v3, &member, 4, 0).await?;
    assert_eq!(
        view(&v3, "get_decision", json!({ "decision_id": "4" })).await?["state"],
        "AwaitingSupplier"
    );
    worker.fast_forward(1_000).await?;
    assert!(supplier
        .call(v3.id(), "agree_to_decision")
        .args_json(json!({ "decision_id": "4" }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    outsider
        .call(v3.id(), "expire_decision")
        .args_json(json!({ "decision_id": "4" }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        view(&v3, "get_decision", json!({ "decision_id": "4" })).await?["state"],
        "Expired"
    );

    let protected_after = view(
        &v4,
        "get_purchase",
        json!({ "purchase_id": purchase_id.to_string() }),
    )
    .await?;
    for field in [
        "price_per_unit",
        "listed_price_usd_cents",
        "terms_hash",
        "state",
    ] {
        assert_eq!(protected_before[field], protected_after[field]);
    }
    assert!(organizer
        .call(v3.id(), "release_payment")
        .args_json(json!({ "purchase_id": purchase_id.to_string() }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    eprintln!("flexible voting: yes/no approval and rejection, fixed eligibility, duplicate/outsider failures, three-option threshold, tie no-consensus, expiry, supplier-after-pass consent, and financial isolation all verified");
    Ok(())
}
