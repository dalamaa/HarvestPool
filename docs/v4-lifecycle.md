# V4 corrected purchase lifecycle

Status: implemented, locally tested, deployed and initialized on Testnet, and selected by the local
port-5010 app. This document's manual browser/device checks remain required; deployment evidence is
in `docs/v4-deployment.md`.

## Lifecycle and contract architecture

V4 is a separate contract package in `contract-v4/`; it does not upgrade or rewrite V2 or V3.

```text
Supplier offer
  supplier signs create_supplier_offer
  -> Open

Organizer request
  organizer signs create_purchase_request
  -> AwaitingSupplier
  named supplier signs accept_supplier_request -> Open
  named supplier signs decline_supplier_request -> Declined

Open
  -> exact paid commitments (one funded membership per account)
  -> Funded or Failed after the join/cancellation cutoff
  -> supplier evidence
  -> funded-household fulfillment confirmations
  -> callback-safe supplier payment, or pull refunds on failure
```

There is no offer-approval vote in V4. The organizer has no withdrawal method, receives no extra
vote, and may join only through the same exact-payment `commit` call as every other household.
Financial terms have no update method.

## Supplier authorization and verification

The contract accepts a fixed initialization-time supplier allowlist. A Testnet initialization is
rejected unless it includes `harvestpool-farmer-1.testnet`. Supplier business name, location, and
public contact details are stored in the immutable supplier profile and shown to customers.

`PilotAllowlisted` means only that the account is eligible for the controlled pilot. It is not a
claim that a real business, beneficial owner, or authorized representative was independently
verified. Production requires an external business-identity and representative-authority service,
plus an operational process for suspension and key rotation.

Supplier acceptance records the supplier account, purchase identifier, on-chain SHA-256 fingerprint
of the organizer, immutable supplier profile, and complete Borsh-serialized financial and
fulfillment agreement, plus block timestamp and block height. The NEAR transaction
and receipt provide the external transaction identifier; NEAR does not expose that hash to the
executing contract. The UI must retain the wallet result/explorer link when deployed.

## Financial and edge-case rules

- The listed USD price is descriptive product metadata. The Testnet escrow accepts only the exact
  native-NEAR amount stored in `price_per_unit`; Testnet NEAR has no redeemable dollar value.
- One cutoff controls joining and voluntary cancellation. A cancellation just before the cutoff
  immediately releases its unit and household capacity and makes only that commitment refundable.
- At or after the cutoff, anyone may finalize. Missing supplier acceptance or insufficient quantity
  produces `Failed` and makes every active contribution refundable.
- Supplier non-fulfillment is a separate failure path. After the fulfillment deadline, anyone may
  call `expire_unfulfilled_purchase`; active contributions become refundable.
- Refund and payment state is changed to pending before an asynchronous transfer. A failed callback
  restores a retryable state and duplicate calls cannot schedule a second payout.

## V3 compatibility

V4 exposes the same authoritative `get_purchase`, `get_funded_members`, and `is_funded_member`
interface shape that V3 needs. The existing deployed V3 remains linked to the existing V2 and must
not be repointed. To enable issues for V4, deploy a separate instance of the current V3 code and
initialize its `v2_contract_id` field with the V4 contract account. The field name is historical;
the code treats it as a read-only purchase-contract interface. V3 rereads the purchase contract in
an asynchronous callback before writing an issue, decision, or resolution, so the browser cannot
assert membership.

## Consumer experience

The browser adapter detects `get_config().version == "V4"` and renders the corrected flow while
retaining deployed V2 purchase, fulfillment, refund, and decision views when configured for V2.
While V2 remains configured, the new-purchase form is visibly marked as a V4 preview and submission
is disabled so it cannot accidentally create the old vote-gated lifecycle. V4 adds:

- product-first cards with supplier business names, listed USD, exact Testnet NEAR, spots, cutoff,
  status, and the relevant action;
- a single conditional creation form for supplier offers and organizer requests;
- a supplier invitation route where only the named connected wallet can accept or decline;
- natural-language agreement, contribution, refund, fulfillment, and payment explanations;
- optional agreement fingerprint and wallet details instead of primary blockchain copy;
- browser Share with Copy Link fallback and a configurable public base URL;
- transaction verification, pending-action reconciliation, and wallet-scoped draft recovery.

No placeholder 70-purchase catalog was added.

## Local test results

Run on 2026-11-09:

- `cargo test -p harvest-pool-v4-contract --lib`: 8 unit tests passed.
- V4 Sandbox: 4 real end-to-end tests passed across authorization, contribution/cancellation,
  concurrent capacity, failure/refund, fulfillment/payment, insufficient gas, and a failed native
  transfer callback. The final complete run passed 4/4 in 244.73 seconds.
