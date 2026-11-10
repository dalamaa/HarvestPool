use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::collections::UnorderedMap;
use near_sdk::json_types::U64;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError,
};
use schemars::JsonSchema;

const MAX_ACTIVE_ISSUES_PER_PURCHASE: usize = 20;
const MAX_ISSUE_SUBJECT_BYTES: usize = 120;
const MAX_ISSUE_DESCRIPTION_BYTES: usize = 2_000;
const MAX_SOLUTION_BYTES: usize = 1_000;
const MAX_PROPOSAL_BYTES: usize = 500;
const MAX_OPTION_BYTES: usize = 120;
const MAX_OPTIONS: usize = 4;
const MAX_VOTERS: usize = 20;
const DECISION_WINDOW_MAX_NS: u64 = 30 * 24 * 60 * 60 * 1_000_000_000;
const CROSS_CALL_GAS: Gas = Gas::from_tgas(25);
const CALLBACK_GAS: Gas = Gas::from_tgas(25);

#[derive(BorshSerialize, BorshStorageKey)]
enum StorageKey {
    Issues,
    Decisions,
    PendingIssueChecks,
    PendingDecisionChecks,
    PendingResolutionChecks,
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
pub enum IssueState {
    Open,
    NeedsGroupDecision,
    Resolved,
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
pub enum DecisionState {
    Open,
    AwaitingSupplier,
    Approved,
    Rejected,
    NoConsensus,
    Expired,
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
pub enum VoteType {
    YesNo,
    MultipleChoice,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct Issue {
    purchase_id: u64,
    raised_by: AccountId,
    subject: String,
    description: String,
    suggested_solution: Option<String>,
    state: IssueState,
    active_decision_id: Option<u64>,
    created_at_ns: u64,
    resolved_at_ns: Option<u64>,
    resolved_by: Option<AccountId>,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct DecisionVote {
    voter: AccountId,
    option: u8,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct Decision {
    issue_id: u64,
    purchase_id: u64,
    decision_type: String,
    vote_type: VoteType,
    proposal: String,
    options: Vec<String>,
    deadline_ns: u64,
    opened_at_ns: u64,
    eligible_voters: Vec<AccountId>,
    required_yes_votes: u32,
    votes: Vec<DecisionVote>,
    state: DecisionState,
    selected_option: Option<u8>,
    supplier_id: AccountId,
    requires_supplier_consent: bool,
    supplier_agreed: bool,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct PendingIssueCheck {
    purchase_id: u64,
    requester: AccountId,
    subject: String,
    description: String,
    suggested_solution: Option<String>,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct PendingDecisionCheck {
    issue_id: u64,
    requester: AccountId,
    decision_type: String,
    vote_type: VoteType,
    proposal: String,
    options: Vec<String>,
    deadline_ns: u64,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct PendingResolutionCheck {
    issue_id: u64,
    requester: AccountId,
}

#[derive(JsonSchema, Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct IssueView {
    pub id: String,
    pub purchase_id: String,
    pub raised_by: String,
    pub subject: String,
    pub description: String,
    pub suggested_solution: Option<String>,
    pub state: IssueState,
    pub active_decision_id: Option<String>,
    pub created_at_ns: String,
    pub resolved_at_ns: Option<String>,
    pub resolved_by: Option<String>,
}

#[derive(JsonSchema, Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct DecisionVoteView {
    pub voter: String,
    pub option: u8,
}

#[derive(JsonSchema, Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct DecisionView {
    pub id: String,
    pub issue_id: String,
    pub purchase_id: String,
    pub decision_type: String,
    pub vote_type: VoteType,
    pub proposal: String,
    pub options: Vec<String>,
    pub deadline_ns: String,
    pub opened_at_ns: String,
    pub eligible_voters: Vec<String>,
    pub required_yes_votes: u32,
    pub votes: Vec<DecisionVoteView>,
    pub state: DecisionState,
    pub selected_option: Option<u8>,
    pub supplier_id: String,
    pub requires_supplier_consent: bool,
    pub supplier_agreed: bool,
}

#[derive(JsonSchema, Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct V3ConfigView {
    pub version: String,
    pub v2_contract_id: String,
    pub max_active_issues_per_purchase: u32,
    pub max_options: u32,
    pub max_voters: u32,
    pub pickup_decisions_only: bool,
    pub private_voting: bool,
    pub supported_vote_types: Vec<String>,
}

/// The V2 view is deliberately read-only and minimal. V3 uses it to verify membership and
/// supplier/organizer authority; it never stores or changes V2 financial state.
#[derive(JsonSchema, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct V2CommitmentView {
    pub account_id: String,
    pub state: String,
}

#[derive(JsonSchema, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct V2PurchaseView {
    pub proposer: String,
    pub farmer_id: String,
    pub state: String,
    pub commitments: Vec<V2CommitmentView>,
}

#[ext_contract(ext_v2)]
trait ExtV2 {
    fn get_purchase(&self, purchase_id: U64) -> Option<V2PurchaseView>;
}

#[ext_contract(ext_self)]
trait ExtSelf {
    fn resolve_issue_raise(
        &mut self,
        request_id: U64,
        #[callback_result] result: Result<Option<V2PurchaseView>, PromiseError>,
    );
    fn resolve_group_vote_request(
        &mut self,
        request_id: U64,
        #[callback_result] result: Result<Option<V2PurchaseView>, PromiseError>,
    );
    fn resolve_issue_resolution(
        &mut self,
        request_id: U64,
        #[callback_result] result: Result<Option<V2PurchaseView>, PromiseError>,
    );
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    v2_contract_id: AccountId,
    issues: UnorderedMap<u64, Issue>,
    decisions: UnorderedMap<u64, Decision>,
    pending_issue_checks: UnorderedMap<u64, PendingIssueCheck>,
    pending_decision_checks: UnorderedMap<u64, PendingDecisionCheck>,
    pending_resolution_checks: UnorderedMap<u64, PendingResolutionCheck>,
    next_issue_id: u64,
    next_decision_id: u64,
    next_request_id: u64,
}

#[near]
impl Contract {
    #[init]
    pub fn new(v2_contract_id: AccountId) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "initialization must be signed by the contract account"
        );
        require!(
            v2_contract_id != env::current_account_id(),
            "V3 cannot point to itself"
        );
        Self {
            v2_contract_id,
            issues: UnorderedMap::new(StorageKey::Issues),
            decisions: UnorderedMap::new(StorageKey::Decisions),
            pending_issue_checks: UnorderedMap::new(StorageKey::PendingIssueChecks),
            pending_decision_checks: UnorderedMap::new(StorageKey::PendingDecisionChecks),
            pending_resolution_checks: UnorderedMap::new(StorageKey::PendingResolutionChecks),
            next_issue_id: 0,
            next_decision_id: 0,
            next_request_id: 0,
        }
    }

