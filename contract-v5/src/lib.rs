use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::collections::UnorderedMap;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};
use schemars::JsonSchema;

const MAX_PURCHASES: u64 = 500;
const MAX_QUANTITY: u32 = 10_000;
const MAX_FUNDED_MEMBERS: u32 = 20;
const MAX_TEXT_BYTES: usize = 2_000;
const MAX_SHORT_TEXT_BYTES: usize = 160;
const MAX_EVIDENCE_BYTES: usize = 256;
const MAX_FULFILLMENT_WINDOW_NS: u64 = 30 * 24 * 60 * 60 * 1_000_000_000;
const FT_VIEW_GAS: Gas = Gas::from_tgas(10);
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(20);
const STALE_OPERATION_NS: u64 = 60 * 60 * 1_000_000_000;
const PILOT_SUPPLIER: &str = "harvestpool-farmer-1.testnet";
const USDC_DECIMALS: u8 = 6;
const OFFICIAL_TESTNET_USDC: &str =
    "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

#[derive(BorshSerialize, BorshStorageKey)]
enum StorageKey {
    Purchases,
    Suppliers,
    Operations,
}

#[derive(
    BorshDeserialize,
    BorshSerialize,
    Clone,
    Copy,
    JsonSchema,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Debug,
)]
#[serde(crate = "near_sdk::serde")]
pub enum PurchaseOrigin {
    SupplierOffer,
    OrganizerRequest,
}

#[derive(
    BorshDeserialize,
    BorshSerialize,
    Clone,
    Copy,
    JsonSchema,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Debug,
)]
#[serde(crate = "near_sdk::serde")]
pub enum PurchaseState {
    AwaitingSupplier,
    Open,
    Declined,
    Funded,
    FulfillmentPending,
    FulfillmentApproved,
    PaymentPending,
    Completed,
    Failed,
}

#[derive(
    BorshDeserialize,
    BorshSerialize,
    Clone,
    Copy,
    JsonSchema,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Debug,
)]
#[serde(crate = "near_sdk::serde")]
pub enum CommitmentState {
    Active,
    Refundable,
    RefundPending,
    Refunded,
}

#[derive(
    BorshDeserialize,
    BorshSerialize,
    Clone,
    Copy,
    JsonSchema,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Debug,
)]
#[serde(crate = "near_sdk::serde")]
pub enum OutboundOperationState {
    RegistrationPending,
    TransferPending,
    Succeeded,
    Failed,
    ReconciliationRequired,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
enum OutboundOperationKind {
    Refund {
        purchase_id: u64,
        account_id: AccountId,
    },
    SupplierPayment {
        purchase_id: u64,
    },
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct OutboundOperation {
    id: u64,
    kind: OutboundOperationKind,
    recipient_id: AccountId,
    amount: u128,
    state: OutboundOperationState,
    created_at_ns: u64,
    updated_at_ns: u64,
    error: Option<String>,
}

#[derive(JsonSchema, Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct ContributionMessage {
    pub v: u8,
    pub action: String,
    #[schemars(with = "String")]
    pub purchase_id: U64,
    pub quantity: u32,
}

#[derive(JsonSchema, Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct StorageBalance {
    #[schemars(with = "String")]
    pub total: U128,
    #[schemars(with = "String")]
    pub available: U128,
}

#[derive(JsonSchema, Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct OutboundOperationView {
    pub id: String,
    pub kind: String,
    pub purchase_id: String,
    pub recipient_id: String,
    pub amount: String,
    pub state: OutboundOperationState,
    pub created_at_ns: String,
    pub updated_at_ns: String,
    pub error: Option<String>,
}

#[derive(JsonSchema, Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct AccountingView {
    pub token_contract_id: String,
    pub token_decimals: u8,
    pub total_accepted: String,
    pub total_refunded: String,
    pub total_supplier_paid: String,
    pub outstanding_liability: String,
    pub last_observed_token_balance: Option<String>,
    pub last_reconciled_liability: Option<String>,
    pub last_reconciled_at_ns: Option<String>,
    pub reconciliation_status: String,
}

#[derive(
    BorshDeserialize,
    BorshSerialize,
    Clone,
    JsonSchema,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Debug,
)]
#[serde(crate = "near_sdk::serde")]
pub enum SupplierVerificationStatus {
    PilotAllowlisted,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct SupplierProfile {
    account_id: AccountId,
    business_name: String,
    location: String,
    public_contact: String,
    verification_status: SupplierVerificationStatus,
}

#[derive(JsonSchema, Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct SupplierProfileInput {
    #[schemars(with = "String")]
    pub account_id: AccountId,
    pub business_name: String,
    pub location: String,
    pub public_contact: String,
}

#[derive(JsonSchema, Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct SupplierProfileView {
    pub account_id: String,
    pub business_name: String,
    pub location: String,
    pub public_contact: String,
    pub verification_status: SupplierVerificationStatus,
    pub verification_label: String,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct PurchaseTerms {
    product_name: String,
    description: String,
    quantity_unit: String,
    price_per_unit: u128,
    listed_price_usd_cents: u64,
    min_quantity: u32,
    max_quantity: u32,
    max_quantity_per_household: u32,
    max_funded_members: u32,
    pickup_or_delivery: String,
    join_deadline_ns: u64,
    fulfillment_deadline_ns: u64,
    cancellation_and_refund_terms: String,
}

