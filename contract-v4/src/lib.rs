use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::collections::UnorderedMap;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError,
};
use schemars::JsonSchema;

const MAX_PURCHASES: u64 = 500;
const MAX_QUANTITY: u32 = 10_000;
const MAX_FUNDED_MEMBERS: u32 = 20;
const MAX_TEXT_BYTES: usize = 2_000;
const MAX_SHORT_TEXT_BYTES: usize = 160;
const MAX_EVIDENCE_BYTES: usize = 256;
const MAX_FULFILLMENT_WINDOW_NS: u64 = 30 * 24 * 60 * 60 * 1_000_000_000;
const CALLBACK_GAS: Gas = Gas::from_tgas(20);
const PILOT_SUPPLIER: &str = "harvestpool-farmer-1.testnet";

#[derive(BorshSerialize, BorshStorageKey)]
enum StorageKey {
    Purchases,
    Suppliers,
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
    pub testnet_only: bool,
    pub max_funded_members: u32,
    pub supplier_verification: String,
}

#[ext_contract(ext_self)]
trait ExtSelf {
    fn resolve_refund(
        &mut self,
        purchase_id: U64,
        account_id: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    );
    fn resolve_payment(
        &mut self,
        purchase_id: U64,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    );
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    purchases: UnorderedMap<u64, Purchase>,
    suppliers: UnorderedMap<AccountId, SupplierProfile>,
    supplier_ids: Vec<AccountId>,
    next_purchase_id: u64,
}