    /// Starts a funded-member check against V2. The issue is written only in the callback after
    /// the V2 purchase view proves that the signed caller has an Active commitment.
    pub fn raise_issue(
        &mut self,
        purchase_id: U64,
        subject: String,
        description: String,
        suggested_solution: Option<String>,
    ) -> Promise {
        self.assert_no_attached_deposit();
        validate_issue_text(&subject, &description, suggested_solution.as_deref());
        let request_id = self.take_request_id();
        let requester = env::predecessor_account_id();
        self.pending_issue_checks.insert(
            &request_id,
            &PendingIssueCheck {
                purchase_id: purchase_id.0,
                requester,
                subject,
                description,
                suggested_solution,
            },
        );
        self.read_v2_purchase(purchase_id.0).then(
            ext_self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .resolve_issue_raise(U64(request_id)),
        )
    }

    /// Any funded member may request a pickup-arrangement decision for an open issue. V2 is read
    /// again before the voter list is snapshotted, so a client cannot supply its own eligibility.
    pub fn request_group_vote(
        &mut self,
        issue_id: U64,
        decision_type: String,
        vote_type: VoteType,
        proposal: String,
        options: Vec<String>,
        deadline_ns: U64,
    ) -> Promise {
        self.assert_no_attached_deposit();
        let options = validate_and_normalize_decision(
            &decision_type,
            vote_type,
            &proposal,
            options,
            deadline_ns.0,
        );
        let issue = self.load_issue(issue_id.0);
        require!(
            issue.state == IssueState::Open,
            "issue is not open for a group decision"
        );
        require!(
            issue.active_decision_id.is_none(),
            "issue already has an active decision"
        );
        let request_id = self.take_request_id();
        self.pending_decision_checks.insert(
            &request_id,
            &PendingDecisionCheck {
                issue_id: issue_id.0,
                requester: env::predecessor_account_id(),
                decision_type,
                vote_type,
                proposal,
                options,
                deadline_ns: deadline_ns.0,
            },
        );
        self.read_v2_purchase(issue.purchase_id).then(
            ext_self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .resolve_group_vote_request(U64(request_id)),
        )
    }