#[derive(JsonSchema, Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct PurchaseTermsInput {
    pub product_name: String,
    pub description: String,
    pub quantity_unit: String,
    #[schemars(with = "String")]
    pub price_per_unit: U128,
    #[schemars(with = "String")]
    pub listed_price_usd_cents: U64,
    pub min_quantity: u32,
    pub max_quantity: u32,
    pub max_quantity_per_household: u32,
    pub max_funded_members: u32,
    pub pickup_or_delivery: String,
    #[schemars(with = "String")]
    pub join_deadline_ns: U64,
    #[schemars(with = "String")]
    pub fulfillment_deadline_ns: U64,
    pub cancellation_and_refund_terms: String,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct SupplierAgreement {
    supplier_id: AccountId,
    terms_hash: String,
    accepted_at_ns: u64,
    accepted_at_block_height: u64,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct Commitment {
    account_id: AccountId,
    quantity: u32,
    amount: u128,
    state: CommitmentState,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct FulfillmentVote {
    voter: AccountId,
    approve: bool,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct Purchase {
    origin: PurchaseOrigin,
    organizer_id: AccountId,
    supplier_id: AccountId,
    terms: PurchaseTerms,
    terms_hash: String,
    state: PurchaseState,
    supplier_agreement: Option<SupplierAgreement>,
    declined_at_ns: Option<u64>,
    total_quantity: u32,
    total_funded_amount: u128,
    commitments: Vec<Commitment>,
    fulfillment_evidence_hash: Option<String>,
    fulfillment_votes: Vec<FulfillmentVote>,
}

#[derive(JsonSchema, Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct SupplierAgreementView {
    pub supplier_id: String,
    pub purchase_id: String,
    pub terms_hash: String,
    pub accepted_at_ns: String,
    pub accepted_at_block_height: String,
}

#[derive(JsonSchema, Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct CommitmentView {
    pub account_id: String,
    pub quantity: u32,
    pub amount: String,
    pub state: CommitmentState,
}

#[derive(JsonSchema, Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PurchaseView {
    pub id: String,
    pub version: String,
    pub origin: PurchaseOrigin,
    pub proposer: String,
    pub organizer_id: String,
    pub farmer_id: String,
    pub supplier_id: String,
    pub supplier_business_name: String,
    pub supplier_location: String,
    pub supplier_public_contact: String,
    pub supplier_verification_status: SupplierVerificationStatus,
    pub product_name: String,
    pub description: String,
    pub quantity_unit: String,
    pub price_per_unit: String,
    pub payment_asset: String,
    pub token_contract_id: String,
    pub token_decimals: u8,
    pub listed_price_usd_cents: String,
    pub min_quantity: u32,
    pub max_quantity: u32,
    pub max_quantity_per_household: u32,
    pub max_funded_members: u32,
    pub open_membership: bool,
    pub pickup_or_delivery: String,
    pub deadline_ns: String,
    pub join_deadline_ns: String,
    pub cancellation_deadline_ns: String,
    pub fulfillment_evidence_deadline_ns: String,
    pub cancellation_and_refund_terms: String,
    pub terms_hash: String,
    pub state: PurchaseState,
    pub supplier_agreement: Option<SupplierAgreementView>,
    pub total_quantity: u32,
    pub total_funded_amount: String,
    pub funded_member_count: u32,
    pub available_funded_member_slots: u32,
    pub fulfillment_evidence_hash: Option<String>,
    pub fulfillment_yes_votes: u32,
    pub fulfillment_no_votes: u32,
    pub required_fulfillment_yes_votes: Option<u32>,
    pub commitments: Vec<CommitmentView>,
}

#[derive(JsonSchema, Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct ContractConfigView {
    pub version: String,
    pub lifecycle: String,
    pub payment_asset: String,
    pub token_contract_id: String,
    pub token_decimals: u8,
    pub testnet_only: bool,
    pub max_funded_members: u32,
    pub supplier_verification: String,
}

#[ext_contract(ext_ft)]
trait ExtFungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance>;
}

