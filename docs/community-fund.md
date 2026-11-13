# Community Goals on SputnikDAO

Status: the native-NEAR workflow is preserved as finalized historical evidence. The customer-facing
goal now uses canonical Circle Testnet USDC, and its registration, contribution, two-member approval,
payment receipt, and retained balance have been verified on NEAR Testnet.

## Integration boundary

Community Goals uses one separate SputnikDAO account for one clearly identified goal in the initial
demonstration. It does not call, own, or receive tokens from
the V5 purchase contract, the V3-for-V5 decision contract, or the finalizer. The Community Goals DAO
may hold the same canonical Circle Testnet USDC token as V5, but it is a different account with no
access to V5 escrow. The Flask
service remains read-only. Wallets sign every contribution, proposal, and vote in the browser.

The implementation supports one explicitly configured asset at a time:

- a normal native transfer contributes to the DAO account;
- `get_available_amount` returns spendable DAO balance after contract storage and locked bonds;
- `get_policy`, `get_factory_info`, and the DAO account access-key list establish the authority
  boundary;
- `get_last_proposal_id`, `get_proposals`, and `get_proposal` expose recorded decisions;
- `add_proposal` creates a `Transfer` proposal with `token_id: ""`;
- `act_proposal` records `VoteApprove` or `VoteReject`;
- the vote that crosses the policy threshold executes the transfer immediately; there is no
  separate organizer-controlled execution step;
- current contract source attempts to mark a failed transfer `Failed`, but the interface never treats
  proposal status or a successful top-level vote transaction alone as proof of payment.

For the customer-facing Phase 3 journey, `token_id` is the canonical Circle Testnet USDC contract.
The DAO must first be registered by calling that token's `storage_deposit` with the exact current
minimum. Contributions call `ft_transfer` directly from the donor to the DAO with one yoctoNEAR.
SputnikDAO's threshold-crossing vote calls `ft_transfer` from the DAO to the proposal recipient.
USDC amounts use six-decimal integer units. Proposal bonds and transaction gas remain native NEAR.

Contract balance, policy, proposal contents, votes, and status are read at finality directly from
NEAR RPC. FastNEAR account history discovers candidate contributions with bounded pagination;
NearBlocks remains the bounded discovery source for broader DAO proposal activity. Every candidate
contribution is independently reread through finalized RPC and must match the exact transaction
hash, signer, canonical token, DAO receiver, amount, one-yocto deposit, successful execution, and
NEP-141 transfer receipt before it is inserted idempotently into the local SQLite receipt ledger.
Wallet-returned hashes use the same server verification boundary. A missing wallet hash is recovered
only when discovery finds one exact finalized match within the saved action window. The durable
ledger survives browser refreshes, Flask restarts, and indexer outages; indexers are not asked to
rediscover stored receipts. The API reports current treasury balance separately from lifetime raised.
When a complete discovery pass is unavailable, stored receipts are labeled as a verified subtotal
and are never promoted to the complete current or lifetime total.

## One-goal accounting boundary

One DAO treasury does not provide goal-specific subaccounts. The initial demonstration therefore
supports exactly one configured goal and one dedicated DAO. Its title, purpose, target, and intended
recipient are public application configuration; they are not new escrow terms and do not create
automatic release or refund rights. Goal progress is the sum of successful transfers of the
configured asset indexed for that DAO. In USDC mode, available balance is the token contract's
authoritative `ft_balance_of(DAO)` result; native `get_available_amount` is not mixed into USDC
totals. Native proposal bonds and the earlier NEAR contribution/payment remain visible on explorers
but are excluded from the USDC goal's progress, requests, and history.

Any connected Testnet wallet registered with the canonical token and holding Testnet USDC can
contribute. Only the fixed member group in the
verified DAO policy can create a payment proposal or vote. The HarvestPool proposal journey fixes
the configured goal recipient, while the underlying SputnikDAO policy still relies on the required
member approvals rather than a recipient allowlist. All transfer proposals remain visible so an
out-of-band proposal cannot be hidden by the interface.

## Verified Testnet deployment facts

Public, read-only checks before creation established:

- `sputnikv2.testnet` exists and exposes the current factory views.
- At Testnet block 277,274,970, `get_number_daos` returned `5588`.
- `get_default_version` returned `[3,31]` and `get_default_code_hash` returned
  `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH`.
- A newly created factory DAO exposed contract `version()` as `2.3.1`, the documented V2 views,
  and the deployed two-argument `act_proposal({id, action})` interface. A real successful Testnet
  transaction against that DAO used `{"id":0,"action":"VoteApprove"}`.
- That DAO's account code hash matched the factory default hash above.
- Factory-created DAOs start with `auto_update: true`; this is not acceptable for the Community
  Goals promise. It must be changed to `false` by the member policy before contributions begin.