    /// Organizer or supplier can settle a clarification without a vote. Their authority is
    /// checked against the immutable V2 purchase record rather than against client input.
    pub fn resolve_issue(&mut self, issue_id: U64) -> Promise {
        self.assert_no_attached_deposit();
        let issue = self.load_issue(issue_id.0);
        require!(
            issue.state == IssueState::Open,
            "issue is not awaiting clarification"
        );
        require!(
            issue.active_decision_id.is_none(),
            "resolve the active decision first"
        );
        let request_id = self.take_request_id();
        self.pending_resolution_checks.insert(
            &request_id,
            &PendingResolutionCheck {
                issue_id: issue_id.0,
                requester: env::predecessor_account_id(),
            },
        );
        self.read_v2_purchase(issue.purchase_id).then(
            ext_self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .resolve_issue_resolution(U64(request_id)),
        )
    }

    /// One fixed-snapshot voter gets one public choice. A choice reaches approval only when it
    /// has the 2/3 threshold; nonparticipation and split choices never count as approval.
    pub fn vote_on_decision(&mut self, decision_id: U64, option: u8) {
        self.assert_no_attached_deposit();
        let voter = env::predecessor_account_id();
        let mut decision = self.load_decision(decision_id.0);
        require!(
            decision.state == DecisionState::Open,
            "decision is not accepting votes"
        );
        require!(
            env::block_timestamp() <= decision.deadline_ns,
            "decision deadline has passed"
        );
        require!(
            option < decision.options.len() as u8,
            "choice is not available"
        );
        require!(
            decision
                .eligible_voters
                .iter()
                .any(|account| account == &voter),
            "only eligible funded members may vote"
        );
        require!(
            !decision.votes.iter().any(|vote| vote.voter == voter),
            "member already voted on this decision"
        );

        decision.votes.push(DecisionVote { voter, option });
        match evaluate_ballot(&decision) {
            BallotProgress::Open => {}
            BallotProgress::Passed(selected) => {
                decision.selected_option = Some(selected);
                if decision.requires_supplier_consent {
                    decision.state = DecisionState::AwaitingSupplier;
                } else {
                    decision.state = DecisionState::Approved;
                    self.resolve_issue_from_decision(&decision);
                }
            }
            BallotProgress::Rejected => {
                decision.state = DecisionState::Rejected;
                self.reopen_issue_from_decision(&decision);
            }
            BallotProgress::NoConsensus => {
                decision.state = DecisionState::NoConsensus;
                self.reopen_issue_from_decision(&decision);
            }
        }
        self.save_decision(decision_id.0, decision);
    }

    /// Supplier agreement is required before a pickup decision becomes binding for the group.
    pub fn agree_to_decision(&mut self, decision_id: U64) {
        self.assert_no_attached_deposit();
        let caller = env::predecessor_account_id();
        let mut decision = self.load_decision(decision_id.0);
        require!(
            caller == decision.supplier_id,
            "only the named supplier may agree"
        );
        require!(
            decision.state == DecisionState::AwaitingSupplier
                && decision.requires_supplier_consent
                && decision.selected_option.is_some(),
            "decision has not passed or does not require supplier agreement"
        );
        require!(
            env::block_timestamp() <= decision.deadline_ns,
            "decision deadline has passed"
        );
        decision.supplier_agreed = true;
        decision.state = DecisionState::Approved;
        self.resolve_issue_from_decision(&decision);
        self.save_decision(decision_id.0, decision);
    }