#[ext_contract(ext_self)]
trait ExtSelf {
    fn resolve_storage_check(
        &mut self,
        operation_id: U64,
        #[callback_result] result: Result<Option<StorageBalance>, PromiseError>,
    ) -> PromiseOrValue<()>;
    fn resolve_outbound_transfer(
        &mut self,
        operation_id: U64,
        #[callback_result] result: Result<(), PromiseError>,
    );
    fn resolve_reconciliation(&mut self, #[callback_result] result: Result<U128, PromiseError>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    purchases: UnorderedMap<u64, Purchase>,
    suppliers: UnorderedMap<AccountId, SupplierProfile>,
    operations: UnorderedMap<u64, OutboundOperation>,
    supplier_ids: Vec<AccountId>,
    next_purchase_id: u64,
    next_operation_id: u64,
    token_contract_id: AccountId,
    token_decimals: u8,
    total_accepted: u128,
    total_refunded: u128,
    total_supplier_paid: u128,
    last_observed_token_balance: Option<u128>,
    last_reconciled_liability: Option<u128>,
    last_reconciled_at_ns: Option<u64>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        suppliers: Vec<SupplierProfileInput>,
        token_contract_id: AccountId,
        token_decimals: u8,
    ) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "initialization must be signed by the contract account"
        );
        require!(
            !suppliers.is_empty(),
            "at least one pilot supplier is required"
        );
        require!(token_decimals == USDC_DECIMALS, "USDC must use 6 decimals");
        require!(
            token_contract_id != env::current_account_id(),
            "token contract must be separate"
        );
        let mut contract = Self {
            purchases: UnorderedMap::new(StorageKey::Purchases),
            suppliers: UnorderedMap::new(StorageKey::Suppliers),
            operations: UnorderedMap::new(StorageKey::Operations),
            supplier_ids: Vec::new(),
            next_purchase_id: 0,
            next_operation_id: 0,
            token_contract_id,
            token_decimals,
            total_accepted: 0,
            total_refunded: 0,
            total_supplier_paid: 0,
            last_observed_token_balance: None,
            last_reconciled_liability: None,
            last_reconciled_at_ns: None,
        };
        for input in suppliers {
            validate_short("business name", &input.business_name);
            validate_short("supplier location", &input.location);
            validate_short("public contact", &input.public_contact);
            require!(
                contract.suppliers.get(&input.account_id).is_none(),
                "duplicate supplier account"
            );
            let account_id = input.account_id;
            contract.suppliers.insert(
                &account_id,
                &SupplierProfile {
                    account_id: account_id.clone(),
                    business_name: input.business_name,
                    location: input.location,
                    public_contact: input.public_contact,
                    verification_status: SupplierVerificationStatus::PilotAllowlisted,
                },
            );
            contract.supplier_ids.push(account_id);
        }
        if env::current_account_id().as_str().ends_with(".testnet") {
            require!(
                contract.token_contract_id.as_str() == OFFICIAL_TESTNET_USDC,
                "Testnet V5 must use Circle's official native USDC contract"
            );
            require!(
                contract
                    .supplier_ids
                    .iter()
                    .any(|id| id.as_str() == PILOT_SUPPLIER),
                "required pilot supplier is missing"
            );
        }
        contract
    }

    /// The supplier's signed creation call authorizes the immutable terms and opens funding.
    pub fn create_supplier_offer(&mut self, terms: PurchaseTermsInput) -> U64 {
        self.assert_no_deposit();
        let supplier_id = env::predecessor_account_id();
        self.assert_supplier(&supplier_id);
        let id = self.create_record(
            PurchaseOrigin::SupplierOffer,
            supplier_id.clone(),
            supplier_id,
            terms,
        );
        let mut purchase = self.load(id.0);
        purchase.state = PurchaseState::Open;
        purchase.supplier_agreement = Some(self.agreement(&purchase));
        self.save(id.0, purchase);
        id
    }

    /// An organizer may prepare terms, but no one can contribute until the named supplier signs.
    pub fn create_purchase_request(
        &mut self,
        supplier_id: AccountId,
        terms: PurchaseTermsInput,
    ) -> U64 {
        self.assert_no_deposit();
        self.assert_supplier(&supplier_id);
        self.create_record(
            PurchaseOrigin::OrganizerRequest,
            env::predecessor_account_id(),
            supplier_id,
            terms,
        )
    }

    pub fn accept_supplier_request(&mut self, purchase_id: U64) {
        self.assert_no_deposit();
        let mut purchase = self.load(purchase_id.0);
        require!(
            purchase.origin == PurchaseOrigin::OrganizerRequest,
            "purchase is not an organizer request"
        );
        require!(
            purchase.state == PurchaseState::AwaitingSupplier,
            "purchase is not awaiting supplier confirmation"
        );
        require!(
            env::predecessor_account_id() == purchase.supplier_id,
            "only the named supplier may accept"
        );
        require!(
            env::block_timestamp() < purchase.terms.join_deadline_ns,
            "join deadline has passed"
        );
        purchase.supplier_agreement = Some(self.agreement(&purchase));
        purchase.state = PurchaseState::Open;
        self.save(purchase_id.0, purchase);
    }

    pub fn decline_supplier_request(&mut self, purchase_id: U64) {
        self.assert_no_deposit();
        let mut purchase = self.load(purchase_id.0);
        require!(
            purchase.origin == PurchaseOrigin::OrganizerRequest,
            "purchase is not an organizer request"
        );
        require!(
            purchase.state == PurchaseState::AwaitingSupplier,
            "purchase is not awaiting supplier confirmation"
        );
        require!(
            env::predecessor_account_id() == purchase.supplier_id,
            "only the named supplier may decline"
        );
        purchase.state = PurchaseState::Declined;
        purchase.declined_at_ns = Some(env::block_timestamp());
        self.save(purchase_id.0, purchase);
    }

    /// NEP-141 receiver entry point. Expected validation failures return the entire token amount
    /// as unused so the token contract's resolver returns it to `sender_id`.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.token_contract_id {
            env::log_str("rejected transfer from an unconfigured token contract");
            return PromiseOrValue::Value(amount);
        }
        let Ok(message) = near_sdk::serde_json::from_str::<ContributionMessage>(&msg) else {
            env::log_str("rejected malformed contribution message");
            return PromiseOrValue::Value(amount);
        };
        if message.v != 1 || message.action != "commit" {
            env::log_str("rejected unsupported contribution message");
            return PromiseOrValue::Value(amount);
        }
        if self.try_accept_contribution(
            sender_id,
            message.purchase_id.0,
            message.quantity,
            amount.0,
        ) {
            PromiseOrValue::Value(U128(0))
        } else {
            PromiseOrValue::Value(amount)
        }
    }

    /// The single join cutoff is also the last moment for a voluntary cancellation.
    pub fn cancel_commitment(&mut self, purchase_id: U64) {
        self.assert_no_deposit();
        let account_id = env::predecessor_account_id();
        let mut purchase = self.load(purchase_id.0);
        require!(
            purchase.state == PurchaseState::Open,
            "purchase is not open"
        );
        require!(
            env::block_timestamp() < purchase.terms.join_deadline_ns,
            "voluntary cancellation cutoff has passed"
        );
        let commitment = purchase
            .commitments
            .iter_mut()
            .find(|c| c.account_id == account_id)
            .unwrap_or_else(|| env::panic_str("account has no commitment"));
        require!(
            commitment.state == CommitmentState::Active,
            "commitment is not cancellable"
        );
        commitment.state = CommitmentState::Refundable;
        purchase.total_quantity = purchase
            .total_quantity
            .checked_sub(commitment.quantity)
            .expect("quantity invariant violated");
        purchase.total_funded_amount = purchase
            .total_funded_amount
            .checked_sub(commitment.amount)
            .expect("funding invariant violated");
        self.save(purchase_id.0, purchase);
    }

    pub fn finalize_purchase(&mut self, purchase_id: U64) {
        self.assert_no_deposit();
        let mut purchase = self.load(purchase_id.0);
        require!(
            env::block_timestamp() >= purchase.terms.join_deadline_ns,
            "join deadline has not passed"
        );
        require!(
            purchase.state == PurchaseState::Open
                || purchase.state == PurchaseState::AwaitingSupplier,
            "purchase cannot be finalized"
        );
        if purchase.state == PurchaseState::Open
            && purchase.total_quantity >= purchase.terms.min_quantity
        {
            purchase.state = PurchaseState::Funded;
        } else {
            fail_and_refund(&mut purchase);
        }
        self.save(purchase_id.0, purchase);
    }

    pub fn submit_fulfillment_evidence(&mut self, purchase_id: U64, evidence_hash: String) {
        self.assert_no_deposit();
        let mut purchase = self.load(purchase_id.0);
        require!(
            env::predecessor_account_id() == purchase.supplier_id,
            "only the named supplier may submit evidence"
        );
        require!(
            purchase.state == PurchaseState::Funded,
            "purchase is not awaiting fulfillment"
        );
        require!(
            env::block_timestamp() <= purchase.terms.fulfillment_deadline_ns,
            "fulfillment deadline has passed"
        );
        require!(
            !evidence_hash.is_empty() && evidence_hash.len() <= MAX_EVIDENCE_BYTES,
            "invalid fulfillment evidence reference"
        );
        purchase.fulfillment_evidence_hash = Some(evidence_hash);
        purchase.state = PurchaseState::FulfillmentPending;
        self.save(purchase_id.0, purchase);
    }

    pub fn vote_on_fulfillment(&mut self, purchase_id: U64, approve: bool) {
        self.assert_no_deposit();
        let voter = env::predecessor_account_id();
        let mut purchase = self.load(purchase_id.0);
        require!(
            purchase.state == PurchaseState::FulfillmentPending,
            "fulfillment is not accepting confirmations"
        );
        require!(
            env::block_timestamp() <= purchase.terms.fulfillment_deadline_ns,
            "fulfillment review deadline has passed"
        );
        require!(
            purchase
                .commitments
                .iter()
                .any(|c| c.account_id == voter && c.state == CommitmentState::Active),
            "only funded household members may confirm fulfillment"
        );
        require!(
            !purchase.fulfillment_votes.iter().any(|v| v.voter == voter),
            "member already confirmed fulfillment"
        );
        purchase
            .fulfillment_votes
            .push(FulfillmentVote { voter, approve });
        if approval_count(&purchase) >= required_fulfillment_votes(&purchase) {
            purchase.state = PurchaseState::FulfillmentApproved;
        }
        self.save(purchase_id.0, purchase);
    }

    pub fn expire_unfulfilled_purchase(&mut self, purchase_id: U64) {
        self.assert_no_deposit();
        let mut purchase = self.load(purchase_id.0);
        require!(
            env::block_timestamp() > purchase.terms.fulfillment_deadline_ns,
            "fulfillment deadline has not passed"
        );
        require!(
            purchase.state == PurchaseState::Funded
                || purchase.state == PurchaseState::FulfillmentPending,
            "purchase is not awaiting fulfillment"
        );
        fail_and_refund(&mut purchase);
        self.save(purchase_id.0, purchase);
    }

    pub fn release_payment(&mut self, purchase_id: U64) -> Promise {
        self.assert_no_deposit();
        let mut purchase = self.load(purchase_id.0);
        require!(
            purchase.state == PurchaseState::FulfillmentApproved,
            "fulfillment is not approved"
        );
        let amount = purchase.total_funded_amount;
        let supplier_id = purchase.supplier_id.clone();
        purchase.state = PurchaseState::PaymentPending;
        self.save(purchase_id.0, purchase);
        self.start_outbound_operation(
            OutboundOperationKind::SupplierPayment {
                purchase_id: purchase_id.0,
            },
            supplier_id,
            amount,
        )
    }

    pub fn claim_refund(&mut self, purchase_id: U64) -> Promise {
        self.assert_no_deposit();
        let account_id = env::predecessor_account_id();
        let mut purchase = self.load(purchase_id.0);
        let commitment = purchase
            .commitments
            .iter_mut()
            .find(|c| c.account_id == account_id)
            .unwrap_or_else(|| env::panic_str("account has no commitment"));
        require!(
            commitment.state == CommitmentState::Refundable,
            "refund is not claimable"
        );
        let amount = commitment.amount;
        commitment.state = CommitmentState::RefundPending;
        self.save(purchase_id.0, purchase);
        self.start_outbound_operation(
            OutboundOperationKind::Refund {
                purchase_id: purchase_id.0,
                account_id: account_id.clone(),
            },
            account_id,
            amount,
        )
    }

    #[private]
    pub fn resolve_storage_check(
        &mut self,
        operation_id: U64,
        #[callback_result] result: Result<Option<StorageBalance>, PromiseError>,
    ) -> PromiseOrValue<()> {
        let Some(mut operation) = self.operations.get(&operation_id.0) else {
            return PromiseOrValue::Value(());
        };
        if operation.state != OutboundOperationState::RegistrationPending {
            return PromiseOrValue::Value(());
        }
        if !matches!(result, Ok(Some(_))) {
            operation.state = OutboundOperationState::Failed;
            operation.updated_at_ns = env::block_timestamp();
            operation.error = Some(match result {
                Ok(None) => "recipient is not registered with the USDC token".to_string(),
                Err(_) => "token storage registration check failed".to_string(),
                Ok(Some(_)) => unreachable!(),
            });
            self.restore_after_observed_failure(&operation);
            self.operations.insert(&operation_id.0, &operation);
            return PromiseOrValue::Value(());
        }

        operation.state = OutboundOperationState::TransferPending;
        operation.updated_at_ns = env::block_timestamp();
        operation.error = None;
        self.operations.insert(&operation_id.0, &operation);
        let promise = ext_ft::ext(self.token_contract_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(
                operation.recipient_id.clone(),
                U128(operation.amount),
                Some(format!("HarvestPool V5 operation {}", operation.id)),
            )
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .resolve_outbound_transfer(operation_id),
            );
        PromiseOrValue::Promise(promise)
    }

    #[private]
    pub fn resolve_outbound_transfer(
        &mut self,
        operation_id: U64,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        let Some(mut operation) = self.operations.get(&operation_id.0) else {
            return;
        };
        if operation.state != OutboundOperationState::TransferPending {
            return;
        }
        operation.updated_at_ns = env::block_timestamp();
        if result.is_ok() {
            operation.state = OutboundOperationState::Succeeded;
            operation.error = None;
            self.finalize_successful_operation(&operation);
        } else {
            operation.state = OutboundOperationState::Failed;
            operation.error = Some(
                "USDC transfer failed; operation may be retried from restored state".to_string(),
            );
            self.restore_after_observed_failure(&operation);
        }
        self.operations.insert(&operation_id.0, &operation);
    }

    /// Marks an operation whose callback did not arrive. A registration check can be safely
    /// released because no transfer was scheduled. A transfer-pending operation is frozen for
    /// investigation; it is never made retryable automatically.
    pub fn flag_stale_operation(&mut self, operation_id: U64) {
        self.assert_no_deposit();
        let mut operation = self
            .operations
            .get(&operation_id.0)
            .unwrap_or_else(|| env::panic_str("operation does not exist"));
        require!(
            env::block_timestamp()
                >= operation
                    .updated_at_ns
                    .checked_add(STALE_OPERATION_NS)
                    .expect("operation time overflow"),
            "operation is not stale"
        );
        match operation.state {
            OutboundOperationState::RegistrationPending => {
                operation.state = OutboundOperationState::Failed;
                operation.error = Some(
                    "storage check callback missing; no token transfer was scheduled".to_string(),
                );
                self.restore_after_observed_failure(&operation);
            }
            OutboundOperationState::TransferPending => {
                operation.state = OutboundOperationState::ReconciliationRequired;
                operation.error = Some(
                    "transfer callback missing; outcome is ambiguous and retry is frozen"
                        .to_string(),
                );
            }
            _ => env::panic_str("operation is not pending"),
        }
        operation.updated_at_ns = env::block_timestamp();
        self.operations.insert(&operation_id.0, &operation);
    }

    pub fn reconcile_token_balance(&self) -> Promise {
        self.assert_no_deposit();
        ext_ft::ext(self.token_contract_id.clone())
            .with_static_gas(FT_VIEW_GAS)
            .ft_balance_of(env::current_account_id())
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .resolve_reconciliation(),
            )
    }

    #[private]
    pub fn resolve_reconciliation(
        &mut self,
        #[callback_result] result: Result<U128, PromiseError>,
    ) {
        let Ok(observed) = result else {
            env::log_str("USDC balance reconciliation read failed");
            return;
        };
        self.last_observed_token_balance = Some(observed.0);
        self.last_reconciled_liability = Some(self.outstanding_liability());
        self.last_reconciled_at_ns = Some(env::block_timestamp());
    }

    pub fn get_purchase(&self, purchase_id: U64) -> Option<PurchaseView> {
        self.purchases
            .get(&purchase_id.0)
            .map(|purchase| self.purchase_view(purchase_id.0, &purchase))
    }

    pub fn get_purchase_count(&self) -> U64 {
        U64(self.next_purchase_id)
    }

    pub fn get_funded_members(&self, purchase_id: U64) -> Vec<AccountId> {
        self.load(purchase_id.0)
            .commitments
            .into_iter()
            .filter(|c| c.state == CommitmentState::Active)
            .map(|c| c.account_id)
            .collect()
    }

    pub fn is_funded_member(&self, purchase_id: U64, account_id: AccountId) -> bool {
        self.load(purchase_id.0)
            .commitments
            .iter()
            .any(|c| c.account_id == account_id && c.state == CommitmentState::Active)
    }

    pub fn get_fulfillment_vote(&self, purchase_id: U64, account_id: AccountId) -> Option<bool> {
        self.load(purchase_id.0)
            .fulfillment_votes
            .into_iter()
            .find(|v| v.voter == account_id)
            .map(|v| v.approve)
    }

    pub fn get_supplier(&self, account_id: AccountId) -> Option<SupplierProfileView> {
        self.suppliers.get(&account_id).map(supplier_view)
    }

    pub fn get_suppliers(&self) -> Vec<SupplierProfileView> {
        self.supplier_ids
            .iter()
            .filter_map(|id| self.suppliers.get(id))
            .map(supplier_view)
            .collect()
    }

    pub fn get_outbound_operation(&self, operation_id: U64) -> Option<OutboundOperationView> {
        self.operations
            .get(&operation_id.0)
            .map(|operation| operation_view(&operation))
    }

    pub fn get_outbound_operation_count(&self) -> U64 {
        U64(self.next_operation_id)
    }

    pub fn get_accounting(&self) -> AccountingView {
        let liability = self.outstanding_liability();
        let (observed, reconciled_liability, reconciled_at, status) =
            if let (Some(observed_balance), Some(expected_liability), Some(observed_at_ns)) = (
                self.last_observed_token_balance,
                self.last_reconciled_liability,
                self.last_reconciled_at_ns,
            ) {
                let status = if observed_balance < expected_liability {
                    "shortfall"
                } else if observed_balance == expected_liability {
                    "balanced"
                } else {
                    "surplus-or-direct-transfer"
                };
                (
                    Some(observed_balance.to_string()),
                    Some(expected_liability.to_string()),
                    Some(observed_at_ns.to_string()),
                    status.to_string(),
                )
            } else {
                (None, None, None, "not-reconciled".to_string())
            };
        AccountingView {
            token_contract_id: self.token_contract_id.to_string(),
            token_decimals: self.token_decimals,
            total_accepted: self.total_accepted.to_string(),
            total_refunded: self.total_refunded.to_string(),
            total_supplier_paid: self.total_supplier_paid.to_string(),
            outstanding_liability: liability.to_string(),
            last_observed_token_balance: observed,
            last_reconciled_liability: reconciled_liability,
            last_reconciled_at_ns: reconciled_at,
            reconciliation_status: status,
        }
    }

    pub fn get_config(&self) -> ContractConfigView {
        ContractConfigView {
            version: "V5".to_string(),
            lifecycle: "supplier-authorized-no-offer-vote".to_string(),
            payment_asset: "native-usdc-nep141".to_string(),
            token_contract_id: self.token_contract_id.to_string(),
            token_decimals: self.token_decimals,
            testnet_only: true,
            max_funded_members: MAX_FUNDED_MEMBERS,
            supplier_verification: "controlled-pilot-allowlist".to_string(),
        }
    }

    fn try_accept_contribution(
        &mut self,
        account_id: AccountId,
        purchase_id: u64,
        quantity: u32,
        transferred_amount: u128,
    ) -> bool {
        let Some(mut purchase) = self.purchases.get(&purchase_id) else {
            env::log_str("rejected contribution for unknown purchase");
            return false;
        };
        if purchase.state != PurchaseState::Open
            || purchase.supplier_agreement.is_none()
            || account_id == purchase.supplier_id
            || env::block_timestamp() >= purchase.terms.join_deadline_ns
            || quantity == 0
            || quantity > purchase.terms.max_quantity_per_household
            || purchase
                .commitments
                .iter()
                .any(|c| c.account_id == account_id)
            || active_member_count(&purchase) >= purchase.terms.max_funded_members
        {
            env::log_str(
                "rejected contribution by lifecycle, identity, deadline, or membership rule",
            );
            return false;
        }
        let Some(next_quantity) = purchase.total_quantity.checked_add(quantity) else {
            return false;
        };
        if next_quantity > purchase.terms.max_quantity {
            env::log_str("rejected contribution that exceeds purchase capacity");
            return false;
        }
        let Some(expected_amount) = purchase.terms.price_per_unit.checked_mul(quantity as u128)
        else {
            return false;
        };
        if expected_amount == 0 || transferred_amount != expected_amount {
            env::log_str("rejected contribution with an incorrect USDC amount");
            return false;
        }
        let Some(next_funded) = purchase.total_funded_amount.checked_add(expected_amount) else {
            return false;
        };
        let Some(next_accepted) = self.total_accepted.checked_add(expected_amount) else {
            return false;
        };
        purchase.total_quantity = next_quantity;
        purchase.total_funded_amount = next_funded;
        purchase.commitments.push(Commitment {
            account_id,
            quantity,
            amount: expected_amount,
            state: CommitmentState::Active,
        });
        self.total_accepted = next_accepted;
        self.save(purchase_id, purchase);
        true
    }

    fn start_outbound_operation(
        &mut self,
        kind: OutboundOperationKind,
        recipient_id: AccountId,
        amount: u128,
    ) -> Promise {
        require!(amount > 0, "outbound amount must be positive");
        let id = self.next_operation_id;
        self.next_operation_id = self
            .next_operation_id
            .checked_add(1)
            .expect("operation id overflow");
        let operation = OutboundOperation {
            id,
            kind,
            recipient_id: recipient_id.clone(),
            amount,
            state: OutboundOperationState::RegistrationPending,
            created_at_ns: env::block_timestamp(),
            updated_at_ns: env::block_timestamp(),
            error: None,
        };
        self.operations.insert(&id, &operation);
        ext_ft::ext(self.token_contract_id.clone())
            .with_static_gas(FT_VIEW_GAS)
            .storage_balance_of(recipient_id)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .resolve_storage_check(U64(id)),
            )
    }

    fn restore_after_observed_failure(&mut self, operation: &OutboundOperation) {
        match &operation.kind {
            OutboundOperationKind::Refund {
                purchase_id,
                account_id,
            } => {
                let Some(mut purchase) = self.purchases.get(purchase_id) else {
                    return;
                };
                let Some(commitment) = purchase
                    .commitments
                    .iter_mut()
                    .find(|c| &c.account_id == account_id)
                else {
                    return;
                };
                if commitment.state == CommitmentState::RefundPending
                    && commitment.amount == operation.amount
                {
                    commitment.state = CommitmentState::Refundable;
                    self.save(*purchase_id, purchase);
                }
            }
            OutboundOperationKind::SupplierPayment { purchase_id } => {
                let Some(mut purchase) = self.purchases.get(purchase_id) else {
                    return;
                };
                if purchase.state == PurchaseState::PaymentPending
                    && purchase.total_funded_amount == operation.amount
                {
                    purchase.state = PurchaseState::FulfillmentApproved;
                    self.save(*purchase_id, purchase);
                }
            }
        }
    }

    fn finalize_successful_operation(&mut self, operation: &OutboundOperation) {
        match &operation.kind {
            OutboundOperationKind::Refund {
                purchase_id,
                account_id,
            } => {
                let mut purchase = self.load(*purchase_id);
                let commitment = purchase
                    .commitments
                    .iter_mut()
                    .find(|c| &c.account_id == account_id)
                    .unwrap_or_else(|| env::panic_str("refund commitment missing"));
                require!(
                    commitment.state == CommitmentState::RefundPending
                        && commitment.amount == operation.amount,
                    "refund operation no longer matches commitment"
                );
                commitment.state = CommitmentState::Refunded;
                self.total_refunded = self
                    .total_refunded
                    .checked_add(operation.amount)
                    .expect("refund accounting overflow");
                self.save(*purchase_id, purchase);
            }
            OutboundOperationKind::SupplierPayment { purchase_id } => {
                let mut purchase = self.load(*purchase_id);
                require!(
                    purchase.state == PurchaseState::PaymentPending
                        && purchase.total_funded_amount == operation.amount,
                    "payment operation no longer matches purchase"
                );
                purchase.state = PurchaseState::Completed;
                self.total_supplier_paid = self
                    .total_supplier_paid
                    .checked_add(operation.amount)
                    .expect("payment accounting overflow");
                self.save(*purchase_id, purchase);
            }
        }
    }

    fn outstanding_liability(&self) -> u128 {
        self.total_accepted
            .checked_sub(self.total_refunded)
            .and_then(|value| value.checked_sub(self.total_supplier_paid))
            .expect("USDC accounting invariant violated")
    }

    fn create_record(
        &mut self,
        origin: PurchaseOrigin,
        organizer_id: AccountId,
        supplier_id: AccountId,
        input: PurchaseTermsInput,
    ) -> U64 {
        require!(
            self.next_purchase_id < MAX_PURCHASES,
            "purchase limit reached"
        );
        let terms = validate_terms(input);
        let id = self.next_purchase_id;
        let supplier_profile = self
            .suppliers
            .get(&supplier_id)
            .unwrap_or_else(|| env::panic_str("supplier is not allowlisted"));
        let terms_hash = hash_terms(id, &organizer_id, &supplier_profile, &terms);
        self.next_purchase_id = self
            .next_purchase_id
            .checked_add(1)
            .expect("purchase id overflow");
        self.purchases.insert(
            &id,
            &Purchase {
                origin,
                organizer_id,
                supplier_id,
                terms,
                terms_hash,
                state: PurchaseState::AwaitingSupplier,
                supplier_agreement: None,
                declined_at_ns: None,
                total_quantity: 0,
                total_funded_amount: 0,
                commitments: Vec::new(),
                fulfillment_evidence_hash: None,
                fulfillment_votes: Vec::new(),
            },
        );
        U64(id)
    }

    fn agreement(&self, purchase: &Purchase) -> SupplierAgreement {
        SupplierAgreement {
            supplier_id: purchase.supplier_id.clone(),
            terms_hash: purchase.terms_hash.clone(),
            accepted_at_ns: env::block_timestamp(),
            accepted_at_block_height: env::block_height(),
        }
    }

    fn purchase_view(&self, id: u64, purchase: &Purchase) -> PurchaseView {
        let supplier = self
            .suppliers
            .get(&purchase.supplier_id)
            .expect("supplier profile missing");
        let funded = active_member_count(purchase);
        PurchaseView {
            id: id.to_string(),
            version: "V5".to_string(),
            origin: purchase.origin,
            proposer: purchase.organizer_id.to_string(),
            organizer_id: purchase.organizer_id.to_string(),
            farmer_id: purchase.supplier_id.to_string(),
            supplier_id: purchase.supplier_id.to_string(),
            supplier_business_name: supplier.business_name,
            supplier_location: supplier.location,
            supplier_public_contact: supplier.public_contact,
            supplier_verification_status: supplier.verification_status,
            product_name: purchase.terms.product_name.clone(),
            description: purchase.terms.description.clone(),
            quantity_unit: purchase.terms.quantity_unit.clone(),
            price_per_unit: purchase.terms.price_per_unit.to_string(),
            payment_asset: "native-usdc-nep141".to_string(),
            token_contract_id: self.token_contract_id.to_string(),
            token_decimals: self.token_decimals,
            listed_price_usd_cents: purchase.terms.listed_price_usd_cents.to_string(),
            min_quantity: purchase.terms.min_quantity,
            max_quantity: purchase.terms.max_quantity,
            max_quantity_per_household: purchase.terms.max_quantity_per_household,
            max_funded_members: purchase.terms.max_funded_members,
            open_membership: true,
            pickup_or_delivery: purchase.terms.pickup_or_delivery.clone(),
            deadline_ns: purchase.terms.join_deadline_ns.to_string(),
            join_deadline_ns: purchase.terms.join_deadline_ns.to_string(),
            cancellation_deadline_ns: purchase.terms.join_deadline_ns.to_string(),
            fulfillment_evidence_deadline_ns: purchase.terms.fulfillment_deadline_ns.to_string(),
            cancellation_and_refund_terms: purchase.terms.cancellation_and_refund_terms.clone(),
            terms_hash: purchase.terms_hash.clone(),
            state: purchase.state,
            supplier_agreement: purchase.supplier_agreement.as_ref().map(|a| {
                SupplierAgreementView {
                    supplier_id: a.supplier_id.to_string(),
                    purchase_id: id.to_string(),
                    terms_hash: a.terms_hash.clone(),
                    accepted_at_ns: a.accepted_at_ns.to_string(),
                    accepted_at_block_height: a.accepted_at_block_height.to_string(),
                }
            }),
            total_quantity: purchase.total_quantity,
            total_funded_amount: purchase.total_funded_amount.to_string(),
            funded_member_count: funded,
            available_funded_member_slots: purchase.terms.max_funded_members.saturating_sub(funded),
            fulfillment_evidence_hash: purchase.fulfillment_evidence_hash.clone(),
            fulfillment_yes_votes: approval_count(purchase),
            fulfillment_no_votes: purchase
                .fulfillment_votes
                .iter()
                .filter(|v| !v.approve)
                .count() as u32,
            required_fulfillment_yes_votes: if funded == 0 {
                None
            } else {
                Some(required_fulfillment_votes(purchase))
            },
            commitments: purchase
                .commitments
                .iter()
                .map(|c| CommitmentView {
                    account_id: c.account_id.to_string(),
                    quantity: c.quantity,
                    amount: c.amount.to_string(),
                    state: c.state,
                })
                .collect(),
        }
    }

    fn load(&self, id: u64) -> Purchase {
        self.purchases
            .get(&id)
            .unwrap_or_else(|| env::panic_str("purchase does not exist"))
    }
    fn save(&mut self, id: u64, purchase: Purchase) {
        self.purchases.insert(&id, &purchase);
    }
    fn assert_supplier(&self, account: &AccountId) {
        require!(
            self.suppliers.get(account).is_some(),
            "supplier is not eligible for the pilot"
        );
    }
    fn assert_no_deposit(&self) {
        require!(
            env::attached_deposit().is_zero(),
            "this method does not accept a deposit"
        );
    }
}

