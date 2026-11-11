# UX issue register

This register is the verification record for the final post-V5 UX pass. “Resolved” means the
current implementation and focused regression coverage address the recorded defect; it does not
replace final wallet-extension testing before deployment.

| ID | Finding | Status | Implementation and verification |
| --- | --- | --- | --- |
| UX-01 | Deal cards use inconsistent content density and field order | Resolved | Marketplace cards now share one content/action structure, clamp long descriptions, reserve consistent outcome space, and show concise failed/completed explanations. Check all lifecycle states at desktop and 375px. |
| UX-02 | Some action labels wrap or produce uneven button rows | Resolved | Card CTAs use a stable action row, non-wrapping primary labels, a compact Share control, and stacked mobile fallback. Accept/decline controls retain 44px targets. |
| UX-03 | Supplier selection is confusing for organizers and suppliers | Resolved | The free-text datalist is now a verified-supplier select showing business name and location before the wallet ID, with a selected-supplier summary. Supplier-mode signer validation remains unchanged. |
| UX-04 | Stale form values may appear outside the repaired draft lifecycle | Verified existing fix | Drafts remain scoped by form, wallet, deal, and issue. Confirmed actions clear only their associated draft; failed/unknown submissions retain it; Start Fresh removes only the current draft. Regression coverage remains in `form-drafts.test.js` and `transaction-flow.test.js`. |
| UX-05 | Supplier invitations do not explain the review outcome clearly enough | Implemented; wallet check pending | The invitation page now shows proposal progress, role-specific waiting/review/result states, a published-deal link after acceptance, and a revised-proposal path after decline. My Sales separates invitations from accepted orders. Live Deal #3’s accepted result was visually verified; a fresh signed accept/decline journey still needs designated demo wallets. |
| UX-06 | Accept and Decline actions are too visually similar | Implemented; wallet check pending | Proposal and pickup-change responses now use explicit labels, green accept/red decline treatments, and an application review dialog explaining the effect before Meteor is opened. The live accepted result was verified; pending controls still need the designated supplier wallet. |
| UX-07 | Role-specific notifications are incomplete | Implemented; wallet check pending | Named suppliers receive an eligible Action Center item/count and deep link. Pending responses replace the action while unresolved and disappear after authoritative state changes. Organizers see waiting, accepted, or declined results in My Group Buys. Existing buyer vote/refund eligibility is preserved. A signed multi-wallet browser pass remains. |
| UX-08 | Homepage text can overlap at some widths or text-size settings | Resolved and verified | Replaced the absolutely positioned orbit labels with two consistent in-flow preview badges, kept “One shared order” as the single card heading, and used a wrapping badge row with natural spacing. Chrome screenshots at 1440px, 375px, and 200% effective browser zoom were visually inspected with no badge collisions or horizontal overflow. |

## Follow-up verification before deployment

- Repeat supplier invitation accept/decline with Meteor using designated Testnet accounts; do not
  perform that wallet test against preserved financial records.
- Check 200% zoom and browser text enlargement in the deployment browser matrix.
- Verify the organizer result after a newly confirmed supplier response, including its deep link.

## Read-only live-state verification · 2026-11-11

- V5 Deal #3 is authoritatively `Open` and includes a supplier agreement accepted at block
  `277195158`. The earlier organizer view that still said “Awaiting supplier confirmation” was
  stale frontend state, not an unsuccessful acceptance.
- V5 Deal #4 is authoritatively `Open` with zero commitments and zero quantity. Its join deadline
  was 2026-11-11 03:35 CST and has passed. The UI therefore presents it as
  “Closed · final result pending”; it must not call the deal Failed before contract finalization.

### Financial automation requirements discovered from Deal #4

The deployed V4 and V5 contracts require an explicit, zero-deposit `finalize_purchase(purchase_id)`
call after the join deadline. The method is permissionless, accepts only `Open` or
`AwaitingSupplier`, and atomically records `Funded` only when an open deal reached its minimum;
otherwise it records failure and makes any active commitments refundable. It performs no outgoing
refund transfer. Each eligible buyer must still call the existing refund path, and V5 refund
completion still depends on its registered-recipient check, token transfer, callback, and retry or
reconciliation rules.

Upcoming automation must therefore:

1. discover only deadline-passed `Open`/`AwaitingSupplier` deals;
2. submit `finalize_purchase` once with idempotent duplicate protection;
3. wait for authoritative final state before notifying users or enabling refunds;
4. keep refund claims and callback reconciliation separate from finalization; and
5. expose failures for retry without ever inferring success from job submission.

There is no deployed organizer-level cancel/delete method for an unjoined deal. The existing
`cancel_commitment` method belongs to an individual buyer and is available only before the join
cutoff. Deal cancellation or deletion must be deferred to a future contract version; the frontend
must not hide an active on-chain record behind a local Delete control.