The authorized demonstration subsequently created and hardened
`harvestpool-community.sputnikv2.testnet`. Read-only checks at final block `277330049` on
2026-11-12 established:

- code hash `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH` and no account access keys;
- exactly the fixed members `harvestpool-member-a-2026.testnet`, `dalamaa.testnet`, and
  `harvestpool-farmer-2026.testnet` with a two-of-three threshold;
- only the reviewed transfer and factory-info-update proposal/vote permissions;
- factory `sputnikv2.testnet` with `auto_update: false`;
- proposal `#1` approved by Member A and Member B for exactly `0.20 NEAR` to
  `harvestpool-farmer-1.testnet`;
- a successful matching payment receipt and a final contract-reported available amount of
  `0.63632 NEAR`.

The subsequent canonical-USDC journey verified:

- exact **1.00 USDC** contribution transaction
  `JD8WYyoGFAxxNdApXDNrRfKpia59RAN41SWGDwZSGbE6`;
- proposal `#2` for exactly **0.80 USDC** to `harvestpool-farmer-1.testnet`;
- first approval `pyRs5SKSNPW4A33E9nxsxMjv9YNB6vWMZFeS8oEGr7Y`, which transferred nothing;
- deciding approval `DNBNDTgi6bEHsjnWX92WaS9v8U1nyhYiqxfKYKsnfA2p`;
- successful canonical-token receipt `FwHKdUzhMXmfH1Ha6HHRTPBrid2MFVVS92JtCjKGrbHf`
  for exactly **0.80 USDC**, leaving exactly **0.20 USDC** in the DAO.

The complete transaction references and retained browser evidence are in
`docs/COMMUNITY_GOALS_DEMO.md`.

The UI pins the reviewed DAO code hash and version. It disables every financial action if the code
hash changes, the version changes, an access key exists, factory auto-updates remain enabled, a
single account can approve a transfer, or wildcard/policy/upgrade/arbitrary-call permissions appear.

## Required policy

Use exactly three explicitly approved member accounts for the first demonstration. Replace the
three placeholders below only after the account owners confirm the complete Testnet account IDs.
The majority threshold `[1,2]` requires two approvals for a three-member fixed group.

```json
{
  "config": {
    "name": "HarvestPool Community Goals",
    "purpose": "A separate member-controlled Testnet treasury for one reviewed community goal",
    "metadata": ""
  },
  "policy": {
    "roles": [
      {
        "name": "all",
        "kind": "Everyone",
        "permissions": [],
        "vote_policy": {}
      },
      {
        "name": "community",
        "kind": {
          "Group": [
            "MEMBER_A.testnet",
            "MEMBER_B.testnet",
            "MEMBER_C.testnet"
          ]
        },
        "permissions": [
          "transfer:AddProposal",
          "transfer:VoteApprove",
          "transfer:VoteReject",
          "transfer:VoteRemove",
          "transfer:Finalize",
          "factory_info_update:AddProposal",
          "factory_info_update:VoteApprove",
          "factory_info_update:VoteReject",
          "factory_info_update:VoteRemove",
          "factory_info_update:Finalize"
        ],
        "vote_policy": {}
      }
    ],
    "default_vote_policy": {
      "weight_kind": "RoleWeight",
      "quorum": "0",
      "threshold": [1, 2]
    },
    "proposal_bond": "100000000000000000000000",
    "proposal_period": "604800000000000",
    "bounty_bond": "1000000000000000000000000",
    "bounty_forgiveness_period": "86400000000000"
  }
}
```

This deliberately omits policy changes, upgrades, arbitrary function calls, member changes, and
wildcards. The member set is fixed for the minimal demonstration. A recipient is not allowlisted;
the enforceable recipient restriction is that a complete receiver and amount are fixed in the
proposal and two of the three members must approve that exact proposal.

## Authorization-gated creation and hardening

Do not run these steps until the user explicitly authorizes the account creation, attached Testnet
NEAR, the creator account, and all three member IDs.

1. Recheck that `harvestpool-community.sputnikv2.testnet` does not exist. Re-read the factory's
   `get_default_code_hash`; stop if it is not the pinned reviewed hash.
2. Serialize the exact JSON above without changing its meaning and base64-encode the resulting UTF-8
   bytes. Review the decoded value again before signing.
3. Call `sputnikv2.testnet.create` with:

   ```json
   {
     "name": "harvestpool-community",
     "args": "<BASE64_OF_EXACT_INITIALIZATION_JSON>"
   }
   ```

   Attach 6 Testnet NEAR and 150 Tgas, signed by the explicitly authorized creator. The attached
   amount funds account creation and contract storage; it is not presented as a member contribution.
