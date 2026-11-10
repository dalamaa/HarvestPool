//! Multi-account NEAR Sandbox coverage for V5 native-USDC accounting.
//!
//! Build V5, V3-for-V5, and the mock token first, then run this test with `--ignored`.

use anyhow::Result;
use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const V5_WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/near/harvest_pool_v5_contract/harvest_pool_v5_contract.wasm"
);
const V3_WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/near/harvest_pool_v3_v5_contract/harvest_pool_v3_v5_contract.wasm"
);
const FT_WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/near/harvest_pool_mock_usdc/harvest_pool_mock_usdc.wasm"
);
const USDC: u128 = 1_000_000;
const PRICE: u128 = 50 * USDC;
const DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;

struct Fixture {
    worker: Worker<Sandbox>,
    v5: Contract,
    token: Contract,
    owner: Account,
    organizer: Account,
    supplier: Account,
    a: Account,
    b: Account,
    c: Account,
    outsider: Account,
}

async fn view_json(contract: &Contract, method: &str, args: Value) -> Result<Value> {
    Ok(contract.call(method).args_json(args).view().await?.json()?)
}

async fn token_balance(token: &Contract, account: &Account) -> Result<u128> {
    let value: String = token
        .call("ft_balance_of")
        .args_json(json!({ "account_id": account.id() }))
        .view()
        .await?
        .json()?;
    Ok(value.parse()?)
}

async fn contract_token_balance(
    token: &Contract,
    account_id: &near_workspaces::AccountId,
) -> Result<u128> {
    let value: String = token
        .call("ft_balance_of")
        .args_json(json!({ "account_id": account_id }))
        .view()
        .await?
        .json()?;
    Ok(value.parse()?)
}