    /// A supplier may decline a proposed obligation; the issue stays open so members can suggest
    /// a different safe pickup arrangement instead of being locked out.
    pub fn decline_decision(&mut self, decision_id: U64) {
        self.assert_no_attached_deposit();
        let caller = env::predecessor_account_id();
        let mut decision = self.load_decision(decision_id.0);
        require!(
            caller == decision.supplier_id,
            "only the named supplier may decline"
        );
        require!(
            decision.state == DecisionState::AwaitingSupplier && decision.requires_supplier_consent,
            "decision has not passed or does not require supplier response"
        );
        require!(
            env::block_timestamp() <= decision.deadline_ns,
            "decision deadline has passed"
        );
        decision.state = DecisionState::Rejected;
        self.reopen_issue_from_decision(&decision);
        self.save_decision(decision_id.0, decision);
    }

    /// Anyone may close an undecided ballot after its immutable deadline.
    pub fn expire_decision(&mut self, decision_id: U64) {
        self.assert_no_attached_deposit();
        let mut decision = self.load_decision(decision_id.0);
        require!(
            env::block_timestamp() > decision.deadline_ns,
            "decision deadline has not passed"
        );
        require!(
            decision.state == DecisionState::Open
                || decision.state == DecisionState::AwaitingSupplier,
            "decision is not expirable"
        );
        decision.state = DecisionState::Expired;
        let mut issue = self.load_issue(decision.issue_id);
        issue.state = IssueState::Open;
        issue.active_decision_id = None;
        self.save_issue(decision.issue_id, issue);
        self.save_decision(decision_id.0, decision);
    }

    #[private]
    pub fn resolve_issue_raise(
        &mut self,
        request_id: U64,
        #[callback_result] result: Result<Option<V2PurchaseView>, PromiseError>,
    ) {
        let Some(pending) = self.pending_issue_checks.remove(&request_id.0) else {
            return;
        };
        let Ok(Some(purchase)) = result else {
            return;
        };
        require!(
            is_active_purchase_state(&purchase.state),
            "purchase is not active for issues"
        );
        require!(
            purchase
                .commitments
                .iter()
                .any(
                    |commitment| commitment.account_id == pending.requester.as_str()
                        && commitment.state == "Active"
                ),
            "only confirmed funded members can raise issues"
        );
        require!(
            self.active_issue_count(pending.purchase_id) < MAX_ACTIVE_ISSUES_PER_PURCHASE,
            "too many open issues for this purchase"
        );
        require!(
            !self.has_duplicate_open_issue(&pending),
            "a matching issue is already open"
        );

        let id = self.next_issue_id;
        self.next_issue_id = self
            .next_issue_id
            .checked_add(1)
            .expect("issue id overflow");
        self.issues.insert(
            &id,
            &Issue {
                purchase_id: pending.purchase_id,
                raised_by: pending.requester,
                subject: pending.subject,
                description: pending.description,
                suggested_solution: pending.suggested_solution,
                state: IssueState::Open,
                active_decision_id: None,
                created_at_ns: env::block_timestamp(),
                resolved_at_ns: None,
                resolved_by: None,
            },
        );
    }