fn validate_terms(input: PurchaseTermsInput) -> PurchaseTerms {
    validate_short("product name", &input.product_name);
    validate_long("description", &input.description);
    validate_short("quantity unit", &input.quantity_unit);
    validate_long("pickup or delivery terms", &input.pickup_or_delivery);
    validate_long(
        "cancellation and refund terms",
        &input.cancellation_and_refund_terms,
    );
    require!(input.price_per_unit.0 > 0, "price must be positive");
    require!(
        input.listed_price_usd_cents.0 > 0,
        "listed USD price must be positive"
    );
    require!(
        input.min_quantity > 0
            && input.max_quantity >= input.min_quantity
            && input.max_quantity <= MAX_QUANTITY,
        "invalid quantity range"
    );
    require!(
        input.max_quantity_per_household > 0
            && input.max_quantity_per_household <= input.max_quantity,
        "invalid household quantity limit"
    );
    require!(
        input.max_funded_members > 0 && input.max_funded_members <= MAX_FUNDED_MEMBERS,
        "invalid funded household limit"
    );
    require!(
        input.max_funded_members <= input.max_quantity,
        "funded household limit exceeds unit capacity"
    );
    require!(
        input.join_deadline_ns.0 > env::block_timestamp(),
        "join deadline must be in the future"
    );
    require!(
        input.fulfillment_deadline_ns.0 > input.join_deadline_ns.0,
        "fulfillment deadline must follow join deadline"
    );
    require!(
        input.fulfillment_deadline_ns.0 - input.join_deadline_ns.0 <= MAX_FULFILLMENT_WINDOW_NS,
        "fulfillment window is too long"
    );
    PurchaseTerms {
        product_name: input.product_name,
        description: input.description,
        quantity_unit: input.quantity_unit,
        price_per_unit: input.price_per_unit.0,
        listed_price_usd_cents: input.listed_price_usd_cents.0,
        min_quantity: input.min_quantity,
        max_quantity: input.max_quantity,
        max_quantity_per_household: input.max_quantity_per_household,
        max_funded_members: input.max_funded_members,
        pickup_or_delivery: input.pickup_or_delivery,
        join_deadline_ns: input.join_deadline_ns.0,
        fulfillment_deadline_ns: input.fulfillment_deadline_ns.0,
        cancellation_and_refund_terms: input.cancellation_and_refund_terms,
    }
}