#[near]
impl Contract {
    #[init]
    pub fn new(suppliers: Vec<SupplierProfileInput>) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "initialization must be signed by the contract account"
        );
        require!(
            !suppliers.is_empty(),
            "at least one pilot supplier is required"
        );
        let mut contract = Self {
            purchases: UnorderedMap::new(StorageKey::Purchases),
            suppliers: UnorderedMap::new(StorageKey::Suppliers),
            supplier_ids: Vec::new(),
            next_purchase_id: 0,
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

    #[payable]
    pub fn commit(&mut self, purchase_id: U64, quantity: u32) {
        let account_id = env::predecessor_account_id();
        let mut purchase = self.load(purchase_id.0);
        require!(
            purchase.state == PurchaseState::Open,
            "purchase is not open"
        );
        require!(
            purchase.supplier_agreement.is_some(),
            "supplier agreement is missing"
        );
        require!(
            account_id != purchase.supplier_id,
            "supplier cannot fund or vote on its own purchase"
        );
        require!(
            env::block_timestamp() < purchase.terms.join_deadline_ns,
            "join deadline has passed"
        );
        require!(
            quantity > 0 && quantity <= purchase.terms.max_quantity_per_household,
            "quantity exceeds the household limit"
        );
        require!(
            !purchase
                .commitments
                .iter()
                .any(|c| c.account_id == account_id),
            "account already has a commitment"
        );
        require!(
            active_member_count(&purchase) < purchase.terms.max_funded_members,
            "funded household capacity reached"
        );
        require!(
            purchase
                .total_quantity
                .checked_add(quantity)
                .map(|v| v <= purchase.terms.max_quantity)
                .unwrap_or(false),
            "purchase would be oversubscribed"
        );
        let amount = purchase
            .terms
            .price_per_unit
            .checked_mul(quantity as u128)
            .expect("commitment amount overflow");
        require!(
            env::attached_deposit().as_yoctonear() == amount,
            "attached deposit must exactly equal price times quantity"
        );
        purchase.total_quantity = purchase
            .total_quantity
            .checked_add(quantity)
            .expect("quantity overflow");
        purchase.total_funded_amount = purchase
            .total_funded_amount
            .checked_add(amount)
            .expect("funding overflow");
        purchase.commitments.push(Commitment {
            account_id,
            quantity,
            amount,
            state: CommitmentState::Active,
        });
        self.save(purchase_id.0, purchase);
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
        Promise::new(supplier_id)
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .resolve_payment(purchase_id, U128(amount)),
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
        Promise::new(account_id.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .resolve_refund(purchase_id, account_id, U128(amount)),
            )
    }

    #[private]
    pub fn resolve_refund(
        &mut self,
        purchase_id: U64,
        account_id: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        let Some(mut purchase) = self.purchases.get(&purchase_id.0) else {
            return;
        };
        let Some(commitment) = purchase
            .commitments
            .iter_mut()
            .find(|c| c.account_id == account_id)
        else {
            return;
        };
        if commitment.state != CommitmentState::RefundPending || commitment.amount != amount.0 {
            return;
        }
        commitment.state = if result.is_ok() {
            CommitmentState::Refunded
        } else {
            CommitmentState::Refundable
        };
        self.save(purchase_id.0, purchase);
    }

    #[private]
    pub fn resolve_payment(
        &mut self,
        purchase_id: U64,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        let Some(mut purchase) = self.purchases.get(&purchase_id.0) else {
            return;
        };
        if purchase.state != PurchaseState::PaymentPending
            || purchase.total_funded_amount != amount.0
        {
            return;
        }
        purchase.state = if result.is_ok() {
            PurchaseState::Completed
        } else {
            PurchaseState::FulfillmentApproved
        };
        self.save(purchase_id.0, purchase);
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

    pub fn get_config(&self) -> ContractConfigView {
        ContractConfigView {
            version: "V4".to_string(),
            lifecycle: "supplier-authorized-no-offer-vote".to_string(),
            payment_asset: "native-testnet-near".to_string(),
            testnet_only: true,
            max_funded_members: MAX_FUNDED_MEMBERS,
            supplier_verification: "controlled-pilot-allowlist".to_string(),
        }
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
            version: "V4".to_string(),
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
    const PRICE: u128 = 10u128.pow(23);

    fn pilot() -> AccountId {
        PILOT_SUPPLIER.parse().unwrap()
    }
    fn context(caller: AccountId, time: u64, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(5))
            .predecessor_account_id(caller)
            .block_timestamp(time)
            .block_height(77)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build());
    }
    fn contract() -> Contract {
        context(accounts(5), NOW, 0);
        Contract::new(vec![SupplierProfileInput {
            account_id: pilot(),
            business_name: "Prairie Family Farm".into(),
            location: "Illinois".into(),
            public_contact: "farm@example.test".into(),
        }])
    }
    fn terms() -> PurchaseTermsInput {
        PurchaseTermsInput {
            product_name: "Family beef box".into(),
            description: "Twenty-pound mixed box".into(),
            quantity_unit: "box".into(),
            price_per_unit: U128(PRICE),
            listed_price_usd_cents: U64(12500),
            min_quantity: 2,
            max_quantity: 4,
            max_quantity_per_household: 2,
            max_funded_members: 4,
            pickup_or_delivery: "Saturday pickup".into(),
            join_deadline_ns: U64(NOW + DAY),
            fulfillment_deadline_ns: U64(NOW + 2 * DAY),
            cancellation_and_refund_terms:
                "Full refund if the group misses its target or the supplier does not fulfill."
                    .into(),
        }
    }

    #[test]
    fn supplier_offer_opens_immediately_with_agreement() {
        let mut c = contract();
        context(pilot(), NOW + 1, 0);
        let id = c.create_supplier_offer(terms());
        let view = c.get_purchase(id).unwrap();
        assert_eq!(view.state, PurchaseState::Open);
        assert_eq!(view.supplier_agreement.unwrap().terms_hash, view.terms_hash);
    }

    #[test]
    fn supplier_cannot_fund_or_vote_on_own_fulfillment() {
        let mut c = contract();
        context(pilot(), NOW + 1, 0);
        let id = c.create_supplier_offer(terms());
        context(pilot(), NOW + 2, PRICE);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.commit(id, 1))).is_err()
        );
    }

    #[test]
    fn timely_cancellation_remains_refundable_after_group_succeeds() {
        let mut c = contract();
        context(pilot(), NOW + 1, 0);
        let id = c.create_supplier_offer(terms());
        context(accounts(0), NOW + 2, PRICE);
        c.commit(id, 1);
        context(accounts(1), NOW + 3, PRICE * 2);
        c.commit(id, 2);
        context(accounts(0), NOW + 4, 0);
        c.cancel_commitment(id);
        context(accounts(2), NOW + DAY, 0);
        c.finalize_purchase(id);
        assert_eq!(c.get_purchase(id).unwrap().state, PurchaseState::Funded);

        context(accounts(0), NOW + DAY + 1, 0);
        let _ = c.claim_refund(id);
        assert_eq!(
            c.get_purchase(id).unwrap().commitments[0].state,
            CommitmentState::RefundPending
        );
        context(accounts(5), NOW + DAY + 2, 0);
        c.resolve_refund(id, accounts(0), U128(PRICE), Ok(()));
        let view = c.get_purchase(id).unwrap();
        assert_eq!(view.state, PurchaseState::Funded);
        assert_eq!(view.commitments[0].state, CommitmentState::Refunded);
        assert_eq!(view.total_funded_amount, (PRICE * 2).to_string());
    }

    #[test]
    fn agreement_fingerprint_is_bound_to_purchase_id() {
        let mut c = contract();
        context(pilot(), NOW + 1, 0);
        let first = c.create_supplier_offer(terms());
        let second = c.create_supplier_offer(terms());
        let first_view = c.get_purchase(first).unwrap();
        let second_view = c.get_purchase(second).unwrap();
        assert_ne!(first_view.terms_hash, second_view.terms_hash);
        assert_eq!(first_view.supplier_agreement.unwrap().purchase_id, "0");
        assert_eq!(second_view.supplier_agreement.unwrap().purchase_id, "1");
    }

    #[test]
    fn organizer_request_needs_actual_supplier_signature() {
        let mut c = contract();
        context(accounts(0), NOW + 1, 0);
        let id = c.create_purchase_request(pilot(), terms());
        assert_eq!(
            c.get_purchase(id).unwrap().state,
            PurchaseState::AwaitingSupplier
        );
        context(accounts(1), NOW + 2, 0);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || c.accept_supplier_request(id)
        ))
        .is_err());
        context(pilot(), NOW + 3, 0);
        c.accept_supplier_request(id);
        assert_eq!(c.get_purchase(id).unwrap().state, PurchaseState::Open);
    }

    #[test]
    fn no_offer_vote_and_only_paid_members_vote_on_fulfillment() {
        let mut c = contract();
        context(pilot(), NOW + 1, 0);
        let id = c.create_supplier_offer(terms());
        context(accounts(0), NOW + 2, PRICE);
        c.commit(id, 1);
        context(accounts(1), NOW + 3, PRICE);
        c.commit(id, 1);
        context(accounts(2), NOW + DAY, 0);
        c.finalize_purchase(id);
        context(pilot(), NOW + DAY + 1, 0);
        c.submit_fulfillment_evidence(id, "sha256:delivery".into());
        context(accounts(2), NOW + DAY + 2, 0);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || c.vote_on_fulfillment(id, true)
        ))
        .is_err());
        for member in [accounts(0), accounts(1)] {
            context(member, NOW + DAY + 3, 0);
            c.vote_on_fulfillment(id, true);
        }
        assert_eq!(
            c.get_purchase(id).unwrap().state,
            PurchaseState::FulfillmentApproved
        );
    }

    #[test]
    fn last_minute_cancellation_reopens_capacity_and_failed_group_refunds() {
        let mut c = contract();
        context(pilot(), NOW + 1, 0);
        let id = c.create_supplier_offer(terms());
        context(accounts(0), NOW + 2, PRICE);
        c.commit(id, 1);
        context(accounts(0), NOW + DAY - 1, 0);
        c.cancel_commitment(id);
        let view = c.get_purchase(id).unwrap();
        assert_eq!(view.total_quantity, 0);
        assert_eq!(view.available_funded_member_slots, 4);
        context(accounts(1), NOW + DAY, 0);
        c.finalize_purchase(id);
        assert_eq!(c.get_purchase(id).unwrap().state, PurchaseState::Failed);
    }

    #[test]
    fn exact_payment_and_household_limit_are_enforced() {
        let mut c = contract();
        context(pilot(), NOW + 1, 0);
        let id = c.create_supplier_offer(terms());
        context(accounts(0), NOW + 2, PRICE - 1);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.commit(id, 1))).is_err()
        );
        context(accounts(0), NOW + 3, PRICE * 3);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.commit(id, 3))).is_err()
        );
    }
}