async fn register(
    token: &Contract,
    payer: &Account,
    account_id: &near_workspaces::AccountId,
) -> Result<()> {
    payer
        .call(token.id(), "storage_deposit")
        .args_json(json!({ "account_id": account_id, "registration_only": true }))
        .deposit(NearToken::from_millinear(10))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn transfer(
    token: &Contract,
    owner: &Account,
    receiver: &Account,
    amount: u128,
) -> Result<()> {
    owner
        .call(token.id(), "ft_transfer")
        .args_json(
            json!({ "receiver_id": receiver.id(), "amount": amount.to_string(), "memo": null }),
        )
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn setup() -> Result<Fixture> {
    let worker = near_workspaces::sandbox().await?;
    let v5 = worker.dev_deploy(&std::fs::read(V5_WASM)?).await?;
    let token = worker.dev_deploy(&std::fs::read(FT_WASM)?).await?;
    let owner = worker.dev_create_account().await?;
    let organizer = worker.dev_create_account().await?;
    let supplier = worker.dev_create_account().await?;
    let a = worker.dev_create_account().await?;
    let b = worker.dev_create_account().await?;
    let c = worker.dev_create_account().await?;
    let outsider = worker.dev_create_account().await?;

    token
        .call("new")
        .args_json(json!({ "owner_id": owner.id(), "total_supply": (100_000 * USDC).to_string() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    for account_id in [
        v5.id(),
        supplier.id(),
        a.id(),
        b.id(),
        c.id(),
        outsider.id(),
    ] {
        register(&token, &owner, account_id).await?;
    }
    for account in [&supplier, &a, &b, &c, &outsider] {
        transfer(&token, &owner, account, 500 * USDC).await?;
    }

    v5.call("new")
        .args_json(json!({
            "suppliers": [{
                "account_id": supplier.id(),
                "business_name": "Sandbox Supplier",
                "location": "Illinois",
                "public_contact": "supplier@example.test"
            }],
            "token_contract_id": token.id(),
            "token_decimals": 6
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    Ok(Fixture {
        worker,
        v5,
        token,
        owner,
        organizer,
        supplier,
        a,
        b,
        c,
        outsider,
    })
}

fn terms(now: u64, min: u32, max: u32, max_members: u32, seconds: u64) -> Value {
    json!({
        "product_name": "Family produce box",
        "description": "A supplier-authorized group purchase",
        "quantity_unit": "box",
        "price_per_unit": PRICE.to_string(),
        "listed_price_usd_cents": "5000",
        "min_quantity": min,
        "max_quantity": max,
        "max_quantity_per_household": 1,
        "max_funded_members": max_members,
        "pickup_or_delivery": "Saturday pickup",
        "join_deadline_ns": (now + seconds * 1_000_000_000).to_string(),
        "fulfillment_deadline_ns": (now + seconds * 1_000_000_000 + DAY_NS).to_string(),
        "cancellation_and_refund_terms": "Full refund if the target is missed or fulfillment expires."
    })
}

async fn supplier_offer(
    f: &Fixture,
    min: u32,
    max: u32,
    max_members: u32,
    seconds: u64,
) -> Result<u64> {
    let now = f.worker.view_block().await?.timestamp();
    let id: String = f
        .supplier
        .call(f.v5.id(), "create_supplier_offer")
        .args_json(json!({ "terms": terms(now, min, max, max_members, seconds) }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    Ok(id.parse()?)
}

async fn contribute_to(
    token: &Contract,
    v5_id: &near_workspaces::AccountId,
    buyer: &Account,
    purchase_id: u64,
    quantity: u32,
    amount: u128,
) -> Result<()> {
    buyer
        .call(token.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": v5_id,
            "amount": amount.to_string(),
            "memo": null,
            "msg": json!({ "v": 1, "action": "commit", "purchase_id": purchase_id.to_string(), "quantity": quantity }).to_string()
        }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn purchase(f: &Fixture, id: u64) -> Result<Value> {
    view_json(
        &f.v5,
        "get_purchase",
        json!({ "purchase_id": id.to_string() }),
    )
    .await
}

async fn accounting(f: &Fixture) -> Result<Value> {
    view_json(&f.v5, "get_accounting", json!({})).await
}

async fn finish_funding(f: &Fixture, id: u64) -> Result<()> {
    f.worker.fast_forward(1_000).await?;
    f.organizer
        .call(f.v5.id(), "finalize_purchase")
        .args_json(json!({ "purchase_id": id.to_string() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

#[tokio::test]
#[ignore = "V5 Sandbox integration; build V5, V3-for-V5, and mock USDC WASMs first"]
async fn exact_contributions_rejections_token_identity_and_final_spot_are_safe() -> Result<()> {
    let f = setup().await?;
    let id = supplier_offer(&f, 2, 2, 2, 60).await?;
    let initial_a = token_balance(&f.token, &f.a).await?;

    contribute_to(&f.token, f.v5.id(), &f.a, id, 1, PRICE - 1).await?;
    assert_eq!(token_balance(&f.token, &f.a).await?, initial_a);
    assert_eq!(purchase(&f, id).await?["funded_member_count"], 0);

    contribute_to(&f.token, f.v5.id(), &f.supplier, id, 1, PRICE).await?;
    assert_eq!(purchase(&f, id).await?["funded_member_count"], 0);

    contribute_to(&f.token, f.v5.id(), &f.a, id, 1, PRICE).await?;
    assert_eq!(token_balance(&f.token, &f.a).await?, initial_a - PRICE);
    assert_eq!(purchase(&f, id).await?["funded_member_count"], 1);

    contribute_to(&f.token, f.v5.id(), &f.a, id, 1, PRICE).await?;
    assert_eq!(token_balance(&f.token, &f.a).await?, initial_a - PRICE);

    let b_before = token_balance(&f.token, &f.b).await?;
    let c_before = token_balance(&f.token, &f.c).await?;
    let (b_outcome, c_outcome) = tokio::join!(
        contribute_to(&f.token, f.v5.id(), &f.b, id, 1, PRICE),
        contribute_to(&f.token, f.v5.id(), &f.c, id, 1, PRICE)
    );
    b_outcome?;
    c_outcome?;
    let b_spent = b_before - token_balance(&f.token, &f.b).await?;
    let c_spent = c_before - token_balance(&f.token, &f.c).await?;
    assert_eq!(b_spent + c_spent, PRICE);
    assert_eq!(purchase(&f, id).await?["funded_member_count"], 2);
    assert_eq!(
        contract_token_balance(&f.token, f.v5.id()).await?,
        2 * PRICE
    );

    let wrong_token = f.worker.dev_deploy(&std::fs::read(FT_WASM)?).await?;
    wrong_token
        .call("new")
        .args_json(json!({ "owner_id": f.owner.id(), "total_supply": (1_000 * USDC).to_string() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    register(&wrong_token, &f.owner, f.v5.id()).await?;
    register(&wrong_token, &f.owner, f.outsider.id()).await?;
    transfer(&wrong_token, &f.owner, &f.outsider, PRICE).await?;
    let before_wrong = token_balance(&wrong_token, &f.outsider).await?;
    contribute_to(&wrong_token, f.v5.id(), &f.outsider, id, 1, PRICE).await?;
    assert_eq!(
        token_balance(&wrong_token, &f.outsider).await?,
        before_wrong
    );

    f.outsider
        .call(f.v5.id(), "reconcile_token_balance")
        .args_json(json!({}))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(accounting(&f).await?["reconciliation_status"], "balanced");
    let expired_id = supplier_offer(&f, 1, 1, 1, 1).await?;
    f.worker.fast_forward(20).await?;
    let outsider_before = token_balance(&f.token, &f.outsider).await?;
    contribute_to(&f.token, f.v5.id(), &f.outsider, expired_id, 1, PRICE).await?;
    assert_eq!(token_balance(&f.token, &f.outsider).await?, outsider_before);
    assert_eq!(purchase(&f, expired_id).await?["funded_member_count"], 0);
    eprintln!("V5 exact 50-USDC acceptance, unused-token returns, token identity, expiry, final-slot contention, and balance reconciliation passed");
    Ok(())
}

#[tokio::test]
#[ignore = "V5 Sandbox integration; build V5, V3-for-V5, and mock USDC WASMs first"]
async fn cancellations_failed_groups_and_failed_transfers_refund_once() -> Result<()> {
    let f = setup().await?;
    let cancel_id = supplier_offer(&f, 1, 2, 2, 60).await?;
    let initial = token_balance(&f.token, &f.a).await?;
    contribute_to(&f.token, f.v5.id(), &f.a, cancel_id, 1, PRICE).await?;
    f.a.call(f.v5.id(), "cancel_commitment")
        .args_json(json!({ "purchase_id": cancel_id.to_string() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    transfer(&f.token, &f.a, &f.owner, initial - PRICE).await?;
    f.a.call(f.token.id(), "storage_unregister")
        .args_json(json!({ "force": false }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    f.a.call(f.v5.id(), "claim_refund")
        .args_json(json!({ "purchase_id": cancel_id.to_string() }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        purchase(&f, cancel_id).await?["commitments"][0]["state"],
        "Refundable"
    );
    register(&f.token, &f.owner, f.a.id()).await?;
    f.a.call(f.v5.id(), "claim_refund")
        .args_json(json!({ "purchase_id": cancel_id.to_string() }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(token_balance(&f.token, &f.a).await?, PRICE);
    assert_eq!(
        purchase(&f, cancel_id).await?["commitments"][0]["state"],
        "Refunded"
    );
    assert!(f
        .a
        .call(f.v5.id(), "claim_refund")
        .args_json(json!({ "purchase_id": cancel_id.to_string() }))
        .max_gas()
        .transact()
        .await?
        .is_failure());

    let failed_id = supplier_offer(&f, 2, 2, 2, 30).await?;
    contribute_to(&f.token, f.v5.id(), &f.b, failed_id, 1, PRICE).await?;
    finish_funding(&f, failed_id).await?;
    assert_eq!(purchase(&f, failed_id).await?["state"], "Failed");

    f.owner
        .call(f.token.id(), "set_fail_direct_transfers")
        .args_json(json!({ "fail": true }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let before = token_balance(&f.token, &f.b).await?;
    f.b.call(f.v5.id(), "claim_refund")
        .args_json(json!({ "purchase_id": failed_id.to_string() }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(token_balance(&f.token, &f.b).await?, before);
    assert_eq!(
        purchase(&f, failed_id).await?["commitments"][0]["state"],
        "Refundable"
    );
    assert_eq!(
        view_json(
            &f.v5,
            "get_outbound_operation",
            json!({ "operation_id": "2" })
        )
        .await?["state"],
        "Failed"
    );

    f.owner
        .call(f.token.id(), "set_fail_direct_transfers")
        .args_json(json!({ "fail": false }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    f.b.call(f.v5.id(), "claim_refund")
        .args_json(json!({ "purchase_id": failed_id.to_string() }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(token_balance(&f.token, &f.b).await?, before + PRICE);
    assert_eq!(
        purchase(&f, failed_id).await?["commitments"][0]["state"],
        "Refunded"
    );
    assert_eq!(accounting(&f).await?["outstanding_liability"], "0");
    eprintln!("V5 cancellation, recipient registration failure/retry, failed-group refund, injected transfer failure recovery, and duplicate guard passed");
    Ok(())
}

#[tokio::test]
#[ignore = "V5 Sandbox integration; build V5, V3-for-V5, and mock USDC WASMs first"]
async fn fulfillment_approval_pays_exact_usdc_and_failed_payout_is_retryable() -> Result<()> {
    let f = setup().await?;
    let id = supplier_offer(&f, 2, 2, 2, 30).await?;
    contribute_to(&f.token, f.v5.id(), &f.a, id, 1, PRICE).await?;
    contribute_to(&f.token, f.v5.id(), &f.b, id, 1, PRICE).await?;
    assert!(f
        .outsider
        .call(f.v5.id(), "release_payment")
        .args_json(json!({ "purchase_id": id.to_string() }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    finish_funding(&f, id).await?;
    f.supplier
        .call(f.v5.id(), "submit_fulfillment_evidence")
        .args_json(
            json!({ "purchase_id": id.to_string(), "evidence_hash": "sha256:sandbox-delivery" }),
        )
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert!(f
        .supplier
        .call(f.v5.id(), "vote_on_fulfillment")
        .args_json(json!({ "purchase_id": id.to_string(), "approve": true }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    assert!(f
        .outsider
        .call(f.v5.id(), "vote_on_fulfillment")
        .args_json(json!({ "purchase_id": id.to_string(), "approve": true }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    for buyer in [&f.a, &f.b] {
        buyer
            .call(f.v5.id(), "vote_on_fulfillment")
            .args_json(json!({ "purchase_id": id.to_string(), "approve": true }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }

    let supplier_before = token_balance(&f.token, &f.supplier).await?;
    f.owner
        .call(f.token.id(), "set_fail_direct_transfers")
        .args_json(json!({ "fail": true }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    f.outsider
        .call(f.v5.id(), "release_payment")
        .args_json(json!({ "purchase_id": id.to_string() }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(purchase(&f, id).await?["state"], "FulfillmentApproved");
    assert_eq!(token_balance(&f.token, &f.supplier).await?, supplier_before);

    f.owner
        .call(f.token.id(), "set_fail_direct_transfers")
        .args_json(json!({ "fail": false }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    f.outsider
        .call(f.v5.id(), "release_payment")
        .args_json(json!({ "purchase_id": id.to_string() }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(purchase(&f, id).await?["state"], "Completed");
    assert_eq!(
        token_balance(&f.token, &f.supplier).await?,
        supplier_before + 2 * PRICE
    );
    assert!(f
        .outsider
        .call(f.v5.id(), "release_payment")
        .args_json(json!({ "purchase_id": id.to_string() }))
        .max_gas()
        .transact()
        .await?
        .is_failure());
    assert_eq!(accounting(&f).await?["outstanding_liability"], "0");
    eprintln!("V5 funded-only approval, premature payout rejection, exact supplier USDC, failure recovery, and payout idempotency passed");
    Ok(())
}

#[tokio::test]
#[ignore = "V5/V3-for-V5 Sandbox integration; build all WASMs first"]
async fn corrected_v3_reads_v5_membership_and_cleans_rejected_callbacks() -> Result<()> {
    let f = setup().await?;
    let v3 = f.worker.dev_deploy(&std::fs::read(V3_WASM)?).await?;
    v3.call("new")
        .args_json(json!({ "v2_contract_id": f.v5.id() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let id = supplier_offer(&f, 2, 3, 3, 300).await?;
    contribute_to(&f.token, f.v5.id(), &f.a, id, 1, PRICE).await?;
    contribute_to(&f.token, f.v5.id(), &f.b, id, 1, PRICE).await?;

    f.a.call(v3.id(), "raise_issue")
        .args_json(json!({
            "purchase_id": id.to_string(), "subject": "Pickup window",
            "description": "Choose a pickup window", "suggested_solution": "Saturday morning"
        }))
        .gas(Gas::from_tgas(80))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(view_json(&v3, "get_issue_count", json!({})).await?, "1");

    // Same funded member submits an identical issue. The callback rejects it without panicking,
    // and the pending record must remain removed.
    f.a.call(v3.id(), "raise_issue")
        .args_json(json!({
            "purchase_id": id.to_string(), "subject": "Pickup window",
            "description": "Choose a pickup window", "suggested_solution": "Saturday morning"
        }))
        .gas(Gas::from_tgas(80))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(view_json(&v3, "get_issue_count", json!({})).await?, "1");
    assert_eq!(
        view_json(&v3, "get_pending_request_count", json!({})).await?,
        "0"
    );

    let now = f.worker.view_block().await?.timestamp();
    f.a.call(v3.id(), "request_group_vote")
        .args_json(json!({
            "issue_id": "0", "decision_type": "pickup_arrangement", "vote_type": "YesNo",
            "proposal": "Use Saturday morning", "options": [],
            "deadline_ns": (now + 300_000_000_000u64).to_string()
        }))
        .gas(Gas::from_tgas(80))
        .transact()
        .await?
        .into_result()?;
    for voter in [&f.a, &f.b] {
        voter
            .call(v3.id(), "vote_on_decision")
            .args_json(json!({ "decision_id": "0", "option": 0 }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    let decision = view_json(&v3, "get_decision", json!({ "decision_id": "0" })).await?;
    assert_eq!(decision["state"], "AwaitingSupplier");
    assert_eq!(decision["required_yes_votes"], 2);
    f.supplier
        .call(v3.id(), "agree_to_decision")
        .args_json(json!({ "decision_id": "0" }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        view_json(&v3, "get_decision", json!({ "decision_id": "0" })).await?["state"],
        "Approved"
    );

    f.b.call(v3.id(), "raise_issue")
        .args_json(json!({
            "purchase_id": id.to_string(), "subject": "Pickup location",
            "description": "Choose one location", "suggested_solution": null
        }))
        .gas(Gas::from_tgas(80))
        .transact()
        .await?
        .into_result()?;
    let now = f.worker.view_block().await?.timestamp();
    f.b.call(v3.id(), "request_group_vote")
        .args_json(json!({
            "issue_id": "1", "decision_type": "pickup_arrangement", "vote_type": "MultipleChoice",
            "proposal": "Choose a pickup site", "options": ["Library", "School", "Park"],
            "deadline_ns": (now + 300_000_000_000u64).to_string()
        }))
        .gas(Gas::from_tgas(80))
        .transact()
        .await?
        .into_result()?;
    for voter in [&f.a, &f.b] {
        voter
            .call(v3.id(), "vote_on_decision")
            .args_json(json!({ "decision_id": "1", "option": 2 }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    assert_eq!(
        view_json(&v3, "get_decision", json!({ "decision_id": "1" })).await?["selected_option"],
        2
    );
    assert_eq!(purchase(&f, id).await?["price_per_unit"], PRICE.to_string());
    eprintln!("Corrected V3-for-V5 funded membership, 2/3 Yes/No, multiple choice, supplier consent, financial isolation, and rejected-callback cleanup passed");
    Ok(())
}