fn validate_short(label: &str, value: &str) {
    require!(
        !value.trim().is_empty() && value.len() <= MAX_SHORT_TEXT_BYTES,
        format!("invalid {label}")
    );
}
fn validate_long(label: &str, value: &str) {
    require!(
        !value.trim().is_empty() && value.len() <= MAX_TEXT_BYTES,
        format!("invalid {label}")
    );
}

fn hash_terms(
    purchase_id: u64,
    organizer: &AccountId,
    supplier: &SupplierProfile,
    terms: &PurchaseTerms,
) -> String {
    let bytes = borsh::to_vec(&(purchase_id, organizer, supplier, terms))
        .expect("terms serialization failed");
    env::sha256(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn supplier_view(profile: SupplierProfile) -> SupplierProfileView {
    SupplierProfileView {
        account_id: profile.account_id.to_string(),
        business_name: profile.business_name,
        location: profile.location,
        public_contact: profile.public_contact,
        verification_status: profile.verification_status,
        verification_label: "Eligible pilot supplier".to_string(),
    }
}

fn operation_view(operation: &OutboundOperation) -> OutboundOperationView {
    let (kind, purchase_id) = match &operation.kind {
        OutboundOperationKind::Refund { purchase_id, .. } => ("Refund", *purchase_id),
        OutboundOperationKind::SupplierPayment { purchase_id } => ("SupplierPayment", *purchase_id),
    };
    OutboundOperationView {
        id: operation.id.to_string(),
        kind: kind.to_string(),
        purchase_id: purchase_id.to_string(),
        recipient_id: operation.recipient_id.to_string(),
        amount: operation.amount.to_string(),
        state: operation.state,
        created_at_ns: operation.created_at_ns.to_string(),
        updated_at_ns: operation.updated_at_ns.to_string(),
        error: operation.error.clone(),
    }
}

fn active_member_count(purchase: &Purchase) -> u32 {
    purchase
        .commitments
        .iter()
        .filter(|c| c.state == CommitmentState::Active)
        .count() as u32
}
fn approval_count(purchase: &Purchase) -> u32 {
    purchase
        .fulfillment_votes
        .iter()
        .filter(|v| v.approve)
        .count() as u32
}
fn required_fulfillment_votes(purchase: &Purchase) -> u32 {
    let n = active_member_count(purchase);
    n.saturating_mul(2).saturating_add(2) / 3
}
fn fail_and_refund(purchase: &mut Purchase) {
    purchase.state = PurchaseState::Failed;
    for c in &mut purchase.commitments {
        if c.state == CommitmentState::Active {
            c.state = CommitmentState::Refundable;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    const NOW: u64 = 1_000_000_000_000;
    const DAY: u64 = 86_400_000_000_000;
    const PRICE: u128 = 50_000_000;

    fn pilot() -> AccountId {
        PILOT_SUPPLIER.parse().unwrap()
    }

    fn context(predecessor: AccountId, current: AccountId, time: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(current)
            .predecessor_account_id(predecessor)
            .block_timestamp(time)
            .block_height(77)
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
    }

    fn contract() -> Contract {
        context(accounts(5), accounts(5), NOW);
        Contract::new(
            vec![SupplierProfileInput {
                account_id: pilot(),
                business_name: "Prairie Family Farm".into(),
                location: "Illinois".into(),
                public_contact: "farm@example.test".into(),
            }],
            accounts(4),
            USDC_DECIMALS,
        )
    }

    fn terms() -> PurchaseTermsInput {
        PurchaseTermsInput {
            product_name: "Family beef box".into(),
            description: "Twenty-pound mixed box".into(),
            quantity_unit: "box".into(),
            price_per_unit: U128(PRICE),
            listed_price_usd_cents: U64(5_000),
            min_quantity: 1,
            max_quantity: 2,
            max_quantity_per_household: 1,
            max_funded_members: 2,
            pickup_or_delivery: "Saturday pickup".into(),
            join_deadline_ns: U64(NOW + DAY),
            fulfillment_deadline_ns: U64(NOW + 2 * DAY),
            cancellation_and_refund_terms: "Full refund on contract failure.".into(),
        }
    }

    fn returned_amount(result: PromiseOrValue<U128>) -> u128 {
        match result {
            PromiseOrValue::Value(value) => value.0,
            PromiseOrValue::Promise(_) => panic!("receiver unexpectedly returned a promise"),
        }
    }

    #[test]
    fn accepts_exact_usdc_only_from_configured_token() {
        let mut contract = contract();
        context(pilot(), accounts(5), NOW);
        let id = contract.create_supplier_offer(terms());
        let message = near_sdk::serde_json::to_string(&ContributionMessage {
            v: 1,
            action: "commit".into(),
            purchase_id: id,
            quantity: 1,
        })
        .unwrap();

        context(accounts(3), accounts(5), NOW);
        assert_eq!(
            returned_amount(contract.ft_on_transfer(accounts(0), U128(PRICE), message.clone())),
            PRICE
        );
        assert!(!contract.is_funded_member(id, accounts(0)));

        context(accounts(4), accounts(5), NOW);
        assert_eq!(
            returned_amount(contract.ft_on_transfer(accounts(0), U128(PRICE - 1), message.clone())),
            PRICE - 1
        );
        assert_eq!(
            returned_amount(contract.ft_on_transfer(accounts(0), U128(PRICE), message)),
            0
        );
        assert!(contract.is_funded_member(id, accounts(0)));
        assert_eq!(
            contract.get_accounting().outstanding_liability,
            PRICE.to_string()
        );
    }

    #[test]
    fn duplicate_and_supplier_contributions_return_unused_tokens() {
        let mut contract = contract();
        context(pilot(), accounts(5), NOW);
        let id = contract.create_supplier_offer(terms());
        let message = near_sdk::serde_json::to_string(&ContributionMessage {
            v: 1,
            action: "commit".into(),
            purchase_id: id,
            quantity: 1,
        })
        .unwrap();

        context(accounts(4), accounts(5), NOW);
        assert_eq!(
            returned_amount(contract.ft_on_transfer(accounts(0), U128(PRICE), message.clone())),
            0
        );
        assert_eq!(
            returned_amount(contract.ft_on_transfer(accounts(0), U128(PRICE), message.clone())),
            PRICE
        );
        assert_eq!(
            returned_amount(contract.ft_on_transfer(pilot(), U128(PRICE), message)),
            PRICE
        );
        assert_eq!(contract.get_funded_members(id), vec![accounts(0)]);
    }

    #[test]
    fn accounting_distinguishes_liability_from_reconciled_balance() {
        let mut contract = contract();
        contract.total_accepted = 100_000_000;
        contract.total_refunded = 25_000_000;
        contract.total_supplier_paid = 50_000_000;
        assert_eq!(contract.outstanding_liability(), 25_000_000);
        assert_eq!(
            contract.get_accounting().reconciliation_status,
            "not-reconciled"
        );
        contract.last_observed_token_balance = Some(30_000_000);
        contract.last_reconciled_liability = Some(25_000_000);
        contract.last_reconciled_at_ns = Some(NOW);
        assert_eq!(
            contract.get_accounting().reconciliation_status,
            "surplus-or-direct-transfer"
        );
    }
}