    #[private]
    pub fn resolve_group_vote_request(
        &mut self,
        request_id: U64,
        #[callback_result] result: Result<Option<V2PurchaseView>, PromiseError>,
    ) {
        let Some(pending) = self.pending_decision_checks.remove(&request_id.0) else {
            return;
        };
        let Ok(Some(purchase)) = result else {
            return;
        };
        let mut issue = self.load_issue(pending.issue_id);
        require!(
            issue.state == IssueState::Open && issue.active_decision_id.is_none(),
            "issue already has an active decision"
        );
        require!(
            is_active_purchase_state(&purchase.state),
            "purchase is not active for decisions"
        );
        require!(
            pending.deadline_ns > env::block_timestamp(),
            "decision deadline has passed"
        );
        let eligible_voters: Vec<AccountId> = purchase
            .commitments
            .iter()
            .filter(|commitment| commitment.state == "Active")
            .filter_map(|commitment| commitment.account_id.parse().ok())
            .collect();
        require!(
            !eligible_voters.is_empty(),
            "a decision needs funded members"
        );
        require!(
            eligible_voters.len() <= MAX_VOTERS,
            "too many eligible voters"
        );
        require!(
            eligible_voters
                .iter()
                .any(|account| account == &pending.requester),
            "only funded members may request a decision"
        );
        require!(
            !self.has_active_decision_for_purchase(issue.purchase_id),
            "purchase already has an active group decision"
        );
        let supplier_id: AccountId = purchase
            .farmer_id
            .parse()
            .expect("V2 returned an invalid supplier account");

        let decision_id = self.next_decision_id;
        self.next_decision_id = self
            .next_decision_id
            .checked_add(1)
            .expect("decision id overflow");
        self.decisions.insert(
            &decision_id,
            &Decision {
                issue_id: pending.issue_id,
                purchase_id: issue.purchase_id,
                decision_type: pending.decision_type,
                vote_type: pending.vote_type,
                proposal: pending.proposal,
                options: pending.options,
                deadline_ns: pending.deadline_ns,
                opened_at_ns: env::block_timestamp(),
                required_yes_votes: ceil_two_thirds(eligible_voters.len() as u32),
                eligible_voters,
                votes: Vec::new(),
                state: DecisionState::Open,
                selected_option: None,
                supplier_id,
                requires_supplier_consent: true,
                supplier_agreed: false,
            },
        );
        issue.state = IssueState::NeedsGroupDecision;
        issue.active_decision_id = Some(decision_id);
        self.save_issue(pending.issue_id, issue);
    }

    #[private]
    pub fn resolve_issue_resolution(
        &mut self,
        request_id: U64,
        #[callback_result] result: Result<Option<V2PurchaseView>, PromiseError>,
    ) {
        let Some(pending) = self.pending_resolution_checks.remove(&request_id.0) else {
            return;
        };
        let Ok(Some(purchase)) = result else {
            return;
        };
        let mut issue = self.load_issue(pending.issue_id);
        require!(
            issue.state == IssueState::Open && issue.active_decision_id.is_none(),
            "issue is no longer open"
        );
        require!(
            pending.requester.as_str() == purchase.proposer
                || pending.requester.as_str() == purchase.farmer_id,
            "only the organizer or supplier may resolve an issue"
        );
        issue.state = IssueState::Resolved;
        issue.resolved_at_ns = Some(env::block_timestamp());
        issue.resolved_by = Some(pending.requester);
        self.save_issue(pending.issue_id, issue);
    }

    pub fn get_config(&self) -> V3ConfigView {
        V3ConfigView {
            version: "V3".to_string(),
            v2_contract_id: self.v2_contract_id.to_string(),
            max_active_issues_per_purchase: MAX_ACTIVE_ISSUES_PER_PURCHASE as u32,
            max_options: MAX_OPTIONS as u32,
            max_voters: MAX_VOTERS as u32,
            pickup_decisions_only: true,
            private_voting: false,
            supported_vote_types: vec!["YesNo".to_string(), "MultipleChoice".to_string()],
        }
    }

    pub fn get_issue_count(&self) -> U64 {
        U64(self.next_issue_id)
    }

    pub fn get_issue(&self, issue_id: U64) -> Option<IssueView> {
        self.issues
            .get(&issue_id.0)
            .map(|issue| self.issue_view(issue_id.0, &issue))
    }

    pub fn get_decision_count(&self) -> U64 {
        U64(self.next_decision_id)
    }

    pub fn get_decision(&self, decision_id: U64) -> Option<DecisionView> {
        self.decisions
            .get(&decision_id.0)
            .map(|decision| self.decision_view(decision_id.0, &decision))
    }

    pub fn get_issues_for_purchase(&self, purchase_id: U64) -> Vec<IssueView> {
        self.issues
            .iter()
            .filter(|(_, issue)| issue.purchase_id == purchase_id.0)
            .map(|(id, issue)| self.issue_view(id, &issue))
            .collect()
    }