- V3 Sandbox: 4 real cross-contract tests passed. The two V2-backed regression journeys passed in
  34.08 seconds. The two V4-backed journeys passed in 40.45 seconds and verified authoritative V4
  membership, frozen voter snapshots, one public vote per account, Yes/No approval and rejection,
  a threshold-winning three-option choice, a three-way `NoConsensus` tie, expiry, supplier consent
  only after passage, financial non-interference, and isolation from the same numeric purchase ID
  on another V4 contract.
- `node --test web/static/*.test.js`: 23 frontend tests passed, including Yes/No normalization,
  three-option preservation, and invalid/duplicate multiple-choice rejection.
- `node --check web/static/app.js`: passed.
- `python3 -m py_compile web/app.py`: passed.
- Port 5010 returned HTTP 200 for all customer routes. No configured visual-automation stack is
  available: Chromium/Playwright are absent, and although macOS includes `safaridriver`, no Selenium
  client or authorized remote Safari session is configured. Screenshot-based desktop/mobile QA and
  live wallet interaction therefore remain manual checks.
- V4 deployable artifact: 225,332 bytes, SHA-256
  `f6da1eb2dc4584045614c2dfdf094f51cc8e7a5845855d6f0127dcd7f4056a3c`.

## Existing V2 versus V4

| Behavior | Existing V2 | New V4 |
| --- | --- | --- |
| Opens after | Fixed-community 2/3 offer vote | Supplier signature |
| Organizer request | No supplier acceptance record | Awaiting supplier, then accept/decline |
| Supplier offer | Still requires community vote | Opens immediately when supplier signs |
| Membership | Exact funded commitment | Exact funded commitment |
| Voluntary cancellation | Separate configured cutoff | Same cutoff as joining |
| Fulfillment approval | Funded households | Funded households |
| Financial storage | Native Testnet NEAR | Native Testnet NEAR; listed USD kept separate |
| Historical state | Preserved | Separate storage and deployment |

## Manual verification

1. Keep the current app pointed at V2 and verify historical V2 purchases and offer voting still load.
2. Reproduce and review the V4 WASM, then deploy it only to a newly authorized Testnet account.
3. Initialize it with the controlled supplier list, including `harvestpool-farmer-1.testnet`.
4. Deploy a separate V3 instance initialized against the V4 account.
5. Set `HARVESTPOOL_CONTRACT_ID`, `HARVESTPOOL_CONTRACT_VERSION=V4`,
   `HARVESTPOOL_V3_CONTRACT_ID`, and the deployed `HARVESTPOOL_PUBLIC_BASE_URL`.
6. At 1440px desktop and 375px mobile widths, run these exact browser checks:
   - Create a Purchase: keyboard through both creation modes; confirm the supplier-offer mode rejects
     a supplier other than the connected wallet; reload and confirm the draft returns.
   - Supplier Creates an Offer: confirm the resulting card is immediately Open with the product and
     supplier business names, listed USD price, and separately labeled exact Testnet NEAR amount.
   - Invite Supplier / Accept or Decline: open the invitation as the named supplier and another
     wallet; verify only the named wallet sees working accept/decline actions and every signed term,
     household cap, date, delivery detail, refund promise, and fingerprint is visible.
   - Explore / Purchase Cards / Details / Sharing: filter every status, open the correct status
     action, copy/share the public URL, and verify shared links do not imply membership.
   - Purchase Agreement / Join & Contribute: verify quantity controls stop at both unit and household
     capacity, listed USD never replaces the exact native Testnet NEAR authorization, and the action
     stays disabled until the agreement checkbox is selected.
   - My Purchases / Refunds: confirm product and supplier names, cancellation only before cutoff,
     Claim refund only for Refundable commitments, and no duplicate action after confirmation.
   - Raise an Issue / My Decisions: confirm only funded members can enter, one choice is recorded,
     duplicate voting is unavailable, and supplier agree/decline appears only to the named supplier.
   - Supplier Dashboard: confirm only assigned purchases appear; evidence form appears only in
     Funded; refresh mid-entry to verify the draft returns; confirm payment amount is clearly shown.
   - Wallet and Transaction Status: test popup approval, rejection, redirect return, slow RPC, and
     refresh during confirmation. The pending banner must prevent resubmission until Check Status
     rereads the authoritative state.
   - Accessibility/responsiveness: use keyboard only, inspect visible focus, labels and live status
     announcements, verify no horizontal scrolling at 375px, and zoom desktop to 200%.
7. For every wallet action, verify the UI waits for an authoritative contract reread and preserves
   the saved form draft when confirmation is uncertain.

## Deployment requirements and remaining work

Deployment requires the user's explicit authorization, approved public business data for the pilot
supplier, a reviewed reproducible build, the two new Testnet accounts, and a public application URL.
See `docs/v4-deployment.md` for the exact handoff. Browser/device accessibility testing and an
independent contract security review remain required. Production additionally requires audited
NEP-141 USDC escrow, external business/authority verification, upgrade governance, monitoring, and
recovery runbooks.