4. Before adding community money, verify all of the following at finality:

   - account ID is exactly `harvestpool-community.sputnikv2.testnet`;
   - account code hash is exactly `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH`;
   - `version()` is exactly `2.3.1`;
   - the account has zero access keys;
   - `get_policy` exactly matches the reviewed fixed policy;
   - `get_factory_info` reports `sputnikv2.testnet` and `auto_update: true`.
5. Member A calls `add_proposal` with exactly 0.1 Testnet NEAR and this proposal:

   ```json
   {
     "proposal": {
       "description": "Disable factory auto-updates before Community Goal contributions",
       "kind": {
         "FactoryInfoUpdate": {
           "factory_info": {
             "factory_id": "sputnikv2.testnet",
             "auto_update": false
           }
         }
       }
     }
   }
   ```

6. Two different configured members call `act_proposal` with the returned proposal ID and
   `"VoteApprove"`, attaching 0 NEAR. Inspect every transaction and receipt.
7. Re-read `get_factory_info`; it must now return `auto_update: false`. Recheck zero access keys,
   the pinned code hash, exact policy, and two-of-three threshold. Do not configure HarvestPool or
   contribute if any check differs.
8. Set these public deployment values in the runtime environment and restart only through the
   existing V5 deployment process:

   ```dotenv
   HARVESTPOOL_COMMUNITY_DAO_ID=harvestpool-community.sputnikv2.testnet
   HARVESTPOOL_COMMUNITY_GOAL_TITLE=Shared community equipment
   HARVESTPOOL_COMMUNITY_GOAL_PURPOSE=Explain the exact public need and intended community benefit
   HARVESTPOOL_COMMUNITY_GOAL_RECIPIENT=reviewed-recipient.testnet
   HARVESTPOOL_COMMUNITY_GOAL_CURRENCY=USDC
   HARVESTPOOL_COMMUNITY_GOAL_TARGET_USDC=1.00
   ```

   Replace every example with the explicitly reviewed demonstration goal. All four goal fields are
   required together; partial or invalid configuration keeps the page disabled.

   `HARVESTPOOL_NEARBLOCKS_API_KEY` is optional for higher NearBlocks rate limits. It is a server-side
   API credential and must never be placed in client code or committed.

## Authorized demonstration sequence

After the gates above pass:

1. Connect any Testnet donor and contribute a deliberately small amount below the published target.
   Verify the final transaction, goal progress, DAO available amount, and indexed incoming record.
2. Member A proposes a smaller payment to the configured goal recipient, with a clear reason. Verify
   the exact receiver, amount, description, 0.1-NEAR bond, and proposal ID.
3. Member A approves. Verify the proposal remains `InProgress` with one recorded approval and that
   no payment receipt exists.
4. Member B reviews the same immutable proposal and casts the second approval. This is the execution
   action. Inspect the transfer and callback receipts.
5. Re-read the proposal and both approving account IDs. Verify the approved amount, recipient
   balance change, remaining `get_available_amount`, deciding-vote transaction hash, and outgoing
   transfer receipt. `Approved` is the expected status, but never report payment as successful
   without that exact receipt regardless of the top-level outcome or callback status.

Testnet NEAR has no cash value. Every account, amount, vote, and transfer is public and must never be
described as private or anonymous.

## Known scope limits

- This is one configured-asset goal and treasury workflow, not a general accounting system. Do not run
  simultaneous goals through this DAO or label its shared balance as segregated goal escrow.
- SputnikDAO has no durable “approved and waiting for an organizer to execute” phase. The threshold-
  crossing approval normally executes the transfer. The UI separately labels an approved proposal
  whose exact payment receipt has not yet been verified and never counts it as spent.
- Contribution discovery indexes up to 1,000 FastNEAR account transactions. NearBlocks proposal
  discovery remains bounded at 500 account transactions and 40 receipt expansions. If a bound is
  exceeded or providers are unavailable, already verified receipts remain visible as a subtotal,
  payment-derived controls fail closed, and no partial total is labeled as complete. Protocol RPC
  cannot list an account's historical transactions, so a new missing hash cannot be discovered while
  every indexer is unavailable.
- The first minimal policy intentionally cannot change members or upgrade code. A later governance
  expansion requires a separate security review and must not be smuggled into this demonstration.

## Primary references

- SputnikDAO contract and setup: https://github.com/near-daos/sputnik-dao-contract
- Current proposal implementation: https://github.com/near-daos/sputnik-dao-contract/blob/main/sputnikdao2/src/proposals.rs
- Current policy implementation: https://github.com/near-daos/sputnik-dao-contract/blob/main/sputnikdao2/src/policy.rs
- Current views: https://github.com/near-daos/sputnik-dao-contract/blob/main/sputnikdao2/src/views.rs
- Factory implementation: https://github.com/near-daos/sputnik-dao-contract/blob/main/sputnikdao-factory2/src/lib.rs
- NearBlocks Testnet API: https://api-testnet.nearblocks.io/api-docs