    fn read_v2_purchase(&self, purchase_id: u64) -> Promise {
        ext_v2::ext(self.v2_contract_id.clone())
            .with_static_gas(CROSS_CALL_GAS)
            .get_purchase(U64(purchase_id))
    }

    fn resolve_issue_from_decision(&mut self, decision: &Decision) {
        let mut issue = self.load_issue(decision.issue_id);
        issue.state = IssueState::Resolved;
        issue.active_decision_id = None;
        issue.resolved_at_ns = Some(env::block_timestamp());
        issue.resolved_by = Some(env::predecessor_account_id());
        self.save_issue(decision.issue_id, issue);
    }

    fn reopen_issue_from_decision(&mut self, decision: &Decision) {
        let mut issue = self.load_issue(decision.issue_id);
        issue.state = IssueState::Open;
        issue.active_decision_id = None;
        self.save_issue(decision.issue_id, issue);
    }

    fn load_issue(&self, issue_id: u64) -> Issue {
        self.issues
            .get(&issue_id)
            .unwrap_or_else(|| env::panic_str("issue does not exist"))
    }

    fn save_issue(&mut self, issue_id: u64, issue: Issue) {
        self.issues.insert(&issue_id, &issue);
    }

    fn load_decision(&self, decision_id: u64) -> Decision {
        self.decisions
            .get(&decision_id)
            .unwrap_or_else(|| env::panic_str("decision does not exist"))
    }

    fn save_decision(&mut self, decision_id: u64, decision: Decision) {
        self.decisions.insert(&decision_id, &decision);
    }

    fn take_request_id(&mut self) -> u64 {
        let id = self.next_request_id;
        self.next_request_id = self
            .next_request_id
            .checked_add(1)
            .expect("request id overflow");
        id
    }

    fn active_issue_count(&self, purchase_id: u64) -> usize {
        self.issues
            .iter()
            .filter(|(_, issue)| {
                issue.purchase_id == purchase_id && issue.state != IssueState::Resolved
            })
            .count()
    }

    fn has_duplicate_open_issue(&self, pending: &PendingIssueCheck) -> bool {
        self.issues.iter().any(|(_, issue)| {
            issue.purchase_id == pending.purchase_id
                && issue.state != IssueState::Resolved
                && issue.subject == pending.subject
                && issue.description == pending.description
                && issue.suggested_solution == pending.suggested_solution
        })
    }

    fn has_active_decision_for_purchase(&self, purchase_id: u64) -> bool {
        self.decisions.iter().any(|(_, decision)| {
            decision.purchase_id == purchase_id
                && matches!(
                    decision.state,
                    DecisionState::Open | DecisionState::AwaitingSupplier
                )
        })
    }

    fn issue_view(&self, id: u64, issue: &Issue) -> IssueView {
        IssueView {
            id: id.to_string(),
            purchase_id: issue.purchase_id.to_string(),
            raised_by: issue.raised_by.to_string(),
            subject: issue.subject.clone(),
            description: issue.description.clone(),
            suggested_solution: issue.suggested_solution.clone(),
            state: issue.state,
            active_decision_id: issue.active_decision_id.map(|value| value.to_string()),
            created_at_ns: issue.created_at_ns.to_string(),
            resolved_at_ns: issue.resolved_at_ns.map(|value| value.to_string()),
            resolved_by: issue.resolved_by.as_ref().map(ToString::to_string),
        }
    }

    fn decision_view(&self, id: u64, decision: &Decision) -> DecisionView {
        DecisionView {
            id: id.to_string(),
            issue_id: decision.issue_id.to_string(),
            purchase_id: decision.purchase_id.to_string(),
            decision_type: decision.decision_type.clone(),
            vote_type: decision.vote_type,
            proposal: decision.proposal.clone(),
            options: decision.options.clone(),
            deadline_ns: decision.deadline_ns.to_string(),
            opened_at_ns: decision.opened_at_ns.to_string(),
            eligible_voters: decision
                .eligible_voters
                .iter()
                .map(ToString::to_string)
                .collect(),
            required_yes_votes: decision.required_yes_votes,
            votes: decision
                .votes
                .iter()
                .map(|vote| DecisionVoteView {
                    voter: vote.voter.to_string(),
                    option: vote.option,
                })
                .collect(),
            state: decision.state,
            selected_option: decision.selected_option,
            supplier_id: decision.supplier_id.to_string(),
            requires_supplier_consent: decision.requires_supplier_consent,
            supplier_agreed: decision.supplier_agreed,
        }
    }

