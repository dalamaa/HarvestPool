use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::collections::UnorderedMap;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError,
};
use schemars::JsonSchema;

const MAX_COMMUNITY_MEMBERS: usize = 100;
const MAX_PURCHASES: u64 = 100;
const MAX_PURCHASE_QUANTITY: u32 = 1_000;
const MAX_FUNDED_MEMBERS: u32 = 20;
const MAX_EVIDENCE_HASH_BYTES: usize = 256;
const MAX_ACCOUNT_ID_BYTES: usize = 64;
const FULL_REFUND_BPS: u16 = 10_000;
const CALLBACK_GAS: Gas = Gas::from_tgas(20);
const PURCHASE_CAPACITY_PREFIX: &[u8] = b"harvestpool:v2:purchase-capacity:";

#[derive(BorshSerialize, BorshStorageKey)]
enum StorageKey {
    Purchases,
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
    Proposed,
    Open,
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

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct OfferVote {
    voter: AccountId,
    approve: bool,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct FulfillmentVote {
    voter: AccountId,
    approve: bool,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct Commitment {
    account_id: AccountId,
    quantity: u32,
    amount: u128,
    state: CommitmentState,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct Purchase {
    proposer: AccountId,
    farmer_id: AccountId,
    min_quantity: u32,
    max_quantity: u32,
    price_per_unit: u128,
    deadline_ns: u64,
    cancellation_deadline_ns: u64,
    fulfillment_evidence_deadline_ns: u64,
    cancellation_refund_bps: u16,
    failed_order_refund_bps: u16,
    state: PurchaseState,
    total_quantity: u32,
    total_funded_amount: u128,
    offer_votes: Vec<OfferVote>,
    commitments: Vec<Commitment>,
    fulfillment_evidence_hash: Option<String>,
    fulfillment_votes: Vec<FulfillmentVote>,
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
    pub proposer: String,
    pub farmer_id: String,
    pub min_quantity: u32,
    pub max_quantity: u32,
    pub price_per_unit: String,
    pub deadline_ns: String,
    pub cancellation_deadline_ns: String,
    pub fulfillment_evidence_deadline_ns: String,
    pub cancellation_refund_bps: u16,
    pub failed_order_refund_bps: u16,
    pub state: PurchaseState,
    pub total_quantity: u32,
    pub total_funded_amount: String,
    pub offer_yes_votes: u32,
    pub offer_no_votes: u32,
    pub required_offer_yes_votes: u32,
    pub fulfillment_evidence_hash: Option<String>,
    pub fulfillment_yes_votes: u32,
    pub fulfillment_no_votes: u32,
    pub required_fulfillment_yes_votes: Option<u32>,
    pub open_membership: bool,
    pub max_funded_members: u32,
    pub funded_member_count: u32,
    pub available_funded_member_slots: u32,
    pub commitments: Vec<CommitmentView>,
}

#[derive(JsonSchema, Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct ContractConfigView {
    pub member_count: u32,
    pub required_offer_yes_votes: u32,
    pub max_community_members: u32,
    pub max_purchases: String,
    pub max_purchase_quantity: u32,
    pub max_funded_members: u32,
    pub supports_open_membership: bool,
    pub testnet_only: bool,
}

/// V2 purchase capacity is stored separately so a Phase 1 state can be upgraded without
/// changing the Borsh layout of the existing Contract or Purchase records. Missing metadata means
/// the purchase keeps Phase 1's fixed-membership behavior.
#[derive(BorshDeserialize, BorshSerialize, Clone, Copy)]
struct PurchaseCapacity {
    open_membership: bool,
    max_funded_members: u32,
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
    members: Vec<AccountId>,
    purchases: UnorderedMap<u64, Purchase>,
    next_purchase_id: u64,
}

#[near]
impl Contract {
    /// Initializes an immutable membership set. There is intentionally no owner or organizer
    /// authority in this contract: membership, voting eligibility, and financial rules are fixed
    /// at initialization and enforced by the contract.
    #[init]
    pub fn new(members: Vec<AccountId>) -> Self {
        require!(
            !members.is_empty(),
            "community must have at least one member"
        );
        require!(
            members.len() <= MAX_COMMUNITY_MEMBERS,
            "community exceeds the member limit"
        );

        let mut unique_members = Vec::with_capacity(members.len());
        for member in members {
            require!(
                member.as_str().len() <= MAX_ACCOUNT_ID_BYTES,
                "member account id is too long"
            );
            require!(
                !unique_members.iter().any(|existing| existing == &member),
                "duplicate community member"
            );
            unique_members.push(member);
        }

        Self {
            members: unique_members,
            purchases: UnorderedMap::new(StorageKey::Purchases),
            next_purchase_id: 0,
        }
    }

    /// Creates an offer. The proposer has no special power after creation. Terms are stored in
    /// the purchase and there is deliberately no update method, so approval and commitments
    /// always refer to the same immutable price, quantity, and deadline terms.
    pub fn create_purchase(
        &mut self,
        min_quantity: u32,
        max_quantity: u32,
        price_per_unit: U128,
        deadline_ns: U64,
        cancellation_deadline_ns: U64,
        fulfillment_evidence_deadline_ns: U64,
        farmer_id: AccountId,
    ) -> U64 {
        self.assert_no_attached_deposit();
        let proposer = env::predecessor_account_id();
        self.assert_member(&proposer);
        self.create_purchase_record(
            proposer,
            min_quantity,
            max_quantity,
            price_per_unit,
            deadline_ns,
            cancellation_deadline_ns,
            fulfillment_evidence_deadline_ns,
            farmer_id,
        )
    }

    /// Creates a purchase whose funded membership is open after the fixed community approves the
    /// offer. The proposer must still be an initialized community member so a public link cannot
    /// unilaterally create a pool. Each account becomes a purchase member only after commit
    /// succeeds with the exact attached native-NEAR amount.
    pub fn create_open_purchase(
        &mut self,
        min_quantity: u32,
        max_quantity: u32,
        max_funded_members: u32,
        price_per_unit: U128,
        deadline_ns: U64,
        cancellation_deadline_ns: U64,
        fulfillment_evidence_deadline_ns: U64,
        farmer_id: AccountId,
    ) -> U64 {
        self.assert_no_attached_deposit();
        let proposer = env::predecessor_account_id();
        self.assert_member(&proposer);
        require!(
            max_funded_members > 0,
            "funded-member capacity must be positive"
        );
        require!(
            max_funded_members as usize <= MAX_COMMUNITY_MEMBERS,
            "funded-member capacity exceeds the limit"
        );
        require!(
            max_funded_members <= MAX_FUNDED_MEMBERS,
            "funded-member capacity exceeds the 20-household limit"
        );
        require!(
            max_funded_members <= max_quantity,
            "funded-member capacity exceeds unit capacity"
        );

        let purchase_id = self.create_purchase_record(
            proposer,
            min_quantity,
            max_quantity,
            price_per_unit,
            deadline_ns,
            cancellation_deadline_ns,
            fulfillment_evidence_deadline_ns,
            farmer_id,
        );
        self.save_purchase_capacity(
            purchase_id.0,
            PurchaseCapacity {
                open_membership: true,
                max_funded_members,
            },
        );
        purchase_id
    }

    /// Each community member may cast exactly one immutable offer vote. A 2/3 supermajority of
    /// the fixed community membership opens the purchase for funded commitments.
    pub fn vote_on_offer(&mut self, purchase_id: U64, approve: bool) {
        self.assert_no_attached_deposit();
        let voter = env::predecessor_account_id();
        self.assert_member(&voter);

        let mut purchase = self.load_purchase(purchase_id.0);
        require!(
            purchase.state == PurchaseState::Proposed,
            "offer is not accepting votes"
        );
        require!(
            env::block_timestamp() < purchase.deadline_ns,
            "offer voting deadline has passed"
        );
        require!(
            !purchase.offer_votes.iter().any(|vote| vote.voter == voter),
            "member already voted on this offer"
        );

        purchase.offer_votes.push(OfferVote { voter, approve });
        if count_approvals(&purchase.offer_votes) >= self.required_offer_yes_votes() {
            purchase.state = PurchaseState::Open;
        }
        self.save_purchase(purchase_id.0, purchase);
    }

    /// A commitment is only created by an attached payment. There is no unpaid reservation
    /// state. One account may have at most one commitment for a purchase.
    #[payable]
    pub fn commit(&mut self, purchase_id: U64, quantity: u32) {
        let account_id = env::predecessor_account_id();
        let mut purchase = self.load_purchase(purchase_id.0);
        let capacity = self.load_purchase_capacity(purchase_id.0);

        if !capacity.open_membership {
            self.assert_member(&account_id);
        }

        require!(
            purchase.state == PurchaseState::Open,
            "purchase is not open"
        );
        require!(
            env::block_timestamp() < purchase.deadline_ns,
            "commitment deadline has passed"
        );
        require!(quantity > 0, "quantity must be positive");
        require!(
            (purchase
                .commitments
                .iter()
                .filter(|commitment| commitment.state == CommitmentState::Active)
                .count() as u32)
                < capacity.max_funded_members,
            "funded-member capacity reached"
        );
        require!(
            purchase
                .total_quantity
                .checked_add(quantity)
                .map(|total| total <= purchase.max_quantity)
                .unwrap_or(false),
            "purchase would be oversubscribed"
        );
        require!(
            !purchase
                .commitments
                .iter()
                .any(|commitment| commitment.account_id == account_id),
            "member already has a commitment"
        );

        let amount = purchase
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
        self.save_purchase(purchase_id.0, purchase);
    }

    /// Cancellation is available only during the immutable cancellation window. The refund is
    /// made claimable in state before any outgoing transfer is scheduled.
    pub fn cancel_commitment(&mut self, purchase_id: U64) {
        self.assert_no_attached_deposit();
        let account_id = env::predecessor_account_id();
        let mut purchase = self.load_purchase(purchase_id.0);
        let capacity = self.load_purchase_capacity(purchase_id.0);
        if !capacity.open_membership {
            self.assert_member(&account_id);
        }

        require!(
            purchase.state == PurchaseState::Open,
            "purchase is not open"
        );
        require!(
            env::block_timestamp() <= purchase.cancellation_deadline_ns,
            "cancellation window has closed"
        );

        let commitment = purchase
            .commitments
            .iter_mut()
            .find(|commitment| commitment.account_id == account_id)
            .unwrap_or_else(|| env::panic_str("member has no commitment"));
        require!(
            commitment.state == CommitmentState::Active,
            "commitment is not cancellable"
        );
        let quantity = commitment.quantity;
        let amount = commitment.amount;
        commitment.state = CommitmentState::Refundable;
        purchase.total_quantity = purchase
            .total_quantity
            .checked_sub(quantity)
            .expect("quantity invariant violated");
        purchase.total_funded_amount = purchase
            .total_funded_amount
            .checked_sub(amount)
            .expect("funding invariant violated");
        self.save_purchase(purchase_id.0, purchase);
    }

    /// After the deadline, anyone may finalize the offer. If it was not approved or did not reach
    /// its fixed minimum, every active commitment becomes refundable. Otherwise the purchase is
    /// funded and the farmer still cannot be paid without fulfillment evidence and member votes.
    pub fn finalize_purchase(&mut self, purchase_id: U64) {
        self.assert_no_attached_deposit();
        let mut purchase = self.load_purchase(purchase_id.0);
        require!(
            env::block_timestamp() >= purchase.deadline_ns,
            "purchase deadline has not passed"
        );
        require!(
            purchase.state == PurchaseState::Proposed || purchase.state == PurchaseState::Open,
            "purchase cannot be finalized from its current state"
        );

        if purchase.state == PurchaseState::Open && purchase.total_quantity >= purchase.min_quantity
        {
            purchase.state = PurchaseState::Funded;
        } else {
            purchase.state = PurchaseState::Failed;
            mark_active_commitments_refundable(&mut purchase);
        }
        self.save_purchase(purchase_id.0, purchase);
    }

    /// The farmer is only an evidence submitter; this method does not release money. The evidence
    /// is a bounded public hash/reference and is accepted only while the purchase is funded.
    pub fn submit_fulfillment_evidence(&mut self, purchase_id: U64, evidence_hash: String) {
        self.assert_no_attached_deposit();
        let caller = env::predecessor_account_id();
        let mut purchase = self.load_purchase(purchase_id.0);
        require!(
            caller == purchase.farmer_id,
            "only the named farmer may submit evidence"
        );
        require!(
            purchase.state == PurchaseState::Funded,
            "purchase is not awaiting evidence"
        );
        require!(
            env::block_timestamp() <= purchase.fulfillment_evidence_deadline_ns,
            "fulfillment evidence deadline has passed"
        );
        require!(!evidence_hash.is_empty(), "evidence hash is required");
        require!(
            evidence_hash.as_bytes().len() <= MAX_EVIDENCE_HASH_BYTES,
            "evidence hash is too long"
        );

        purchase.fulfillment_evidence_hash = Some(evidence_hash);
        purchase.state = PurchaseState::FulfillmentPending;
        self.save_purchase(purchase_id.0, purchase);
    }

    /// Only funded household members may vote, and only once each, on the submitted fulfillment
    /// evidence. A 2/3 supermajority of the funded households approves payment.
    pub fn vote_on_fulfillment(&mut self, purchase_id: U64, approve: bool) {
        self.assert_no_attached_deposit();
        let voter = env::predecessor_account_id();
        let mut purchase = self.load_purchase(purchase_id.0);
        require!(
            purchase.state == PurchaseState::FulfillmentPending,
            "fulfillment is not accepting votes"
        );
        require!(
            env::block_timestamp() <= purchase.fulfillment_evidence_deadline_ns,
            "fulfillment voting deadline has passed"
        );
        require!(
            purchase
                .commitments
                .iter()
                .any(|commitment| commitment.account_id == voter
                    && commitment.state == CommitmentState::Active),
            "only funded household members may vote"
        );
        require!(
            !purchase
                .fulfillment_votes
                .iter()
                .any(|vote| vote.voter == voter),
            "member already voted on fulfillment"
        );

        purchase
            .fulfillment_votes
            .push(FulfillmentVote { voter, approve });
        let required = required_fulfillment_votes(&purchase);
        if count_approvals(&purchase.fulfillment_votes) >= required {
            purchase.state = PurchaseState::FulfillmentApproved;
        }
        self.save_purchase(purchase_id.0, purchase);
    }

    /// If the farmer does not submit evidence, or the funded households do not approve it before
    /// the fixed review deadline, anyone may transition the purchase to Failed and unlock refunds.
    pub fn expire_unfulfilled_purchase(&mut self, purchase_id: U64) {
        self.assert_no_attached_deposit();
        let mut purchase = self.load_purchase(purchase_id.0);
        require!(
            env::block_timestamp() > purchase.fulfillment_evidence_deadline_ns,
            "fulfillment review deadline has not passed"
        );
        require!(
            purchase.state == PurchaseState::Funded
                || purchase.state == PurchaseState::FulfillmentPending,
            "purchase is not awaiting fulfillment"
        );
        purchase.state = PurchaseState::Failed;
        mark_active_commitments_refundable(&mut purchase);
        self.save_purchase(purchase_id.0, purchase);
    }

    /// Payment is permissionless after the on-chain evidence vote reaches the required threshold.
    /// The state is locked before the transfer, and a failed transfer returns the purchase to a
    /// retryable approved state without paying twice.
    pub fn release_payment(&mut self, purchase_id: U64) -> Promise {
        self.assert_no_attached_deposit();
        let mut purchase = self.load_purchase(purchase_id.0);
        require!(
            purchase.state == PurchaseState::FulfillmentApproved,
            "fulfillment evidence is not approved"
        );
        let amount = purchase.total_funded_amount;
        let farmer_id = purchase.farmer_id.clone();
        purchase.state = PurchaseState::PaymentPending;
        self.save_purchase(purchase_id.0, purchase);

        Promise::new(farmer_id)
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .resolve_payment(U64(purchase_id.0), U128(amount)),
            )
    }

    /// Pull-based refund. The commitment is marked pending before the transfer, so a second call
    /// cannot create a double payout while the first transfer is in flight.
    pub fn claim_refund(&mut self, purchase_id: U64) -> Promise {
        self.assert_no_attached_deposit();
        let account_id = env::predecessor_account_id();
        let mut purchase = self.load_purchase(purchase_id.0);
        require!(
            purchase.state == PurchaseState::Open || purchase.state == PurchaseState::Failed,
            "purchase is not refundable"
        );

        let commitment = purchase
            .commitments
            .iter_mut()
            .find(|commitment| commitment.account_id == account_id)
            .unwrap_or_else(|| env::panic_str("member has no commitment"));
        require!(
            commitment.state == CommitmentState::Refundable,
            "refund is not claimable"
        );
        let amount = commitment.amount;
        commitment.state = CommitmentState::RefundPending;
        self.save_purchase(purchase_id.0, purchase);

        Promise::new(account_id.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .resolve_refund(U64(purchase_id.0), account_id, U128(amount)),
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
            .find(|commitment| commitment.account_id == account_id)
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
        self.save_purchase(purchase_id.0, purchase);
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
        self.save_purchase(purchase_id.0, purchase);
    }

    pub fn get_purchase(&self, purchase_id: U64) -> Option<PurchaseView> {
        self.purchases
            .get(&purchase_id.0)
            .map(|purchase| self.purchase_view(purchase_id.0, &purchase))
    }

    pub fn get_purchase_count(&self) -> U64 {
        U64(self.next_purchase_id)
    }

    pub fn get_members(&self) -> Vec<AccountId> {
        self.members.clone()
    }

    pub fn get_funded_members(&self, purchase_id: U64) -> Vec<AccountId> {
        self.load_purchase(purchase_id.0)
            .commitments
            .into_iter()
            .filter(|commitment| commitment.state == CommitmentState::Active)
            .map(|commitment| commitment.account_id)
            .collect()
    }

    pub fn is_funded_member(&self, purchase_id: U64, account_id: AccountId) -> bool {
        self.load_purchase(purchase_id.0)
            .commitments
            .iter()
            .any(|commitment| {
                commitment.account_id == account_id && commitment.state == CommitmentState::Active
            })
    }

    /// Returns the caller's recorded offer vote, when one exists. This is a read-only projection
    /// of the immutable on-chain vote record so clients do not need browser storage to decide
    /// whether the caller may still vote.
    pub fn get_offer_vote(&self, purchase_id: U64, account_id: AccountId) -> Option<bool> {
        self.load_purchase(purchase_id.0)
            .offer_votes
            .into_iter()
            .find(|vote| vote.voter == account_id)
            .map(|vote| vote.approve)
    }

    /// Returns the caller's recorded fulfillment vote, when one exists.
    pub fn get_fulfillment_vote(&self, purchase_id: U64, account_id: AccountId) -> Option<bool> {
        self.load_purchase(purchase_id.0)
            .fulfillment_votes
            .into_iter()
            .find(|vote| vote.voter == account_id)
            .map(|vote| vote.approve)
    }

    pub fn is_member(&self, account_id: AccountId) -> bool {
        self.is_member_internal(&account_id)
    }

    pub fn get_config(&self) -> ContractConfigView {
        ContractConfigView {
            member_count: self.members.len() as u32,
            required_offer_yes_votes: self.required_offer_yes_votes(),
            max_community_members: MAX_COMMUNITY_MEMBERS as u32,
            max_purchases: MAX_PURCHASES.to_string(),
            max_purchase_quantity: MAX_PURCHASE_QUANTITY,
            max_funded_members: MAX_FUNDED_MEMBERS,
            supports_open_membership: true,
            testnet_only: true,
        }
    }

    fn create_purchase_record(
        &mut self,
        proposer: AccountId,
        min_quantity: u32,
        max_quantity: u32,
        price_per_unit: U128,
        deadline_ns: U64,
        cancellation_deadline_ns: U64,
        fulfillment_evidence_deadline_ns: U64,
        farmer_id: AccountId,
    ) -> U64 {
        require!(
            self.next_purchase_id < MAX_PURCHASES,
            "purchase limit reached"
        );
        require!(min_quantity > 0, "minimum order must be positive");
        require!(
            max_quantity >= min_quantity,
            "maximum must be at least minimum"
        );
        require!(
            max_quantity <= MAX_PURCHASE_QUANTITY,
            "maximum order exceeds the limit"
        );
        require!(price_per_unit.0 > 0, "price must be positive");

        let now = env::block_timestamp();
        require!(deadline_ns.0 > now, "deadline must be in the future");
        require!(
            cancellation_deadline_ns.0 <= deadline_ns.0,
            "cancellation deadline must not exceed purchase deadline"
        );
        require!(
            fulfillment_evidence_deadline_ns.0 > deadline_ns.0,
            "fulfillment deadline must be after purchase deadline"
        );
        require!(
            fulfillment_evidence_deadline_ns
                .0
                .checked_sub(deadline_ns.0)
                .expect("checked above")
                <= 30 * 24 * 60 * 60 * 1_000_000_000,
            "fulfillment review window is too long"
        );

        let purchase_id = self.next_purchase_id;
        self.next_purchase_id = self
            .next_purchase_id
            .checked_add(1)
            .expect("purchase id overflow");

        self.purchases.insert(
            &purchase_id,
            &Purchase {
                proposer,
                farmer_id,
                min_quantity,
                max_quantity,
                price_per_unit: price_per_unit.0,
                deadline_ns: deadline_ns.0,
                cancellation_deadline_ns: cancellation_deadline_ns.0,
                fulfillment_evidence_deadline_ns: fulfillment_evidence_deadline_ns.0,
                cancellation_refund_bps: FULL_REFUND_BPS,
                failed_order_refund_bps: FULL_REFUND_BPS,
                state: PurchaseState::Proposed,
                total_quantity: 0,
                total_funded_amount: 0,
                offer_votes: Vec::new(),
                commitments: Vec::new(),
                fulfillment_evidence_hash: None,
                fulfillment_votes: Vec::new(),
            },
        );

        U64(purchase_id)
    }

    fn load_purchase(&self, purchase_id: u64) -> Purchase {
        self.purchases
            .get(&purchase_id)
            .unwrap_or_else(|| env::panic_str("purchase does not exist"))
    }

    fn save_purchase(&mut self, purchase_id: u64, purchase: Purchase) {
        self.purchases.insert(&purchase_id, &purchase);
    }

    fn purchase_view(&self, id: u64, purchase: &Purchase) -> PurchaseView {
        let funded_member_count = purchase
            .commitments
            .iter()
            .filter(|commitment| commitment.state == CommitmentState::Active)
            .count() as u32;
        let capacity = self.load_purchase_capacity(id);

        PurchaseView {
            id: id.to_string(),
            proposer: purchase.proposer.to_string(),
            farmer_id: purchase.farmer_id.to_string(),
            min_quantity: purchase.min_quantity,
            max_quantity: purchase.max_quantity,
            price_per_unit: purchase.price_per_unit.to_string(),
            deadline_ns: purchase.deadline_ns.to_string(),
            cancellation_deadline_ns: purchase.cancellation_deadline_ns.to_string(),
            fulfillment_evidence_deadline_ns: purchase.fulfillment_evidence_deadline_ns.to_string(),
            cancellation_refund_bps: purchase.cancellation_refund_bps,
            failed_order_refund_bps: purchase.failed_order_refund_bps,
            state: purchase.state,
            total_quantity: purchase.total_quantity,
            total_funded_amount: purchase.total_funded_amount.to_string(),
            offer_yes_votes: count_approvals(&purchase.offer_votes),
            offer_no_votes: count_rejections(&purchase.offer_votes),
            required_offer_yes_votes: self.required_offer_yes_votes(),
            fulfillment_evidence_hash: purchase.fulfillment_evidence_hash.clone(),
            fulfillment_yes_votes: count_approvals(&purchase.fulfillment_votes),
            fulfillment_no_votes: count_rejections(&purchase.fulfillment_votes),
            required_fulfillment_yes_votes: if funded_member_count == 0 {
                None
            } else {
                Some(required_fulfillment_votes(purchase))
            },
            open_membership: capacity.open_membership,
            max_funded_members: capacity.max_funded_members,
            funded_member_count,
            available_funded_member_slots: capacity
                .max_funded_members
                .saturating_sub(funded_member_count),
            commitments: purchase
                .commitments
                .iter()
                .map(|commitment| CommitmentView {
                    account_id: commitment.account_id.to_string(),
                    quantity: commitment.quantity,
                    amount: commitment.amount.to_string(),
                    state: commitment.state,
                })
                .collect(),
        }
    }

    fn required_offer_yes_votes(&self) -> u32 {
        ceil_two_thirds(self.members.len() as u32)
    }

    fn assert_member(&self, account_id: &AccountId) {
        require!(
            self.is_member_internal(account_id),
            "caller is not an eligible community member"
        );
    }

    fn is_member_internal(&self, account_id: &AccountId) -> bool {
        self.members.iter().any(|member| member == account_id)
    }

    fn assert_no_attached_deposit(&self) {
        require!(
            env::attached_deposit().is_zero(),
            "this method does not accept an attached deposit"
        );
    }

    fn load_purchase_capacity(&self, purchase_id: u64) -> PurchaseCapacity {
        env::storage_read(&purchase_capacity_key(purchase_id))
            .and_then(|bytes| PurchaseCapacity::try_from_slice(&bytes).ok())
            .unwrap_or(PurchaseCapacity {
                open_membership: false,
                max_funded_members: self.members.len() as u32,
            })
    }

    fn save_purchase_capacity(&self, purchase_id: u64, capacity: PurchaseCapacity) {
        let bytes = borsh::to_vec(&capacity).expect("purchase capacity serialization failed");
        env::storage_write(&purchase_capacity_key(purchase_id), &bytes);
    }
}

fn purchase_capacity_key(purchase_id: u64) -> Vec<u8> {
    let mut key = PURCHASE_CAPACITY_PREFIX.to_vec();
    key.extend_from_slice(&purchase_id.to_le_bytes());
    key
}

fn mark_active_commitments_refundable(purchase: &mut Purchase) {
    for commitment in &mut purchase.commitments {
        if commitment.state == CommitmentState::Active {
            commitment.state = CommitmentState::Refundable;
        }
    }
}

fn count_approvals(votes: &[impl VoteApproval]) -> u32 {
    votes.iter().filter(|vote| vote.approve()).count() as u32
}

trait VoteApproval {
    fn approve(&self) -> bool;
}

impl VoteApproval for OfferVote {
    fn approve(&self) -> bool {
        self.approve
    }
}

impl VoteApproval for FulfillmentVote {
    fn approve(&self) -> bool {
        self.approve
    }
}

fn count_rejections(votes: &[impl VoteApproval]) -> u32 {
    votes.iter().filter(|vote| !vote.approve()).count() as u32
}

fn required_fulfillment_votes(purchase: &Purchase) -> u32 {
    let funded_members = purchase
        .commitments
        .iter()
        .filter(|commitment| commitment.state == CommitmentState::Active)
        .count() as u32;
    ceil_two_thirds(funded_members)
}

fn ceil_two_thirds(value: u32) -> u32 {
    value.saturating_mul(2).saturating_add(2) / 3
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    const NOW: u64 = 1_000_000_000_000;
    const DAY: u64 = 24 * 60 * 60 * 1_000_000_000;
    const PRICE: u128 = 5 * 10u128.pow(24);

    fn context(account: AccountId, timestamp: u64, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(5))
            .predecessor_account_id(account)
            .block_timestamp(timestamp)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build());
    }

    fn contract() -> Contract {
        context(accounts(0), NOW, 0);
        Contract::new(vec![accounts(0), accounts(1), accounts(2)])
    }

    fn create_open_purchase(contract: &mut Contract) -> u64 {
        context(accounts(0), NOW, 0);
        let id = contract.create_purchase(
            2,
            3,
            U128(PRICE),
            U64(NOW + DAY),
            U64(NOW + DAY),
            U64(NOW + 2 * DAY),
            accounts(3),
        );
        for member in [accounts(0), accounts(1)] {
            context(member, NOW + 1, 0);
            contract.vote_on_offer(id, true);
        }
        id.0
    }

    fn create_open_purchase_with_capacity(
        contract: &mut Contract,
        max_quantity: u32,
        max_funded_members: u32,
    ) -> u64 {
        context(accounts(0), NOW, 0);
        let id = contract.create_open_purchase(
            1,
            max_quantity,
            max_funded_members,
            U128(PRICE),
            U64(NOW + DAY),
            U64(NOW + DAY),
            U64(NOW + 2 * DAY),
            accounts(3),
        );
        for member in [accounts(0), accounts(1)] {
            context(member, NOW + 1, 0);
            contract.vote_on_offer(id, true);
        }
        id.0
    }

    #[test]
    fn only_funded_commitments_count_and_duplicate_is_rejected() {
        let mut contract = contract();
        let id = create_open_purchase(&mut contract);

        context(accounts(0), NOW + 2, PRICE);
        contract.commit(U64(id), 1);
        let view = contract.get_purchase(U64(id)).unwrap();
        assert_eq!(view.total_quantity, 1);
        assert_eq!(view.total_funded_amount, PRICE.to_string());

        context(accounts(0), NOW + 3, PRICE);
        let duplicate =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| contract.commit(U64(id), 1)));
        assert!(duplicate.is_err());
    }

    #[test]
    fn oversubscription_and_wrong_payment_are_rejected() {
        let mut contract = contract();
        let id = create_open_purchase(&mut contract);

        context(accounts(0), NOW + 2, PRICE - 1);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.commit(U64(id), 1)
        }))
        .is_err());

        context(accounts(0), NOW + 3, PRICE * 2);
        contract.commit(U64(id), 2);
        context(accounts(1), NOW + 4, PRICE * 2);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.commit(U64(id), 2)
        }))
        .is_err());
    }

    #[test]
    fn open_membership_separates_unit_capacity_from_funded_household_capacity() {
        let mut contract = contract();
        let id = create_open_purchase_with_capacity(&mut contract, 100, 2);

        context(accounts(3), NOW + 2, PRICE * 10);
        contract.commit(U64(id), 10);
        context(accounts(4), NOW + 3, PRICE * 10);
        contract.commit(U64(id), 10);

        let view = contract.get_purchase(U64(id)).unwrap();
        assert!(view.open_membership);
        assert_eq!(view.max_quantity, 100);
        assert_eq!(view.total_quantity, 20);
        assert_eq!(view.funded_member_count, 2);
        assert_eq!(view.available_funded_member_slots, 0);

        context(accounts(5), NOW + 4, PRICE);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.commit(U64(id), 1)
        }))
        .is_err());
    }

    #[test]
    fn open_purchase_caps_funded_households_at_twenty() {
        let mut contract = contract();
        context(accounts(0), NOW, 0);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.create_open_purchase(
                20,
                25,
                21,
                U128(PRICE),
                U64(NOW + DAY),
                U64(NOW + DAY),
                U64(NOW + 2 * DAY),
                accounts(3),
            )
        }));
        assert!(result.is_err());
        assert_eq!(contract.get_config().max_funded_members, 20);
    }

    #[test]
    fn open_member_can_cancel_and_reclaim_a_funded_spot() {
        let mut contract = contract();
        let id = create_open_purchase_with_capacity(&mut contract, 10, 2);

        context(accounts(3), NOW + 2, PRICE);
        contract.commit(U64(id), 1);
        context(accounts(3), NOW + 3, 0);
        contract.cancel_commitment(U64(id));

        let view = contract.get_purchase(U64(id)).unwrap();
        assert_eq!(view.total_quantity, 0);
        assert_eq!(view.available_funded_member_slots, 2);
        assert_eq!(view.commitments[0].state, CommitmentState::Refundable);
    }

    #[test]
    fn unfunded_account_cannot_vote_on_fulfillment() {
        let mut contract = contract();
        let id = create_open_purchase_with_capacity(&mut contract, 2, 2);

        context(accounts(3), NOW + 2, PRICE);
        contract.commit(U64(id), 1);
        context(accounts(0), NOW + DAY, 0);
        contract.finalize_purchase(U64(id));
        context(accounts(3), NOW + DAY + 1, 0);
        contract.submit_fulfillment_evidence(U64(id), "delivery-hash".to_string());

        context(accounts(4), NOW + DAY + 2, 0);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.vote_on_fulfillment(U64(id), true)
        }))
        .is_err());
    }

    #[test]
    fn offer_requires_two_thirds_and_nonmember_cannot_vote() {
        let mut contract = contract();
        context(accounts(0), NOW, 0);
        let id = contract.create_purchase(
            1,
            2,
            U128(PRICE),
            U64(NOW + DAY),
            U64(NOW + DAY),
            U64(NOW + 2 * DAY),
            accounts(3),
        );
        context(accounts(3), NOW + 1, 0);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.vote_on_offer(id, true)
        }))
        .is_err());

        context(accounts(0), NOW + 1, 0);
        contract.vote_on_offer(id, true);
        assert_eq!(contract.get_offer_vote(id, accounts(0)), Some(true));
        assert_eq!(contract.get_offer_vote(id, accounts(1)), None);
        let view = contract.get_purchase(id).unwrap();
        assert_eq!(view.state, PurchaseState::Proposed);
        context(accounts(1), NOW + 1, 0);
        contract.vote_on_offer(id, true);
        assert_eq!(contract.get_offer_vote(id, accounts(1)), Some(true));
        assert_eq!(
            contract.get_purchase(id).unwrap().state,
            PurchaseState::Open
        );
        context(accounts(2), NOW + 1, 0);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.vote_on_offer(id, true)
        }))
        .is_err());
    }

    #[test]
    fn cancellation_makes_exact_refund_claimable_and_cannot_repeat() {
        let mut contract = contract();
        let id = create_open_purchase(&mut contract);
        context(accounts(0), NOW + 2, PRICE);
        contract.commit(U64(id), 1);
        context(accounts(0), NOW + 3, 0);
        contract.cancel_commitment(U64(id));
        let view = contract.get_purchase(U64(id)).unwrap();
        assert_eq!(view.commitments[0].state, CommitmentState::Refundable);
        assert_eq!(view.total_quantity, 0);

        context(accounts(0), NOW + 4, 0);
        let _promise = contract.claim_refund(U64(id));
        assert_eq!(
            contract.get_purchase(U64(id)).unwrap().commitments[0].state,
            CommitmentState::RefundPending
        );
        context(accounts(0), NOW + 5, 0);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.claim_refund(U64(id))
        }))
        .is_err());
    }

    #[test]
    fn failed_order_refunds_all_active_commitments() {
        let mut contract = contract();
        let id = create_open_purchase(&mut contract);
        context(accounts(0), NOW + 2, PRICE);
        contract.commit(U64(id), 1);
        context(accounts(0), NOW + DAY, 0);
        contract.finalize_purchase(U64(id));
        assert_eq!(
            contract.get_purchase(U64(id)).unwrap().state,
            PurchaseState::Failed
        );
        assert!(contract
            .get_purchase(U64(id))
            .unwrap()
            .commitments
            .iter()
            .all(|commitment| commitment.state == CommitmentState::Refundable));
    }

    #[test]
    fn fulfillment_needs_funded_household_supermajority() {
        let mut contract = contract();
        let id = create_open_purchase(&mut contract);
        for (member, quantity) in [(accounts(0), 1), (accounts(1), 1)] {
            context(member, NOW + 2, PRICE * quantity as u128);
            contract.commit(U64(id), quantity);
        }
        context(accounts(0), NOW + DAY, 0);
        contract.finalize_purchase(U64(id));
        context(accounts(3), NOW + DAY + 1, 0);
        contract.submit_fulfillment_evidence(U64(id), "delivery-hash".to_string());

        context(accounts(0), NOW + DAY + 2, 0);
        contract.vote_on_fulfillment(U64(id), true);
        assert_eq!(
            contract.get_purchase(U64(id)).unwrap().state,
            PurchaseState::FulfillmentPending
        );
        context(accounts(1), NOW + DAY + 3, 0);
        contract.vote_on_fulfillment(U64(id), true);
        assert_eq!(
            contract.get_purchase(U64(id)).unwrap().state,
            PurchaseState::FulfillmentApproved
        );
    }

    #[test]
    fn invalid_transitions_and_unauthorized_evidence_are_rejected() {
        let mut contract = contract();
        let id = create_open_purchase(&mut contract);
        context(accounts(0), NOW + 1, 0);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.release_payment(U64(id))
        }))
        .is_err());
        context(accounts(0), NOW + 2, PRICE);
        contract.commit(U64(id), 1);
        context(accounts(0), NOW + DAY, 0);
        contract.finalize_purchase(U64(id));
        context(accounts(0), NOW + DAY + 1, 0);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.submit_fulfillment_evidence(U64(id), "hash".to_string())
        }))
        .is_err());
    }

    #[test]
    fn failed_payment_callback_restores_retryable_approved_state() {
        let mut contract = contract();
        let id = create_open_purchase(&mut contract);
        for member in [accounts(0), accounts(1)] {
            context(member, NOW + 2, PRICE);
            contract.commit(U64(id), 1);
        }
        context(accounts(0), NOW + DAY, 0);
        contract.finalize_purchase(U64(id));
        context(accounts(3), NOW + DAY + 1, 0);
        contract.submit_fulfillment_evidence(U64(id), "hash".to_string());
        for member in [accounts(0), accounts(1)] {
            context(member, NOW + DAY + 2, 0);
            contract.vote_on_fulfillment(U64(id), true);
        }
        context(accounts(0), NOW + DAY + 3, 0);
        let _promise = contract.release_payment(U64(id));
        assert_eq!(
            contract.get_purchase(U64(id)).unwrap().state,
            PurchaseState::PaymentPending
        );
        context(accounts(5), NOW + DAY + 4, 0);
        contract.resolve_payment(U64(id), U128(PRICE * 2), Err(PromiseError::Failed));
        assert_eq!(
            contract.get_purchase(U64(id)).unwrap().state,
            PurchaseState::FulfillmentApproved
        );
    }

    #[test]
    fn successful_payment_callback_is_terminal() {
        let mut contract = contract();
        let id = create_open_purchase(&mut contract);
        for member in [accounts(0), accounts(1)] {
            context(member, NOW + 2, PRICE);
            contract.commit(U64(id), 1);
        }
        context(accounts(0), NOW + DAY, 0);
        contract.finalize_purchase(U64(id));
        context(accounts(3), NOW + DAY + 1, 0);
        contract.submit_fulfillment_evidence(U64(id), "hash".to_string());
        for member in [accounts(0), accounts(1)] {
            context(member, NOW + DAY + 2, 0);
            contract.vote_on_fulfillment(U64(id), true);
        }
        context(accounts(0), NOW + DAY + 3, 0);
        let _promise = contract.release_payment(U64(id));
        context(accounts(5), NOW + DAY + 4, 0);
        contract.resolve_payment(U64(id), U128(PRICE * 2), Ok(()));
        assert_eq!(
            contract.get_purchase(U64(id)).unwrap().state,
            PurchaseState::Completed
        );
    }
}