    fn assert_no_attached_deposit(&self) {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(0),
            "this method does not accept an attached deposit"
        );
    }
}

fn validate_issue_text(subject: &str, description: &str, solution: Option<&str>) {
    require!(!subject.trim().is_empty(), "issue subject is required");
    require!(
        !description.trim().is_empty(),
        "issue description is required"
    );
    require!(
        subject.as_bytes().len() <= MAX_ISSUE_SUBJECT_BYTES,
        "issue subject is too long"
    );
    require!(
        description.as_bytes().len() <= MAX_ISSUE_DESCRIPTION_BYTES,
        "issue description is too long"
    );
    if let Some(solution) = solution {
        require!(
            solution.as_bytes().len() <= MAX_SOLUTION_BYTES,
            "suggested solution is too long"
        );
    }
}

fn validate_and_normalize_decision(
    decision_type: &str,
    vote_type: VoteType,
    proposal: &str,
    options: Vec<String>,
    deadline_ns: u64,
) -> Vec<String> {
    require!(
        decision_type == "pickup_arrangement",
        "only pickup arrangements can be put to a group vote"
    );
    require!(!proposal.trim().is_empty(), "decision proposal is required");
    require!(
        proposal.as_bytes().len() <= MAX_PROPOSAL_BYTES,
        "decision proposal is too long"
    );
    let normalized = match vote_type {
        VoteType::YesNo => {
            require!(
                options.is_empty(),
                "yes/no labels are fixed; do not provide choices"
            );
            vec!["Yes".to_string(), "No".to_string()]
        }
        VoteType::MultipleChoice => {
            require!(
                options.len() >= 2 && options.len() <= MAX_OPTIONS,
                "provide two to four choices"
            );
            options
                .into_iter()
                .map(|option| option.trim().to_string())
                .collect()
        }
    };
    for option in &normalized {
        require!(!option.trim().is_empty(), "choice cannot be empty");
        require!(
            option.as_bytes().len() <= MAX_OPTION_BYTES,
            "choice is too long"
        );
    }
    require!(
        normalized
            .iter()
            .enumerate()
            .all(|(index, option)| normalized
                .iter()
                .enumerate()
                .all(|(other_index, other)| index == other_index || option != other)),
        "choices must be different"
    );
    require!(
        deadline_ns > env::block_timestamp(),
        "decision deadline must be in the future"
    );
    require!(
        deadline_ns - env::block_timestamp() <= DECISION_WINDOW_MAX_NS,
        "decision window is too long"
    );
    normalized
}

fn is_active_purchase_state(state: &str) -> bool {
    matches!(
        state,
        "Open" | "Funded" | "FulfillmentPending" | "FulfillmentApproved"
    )
}

fn count_option_votes(votes: &[DecisionVote], option: u8) -> u32 {
    votes.iter().filter(|vote| vote.option == option).count() as u32
}

#[derive(Debug, PartialEq, Eq)]
enum BallotProgress {
    Open,
    Passed(u8),
    Rejected,
    NoConsensus,
}

fn evaluate_ballot(decision: &Decision) -> BallotProgress {
    match decision.vote_type {
        VoteType::YesNo => {
            let yes_votes = count_option_votes(&decision.votes, 0);
            if yes_votes >= decision.required_yes_votes {
                return BallotProgress::Passed(0);
            }
            let remaining = decision
                .eligible_voters
                .len()
                .saturating_sub(decision.votes.len()) as u32;
            if yes_votes.saturating_add(remaining) < decision.required_yes_votes {
                BallotProgress::Rejected
            } else {
                BallotProgress::Open
            }
        }
        VoteType::MultipleChoice => {
            for option in 0..decision.options.len() as u8 {
                if count_option_votes(&decision.votes, option) >= decision.required_yes_votes {
                    return BallotProgress::Passed(option);
                }
            }
            if decision.votes.len() == decision.eligible_voters.len() {
                BallotProgress::NoConsensus
            } else {
                BallotProgress::Open
            }
        }
    }
}

fn ceil_two_thirds(value: u32) -> u32 {
    value.saturating_mul(2).saturating_add(2) / 3
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decision(vote_type: VoteType, options: &[&str], voter_count: usize) -> Decision {
        Decision {
            issue_id: 0,
            purchase_id: 0,
            decision_type: "pickup_arrangement".to_string(),
            vote_type,
            proposal: "Choose a safe pickup plan".to_string(),
            options: options.iter().map(|value| value.to_string()).collect(),
            deadline_ns: u64::MAX,
            opened_at_ns: 0,
            eligible_voters: (0..voter_count)
                .map(|index| format!("member-{index}.testnet").parse().unwrap())
                .collect(),
            required_yes_votes: ceil_two_thirds(voter_count as u32),
            votes: Vec::new(),
            state: DecisionState::Open,
            selected_option: None,
            supplier_id: "supplier.testnet".parse().unwrap(),
            requires_supplier_consent: true,
            supplier_agreed: false,
        }
    }

    #[test]
    fn threshold_requires_two_thirds_and_not_silence() {
        assert_eq!(ceil_two_thirds(1), 1);
        assert_eq!(ceil_two_thirds(2), 2);
        assert_eq!(ceil_two_thirds(3), 2);
        assert_eq!(ceil_two_thirds(4), 3);
        let votes = vec![
            DecisionVote {
                voter: "a.testnet".parse().unwrap(),
                option: 0,
            },
            DecisionVote {
                voter: "b.testnet".parse().unwrap(),
                option: 1,
            },
        ];
        assert_eq!(count_option_votes(&votes, 0), 1);
        assert_eq!(count_option_votes(&votes, 1), 1);
    }

    #[test]
    fn purchase_state_gate_excludes_terminal_orders() {
        assert!(is_active_purchase_state("Funded"));
        assert!(!is_active_purchase_state("Completed"));
        assert!(!is_active_purchase_state("Failed"));
    }

    #[test]
    fn yes_no_requires_yes_and_rejects_when_yes_is_impossible() {
        let mut ballot = decision(VoteType::YesNo, &["Yes", "No"], 3);
        ballot.votes.push(DecisionVote {
            voter: ballot.eligible_voters[0].clone(),
            option: 0,
        });
        assert_eq!(evaluate_ballot(&ballot), BallotProgress::Open);
        ballot.votes.push(DecisionVote {
            voter: ballot.eligible_voters[1].clone(),
            option: 0,
        });
        assert_eq!(evaluate_ballot(&ballot), BallotProgress::Passed(0));

        let mut rejected = decision(VoteType::YesNo, &["Yes", "No"], 3);
        for index in 0..2 {
            rejected.votes.push(DecisionVote {
                voter: rejected.eligible_voters[index].clone(),
                option: 1,
            });
        }
        assert_eq!(evaluate_ballot(&rejected), BallotProgress::Rejected);
    }

    #[test]
    fn three_choice_ballot_needs_threshold_and_tie_has_no_consensus() {
        let mut passed = decision(
            VoteType::MultipleChoice,
            &["Saturday", "Sunday", "Weeknight"],
            3,
        );
        for index in 0..2 {
            passed.votes.push(DecisionVote {
                voter: passed.eligible_voters[index].clone(),
                option: 2,
            });
        }
        assert_eq!(evaluate_ballot(&passed), BallotProgress::Passed(2));

        let mut tied = decision(
            VoteType::MultipleChoice,
            &["Saturday", "Sunday", "Weeknight"],
            3,
        );
        for index in 0..3 {
            tied.votes.push(DecisionVote {
                voter: tied.eligible_voters[index].clone(),
                option: index as u8,
            });
        }
        assert_eq!(evaluate_ballot(&tied), BallotProgress::NoConsensus);
    }
}
