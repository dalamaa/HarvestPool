/* HarvestPool's browser adapter. Flask never signs, stores, or controls funds. */
(function () {
  "use strict";

  const appConfig = JSON.parse(document.getElementById("app-config").textContent);
  const filterTools = window.HarvestPoolFiltering;
  if (!filterTools) {
    throw new Error("HarvestPool filtering module did not load.");
  }
  const transactionTools = window.HarvestPoolTransactions;
  if (!transactionTools) {
    throw new Error("HarvestPool transaction module did not load.");
  }
  const usdcTools = window.HarvestPoolUsdc;
  if (!usdcTools) throw new Error("HarvestPool USDC payment helpers did not load.");
  const dealFormTools = window.HarvestPoolDealForm;
  if (!dealFormTools) throw new Error("HarvestPool deal form helpers did not load.");
  const dealTimeTools = window.HarvestPoolDealTime;
  if (!dealTimeTools) throw new Error("HarvestPool deal time helpers did not load.");
  const checkoutStateTools = window.HarvestPoolCheckoutState;
  if (!checkoutStateTools) throw new Error("HarvestPool checkout state helpers did not load.");
  const dealCreationTools = window.HarvestPoolDealCreation;
  if (!dealCreationTools) throw new Error("HarvestPool deal creation helpers did not load.");
  const draftTools = window.HarvestPoolDrafts;
  if (!draftTools) {
    throw new Error("HarvestPool form draft module did not load.");
  }
  const confirmationTools = window.HarvestPoolTransactionConfirmation || window.HarvestPoolV3Confirmation;
  if (!confirmationTools) {
    throw new Error("HarvestPool transaction confirmation module did not load.");
  }
  const votingTools = window.HarvestPoolVoting;
  if (!votingTools) {
    throw new Error("HarvestPool voting format module did not load.");
  }
  const actionCenterTools = window.HarvestPoolActionCenter;
  if (!actionCenterTools) throw new Error("HarvestPool action center module did not load.");
  const communityFundTools = window.HarvestPoolCommunityFund;
  if (!communityFundTools) throw new Error("HarvestPool Community Fund helpers did not load.");
  const walletInitializationTools = window.HarvestPoolWalletInitialization;
  if (!walletInitializationTools) throw new Error("HarvestPool wallet initialization helpers did not load.");
  const rpcReadTools = window.HarvestPoolRpcReads;
  if (!rpcReadTools) throw new Error("HarvestPool RPC read helpers did not load.");
  const pendingActionStore = confirmationTools.pendingStore(window.localStorage);
  const archivedActionAlertStore = actionCenterTools.archivedAlertStore(window.localStorage);
  const personalContributionOutcomePrefix = "harvestpool:community-contribution-outcomes:v1";

  function personalContributionOutcomeKey(accountId = state.accountId) {
    return `${personalContributionOutcomePrefix}:${String(appConfig.fundSlug || appConfig.communityDaoId || "fund")}:${String(accountId || "")}`;
  }

  function personalContributionOutcomes(accountId = state.accountId) {
    if (!accountId) return [];
    try {
      const records = JSON.parse(window.localStorage.getItem(personalContributionOutcomeKey(accountId)) || "[]");
      return Array.isArray(records) ? records : [];
    } catch (_error) {
      return [];
    }
  }

  function savePersonalContributionOutcome(action, result) {
    if (!action || action.methodName !== "community_contribute_usdc" || !action.signerId) return;
    const record = result?.record || result?.attempt || {};
    const transactionHash = record.transactionHash || action.transactionHash || null;
    const id = record.attemptId || transactionHash || action.id;
    const outcome = {
      id,
      amount: String(record.amount || action.args?.amount || "0"),
      state: result.state,
      transactionHash,
      receiptId: record.receiptId || null,
      updatedAt: Date.now(),
    };
    const records = personalContributionOutcomes(action.signerId)
      .filter((item) => String(item.id) !== String(id));
    records.unshift(outcome);
    try {
      window.localStorage.setItem(personalContributionOutcomeKey(action.signerId), JSON.stringify(records.slice(0, 25)));
    } catch (_error) {
      // The authoritative receipt and attempt ledgers remain server-side.
    }
  }

  function dismissPersonalContributionOutcome(outcomeId, accountId = state.accountId) {
    if (!outcomeId || !accountId) return false;
    const records = personalContributionOutcomes(accountId)
      .filter((item) => String(item.id) !== String(outcomeId));
    try {
      window.localStorage.setItem(personalContributionOutcomeKey(accountId), JSON.stringify(records));
      return true;
    } catch (_error) {
      return false;
    }
  }
  const submissionGate = confirmationTools.actionGate();
  const state = {
    near: null,
    selector: null,
    wallet: null,
    walletStatus: "initializing",
    actionCreators: null,
    accountId: null,
    members: [],
    suppliers: [],
    config: null,
    purchases: [],
    memberStatus: null,
    fundedMembership: new Map(),
    dataLoaded: false,
    purchaseDiscoveryStatus: "idle",
    liveDataError: null,
    lastVerifiedRefreshAt: 0,
    walletError: null,
    accountDataVerified: false,
    accountDataError: null,
    currentPurchase: null,
    contributionStatus: null,
    nearPrice: null,
    recordedVotes: new Map(),
    issues: [],
    decisions: [],
    v3Config: null,
    v3Available: false,
    v3Error: null,
    detailAuthorityReady: true,
    pendingTransactions: new Set(),
    reconcilingPending: false,
    financialReadiness: null,
    confirmedIssueId: null,
    recoveredCreateRecord: null,
    openFinancialOperationsId: null,
    refreshingLiveData: null,
    lastLiveRefreshAt: 0,
    communityFund: {
      loaded: false,
      error: null,
      config: null,
      policy: null,
      factoryInfo: null,
      version: null,
      availableAmount: null,
      asset: null,
      proposals: [],
      proposalsComplete: false,
      accessKeys: null,
      codeHash: null,
      activity: null,
      activityPromise: null,
      activityRefreshPromise: null,
      recentContributions: [],
      safety: null,
      activeTab: null,
    },
  };

  const CHANGE_METHODS = [
    "create_supplier_offer",
    "create_purchase_request",
    "accept_supplier_request",
    "decline_supplier_request",
    "create_open_purchase",
    "create_purchase",
    "vote_on_offer",
    "commit",
    "ft_transfer_call",
    "cancel_commitment",
    "finalize_purchase",
    "submit_fulfillment_evidence",
    "vote_on_fulfillment",
    "expire_unfulfilled_purchase",
    "release_payment",
    "reconcile_token_balance",
    "claim_refund",
    "raise_issue",
    "request_group_vote",
    "resolve_issue",
    "vote_on_decision",
    "agree_to_decision",
    "decline_decision",
    "expire_decision",
  ];
  const WALLET_INITIALIZATION_TIMEOUT_MS = 15_000;
  const WALLET_SESSION_RESTORE_TIMEOUT_MS = 3_000;
  const WALLET_BUNDLE_VERSION = "2026-11-12.3";
  const YOCTO_PER_NEAR = 10n ** 24n;
  const PRICE_SCALE = 1_000_000n;
  const RECONCILIATION_MAX_AGE_MS = 5 * 60_000;
  const TRANSACTION_BUNDLE_VERSION = "2026-11-13.6";
  const WALLET_RESULT_TIMEOUT_MS = 15_000;
  const EXPLORE_REFRESH_INTERVAL_MS = 15_000;
  const ACTION_CENTER_REFRESH_INTERVAL_MS = 30_000;
  const CREATE_SUBMITTED_KEY = "harvestpool:create-submitted:v1";
  let exploreRefreshTimer = null;
  let actionCenterRefreshTimer = null;
  let communityReconciliationTimer = null;
  let pendingReconciliationPromise = null;
  let publicPurchaseDataRun = null;
  let v3DataRun = null;
  const manualPaymentCheckTimers = new WeakMap();
  let walletInitializationAttempt = 0;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function draftSurface(formOrSurface) {
    if (!formOrSurface) return null;
    if (formOrSurface.id === "agreement-root") return formOrSurface;
    if (formOrSurface.matches?.("[data-draft-form], [data-draft-surface]")) return formOrSurface;
    return formOrSurface.closest?.("[data-draft-form], [data-draft-surface], #agreement-root") || null;
  }

  function draftFormId(surface) {
    return surface?.dataset.draftForm || surface?.dataset.draftSurface || (surface?.id === "agreement-root" ? "contribution" : "");
  }

  function draftContext(surface) {
    const purchaseField = $("[name='purchase_id']", surface);
    return {
      walletId: state.accountId || "unconnected",
      purchaseId: surface?.dataset.draftPurchaseId || surface?.dataset.purchaseId || purchaseField?.value || "global",
      issueId: surface?.dataset.draftIssueId || "global",
    };
  }

  function saveDraft(surface) {
    const target = draftSurface(surface);
    const formId = draftFormId(target);
    if (target && formId) draftTools.save(target, formId, draftContext(target));
  }

  function draftReference(surface) {
    const target = draftSurface(surface);
    const formId = draftFormId(target);
    return target && formId ? { formId, context: draftContext(target) } : null;
  }

  function clearDraftReference(reference) {
    if (!reference?.formId || !reference.context) return false;
    return draftTools.clear(reference.formId, reference.context);
  }

  function pendingForDraft(reference) {
    if (!reference || !state.accountId) return null;
    const expected = draftTools.draftKey(reference.formId, reference.context);
    return pendingActionStore.list(state.accountId).find((action) => {
      const saved = action.context?.draft;
      return saved && draftTools.draftKey(saved.formId, saved.context) === expected;
    }) || null;
  }

  function restoreDraftsInDom() {
    $$('[data-draft-form], [data-draft-surface], #agreement-root').forEach((surface) => {
      const formId = draftFormId(surface);
      if (!formId) return;
      if (surface.id === "agreement-root") surface.dataset.draftSurface = "contribution";
      if (surface.id === "agreement-root" && !$("[data-action='discard-draft']", surface)) {
        const contributeButton = $("[data-action='contribute']", surface);
        if (contributeButton?.parentNode) {
          const discardButton = document.createElement("button");
          discardButton.type = "button";
          discardButton.className = "button button-outline button-small draft-discard-contribution";
          discardButton.dataset.action = "discard-draft";
          discardButton.textContent = "Start fresh";
          contributeButton.parentNode.insertBefore(discardButton, contributeButton);
        }
      }
      const isCreateForm = surface.id === "create-purchase-form";
      const savedDraft = draftTools.read(formId, draftContext(surface));
      const restored = !isCreateForm && draftTools.restore(surface, formId, draftContext(surface));
      const purchaseField = $("[name='purchase_id']", surface);
      if (purchaseField?.value) surface.dataset.draftPurchaseId = purchaseField.value;
      if (restored) {
        surface.dataset.draftRestored = "true";
        const discard = $("[data-action='discard-draft']", surface);
        if (discard) discard.textContent = "Start fresh";
        if (!$(".draft-restored-note", surface)) {
          const actions = $(".draft-actions", surface);
          actions?.insertAdjacentHTML("beforebegin", '<p class="draft-restored-note" role="status">Saved draft restored. Continue where you left off or start fresh.</p>');
        }
      }
      if (isCreateForm && savedDraft && !surface.dataset.draftRestored && !$(".draft-restoration", surface)) {
        const actions = $(".draft-actions", surface);
        const anchor = $(".form-intro", surface) || actions;
        anchor?.insertAdjacentHTML(anchor === actions ? "beforebegin" : "afterend", '<div class="draft-restoration" role="status"><div><strong>Saved draft available</strong><span>Your last unfinished deal is kept on this device.</span></div><div class="draft-restoration-actions"><button class="button button-outline button-small" type="button" data-action="restore-draft">Restore saved draft</button><button class="button button-outline button-small" type="button" data-action="discard-draft">Discard draft</button></div></div>');
      }
      if (pendingForDraft(draftReference(surface))) {
        surface.dataset.v3ConfirmationUncertain = "true";
        const submit = $("button[type='submit'], [data-action='contribute']", surface);
        if (submit) setBusy(submit, true, "Checking submitted action…");
        setTransactionSurfaceBusy(surface, true);
      } else if (surface.dataset.v3ConfirmationUncertain === "true") {
        delete surface.dataset.v3ConfirmationUncertain;
        const submit = $("button[type='submit'], [data-action='contribute']", surface);
        if (submit) {
          delete submit.dataset.submissionLock;
          setBusy(submit, false);
        }
        setTransactionSurfaceBusy(surface, false);
      }
      if (surface.id === "create-purchase-form") {
        updateSaleUnitFields();
        updateSupplierSelection();
        updateCreationModeCopy();
        updateTimezoneControls();
      }
    });
  }

  function migrateUnconnectedCreateDraft() {
    const form = $("#create-purchase-form");
    if (!form || !state.accountId) return false;
    const formId = draftFormId(form);
    const connectedContext = draftContext(form);
    const unconnectedContext = { ...connectedContext, walletId: "unconnected" };
    if (draftTools.read(formId, connectedContext)) return false;
    if (!draftTools.copy(formId, unconnectedContext, connectedContext)) return false;
    restoreDraftForSurface(form);
    draftTools.clear(formId, unconnectedContext);
    updateSaleUnitFields();
    updateCreationModeCopy();
    updateTimezoneControls();
    return true;
  }

  function showCreateConnectionFollowup() {
    if (!state.accountId || appConfig.page !== "create") return false;
    const selectedMode = dealCreationTools.consumeConnectionIntent(window.sessionStorage);
    if (!selectedMode) return false;
    migrateUnconnectedCreateDraft();
    setCreateError(selectedMode.connected);
    showToast("Wallet connected. No deal transaction was submitted.", "success");
    return true;
  }

  function clearDraft(surface) {
    const target = draftSurface(surface);
    const formId = draftFormId(target);
    if (target && formId) draftTools.clear(formId, draftContext(target));
  }

  function clearDraftForContext(surface, context = {}) {
    const target = draftSurface(surface);
    const formId = draftFormId(target);
    if (!target || !formId) return;
    draftTools.clear(formId, { ...draftContext(target), ...context });
  }

  function restoreDraftForSurface(surface) {
    const target = draftSurface(surface);
    const formId = draftFormId(target);
    if (!target || !formId || !draftTools.restore(target, formId, draftContext(target))) return false;
    target.dataset.draftRestored = "true";
    $(".draft-restoration", target)?.remove();
    const discard = $("[data-action='discard-draft']", target);
    if (discard) discard.textContent = "Start fresh";
    if (!$(".draft-restored-note", target)) {
      const actions = $(".draft-actions", target);
      actions?.insertAdjacentHTML("beforebegin", '<p class="draft-restored-note" role="status">Saved draft restored. Continue where you left off or start fresh.</p>');
    }
    if (target.id === "create-purchase-form") {
      updateSaleUnitFields();
      updateSupplierSelection();
      updateCreationModeCopy();
      updateTimezoneControls();
    }
    return true;
  }

  function technicalDetailsMarkup(error) {
    const detail = String(error?.message || error || "Unknown transaction error").slice(0, 1600);
    const hash = String(error?.transactionHash || "");
    const transactionLink = hash
      ? `<p>Transaction: <a href="https://testnet.nearblocks.io/txns/${encodeURIComponent(hash)}" target="_blank" rel="noopener noreferrer"><code>${escapeHtml(hash)}</code></a></p>`
      : "";
    return `<details class="technical-details"><summary>Technical details</summary><code>${escapeHtml(detail)}</code>${transactionLink}</details>`;
  }

  function setErrorSummary(container, message, error = null) {
    if (!container) return;
    container.innerHTML = message ? `${escapeHtml(message)}${error ? technicalDetailsMarkup(error) : ""}` : "";
    container.hidden = !message;
    if (message) container.focus();
  }

  function showFormTransactionError(form, message, error = null) {
    if (!form) return;
    let summary = $(".form-error-summary", form);
    if (!summary) {
      summary = document.createElement("div");
      summary.className = "form-error-summary";
      summary.tabIndex = -1;
      summary.setAttribute("role", "alert");
      form.insertBefore(summary, $(".draft-actions", form) || form.lastElementChild);
    }
    setErrorSummary(summary, message, error);
  }

  function appendV3CheckAction(form, kind) {
    const summary = $(".form-error-summary", form);
    if (!summary || $("[data-action='check-v3-confirmation']", summary)) return;
    const check = document.createElement("button");
    check.type = "button";
    check.className = "button button-outline button-small confirmation-check";
    check.dataset.action = "check-v3-confirmation";
    check.dataset.confirmationKind = kind;
    check.textContent = "Check on-chain state";
    summary.appendChild(check);
  }

  function markV3ConfirmationUncertain(form, button, kind) {
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
      button.textContent = actionProgressCopy(kind === "issue" ? "raise_issue" : "request_group_vote");
    }
    form.dataset.v3ConfirmationUncertain = "true";
    showFormTransactionError(form, "We haven't confirmed the result yet. Please don't submit again while we check.");
  }

  function clearV3ConfirmationUncertainty(form) {
    delete form.dataset.v3ConfirmationUncertain;
  }

  function editableSurfaceOpen() {
    return Boolean($("[data-draft-form], [data-draft-surface]"));
  }

  function discardDraftForSurface(surface) {
    const target = draftSurface(surface);
    if (!target) return;
    clearDraft(target);
    if (typeof target.reset === "function") target.reset();
    if (target.id === "create-purchase-form") setCreateDefaults();
    if (target.id === "agreement-root") {
      const quantity = $("#contribution-quantity", target);
      const acceptance = $("#agreement-acceptance", target);
      if (quantity) quantity.value = "1";
      if (acceptance) acceptance.checked = false;
      updateContributionTotal();
      updateAgreementAcceptance();
    }
    $(".form-error-summary", target)?.replaceChildren();
    $(".form-error-summary", target)?.setAttribute("hidden", "");
    delete target.dataset.draftRestored;
    $(".draft-restored-note", target)?.remove();
    $(".draft-restoration", target)?.remove();
    const discard = $("[data-action='discard-draft']", target);
    if (discard) discard.textContent = "Start fresh";
    showToast("Started a clean form. This action's saved draft was removed.");
  }

  function handleDraftContextChange(field) {
    const surface = draftSurface(field);
    if (!surface || field.name !== "purchase_id") return;
    const previousPurchaseId = surface.dataset.draftPurchaseId;
    const nextPurchaseId = String(field.value || "global");
    if (previousPurchaseId && previousPurchaseId !== nextPurchaseId) {
      const currentPurchaseId = field.value;
      field.value = previousPurchaseId;
      saveDraft(surface);
      field.value = currentPurchaseId;
      surface.dataset.draftPurchaseId = nextPurchaseId;
      const saved = draftTools.read(draftFormId(surface), draftContext(surface));
      if (saved) {
        draftTools.restore(surface, draftFormId(surface), draftContext(surface));
      } else {
        draftTools.fields(surface).forEach((draftField) => {
          if (draftField.name === "purchase_id") return;
          if (draftField.type === "checkbox" || draftField.type === "radio") draftField.checked = false;
          else draftField.value = "";
        });
      }
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function shortAccount(value) {
    const text = String(value || "");
    return text.length > 27 ? `${text.slice(0, 13)}…${text.slice(-11)}` : text;
  }

  function showToast(message, type = "") {
    const toast = $("#toast");
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => { toast.className = "toast"; }, 5200);
  }

  function showError(container, title, message, action = "") {
    if (!container) return;
    container.innerHTML = `<div class="error-state"><div class="empty-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5M12 17h.01"/></svg></div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>${action}</div>`;
  }

  function reviewTransaction({ title, summary, signer, receiver, method, args, gas, deposit, warning, confirmLabel = "Continue to Meteor" }) {
    const backdrop = $("#transaction-review");
    if (!backdrop) return Promise.resolve(false);
    const dialog = $(".transaction-review-dialog", backdrop);
    if (!dialog) return Promise.resolve(false);
    const previousFocus = document.activeElement;
    $("#transaction-review-title").textContent = title;
    $("#transaction-review-summary").textContent = summary;
    const values = { signer, receiver, method, arguments: JSON.stringify(args), gas, deposit };
    Object.entries(values).forEach(([field, value]) => {
      const target = $(`[data-review-field="${field}"]`, backdrop);
      if (target) target.textContent = String(value);
    });
    $("[data-review-warning]", backdrop).textContent = warning;
    const confirmButton = $("[data-review-confirm]", backdrop);
    const cancelButton = $("[data-review-cancel]", backdrop);
    confirmButton.textContent = confirmLabel;
    backdrop.removeAttribute("hidden");
    cancelButton.focus();
    return new Promise((resolve) => {
      const finish = (approved) => {
        backdrop.setAttribute("hidden", "");
        confirmButton.removeEventListener("click", approve);
        cancelButton.removeEventListener("click", cancel);
        backdrop.removeEventListener("click", cancelFromBackdrop);
        document.removeEventListener("keydown", cancelFromKeyboard);
        if (previousFocus?.focus) previousFocus.focus();
        resolve(approved);
      };
      const approve = () => finish(true);
      const cancel = () => finish(false);
      const cancelFromBackdrop = (event) => { if (event.target === backdrop) cancel(); };
      const cancelFromKeyboard = (event) => {
        if (event.key === "Escape") {
          cancel();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = [cancelButton, confirmButton].filter((item) => item && !item.disabled);
        const current = focusable.indexOf(document.activeElement);
        if (event.shiftKey && (current <= 0)) {
          event.preventDefault();
          focusable[focusable.length - 1]?.focus();
        } else if (!event.shiftKey && current === focusable.length - 1) {
          event.preventDefault();
          focusable[0]?.focus();
        }
      };
      confirmButton.addEventListener("click", approve);
      cancelButton.addEventListener("click", cancel);
      backdrop.addEventListener("click", cancelFromBackdrop);
      document.addEventListener("keydown", cancelFromKeyboard);
    });
  }

  function setBusy(button, busy, label = "Working…") {
    if (!button) return;
    if (busy) {
      if (!button.dataset.originalLabel) button.dataset.originalLabel = button.innerHTML;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.textContent = label;
    } else {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      if (button.dataset.originalLabel) button.innerHTML = button.dataset.originalLabel;
    }
  }

  function setTransactionSurfaceBusy(surface, busy) {
    const target = draftSurface(surface) || (surface?.matches?.("form") ? surface : null);
    if (!target) return;
    $$('[data-action="discard-draft"]', target).forEach((button) => {
      button.disabled = busy;
      button.setAttribute("aria-disabled", String(busy));
    });
  }

  async function runGuardedSubmission(surface, work, label = "Preparing wallet request…") {
    if (!surface || !submissionGate.begin(surface)) return null;
    const button = surface.matches?.("button") ? surface : $("button[type=submit]", surface);
    setBusy(button, true, label);
    setTransactionSurfaceBusy(surface, true);
    try {
      return await work();
    } finally {
      const keepLocked = button?.dataset.submissionLock === "true"
        || surface.dataset?.v3ConfirmationUncertain === "true";
      submissionGate.finish(surface, { keepLocked });
      if (!keepLocked && button?.isConnected) setBusy(button, false);
      setTransactionSurfaceBusy(surface, keepLocked);
    }
  }

  function formatNear(yocto) {
    try {
      const base = 1000000000000000000000000n;
      const raw = BigInt(String(yocto || "0"));
      const whole = raw / base;
      const remainder = (raw % base).toString().padStart(24, "0").replace(/0+$/, "");
      return remainder ? `${whole}.${remainder}` : String(whole);
    } catch (_error) {
      return "—";
    }
  }

  function isV5(purchase = state.currentPurchase) {
    return String(purchase?.version || state.config?.version || appConfig.contractVersion || "").toUpperCase() === "V5";
  }

  function paymentLabel(purchase, amount) {
    const version = purchase?.version || state.config?.version || appConfig.contractVersion;
    const decimals = Number(purchase?.token_decimals ?? state.config?.token_decimals ?? 6);
    return usdcTools.formatPayment(amount, version, decimals);
  }

  function paymentAsset(purchase = state.currentPurchase) {
    return usdcTools.paymentAsset(
      purchase?.version || state.config?.version || appConfig.contractVersion,
      Number(purchase?.token_decimals ?? state.config?.token_decimals ?? 6),
    );
  }

  function parseNearAmount(value) {
    const normalized = String(value ?? "").trim();
    if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
    const [wholePart, fractionPart = ""] = normalized.split(".");
    if (fractionPart.length > 24) return null;
    const fraction = fractionPart.padEnd(24, "0");
    return (BigInt(wholePart) * 10n ** 24n + BigInt(fraction || "0")).toString();
  }

  function parseScaledDecimal(value, scale = PRICE_SCALE) {
    const normalized = String(value ?? "").trim();
    if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
    const [wholePart, fractionPart = ""] = normalized.split(".");
    const scaleDigits = String(scale).length - 1;
    if (fractionPart.length > scaleDigits) {
      const kept = fractionPart.slice(0, scaleDigits);
      const rounded = fractionPart[scaleDigits] >= "5" ? BigInt(kept || "0") + 1n : BigInt(kept || "0");
      return BigInt(wholePart) * scale + rounded;
    }
    return BigInt(wholePart) * scale + BigInt(fractionPart.padEnd(scaleDigits, "0") || "0");
  }

  function groupInteger(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  const UNIT_SEPARATOR = " || ";
  function unitDetails(purchaseOrValue) {
    const raw = String(typeof purchaseOrValue === "object" ? purchaseOrValue?.quantity_unit : purchaseOrValue || "unit");
    const [unitValue, ...contentsParts] = raw.split(UNIT_SEPARATOR);
    return { unit: unitValue.trim() || "unit", contents: contentsParts.join(UNIT_SEPARATOR).trim() };
  }

  function pluralUnit(unitValue, count = 2) {
    return dealFormTools.pluralUnit(unitValue, count);
  }

  function quantityLabel(purchase, count) {
    const { unit } = unitDetails(purchase);
    return `${groupInteger(count)} ${escapeHtml(pluralUnit(unit, count))}`;
  }

  function packageContentsMarkup(purchase) {
    const { unit, contents } = unitDetails(purchase);
    return contents ? `<p class="package-contents">Each ${escapeHtml(unit)} contains ${escapeHtml(contents)}.</p>` : "";
  }

  function supplierAccount(purchase) {
    return purchase?.supplier_id || purchase?.farmer_id || "";
  }

  function actionProgressCopy(methodName) {
    if (methodName === "create_supplier_offer") return dealCreationTools.mode("supplier_offer").progress;
    if (methodName === "create_purchase_request") return dealCreationTools.mode("organizer_request").progress;
    if (["create_purchase", "create_open_purchase"].includes(methodName)) return "Publishing your deal…";
    if (["commit", "commit_usdc"].includes(methodName)) return "Securing your spot…";
    if (methodName === "community_contribute_usdc") return "Confirming your Community Fund contribution…";
    if (methodName === "raise_issue") return "Confirming your issue…";
    if (methodName === "request_group_vote") return "Confirming your vote request…";
    if (methodName === "reconcile_token_balance") return "Recording a fresh escrow snapshot…";
    if (["vote_on_offer", "vote_on_fulfillment", "vote_on_decision"].includes(methodName)) return "Recording your vote…";
    if (methodName === "submit_fulfillment_evidence") return isV5() ? "Submitting simulated Testnet evidence…" : "Submitting fulfillment evidence…";
    return "Saving your update…";
  }

  function formatUsdFromYocto(yocto) {
    const priceMicros = parseScaledDecimal(state.nearPrice?.usd);
    if (priceMicros === null || priceMicros <= 0n) return "USD unavailable";
    try {
      const raw = BigInt(String(yocto || "0"));
      const usdMicros = (raw * priceMicros + YOCTO_PER_NEAR / 2n) / YOCTO_PER_NEAR;
      const cents = (usdMicros + 5_000n) / 10_000n;
      const dollars = cents / 100n;
      const remainder = (cents % 100n).toString().padStart(2, "0");
      return `$${groupInteger(dollars)}.${remainder}`;
    } catch (_error) {
      return "USD unavailable";
    }
  }

  function moneyMarkup(amount, suffix = "", purchase = state.currentPurchase) {
    return `<span class="money-primary">${escapeHtml(paymentLabel(purchase, amount))}${escapeHtml(suffix)}</span>`;
  }

  function usdFromTokenUnits(amount, decimals = Number(state.config?.token_decimals || 6)) {
    return usdcTools.formatDollars(amount, decimals);
  }

  function customerPaymentLabel(purchase, amount) {
    return isV5(purchase)
      ? usdFromTokenUnits(amount, Number(purchase?.token_decimals ?? state.config?.token_decimals ?? 6))
      : paymentLabel(purchase, amount);
  }

  function testPaymentLabel(purchase, amount) {
    const label = paymentLabel(purchase, amount);
    return isV5(purchase) ? label.replace(" USDC", " test USDC") : label;
  }

  function listedUsd(purchase) {
    try {
      const cents = BigInt(String(purchase?.listed_price_usd_cents || "0"));
      if (cents <= 0n) return null;
      return `$${groupInteger(cents / 100n)}.${(cents % 100n).toString().padStart(2, "0")}`;
    } catch (_error) {
      return null;
    }
  }

  function formatQuoteTime(value) {
    if (!value) return "unknown time";
    try {
      return dealTimeTools.formatZoned(new Date(value), dealTimeTools.browserTimeZone());
    } catch (_error) {
      return "unknown time";
    }
  }

  function updatePriceStatus() {
    const status = $("#near-price-status");
    if (!status) return;
    status.textContent = isV5()
      ? "Listed USD prices · payment details shown at checkout"
      : `Listed USD price first · exact ${paymentAsset().displayName} shown at checkout`;
  }

  async function loadNearPrice() {
    try {
      const response = await fetch("/api/near-price", { headers: { Accept: "application/json" } });
      const payload = await response.json();
      if (!response.ok || !payload.usd) throw new Error(payload.error || "price source unavailable");
      state.nearPrice = payload;
    } catch (_error) {
      state.nearPrice = null;
    }
    updatePriceStatus();
    updateCreatePricePreview();
  }

  function formatDate(ns, _includeTime = false) {
    return dealTimeTools.formatInstant(ns, businessTimeZone(), dealTimeTools.browserTimeZone());
  }

  function formatStatus(status) {
    const labels = {
      Proposed: "Needs approval",
      AwaitingSupplier: "Awaiting supplier confirmation",
      Declined: "Supplier declined",
      Open: "Open for contributions",
      Funded: "Funded · awaiting fulfillment",
      FulfillmentPending: "Fulfillment review",
      FulfillmentApproved: "Fulfillment approved",
      PaymentPending: "Payment pending",
      Completed: "Completed",
      Failed: "Failed · refunds available",
      Canceled: "Canceled",
      Cancelled: "Canceled",
      Expired: "Expired",
      Refunded: "Refunded",
      DeadlinePassed: "Closed · final result pending",
    };
    return labels[status] || status || "Unknown state";
  }

  function statusClass(status) {
    if (status === "Proposed" || status === "AwaitingSupplier") return "status-proposed";
    if (["Declined", "Failed", "Canceled", "Cancelled", "Expired"].includes(status)) return "status-failed";
    if (status === "Open") return "status-open";
    if (status === "Failed") return "status-failed";
    if (status === "PaymentPending" || status === "FulfillmentPending" || status === "DeadlinePassed") return "status-pending";
    return "status-funded";
  }

  function statusPill(status) {
    return `<span class="status ${statusClass(status)}"><span></span>${escapeHtml(formatStatus(status))}</span>`;
  }

  function presentationState(purchase) {
    return purchase && ["Open", "AwaitingSupplier"].includes(purchase.state) && deadlineHasPassed(purchase.deadline_ns)
      ? "DeadlinePassed"
      : purchase?.state;
  }

  function participantCount(purchase) {
    return new Set((purchase?.commitments || [])
      .filter((commitment) => commitment && commitment.account_id)
      .map((commitment) => String(commitment.account_id))).size;
  }

  function failureReason(purchase) {
    if (purchase?.state !== "Failed") return "";
    if (Number(purchase.total_quantity || 0) < Number(purchase.min_quantity || 0)) {
      return "The deal closed below its minimum quantity.";
    }
    if (!purchase.fulfillment_evidence_hash && deadlineHasPassed(purchase.fulfillment_evidence_deadline_ns)) {
      return "The fulfillment deadline passed without confirmed evidence.";
    }
    return "The contract marked this deal failed under its fulfillment and refund rules.";
  }

  function terminalOutcomeMarkup(purchase) {
    const outcome = {
      Canceled: ["Canceled.", "The buyer commitment was canceled under the contract rules."],
      Cancelled: ["Canceled.", "The buyer commitment was canceled under the contract rules."],
      Expired: ["Expired.", "The deal expired without reaching its next contract state."],
      Refunded: ["Refunded.", "The associated commitment was refunded."],
    }[purchase?.state];
    if (!outcome) return "";
    return `<p class="deal-outcome deal-outcome-failed"><strong>${escapeHtml(outcome[0])}</strong> ${escapeHtml(outcome[1])}</p>`;
  }

  function refundNoticeMarkup(purchase) {
    const commitment = commitmentFor(purchase);
    if (!commitment || !["Refundable", "RefundPending", "Refunded"].includes(commitment.state)) return "";
    const copy = commitment.state === "Refundable"
      ? `${customerPaymentLabel(purchase, commitment.amount)} is available to claim.`
      : commitment.state === "RefundPending"
        ? "Your refund transaction is awaiting authoritative confirmation. Do not submit it again."
        : `${customerPaymentLabel(purchase, commitment.amount)} was refunded.`;
    return `<div class="refund-notice"><strong>${commitment.state === "Refundable" ? "Refund ready" : commitment.state === "Refunded" ? "Refund complete" : "Refund pending"}</strong><span>${escapeHtml(copy)}</span>${commitment.state === "Refundable" ? `<a href="/dashboard#action-refund-${encodeURIComponent(purchase.id)}">Claim in My Group Buys</a>` : ""}</div>`;
  }

  function activeCommitments(purchase) {
    return (purchase && purchase.commitments || []).filter((commitment) => commitment.state === "Active");
  }

  function availableCapacity(purchase) {
    return Math.max(0, Number(purchase.max_quantity || 0) - Number(purchase.total_quantity || 0));
  }

  function spotLabel(count) {
    const value = Math.max(0, Number(count || 0));
    return `${value} spot${value === 1 ? "" : "s"} left`;
  }

  function refundRateLabel(bps) {
    const rate = Number(bps || 0) / 100;
    return Number.isInteger(rate) ? `${rate}%` : `${rate.toFixed(2)}%`;
  }

  function fundedMemberCount(purchase) {
    return Number.isFinite(Number(purchase?.funded_member_count))
      ? Number(purchase.funded_member_count)
      : activeCommitments(purchase).length;
  }

  function maxFundedMembers(purchase) {
    const fallback = Number(state.config?.member_count || activeCommitments(purchase).length || 0);
    return Number(purchase?.max_funded_members || fallback);
  }

  function fundedMemberCapacity(purchase) {
    return Math.max(0, maxFundedMembers(purchase) - fundedMemberCount(purchase));
  }

  function fundedCapacityLabel(purchase) {
    const value = maxFundedMembers(purchase);
    return `${value} household${value === 1 ? "" : "s"}`;
  }

  function isOpenMembership(purchase) {
    return ["V4", "V5"].includes(String(purchase?.version || "").toUpperCase()) || purchase?.open_membership === true;
  }

  function isMember() {
    return state.memberStatus !== null
      ? state.memberStatus
      : Boolean(state.accountId && state.members.some((member) => String(member) === String(state.accountId)));
  }

  function confirmedTransaction(outcome) {
    const result = confirmationTools.classifyOutcome(outcome);
    if (result.state === "uncertain") {
      const error = new Error("The wallet did not return a transaction status.");
      error.transactionState = "pending";
      throw error;
    }
    if (result.state === "failed") {
      const error = new Error(result.message);
      error.transactionState = "failed";
      error.transactionHash = confirmationTools.transactionHash(outcome);
      throw error;
    }
    return result.outcome;
  }

  function commitmentFor(purchase) {
    return (purchase && purchase.commitments || []).find((commitment) => String(commitment.account_id) === String(state.accountId));
  }

  function isFundedMember(purchase) {
    const commitment = commitmentFor(purchase);
    const viewValue = state.fundedMembership.get(String(purchase?.id));
    return viewValue !== undefined ? viewValue : Boolean(commitment && commitment.state === "Active");
  }

  function actionCenterTasks({ scope = "active" } = {}) {
    const accountVerified = accountAuthorityReady();
    const tasks = actionCenterTools.eligibleTasks({
      accountId: state.accountId,
      purchases: accountVerified ? state.purchases : [],
      issues: accountVerified ? state.issues : [],
      decisions: accountVerified ? state.decisions : [],
      votes: state.recordedVotes,
      pending: state.accountId ? pendingActionStore.list(state.accountId) : [],
      isMember: isMember(),
    });
    if (scope === "all") return tasks;
    return tasks.filter((task) => {
      const archived = task.kind === "pending-transaction"
        && archivedActionAlertStore.has(task.actionId);
      return scope === "archived" ? archived : !archived;
    });
  }

  function taskHref(task) {
    if (task.kind === "refund") return `/dashboard#action-${encodeURIComponent(task.id)}`;
    if (task.kind === "supplier-invitation") return `/supplier-invitations/${encodeURIComponent(task.purchaseId)}#supplier-response`;
    if (task.kind === "supplier-consent") return `/decisions#action-${encodeURIComponent(task.id)}`;
    if (task.kind === "pending-transaction") return `/decisions#action-${encodeURIComponent(task.id)}`;
    return `/decisions#action-${encodeURIComponent(task.id)}`;
  }

  function taskLabel(task) {
    if (task.kind === "pending-transaction" && task.methodName === "community_contribute_usdc") {
      return task.transactionHash
        ? "A submitted payment is awaiting confirmation"
        : "A payment attempt needs a status check";
    }
    const labels = {
      "offer-vote": "An offer vote needs your decision",
      "fulfillment-vote": "Fulfillment evidence needs your approval",
      "community-vote": "A community vote is open for you",
      "supplier-consent": "A passed proposal needs your supplier response",
      "supplier-invitation": "A Group Deal proposal needs your review",
      refund: "Your refund is ready to claim",
      "pending-transaction": "A saved action still needs confirmation",
    };
    return labels[task.kind] || "An action needs your attention";
  }

  function actionAlertsMarkup(tasks, title = "Needs your attention") {
    if (!tasks.length) return "";
    return `<section class="action-alerts" aria-label="${escapeHtml(title)}"><div><strong>${escapeHtml(title)}</strong><span>${tasks.length} eligible ${tasks.length === 1 ? "action" : "actions"}</span></div><div class="action-alert-links">${tasks.slice(0, 3).map((task) => `<a href="${taskHref(task)}">${escapeHtml(taskLabel(task))}${task.purchaseId ? ` · Deal #${escapeHtml(task.purchaseId)}` : ""}</a>`).join("")}</div></section>`;
  }

  function updateActionCenterCount() {
    const count = $("#action-center-count");
    if (!count) return;
    const total = actionCenterTasks().length;
    count.hidden = total === 0;
    count.textContent = total > 99 ? "99+" : String(total);
    count.setAttribute("aria-label", `${total} pending ${total === 1 ? "action" : "actions"}`);
  }

  function focusHashTarget() {
    let id = "";
    try { id = decodeURIComponent(String(window.location.hash || "").replace(/^#/, "")); }
    catch (_error) { return; }
    if (!id) return;
    window.requestAnimationFrame(() => {
      const target = document.getElementById(id);
      if (!target) return;
      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      target.scrollIntoView({ block: "start" });
      target.focus({ preventScroll: true });
    });
  }

  function voteStateKey(purchaseId, type) {
    return `${type}:${purchaseId}`;
  }

  function recordedVote(purchaseId, type) {
    if (!state.accountId) return null;
    return state.recordedVotes.get(voteStateKey(purchaseId, type)) || null;
  }

  function recordVote(purchaseId, type, approve) {
    // This is only a same-session rendering guard after a confirmed wallet outcome. When the
    // additive V2 read methods are available, loadWalletState replaces it with contract state.
    state.recordedVotes.set(voteStateKey(purchaseId, type), { approve });
  }

  function deadlineHasPassed(deadlineNs) {
    try {
      return BigInt(Date.now()) * 1000000n >= BigInt(String(deadlineNs));
    } catch (_error) {
      return false;
    }
  }

  function icon(name) {
    const icons = {
      shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 7v5c0 4.5 3.4 7.9 8 9 4.6-1.1 8-4.5 8-9V7l-8-4Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></svg>',
      leaf: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21c0-7.7 4.2-13.2 12-16 0 8.2-3.9 13-12 16Z"/><path d="M6 21c1.8-4.2 4.8-7.5 9.4-10.2"/></svg>',
      link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1L11 5"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1-1"/></svg>',
    };
    return icons[name] || icons.shield;
  }

  async function setupNear() {
    const attempt = ++walletInitializationAttempt;
    state.near = { networkId: "testnet", nodeUrl: "https://test.rpc.fastnear.com" };
    state.walletStatus = "initializing";
    state.walletError = null;
    updateWalletUi();
    try {
      const initialized = await walletInitializationTools.withTimeout((async () => {
        const { setupWalletSelector, actionCreators, setupMeteorWallet } = await import(
          `/static/wallet-selector-bundle.js?v=${WALLET_BUNDLE_VERSION}`
        );
        const selector = await setupWalletSelector({
          network: "testnet",
          modules: [setupMeteorWallet()],
        });
        const wallet = await selector.wallet("meteor-wallet");
        return { actionCreators, selector, wallet };
      })(), WALLET_INITIALIZATION_TIMEOUT_MS);
      if (attempt !== walletInitializationAttempt) return false;
      state.selector = initialized.selector;
      state.actionCreators = initialized.actionCreators;
      state.wallet = initialized.wallet;
      let accounts = [];
      try {
        accounts = await walletInitializationTools.withTimeout(
          state.wallet.getAccounts(),
          WALLET_SESSION_RESTORE_TIMEOUT_MS,
          "Wallet session restoration timed out.",
        );
      } catch (error) {
        console.info("Meteor wallet session restoration is retrying after a temporary failure.", error);
        try {
          accounts = await walletInitializationTools.withTimeout(
            state.wallet.getAccounts(),
            WALLET_SESSION_RESTORE_TIMEOUT_MS,
            "Wallet session restoration timed out.",
          );
        } catch (retryError) {
          console.info("Meteor has no restorable wallet session.", retryError);
        }
      }
      await applyWalletAccounts(accounts);
      state.selector.store?.observable?.subscribe(() => syncWalletAccount());
      return true;
    } catch (error) {
      if (attempt !== walletInitializationAttempt) return false;
      console.error("HarvestPool wallet initialization failed.", error);
      state.walletError = error;
      state.wallet = null;
      state.walletStatus = "unavailable";
      showToast(walletInitializationTools.failureMessage(error), "error");
    }
    updateWalletUi();
    return false;
  }

  async function applyWalletAccounts(accounts) {
    const previousAccountId = state.accountId;
    state.accountId = accounts?.[0]?.accountId || null;
    state.walletStatus = state.accountId ? "connected" : "disconnected";
    if (state.accountId && !previousAccountId) migrateUnconnectedCreateDraft();
    state.memberStatus = null;
    state.fundedMembership = new Map();
    state.recordedVotes = new Map();
    state.accountDataVerified = !state.accountId;
    state.accountDataError = null;
    updateWalletUi();
    window.dispatchEvent(new CustomEvent("harvestpool:wallet-account", {
      detail: { accountId: state.accountId },
    }));
    if (appConfig.page === "decisions" && !state.dataLoaded) renderDecisions();
    if (state.dataLoaded) {
      await loadWalletState({ strict: appConfig.page === "details" });
      updateWalletUi();
      const accountChanged = String(previousAccountId || "") !== String(state.accountId || "");
      if (accountChanged || !editableSurfaceOpen()) renderCurrentPage();
      else restoreDraftsInDom();
    } else if (appConfig.page === "community_fund" && state.communityFund.loaded) {
      await loadCommunityAccountAsset();
      updateWalletUi();
      renderCurrentPage();
    }
  }

  async function syncWalletAccount() {
    if (!state.wallet || typeof state.wallet.getAccounts !== "function") {
      await applyWalletAccounts([]);
      return;
    }
    try {
      await applyWalletAccounts(await state.wallet.getAccounts());
    } catch (_error) {
      state.walletStatus = state.accountId ? "connected" : "disconnected";
      updateWalletUi();
      if (appConfig.page === "decisions") renderDecisions();
    }
  }

  function encodeArgs(args) {
    const bytes = new TextEncoder().encode(JSON.stringify(args || {}));
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  async function viewOnContract(contractId, methodName, args = {}) {
    if (!state.near) throw new Error("The testnet connection is not ready.");
    const payload = await rpcReadTools.fetchJsonWithRetry(fetch, state.near.nodeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "harvestpool-ui",
        method: "query",
        params: { request_type: "call_function", finality: "final", account_id: contractId, method_name: methodName, args_base64: encodeArgs(args) },
      }),
    }, { retryPayload: rpcReadTools.transientRpcPayload });
    if (!payload || typeof payload !== "object" || payload.error || !payload.result || !Array.isArray(payload.result.result)) {
      throw new Error(payload?.error?.message || "The testnet returned an invalid JSON-RPC response.");
    }
    const raw = new TextDecoder().decode(new Uint8Array(payload.result.result));
    return JSON.parse(raw);
  }

  async function rpcRequest(method, params) {
    if (!state.near) throw new Error("The testnet connection is not ready.");
    const payload = await rpcReadTools.fetchJsonWithRetry(fetch, state.near.nodeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "harvestpool-community-fund", method, params }),
    }, { retryPayload: rpcReadTools.transientRpcPayload });
    if (!payload || typeof payload !== "object" || payload.error || !Object.prototype.hasOwnProperty.call(payload, "result")) {
      throw new Error(payload?.error?.message || "The testnet returned an invalid JSON-RPC response.");
    }
    return payload.result;
  }

  function queryRpc(params) {
    return rpcRequest("query", params);
  }

  async function fetchCommunityActivity(refreshActivity = false) {
    return fetch(`${appConfig.communityActivityUrl || "/api/community-fund/activity"}${refreshActivity ? "?refresh=1" : ""}`, {
      headers: { Accept: "application/json" },
    }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Transaction history is unavailable.");
      return payload;
    }).catch((error) => ({ error: String(error?.message || error) }));
  }

  function applyCommunityActivity(activityResult) {
    const fund = state.communityFund;
    if (activityResult.error && (fund.activity?.contributions || []).length) {
      fund.activity = { ...fund.activity, refreshError: activityResult.error, stale: true };
      return fund.activity;
    }
    const indexedContributions = activityResult.contributions || [];
    const recentContributions = fund.recentContributions.filter((recent) =>
      !indexedContributions.some((item) => item.transactionHash === recent.transactionHash)
    );
    fund.activity = activityResult.error ? activityResult : {
      ...activityResult,
      contributions: [...indexedContributions, ...recentContributions],
    };
    return fund.activity;
  }

  async function loadPersistedCommunityActivity() {
    const activity = await fetchCommunityActivity(false);
    applyCommunityActivity(activity);
    renderCurrentPage();
    document.documentElement.dataset.harvestpoolUsefulContentMs = performance.now().toFixed(1);
    return activity;
  }

  function refreshCommunityActivityInBackground() {
    const fund = state.communityFund;
    if (fund.activityRefreshPromise) return fund.activityRefreshPromise;
    fund.activityRefreshPromise = fetchCommunityActivity(true)
      .then((activity) => {
        applyCommunityActivity(activity);
        renderCurrentPage();
        return activity;
      })
      .finally(() => { fund.activityRefreshPromise = null; });
    return fund.activityRefreshPromise;
  }

  async function loadCommunityAccountAsset() {
    const fund = state.communityFund;
    const goal = appConfig.communityGoal || {};
    if (goal.currency !== "USDC" || !fund.asset) return;
    const tokenId = String(goal.tokenId || "");
    const [accountStorage, accountBalance] = await Promise.all([
      state.accountId ? viewOnContract(tokenId, "storage_balance_of", { account_id: state.accountId }) : Promise.resolve(null),
      state.accountId ? viewOnContract(tokenId, "ft_balance_of", { account_id: state.accountId }) : Promise.resolve("0"),
    ]);
    fund.asset.accountStorage = accountStorage;
    fund.asset.accountBalance = String(accountBalance || "0");
  }

  async function loadCommunityFundData({ refreshActivity = false, deferActivity = false, loadActivity = true } = {}) {
    const fund = state.communityFund;
    if (!appConfig.communityDaoId) {
      fund.loaded = true;
      fund.error = null;
      return fund;
    }
    try {
      const daoId = appConfig.communityDaoId;
      const activityPromise = loadActivity ? fetchCommunityActivity(refreshActivity) : Promise.resolve(fund.activity || {});
      fund.activityPromise = activityPromise;
      const [config, policy, factoryInfo, version, availableAmount, lastProposalId, accessKeyResult, accountResult] = await Promise.all([
        viewOnContract(daoId, "get_config"),
        viewOnContract(daoId, "get_policy"),
        viewOnContract(daoId, "get_factory_info"),
        viewOnContract(daoId, "version"),
        viewOnContract(daoId, "get_available_amount"),
        viewOnContract(daoId, "get_last_proposal_id"),
        queryRpc({ request_type: "view_access_key_list", finality: "final", account_id: daoId }),
        queryRpc({ request_type: "view_account", finality: "final", account_id: daoId }),
      ]);
      const proposalCount = Number(lastProposalId || 0);
      const proposalLimit = Math.min(proposalCount, 500);
      const proposals = [];
      for (let fromIndex = 0; fromIndex < proposalLimit; fromIndex += 100) {
        const batch = await viewOnContract(daoId, "get_proposals", {
          from_index: fromIndex,
          limit: Math.min(100, proposalLimit - fromIndex),
        });
        proposals.push(...(batch || []));
      }
      fund.config = config;
      fund.policy = policy;
      fund.factoryInfo = factoryInfo;
      fund.version = version;
      fund.availableAmount = String(availableAmount ?? "0");
      fund.proposals = proposals.reverse();
      fund.proposalsComplete = proposalCount <= 500;
      fund.accessKeys = accessKeyResult?.keys || [];
      fund.codeHash = String(accountResult?.code_hash || "");
      const goal = appConfig.communityGoal || {};
      if (goal.currency === "USDC") {
        const tokenId = String(goal.tokenId || "");
        const [metadata, storageBounds, daoStorage, daoBalance, recipientStorage, accountStorage, accountBalance] = await Promise.all([
          viewOnContract(tokenId, "ft_metadata"),
          viewOnContract(tokenId, "storage_balance_bounds"),
          viewOnContract(tokenId, "storage_balance_of", { account_id: daoId }),
          viewOnContract(tokenId, "ft_balance_of", { account_id: daoId }),
          viewOnContract(tokenId, "storage_balance_of", { account_id: goal.recipient }),
          state.accountId ? viewOnContract(tokenId, "storage_balance_of", { account_id: state.accountId }) : Promise.resolve(null),
          state.accountId ? viewOnContract(tokenId, "ft_balance_of", { account_id: state.accountId }) : Promise.resolve("0"),
        ]);
        fund.asset = {
          tokenId,
          metadata,
          storageBounds,
          daoStorage,
          daoBalance: String(daoBalance || "0"),
          recipientStorage,
          accountStorage,
          accountBalance: String(accountBalance || "0"),
          ready: tokenId === goal.tokenId && metadata?.symbol === "USDC" && Number(metadata?.decimals) === 6
            && Boolean(daoStorage) && Boolean(recipientStorage),
        };
      } else {
        fund.asset = { tokenId: "", ready: true, daoBalance: fund.availableAmount };
      }
      fund.safety = communityFundTools.analyzePolicy(policy, factoryInfo, fund.accessKeys, {
        codeHash: fund.codeHash,
        expectedCodeHash: appConfig.communityDaoCodeHash,
        version,
      });
      fund.error = null;
      if (!loadActivity) {
        // Persisted activity is loaded independently so this RPC fan-out cannot delay it.
      } else if (deferActivity) {
        activityPromise.then((activityResult) => {
          if (fund.activityPromise !== activityPromise) return;
          applyCommunityActivity(activityResult);
          renderCurrentPage();
        });
      } else {
        applyCommunityActivity(await activityPromise);
      }
    } catch (error) {
      fund.error = error;
    }
    fund.loaded = true;
    return fund;
  }

  async function view(methodName, args = {}) {
    return viewOnContract(appConfig.contractId, methodName, args);
  }

  async function viewV3(methodName, args = {}) {
    if (!appConfig.v3ContractId) throw new Error("Member issues are not enabled for this community yet.");
    return viewOnContract(appConfig.v3ContractId, methodName, args);
  }

  async function readIndexedRecords(readRecord, count, concurrency = 8) {
    const results = Array.from({ length: count });
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < count) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = { status: "fulfilled", value: await readRecord(index) };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(count, concurrency) }, worker));
    return results;
  }

  function mergeIndexedRecords(previous, reads) {
    const records = new Map((previous || [])
      .filter((record) => record && record.id !== undefined && record.id !== null)
      .map((record) => [String(record.id), record]));
    let failed = 0;
    reads.forEach((result) => {
      if (result?.status === "fulfilled" && result.value && result.value.id !== undefined && result.value.id !== null) {
        records.set(String(result.value.id), result.value);
      }
      else if (result?.status === "rejected") failed += 1;
    });
    return { records: [...records.values()], failed };
  }

  function applySupplierData(suppliers) {
    if (!Array.isArray(suppliers)) throw new Error("The supplier directory returned an invalid JSON-RPC result.");
    state.suppliers = suppliers;
    const supplierSelect = $("#farmer-account");
    if (supplierSelect) {
      const selected = supplierSelect.value;
      supplierSelect.innerHTML = `<option value="">Choose a verified supplier</option>${state.suppliers.map((supplier) => `<option value="${escapeHtml(supplier.account_id)}">${escapeHtml(supplier.business_name)} · ${escapeHtml(supplier.location)} — ${escapeHtml(supplier.account_id)}</option>`).join("")}`;
      if ([...supplierSelect.options].some((option) => option.value === selected)) supplierSelect.value = selected;
      updateSupplierSelection();
    }
    updateWalletUi();
    if (appConfig.page === "create") {
      document.documentElement.dataset.harvestpoolSupplierReadyMs = performance.now().toFixed(1);
    }
  }

  async function loadCreatePublicData() {
    try {
      const config = await view("get_config");
      state.config = config;
      const version = String(config.version || "").toUpperCase();
      const suppliers = ["V4", "V5"].includes(version) ? await view("get_suppliers") : [];
      applySupplierData(suppliers);
      state.liveDataError = null;
      state.lastVerifiedRefreshAt = Date.now();
      return true;
    } catch (error) {
      state.liveDataError = error;
      throw error;
    }
  }

  async function loadPublicPurchaseDataOnce() {
    walletStateRun = null;
    const firstLoad = !state.dataLoaded;
    if (firstLoad) {
      state.purchaseDiscoveryStatus = "loading";
      if (appConfig.page === "explore" || ["dashboard", "farmer", "decisions"].includes(appConfig.page)) renderCurrentPage();
    }
    try {
      const config = await view("get_config");
      const isV4 = ["V4", "V5"].includes(String(config.version || "").toUpperCase());
      state.config = config;
      const previousSuppliers = state.suppliers;
      const supplierPromise = isV4
        ? view("get_suppliers")
          .then((suppliers) => {
            applySupplierData(suppliers);
            return suppliers;
          })
          .catch((error) => {
            state.suppliers = previousSuppliers;
            updateWalletUi();
            console.warn("Supplier directory is temporarily unavailable.", error);
            return [];
          })
        : Promise.resolve([]);
      const [members, countValue] = await Promise.all([
        isV4 ? Promise.resolve([]) : view("get_members"),
        view("get_purchase_count"),
      ]);
      if (!Array.isArray(members)) throw new Error("The member directory returned an invalid JSON-RPC result.");
      state.members = members;
      if (appConfig.page !== "explore") await supplierPromise;
      const countNumber = Number(countValue);
      if (!Number.isInteger(countNumber) || countNumber < 0) throw new Error("The purchase count returned an invalid JSON-RPC result.");
      const count = Math.min(countNumber, 500);
      const purchaseReads = await readIndexedRecords((id) => view("get_purchase", { purchase_id: String(id) }), count);
      const merged = mergeIndexedRecords(state.purchases, purchaseReads);
      const freshPurchases = purchaseReads.filter((result) => result?.status === "fulfilled" && result.value).map((result) => result.value);
      if (count > 0 && freshPurchases.length === 0 && state.purchases.length === 0) {
        throw purchaseReads.find((result) => result?.status === "rejected")?.reason || new Error("Purchase reads failed.");
      }
      state.purchases = merged.records.sort((left, right) => Number(right.id) - Number(left.id));
      state.liveDataError = merged.failed
        ? new Error(`${merged.failed} deal ${merged.failed === 1 ? "record is" : "records are"} temporarily unavailable. Previously confirmed records were retained.`)
        : null;
      state.dataLoaded = true;
      state.purchaseDiscoveryStatus = "ready";
      state.lastVerifiedRefreshAt = Date.now();
      const currentId = appConfig.purchaseId === null || appConfig.purchaseId === undefined ? null : String(appConfig.purchaseId);
      const currentPurchase = currentId === null ? null : state.purchases.find((purchase) => String(purchase.id) === currentId);
      if (currentPurchase) state.currentPurchase = currentPurchase;
      if (appConfig.page === "explore") {
        if (!document.documentElement.dataset.harvestpoolPurchaseDataMs) {
          document.documentElement.dataset.harvestpoolPurchaseDataMs = performance.now().toFixed(1);
        }
        renderExplore();
      }
    } catch (error) {
      state.liveDataError = error;
      state.purchaseDiscoveryStatus = state.dataLoaded ? "ready" : "error";
      if (appConfig.page === "explore") renderExplore();
      throw error;
    }
  }

  async function loadPublicPurchaseData() {
    if (publicPurchaseDataRun) return publicPurchaseDataRun;
    publicPurchaseDataRun = loadPublicPurchaseDataOnce();
    try {
      return await publicPurchaseDataRun;
    } finally {
      publicPurchaseDataRun = null;
    }
  }

  async function loadBaseData() {
    await loadPublicPurchaseData();
    await Promise.all([loadWalletState(), loadV3Data()]);
  }

  function pagePurchaseId() {
    return $("[data-purchase-id]")?.dataset.purchaseId || state.currentPurchase?.id || null;
  }

  async function loadDetailData(purchaseId, { render = true, walletReady = null } = {}) {
    walletStateRun = null;
    const id = String(purchaseId);
    state.detailAuthorityReady = false;
    const [config, purchase] = await Promise.all([
      view("get_config"),
      view("get_purchase", { purchase_id: id }),
    ]);
    if (!purchase) throw new Error("That purchase does not exist on the current contract.");
    state.config = config;
    state.members = [];
    state.purchases = [purchase];
    state.currentPurchase = purchase;
    state.dataLoaded = true;
    state.purchaseDiscoveryStatus = "ready";
    state.liveDataError = null;
    state.lastVerifiedRefreshAt = Date.now();

    if (render) renderCurrentPage();

    const walletSessionReady = walletReady
      ? await walletReady
      : state.walletStatus !== "initializing";
    const walletVerified = await loadWalletState({ strict: true });
    state.detailAuthorityReady = Boolean(walletVerified && (walletSessionReady || ["disconnected", "unavailable"].includes(state.walletStatus)));
    if (render) renderCurrentPage();

    await loadV3Data();
    if (render) renderCurrentPage();
    return purchase;
  }

  async function refreshLiveData({ force = false, render = true } = {}) {
    if (!force && Date.now() - state.lastLiveRefreshAt < 12_000) return false;
    if (state.refreshingLiveData) return state.refreshingLiveData;
    state.refreshingLiveData = (async () => {
      if (appConfig.page === "community_fund") {
        await loadCommunityFundData();
        state.lastLiveRefreshAt = Date.now();
        updateWalletUi();
        if (render) renderCurrentPage();
        return true;
      }
      const purchaseId = pagePurchaseId();
      if (appConfig.page === "details" && purchaseId !== null) {
        await loadDetailData(purchaseId, { render: false });
      } else {
        await loadBaseData();
      }
      if (["agreement", "issue_form", "supplier_invitation"].includes(appConfig.page)
        && purchaseId !== null
        && (!state.currentPurchase || String(state.currentPurchase.id) !== String(purchaseId))) {
        await loadPurchase(purchaseId).catch(() => null);
      }
      state.lastLiveRefreshAt = Date.now();
      updateWalletUi();
      if (render) renderCurrentPage();
      return true;
    })().catch((error) => {
      state.liveDataError = error;
      if (render) renderCurrentPage();
      throw error;
    }).finally(() => { state.refreshingLiveData = null; });
    return state.refreshingLiveData;
  }

  function scheduleExploreRefresh() {
    if (appConfig.page !== "explore" || document.visibilityState !== "visible" || exploreRefreshTimer !== null) return;
    exploreRefreshTimer = window.setTimeout(async () => {
      exploreRefreshTimer = null;
      if (document.visibilityState !== "visible") return;
      await refreshLiveData({ force: true }).catch(() => null);
      scheduleExploreRefresh();
    }, EXPLORE_REFRESH_INTERVAL_MS);
  }

  function stopExploreRefresh() {
    if (exploreRefreshTimer !== null) window.clearTimeout(exploreRefreshTimer);
    exploreRefreshTimer = null;
  }

  function stopActionCenterRefresh() {
    if (actionCenterRefreshTimer !== null) window.clearTimeout(actionCenterRefreshTimer);
    actionCenterRefreshTimer = null;
  }

  function scheduleActionCenterRefresh() {
    if (appConfig.page !== "decisions" || document.visibilityState !== "visible" || actionCenterRefreshTimer !== null) return;
    actionCenterRefreshTimer = window.setTimeout(async () => {
      actionCenterRefreshTimer = null;
      if (document.visibilityState !== "visible") return;
      await refreshLiveData({ force: true }).catch(() => null);
      scheduleActionCenterRefresh();
    }, ACTION_CENTER_REFRESH_INTERVAL_MS);
  }

  async function refreshAffectedAction(action) {
    const methodName = action.methodName;
    const purchaseId = action.args?.purchase_id
      ?? action.context?.purchaseId
      ?? (appConfig.page === "details" ? pagePurchaseId() : null);
    const createsPurchase = ["create_purchase", "create_open_purchase", "create_supplier_offer", "create_purchase_request"].includes(methodName);
    const isGovernanceAction = String(action.receiverId || "") === String(appConfig.v3ContractId || "")
      || ["raise_issue", "request_group_vote", "vote_on_decision", "agree_to_decision", "decline_decision", "expire_decision"].includes(methodName);

    if (createsPurchase) {
      await loadBaseData();
      return;
    }
    if (appConfig.page === "details" && purchaseId !== null && purchaseId !== undefined) {
      await loadDetailData(purchaseId, { render: false });
      return;
    }
    if (purchaseId !== null && purchaseId !== undefined && state.dataLoaded) {
      await loadPurchase(purchaseId);
      if (state.accountId) await loadWalletState();
    }
    if (isGovernanceAction) await loadV3Data();
    if (!purchaseId && !isGovernanceAction) await loadBaseData();
  }

  async function loadV3DataOnce() {
    if (!appConfig.v3ContractId) return false;
    const hadVerifiedData = state.v3Available;
    try {
      state.v3Error = null;
      const [config, issueCountValue, decisionCountValue] = await Promise.all([
        viewV3("get_config"),
        viewV3("get_issue_count"),
        viewV3("get_decision_count"),
      ]);
      if (!["V3", "V3-V5"].includes(String(config.version || "")) || String(config.v2_contract_id || "") !== String(appConfig.contractId)) {
        throw new Error("The configured member-decision contract is linked to a different purchase contract.");
      }
      const issueCount = Math.min(Number(issueCountValue || 0), 500);
      const decisionCount = Math.min(Number(decisionCountValue || 0), 500);
      const [issueReads, decisionReads] = await Promise.all([
        readIndexedRecords((id) => viewV3("get_issue", { issue_id: String(id) }), issueCount),
        readIndexedRecords((id) => viewV3("get_decision", { decision_id: String(id) }), decisionCount),
      ]);
      const mergedIssues = mergeIndexedRecords(state.issues, issueReads);
      const mergedDecisions = mergeIndexedRecords(state.decisions, decisionReads);
      if (issueCount > 0 && mergedIssues.records.length === 0 && !state.issues.length) throw new Error("Issue reads failed.");
      if (decisionCount > 0 && mergedDecisions.records.length === 0 && !state.decisions.length) throw new Error("Decision reads failed.");
      state.v3Config = config;
      state.issues = mergedIssues.records.sort((left, right) => Number(right.id) - Number(left.id));
      state.decisions = mergedDecisions.records.sort((left, right) => Number(right.id) - Number(left.id));
      state.v3Available = true;
      const failed = mergedIssues.failed + mergedDecisions.failed;
      state.v3Error = failed ? new Error(`${failed} issue or decision read${failed === 1 ? " is" : "s are"} temporarily unavailable. Previously confirmed records were retained.`) : null;
      state.lastVerifiedRefreshAt = Date.now();
      return true;
    } catch (error) {
      state.v3Error = error;
      state.v3Available = hadVerifiedData;
      return false;
    }
  }

  async function loadV3Data() {
    if (v3DataRun) return v3DataRun;
    v3DataRun = loadV3DataOnce();
    try {
      return await v3DataRun;
    } finally {
      v3DataRun = null;
    }
  }

  async function waitForV3Record(predicate) {
    return confirmationTools.waitForState(
      async () => {
        const refreshed = await loadV3Data();
        return refreshed ? { issues: state.issues, decisions: state.decisions } : null;
      },
      (snapshot) => snapshot && predicate(snapshot.issues, snapshot.decisions),
      { attempts: 8, delayMs: 750 },
    );
  }

  async function waitForV3RecordWithLock(button, predicate) {
    if (button) {
      state.pendingTransactions.add(button);
      setBusy(button, true, "Verifying on-chain state…");
    }
    try {
      return await waitForV3Record(predicate);
    } finally {
      setBusy(button, false);
      if (button) state.pendingTransactions.delete(button);
    }
  }

  function pendingAction(methodName, args, receiverId = appConfig.contractId, context = {}) {
    return {
      networkId: "testnet",
      signerId: String(state.accountId || ""),
      receiverId,
      methodName,
      args,
      context,
    };
  }

  function captureWalletCallbackHash() {
    if (!state.accountId) return null;
    const hashes = confirmationTools.walletCallbackHashes(window.location.search);
    const pending = pendingActionStore.list(state.accountId);
    const target = confirmationTools.pendingForWalletCallback(pending);
    if (hashes.length !== 1 || !target) return null;
    const saved = confirmationTools.persistTransactionHash(pendingActionStore, target, hashes[0]);
    if (!saved) return null;
    const url = new URL(window.location.href);
    url.searchParams.delete("transactionHashes");
    url.searchParams.delete("transactionHash");
    url.searchParams.delete("errorCode");
    url.searchParams.delete("errorMessage");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    return saved;
  }

  function purchaseCommitment(purchase, signerId) {
    return (purchase?.commitments || []).find((item) => String(item.account_id) === String(signerId));
  }

  function samePurchaseInput(purchase, args, signerId) {
    const terms = args.terms || args;
    return purchase
      && (String(purchase.proposer) === String(signerId) || String(purchase.supplier_id) === String(signerId))
      && Number(purchase.min_quantity) === Number(terms.min_quantity)
      && Number(purchase.max_quantity) === Number(terms.max_quantity)
      && String(purchase.price_per_unit) === String(terms.price_per_unit)
      && String(purchase.deadline_ns) === String(terms.join_deadline_ns || terms.deadline_ns);
  }

  async function readActionConfirmation(action) {
    const { methodName, args = {}, signerId, receiverId } = action;
    if (methodName === "community_contribute_usdc") {
      const configuredFund = communityFundTools.configuredContributionFund(appConfig.communityFunds, {
        daoId: action.context?.daoId,
        tokenId: receiverId,
      });
      if (!configuredFund) return { state: "failed" };
      const verificationUrl = configuredFund.activityUrl.replace(/\/activity(?:\?.*)?$/, "/contributions/verify");
      let payload;
      let response;
      try {
        response = await fetch(verificationUrl, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            signerId,
            amount: String(args.amount || ""),
            memo: String(args.memo || ""),
            transactionHash: action.transactionHash || null,
            startedAtNs: action.startedAtNs || null,
          }),
        });
        payload = await response.json();
      } catch (error) {
        return { state: "uncertain", reason: `Durable receipt verification is unavailable: ${String(error?.message || error)}` };
      }
      if (payload?.summary && state.communityFund.activity) {
        state.communityFund.activity = { ...state.communityFund.activity, ...payload.summary };
      }
      if (!response.ok) {
        return { state: "uncertain", reason: payload?.error || "No exact finalized contribution record was available." };
      }
      if (["failed", "resolved"].includes(payload?.state)) {
        return {
          state: "failed",
          attempt: payload.attempt,
          reason: payload.state === "failed"
            ? "The exact transaction finalized unsuccessfully. No retry was submitted."
            : "The exact transaction finalized without one verified transfer receipt. No retry was submitted.",
        };
      }
      if (payload?.state === "awaiting" || !payload?.record) {
        return {
          state: "uncertain",
          attempt: payload?.attempt,
          reason: payload?.verificationUnavailable
            ? payload.error
            : "The exact transaction was observed, but its final outcome is still awaiting confirmation.",
        };
      }
      const record = payload.record;
      if (!action.transactionHash) {
        confirmationTools.persistTransactionHash(pendingActionStore, action, record.transactionHash);
      }
      const onMatchingFundPage = appConfig.page === "community_fund"
        && String(appConfig.communityDaoId || "") === String(configuredFund.daoId);
      if (onMatchingFundPage && !state.communityFund.recentContributions.some((item) => item.transactionHash === record.transactionHash)) {
        state.communityFund.recentContributions.push(record);
      }
      return { state: "confirmed", record, attempt: payload.attempt };
    }
    if (String(receiverId) === String(appConfig.v3ContractId)) {
      if (["vote_on_decision", "agree_to_decision", "decline_decision", "expire_decision"].includes(methodName)) {
        const decision = await viewV3("get_decision", { decision_id: String(args.decision_id) });
        if (!decision) return { state: "uncertain" };
        if (methodName === "vote_on_decision") {
          const vote = (decision.votes || []).find((item) => String(item.voter) === String(signerId));
          if (!vote) return { state: decision.state === "Open" ? "uncertain" : "failed", record: decision };
          return { state: Number(vote.option) === Number(args.option) ? "confirmed" : "failed", record: decision };
        }
        if (methodName === "agree_to_decision") return { state: decision.supplier_agreed ? "confirmed" : "uncertain", record: decision };
        if (methodName === "decline_decision") return { state: decision.state === "Rejected" ? "confirmed" : "uncertain", record: decision };
        return { state: decision.state === "Expired" ? "confirmed" : "uncertain", record: decision };
      }
      if (methodName === "resolve_issue") {
        const issue = await viewV3("get_issue", { issue_id: String(args.issue_id) });
        return { state: issue?.state === "Resolved" ? "confirmed" : "uncertain", record: issue };
      }
      if (methodName === "raise_issue") {
        await loadV3Data();
        const record = state.issues.find((issue) => issueMatches(issue, {
          purchaseId: args.purchase_id,
          requesterId: signerId,
          subject: args.subject,
          description: args.description,
          suggestedSolution: args.suggested_solution,
        }));
        return { state: record ? "confirmed" : "uncertain", record };
      }
      if (methodName === "request_group_vote") {
        await loadV3Data();
        const record = state.decisions.find((decision) => decisionMatches(decision, {
          issueId: args.issue_id,
          proposal: args.proposal,
          options: args.options,
          voteType: args.vote_type,
        }));
        return { state: record ? "confirmed" : "uncertain", record };
      }
    }

    if (methodName === "vote_on_offer" || methodName === "vote_on_fulfillment") {
      const readMethod = methodName === "vote_on_offer" ? "get_offer_vote" : "get_fulfillment_vote";
      const vote = await view(readMethod, { purchase_id: String(args.purchase_id), account_id: signerId });
      if (vote === null || vote === undefined) return { state: "uncertain" };
      return { state: Boolean(vote) === Boolean(args.approve) ? "confirmed" : "failed", record: vote };
    }
    if (methodName === "reconcile_token_balance") {
      const accounting = await view("get_accounting");
      const observedAt = accounting?.last_reconciled_at_ns;
      const previous = action.context?.previousReconciledAt ?? null;
      const startedAtNs = action.startedAtNs ?? null;
      const changedFromBaseline = observedAt !== null && observedAt !== undefined
        && String(observedAt) !== String(previous ?? "");
      const newerThanAction = observedAt !== null && observedAt !== undefined && startedAtNs !== null
        && BigInt(String(observedAt)) >= BigInt(String(startedAtNs)) - 60_000_000_000n;
      const valuesMatch = String(accounting?.last_observed_token_balance ?? "")
        === String(accounting?.last_reconciled_liability ?? "");
      const confirmed = valuesMatch && (changedFromBaseline || newerThanAction);
      return { state: confirmed ? "confirmed" : "uncertain", record: accounting };
    }
    if (["create_purchase", "create_open_purchase", "create_supplier_offer", "create_purchase_request"].includes(methodName)) {
      const count = Number(await view("get_purchase_count"));
      const purchases = await Promise.all(Array.from({ length: Math.min(count, 100) }, (_, id) => view("get_purchase", { purchase_id: String(id) })));
      const minimumId = Number(action.context?.minimumPurchaseId ?? 0);
      const record = purchases.find((purchase) => Number(purchase?.id) >= minimumId && samePurchaseInput(purchase, args, signerId));
      return { state: record ? "confirmed" : "uncertain", record };
    }
    const purchase = args.purchase_id === undefined ? null : await view("get_purchase", { purchase_id: String(args.purchase_id) });
    if (methodName === "accept_supplier_request") return { state: purchase?.state === "Open" && purchase?.supplier_agreement ? "confirmed" : "uncertain", record: purchase };
    if (methodName === "decline_supplier_request") return { state: purchase?.state === "Declined" ? "confirmed" : "uncertain", record: purchase };
    const commitment = purchaseCommitment(purchase, signerId);
    if (["commit", "commit_usdc"].includes(methodName)) return { state: commitment?.state === "Active" && Number(commitment.quantity) === Number(args.quantity) ? "confirmed" : "uncertain", record: purchase };
    if (methodName === "cancel_commitment") return { state: ["Refundable", "RefundPending", "Refunded"].includes(commitment?.state) ? "confirmed" : "uncertain", record: purchase };
    if (methodName === "finalize_purchase") return { state: ["Funded", "Failed"].includes(purchase?.state) ? "confirmed" : "uncertain", record: purchase };
    if (methodName === "submit_fulfillment_evidence") return { state: purchase?.fulfillment_evidence_hash === args.evidence_hash ? "confirmed" : "uncertain", record: purchase };
    if (methodName === "expire_unfulfilled_purchase") return { state: purchase?.state === "Failed" ? "confirmed" : "uncertain", record: purchase };
    if (methodName === "release_payment") {
      const operationCount = Number(await view("get_outbound_operation_count"));
      const operations = await Promise.all(Array.from({ length: Math.min(operationCount, 500) }, (_, id) =>
        view("get_outbound_operation", { operation_id: String(id) })));
      const operation = operations.filter((item) => item
        && item.kind === "SupplierPayment"
        && String(item.purchase_id) === String(args.purchase_id))
        .sort((left, right) => Number(right.id) - Number(left.id))[0];
      if (operation?.state === "Failed") return { state: "failed", record: { purchase, operation } };
      if (purchase?.state === "Completed" && operation?.state === "Succeeded") {
        return { state: "confirmed", record: { purchase, operation } };
      }
      return { state: "uncertain", record: { purchase, operation } };
    }
    if (methodName === "claim_refund") {
      const operationCount = Number(await view("get_outbound_operation_count"));
      const operations = await Promise.all(Array.from({ length: Math.min(operationCount, 500) }, (_, id) =>
        view("get_outbound_operation", { operation_id: String(id) })));
      const operation = operations.filter((item) => item
        && item.kind === "Refund"
        && String(item.purchase_id) === String(args.purchase_id)
        && String(item.recipient_id) === String(signerId))
        .sort((left, right) => Number(right.id) - Number(left.id))[0];
      if (operation?.state === "Failed") return { state: "failed", record: { purchase, operation } };
      if (commitment?.state === "Refunded" && operation?.state === "Succeeded") {
        return { state: "confirmed", record: { purchase, operation } };
      }
      return { state: "uncertain", record: { purchase, operation } };
    }
    return { state: "uncertain" };
  }

  async function waitForActionConfirmation(action, options = {}) {
    if (action.methodName === "community_contribute_usdc" && !action.transactionHash) {
      return readActionConfirmation(action);
    }
    const callbackMethods = new Set([
      "commit_usdc", "raise_issue", "request_group_vote", "reconcile_token_balance",
      "release_payment", "claim_refund", "community_contribute_usdc",
    ]);
    return confirmationTools.waitForState(
      () => readActionConfirmation(action),
      (result) => result && result.state !== "uncertain" ? result : null,
      {
        attempts: options.attempts || (callbackMethods.has(action.methodName) ? 30 : 15),
        delayMs: options.delayMs ?? 1000,
      },
    );
  }

  function renderPendingConfirmationNotice() {
    let notice = $("#pending-transaction-notice");
    const pending = state.accountId
      ? pendingActionStore.list(state.accountId).filter((action) => !archivedActionAlertStore.has(action.id))
      : [];
    const inlineCommunityStatus = appConfig.page === "community_fund"
      && pending.length > 0
      && pending.every((action) => action.methodName === "community_contribute_usdc");
    if (!pending.length || inlineCommunityStatus) {
      notice?.remove();
      return;
    }
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "pending-transaction-notice";
      notice.className = "pending-transaction-notice";
      notice.setAttribute("role", "status");
      notice.setAttribute("aria-live", "polite");
      document.body.appendChild(notice);
    }
    const current = pending.slice().sort((left, right) => Number(right.savedAt || 0) - Number(left.savedAt || 0))[0];
    const phase = current.phase || "confirming";
    const title = phase === "wallet" ? "Sending this action through Meteor…" : actionProgressCopy(current.methodName);
    const message = phase === "wallet"
      ? "Review the request in your wallet. No action is complete until the deal record confirms it."
      : phase === "unresolved"
        ? current.methodName === "community_contribute_usdc" && !current.transactionHash
          ? "Meteor returned no hash. HarvestPool will accept only one independently discovered exact finalized transaction; do not submit again while it checks."
          : "We haven't confirmed the result yet. Please don't submit again while we check."
        : "Your request was submitted. We’re checking the result now…";
    notice.innerHTML = `<div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>`;
  }

  async function reconcilePendingActions(options = {}) {
    if (!state.accountId) return [];
    if (pendingReconciliationPromise) return pendingReconciliationPromise;
    pendingReconciliationPromise = reconcilePendingActionsOnce(options);
    try {
      return await pendingReconciliationPromise;
    } finally {
      pendingReconciliationPromise = null;
    }
  }

  async function reconcilePendingActionsOnce({ poll = false } = {}) {
    state.reconcilingPending = true;
    const pending = pendingActionStore.list(state.accountId);
    const remaining = [];
    const affectedPurchaseIds = new Set();
    try {
      for (const action of pending) {
        const purchaseId = action.context?.purchaseId ?? action.args?.purchase_id;
        if (purchaseId !== null && purchaseId !== undefined) affectedPurchaseIds.add(String(purchaseId));
        const result = poll ? await waitForActionConfirmation(action) : await readActionConfirmation(action).catch(() => ({ state: "uncertain" }));
        if (result?.state === "confirmed") {
          savePersonalContributionOutcome(action, result);
          pendingActionStore.remove(action.id);
          clearDraftReference(action.context?.draft);
          if (action.methodName === "raise_issue" && result.record?.id !== undefined) state.confirmedIssueId = String(result.record.id);
          if (["create_purchase", "create_open_purchase", "create_supplier_offer", "create_purchase_request"].includes(action.methodName) && result.record) {
            state.recoveredCreateRecord = result.record;
          }
          if (action.methodName !== "community_contribute_usdc") {
            showToast(actionSuccessCopy(action.methodName), "success");
          }
        } else if (result?.state === "failed") {
          savePersonalContributionOutcome(action, result);
          pendingActionStore.remove(action.id);
          if (action.methodName !== "community_contribute_usdc") {
            showToast("That action did not complete. Your saved information is unchanged.", "error");
          }
        } else {
          const unresolved = pendingActionStore.save({
            ...action,
            phase: !action.transactionHash && action.phase === "wallet-unresponsive"
              ? "wallet-unresponsive"
              : action.phase === "wallet" ? "unresolved" : action.phase || "unresolved",
          });
          remaining.push(unresolved);
        }
      }
      if (pending.length) {
        const purchaseId = [...affectedPurchaseIds][0] ?? state.currentPurchase?.id ?? $("[data-purchase-id]")?.dataset.purchaseId;
        const requiresPurchaseRefresh = pending.some((action) => action.methodName !== "community_contribute_usdc");
        await Promise.allSettled([
          appConfig.page === "community_fund"
            ? fetchCommunityActivity(false).then((activity) => applyCommunityActivity(activity))
            : requiresPurchaseRefresh && appConfig.page === "details" && purchaseId !== null && purchaseId !== undefined
              ? loadDetailData(purchaseId, { render: false })
              : requiresPurchaseRefresh ? loadBaseData() : Promise.resolve(),
        ]);
        renderCurrentPage();
      }
      renderPendingConfirmationNotice();
      scheduleCommunityReconciliation(remaining);
      return remaining;
    } finally {
      state.reconcilingPending = false;
    }
  }

  function scheduleCommunityReconciliation(actions = null) {
    if (communityReconciliationTimer !== null) window.clearTimeout(communityReconciliationTimer);
    communityReconciliationTimer = null;
    const pending = actions || (state.accountId ? pendingActionStore.list(state.accountId) : []);
    if (!pending.some((action) => action.methodName === "community_contribute_usdc")) return;
    communityReconciliationTimer = window.setTimeout(async () => {
      communityReconciliationTimer = null;
      if (document.visibilityState !== "visible") {
        scheduleCommunityReconciliation();
        return;
      }
      const remaining = await reconcilePendingActions().catch(() => pending);
      scheduleCommunityReconciliation(remaining);
    }, 5000);
  }

  function startManualPaymentCheckCooldown(button, seconds = 5) {
    const existing = manualPaymentCheckTimers.get(button);
    if (existing) window.clearInterval(existing);
    const original = button.dataset.originalLabel || button.innerHTML || "Check payment status";
    button.dataset.originalLabel = original;
    const readyAt = Date.now() + seconds * 1000;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((readyAt - Date.now()) / 1000));
      if (!button.isConnected || remaining === 0) {
        window.clearInterval(manualPaymentCheckTimers.get(button));
        manualPaymentCheckTimers.delete(button);
        if (button.isConnected) {
          button.disabled = false;
          button.removeAttribute("aria-disabled");
          button.innerHTML = original;
        }
        return;
      }
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
      button.textContent = `Check again in ${remaining}s`;
    };
    update();
    manualPaymentCheckTimers.set(button, window.setInterval(update, 250));
  }

  async function checkPendingAction(actionId) {
    const action = pendingActionStore.list(state.accountId).find((item) => String(item.id) === String(actionId));
    if (!action) return { state: "missing", message: "This saved action is no longer pending." };
    const result = await readActionConfirmation(action);
    if (result?.state === "confirmed") {
      savePersonalContributionOutcome(action, result);
      pendingActionStore.remove(action.id);
      clearDraftReference(action.context?.draft);
      renderCurrentPage();
      renderPendingConfirmationNotice();
      return { state: "confirmed", message: actionSuccessCopy(action.methodName) };
    }
    if (result?.state === "failed") {
      savePersonalContributionOutcome(action, result);
      pendingActionStore.remove(action.id);
      renderCurrentPage();
      renderPendingConfirmationNotice();
      return {
        state: "failed",
        message: result.reason || "The exact transaction reached a final outcome without a verified contribution. No retry was submitted.",
      };
    }
    return {
      state: "uncertain",
      message: result?.reason || "Finalized state is not available yet. The saved action remains protected and no transaction was resubmitted.",
    };
  }

  function archivePendingActionAlert(actionId) {
    const action = pendingActionStore.list().find((item) => String(item.id) === String(actionId));
    if (!action) return false;
    archivedActionAlertStore.archive({ actionId: action.id, signerId: action.signerId });
    renderPendingConfirmationNotice();
    updateActionCenterCount();
    renderDecisions();
    const announcement = $("[data-action-center-announcement]", $("#decisions-root"));
    if (announcement) announcement.textContent = "Alert archived. Automatic verification and duplicate protection continue.";
    return true;
  }

  async function recoverIfTransactionBundleChanged() {
    if (!state.accountId || !pendingActionStore.list(state.accountId).length) return false;
    try {
      const response = await fetch(`/static/app.js?transaction-version=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) return false;
      const source = await response.text();
      const version = source.match(/TRANSACTION_BUNDLE_VERSION\s*=\s*"([^"]+)"/)?.[1];
      if (version && version !== TRANSACTION_BUNDLE_VERSION) {
        window.location.reload();
        return true;
      }
    } catch (_error) {
      // A version check must never replace authoritative transaction reconciliation.
    }
    return false;
  }

  function actionSuccessCopy(methodName) {
    if (methodName === "create_supplier_offer") return dealCreationTools.mode("supplier_offer").success;
    if (methodName === "create_purchase_request") return dealCreationTools.mode("organizer_request").success;
    if (["create_purchase", "create_open_purchase"].includes(methodName)) return "Your deal is live!";
    if (["commit", "commit_usdc"].includes(methodName)) return "You’re in! Your spot is secured.";
    if (methodName === "community_contribute_usdc") return "Your Community Fund contribution is confirmed.";
    if (methodName === "raise_issue") return "Your issue has been submitted.";
    if (methodName === "reconcile_token_balance") return "Escrow reconciliation successful";
    if (["vote_on_offer", "vote_on_fulfillment", "vote_on_decision"].includes(methodName)) return "Your vote has been recorded.";
    return "Your update is confirmed.";
  }

  function issueMatches(issue, { purchaseId, requesterId, subject, description, suggestedSolution }) {
    return confirmationTools.issueMatches(issue, { purchaseId, requesterId, subject, description, suggestedSolution });
  }

  function decisionMatches(decision, { issueId, proposal, options, voteType }) {
    const expectedOptions = voteType === "YesNo" ? ["Yes", "No"] : (options || []);
    return decision
      && String(decision.issue_id) === String(issueId)
      && decision.proposal === proposal
      && (!voteType || decision.vote_type === voteType)
      && JSON.stringify(decision.options || []) === JSON.stringify(expectedOptions);
  }

  let walletStateRun = null;

  async function loadWalletState(options = {}) {
    const accountId = String(state.accountId || "");
    if (walletStateRun
      && walletStateRun.accountId === accountId
      && (!options.strict || walletStateRun.strict)) return walletStateRun.promise;
    const previousMemberStatus = state.memberStatus;
    const previousFundedMembership = new Map(state.fundedMembership);
    const previousVotes = state.recordedVotes;
    const promise = (async () => {
      if (!accountId || !state.dataLoaded) {
        state.memberStatus = null;
        state.fundedMembership = new Map();
        state.accountDataVerified = !accountId;
        state.accountDataError = null;
        return true;
      }
      let accountReadFailed = false;
      try {
        const version = String(state.config?.version || "").toUpperCase();
        const usesOpenMembership = ["V4", "V5"].includes(version);
        state.memberStatus = usesOpenMembership ? true : Boolean(await view("is_member", { account_id: accountId }));
        const fundedEntries = await Promise.all(state.purchases.map(async (purchase) => {
          try {
            const funded = await view("is_funded_member", { purchase_id: String(purchase.id), account_id: accountId });
            return [String(purchase.id), Boolean(funded)];
          } catch (error) {
            accountReadFailed = true;
            if (options.strict) throw error;
            return [String(purchase.id), Boolean(commitmentFor(purchase)?.state === "Active")];
          }
        }));
        if (String(state.accountId || "") !== accountId) return false;
        state.fundedMembership = new Map(fundedEntries);
        const voteTypes = usesOpenMembership ? [["fulfillment", "get_fulfillment_vote"]] : [["offer", "get_offer_vote"], ["fulfillment", "get_fulfillment_vote"]];
        const voteEntries = await Promise.all(state.purchases.flatMap((purchase) => voteTypes.map(async ([type, methodName]) => {
          try {
            const vote = await view(methodName, { purchase_id: String(purchase.id), account_id: accountId });
            return [voteStateKey(purchase.id, type), vote === null ? null : { approve: Boolean(vote) }];
          } catch (error) {
            accountReadFailed = true;
            if (options.strict) throw error;
            // Older deployed V2 accounts may not expose the additive per-voter view yet.
            const key = voteStateKey(purchase.id, type);
            return [key, previousVotes.get(key) || null];
          }
        })));
        if (String(state.accountId || "") !== accountId) return false;
        voteEntries.forEach(([key, vote]) => {
          if (vote) state.recordedVotes.set(key, vote);
        });
        state.accountDataVerified = !accountReadFailed;
        state.accountDataError = accountReadFailed
          ? new Error("Some wallet-specific contract reads could not be verified. Restricted actions remain disabled until Refresh succeeds.")
          : null;
        return !accountReadFailed;
      } catch (error) {
        if (String(state.accountId || "") !== accountId) return false;
        state.memberStatus = previousMemberStatus ?? Boolean(state.members.some((member) => String(member) === accountId));
        state.fundedMembership = new Map(previousFundedMembership);
        state.purchases.forEach((purchase) => {
          if (!state.fundedMembership.has(String(purchase.id))) {
            state.fundedMembership.set(String(purchase.id), Boolean(commitmentFor(purchase)?.state === "Active"));
          }
        });
        state.recordedVotes = previousVotes;
        state.accountDataVerified = false;
        state.accountDataError = error || new Error("Wallet-specific contract reads could not be verified.");
        return !options.strict;
      }
    })();
    walletStateRun = { accountId, promise, strict: Boolean(options.strict) };
    return await promise;
  }

  async function loadPurchase(purchaseId) {
    if (!state.dataLoaded) await loadBaseData();
    const purchase = await view("get_purchase", { purchase_id: String(purchaseId) });
    if (!purchase) throw new Error("That purchase does not exist on the current contract.");
    state.currentPurchase = purchase;
    const index = state.purchases.findIndex((item) => String(item.id) === String(purchase.id));
    if (index >= 0) state.purchases[index] = purchase;
    else state.purchases.unshift(purchase);
    state.lastVerifiedRefreshAt = Date.now();
    walletStateRun = null;
    return purchase;
  }

  async function loadFinancialReadiness(purchase = state.currentPurchase) {
    if (!purchase || !isV5(purchase)) {
      state.financialReadiness = null;
      return null;
    }
    const tokenId = String(purchase.token_contract_id || state.config?.token_contract_id || "");
    if (!tokenId) throw new Error("The configured Circle token account is unavailable.");
    const [accounting, operationCountValue, circleBalance, supplierRegistration] = await Promise.all([
      view("get_accounting"),
      view("get_outbound_operation_count"),
      viewOnContract(tokenId, "ft_balance_of", { account_id: appConfig.contractId }),
      viewOnContract(tokenId, "storage_balance_of", { account_id: purchase.supplier_id }),
    ]);
    const operationCount = Number(operationCountValue || 0);
    const operations = await Promise.all(Array.from({ length: Math.min(operationCount, 500) }, (_, id) =>
      view("get_outbound_operation", { operation_id: String(id) })));
    const balance = String(circleBalance || "0");
    const liability = String(accounting.outstanding_liability || "0");
    state.financialReadiness = {
      accounting,
      balance,
      liability,
      supplierRegistration,
      operations: operations.filter(Boolean),
      checkedAt: new Date().toISOString(),
      error: false,
      figuresMatch: balance === liability,
    };
    return state.financialReadiness;
  }

  async function verifyContributionEligibility(purchaseId, quantity, agreementAccepted) {
    if (!state.accountId) throw new Error("Connect a wallet before contributing.");
    if (!agreementAccepted) throw new Error("Read and accept the purchase terms before contributing.");

    const [purchase, config] = await Promise.all([
      view("get_purchase", { purchase_id: String(purchaseId) }),
      view("get_config"),
    ]);
    if (!purchase) throw new Error("That purchase is no longer available on the current contract.");
    state.config = config;
    state.currentPurchase = purchase;
    const index = state.purchases.findIndex((item) => String(item.id) === String(purchase.id));
    if (index >= 0) state.purchases[index] = purchase;
    else state.purchases.unshift(purchase);

    const [member, funded] = await Promise.all([
      isOpenMembership(purchase)
        ? Promise.resolve(true)
        : view("is_member", { account_id: state.accountId }),
      view("is_funded_member", { purchase_id: String(purchase.id), account_id: state.accountId }),
    ]);
    state.memberStatus = Boolean(member);
    state.fundedMembership.set(String(purchase.id), Boolean(funded));

    if (purchase.state !== "Open") throw new Error(`This purchase is no longer open for contributions.`);
    if (deadlineHasPassed(purchase.deadline_ns)) throw new Error("The contribution deadline has passed.");
    if (!isOpenMembership(purchase) && !member) throw new Error("This wallet is not eligible for this purchase.");
    if (funded) throw new Error("This wallet already has a funded place in this purchase.");
    if (commitmentFor(purchase)) throw new Error("This wallet already has a commitment for this purchase.");
    if (availableCapacity(purchase) < quantity || fundedMemberCapacity(purchase) < 1) {
      throw new Error("Group full: the remaining capacity was taken before authorization.");
    }
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error("Choose at least one unit.");
    if (Number(purchase.max_quantity_per_household || 0) > 0 && quantity > Number(purchase.max_quantity_per_household)) throw new Error("That quantity is above the per-household limit.");

    const amount = (BigInt(purchase.price_per_unit) * BigInt(quantity)).toString();
    if (isV5(purchase)) {
      const tokenId = String(config.token_contract_id || purchase.token_contract_id || "");
      if (!tokenId) throw new Error("The V5 USDC token contract is not configured.");
      const [registration, balance] = await Promise.all([
        viewOnContract(tokenId, "storage_balance_of", { account_id: state.accountId }),
        viewOnContract(tokenId, "ft_balance_of", { account_id: state.accountId }),
      ]);
      if (!registration) throw new Error("Register this wallet with the configured USDC contract before contributing.");
      if (BigInt(String(balance || "0")) < BigInt(amount)) throw new Error("This wallet does not have enough native Testnet USDC for that contribution.");
    }
    return { purchase, depositYocto: amount };
  }

  function ensureSignedIn() {
    if (!state.wallet || !state.accountId) {
      showToast("Connect Meteor Wallet before signing this action.", "error");
      connectWallet();
      return false;
    }
    return true;
  }

  async function connectWallet() {
    if (!state.wallet) {
      if (state.walletError) {
        const ready = await setupNear();
        if (ready) return connectWallet();
      } else {
        showToast("The Meteor connector is still loading. Wait a moment and try again.", "error");
      }
      return;
    }
    try {
      const accounts = await state.wallet.signIn({
        contractId: appConfig.page === "community_fund" && appConfig.communityDaoId
          ? appConfig.communityDaoId
          : appConfig.contractId,
        methodNames: appConfig.page === "community_fund" ? ["add_proposal", "act_proposal"] : CHANGE_METHODS,
        successUrl: window.location.href,
        failureUrl: window.location.href,
      });
      state.accountId = accounts?.[0]?.accountId || state.accountId;
      await syncWalletAccount();
      if (!state.accountId) {
        showToast("Meteor Wallet did not return a Testnet account.", "error");
        return false;
      }
      return true;
    } catch (error) {
      const browserHint = /popup|window|localhost|permission|extension|not supported/i.test(String(error?.message || error || ""))
        ? " Check that Meteor is enabled for this localhost site and that wallet pop-ups are allowed."
        : "";
      showToast(`Meteor Wallet did not connect. Check the selected Testnet account and try again.${browserHint}`, "error");
      return false;
    }
  }

  async function disconnectWallet() {
    if (state.wallet) await state.wallet.signOut();
    state.accountId = null;
    state.walletStatus = "disconnected";
    state.memberStatus = null;
    state.fundedMembership = new Map();
    state.members = state.members || [];
    updateWalletUi();
    renderCurrentPage();
    closeWalletPanel();
    showToast("Wallet disconnected.");
  }

  function updateWalletUi() {
    const walletButton = $("#wallet-button");
    const accountLabel = $("#wallet-account");
    const signout = $("#wallet-signout");
    const copy = $("#wallet-panel-copy");
    if (state.walletStatus === "initializing") {
      if (walletButton) {
        walletButton.textContent = "Loading wallet…";
        walletButton.disabled = true;
        walletButton.setAttribute("aria-busy", "true");
      }
      return;
    }
    if (walletButton) {
      walletButton.disabled = false;
      walletButton.removeAttribute("aria-busy");
      walletButton.removeAttribute("title");
      walletButton.removeAttribute("aria-label");
    }
    if (state.walletStatus === "unavailable") {
      if (walletButton) {
        walletButton.textContent = "Retry wallet";
        walletButton.title = "Wallet setup failed. Retry wallet initialization.";
        walletButton.setAttribute("aria-label", "Wallet setup failed. Retry wallet initialization.");
      }
      if (accountLabel) accountLabel.textContent = "Wallet unavailable";
      if (copy) copy.textContent = walletInitializationTools.failureMessage(state.walletError);
      if (signout) signout.hidden = true;
      return;
    }
    if (state.accountId) {
      if (walletButton) walletButton.textContent = shortAccount(state.accountId);
      if (accountLabel) accountLabel.textContent = state.accountId;
      const supplier = state.suppliers.some((item) => String(item.account_id) === String(state.accountId))
        || state.purchases.some((purchase) => String(supplierAccount(purchase)) === String(state.accountId));
      const openMembership = ["V4", "V5"].includes(String(state.config?.version || appConfig.contractVersion || "").toUpperCase());
      if (copy && appConfig.page === "community_fund") {
        const safety = state.communityFund.safety;
        copy.textContent = safety?.members?.includes(state.accountId)
          ? "Wallet connected. This account is a Community Goals voting member."
          : "Wallet connected. This account can read the public fund but is not a voting member.";
      } else if (copy) copy.textContent = supplier
        ? "Wallet connected. This account is an eligible pilot supplier. Supplier actions do not require buyer community membership."
        : openMembership
          ? "Wallet connected. Buyer eligibility is checked for each Group Deal when contributing."
          : isMember()
            ? "Wallet connected. This account is in the initialized community."
            : "Wallet connected. This account is not in the initialized community.";
      if (signout) signout.hidden = false;
    } else {
      if (walletButton) walletButton.textContent = "Connect wallet";
      if (accountLabel) accountLabel.textContent = "Not connected";
      if (copy) copy.textContent = "Meteor Wallet is ready on NEAR Testnet. Connect the account you intend to use to check eligibility and sign actions.";
      if (signout) signout.hidden = true;
    }
  }

  function openWalletPanel() { $("#wallet-panel")?.removeAttribute("hidden"); }
  function closeWalletPanel() { $("#wallet-panel")?.setAttribute("hidden", ""); }

  async function sendChangeTo(receiverId, methodName, args = {}, depositValue = "0", valueIsYocto = false) {
    if (!ensureSignedIn()) throw new Error("Connect a wallet first.");
    const attachedDeposit = valueIsYocto ? depositValue : depositValue === "0" ? "0" : parseNearAmount(depositValue);
    if (attachedDeposit === null) throw new Error("The contribution amount could not be converted to yoctoNEAR.");
    const transaction = transactionTools.buildFunctionCallTransaction({
      actionCreators: state.actionCreators,
      signerId: state.accountId,
      receiverId,
      methodName,
      args,
      gasYocto: transactionTools.gasForMethod(receiverId, appConfig.v3ContractId, methodName),
      depositYocto: attachedDeposit,
    });
    return state.wallet.signAndSendTransaction({
      ...transaction,
      callbackUrl: window.location.href,
    });
  }

  async function sendChange(methodName, args = {}, depositValue = "0", valueIsYocto = false) {
    return sendChangeTo(appConfig.contractId, methodName, args, depositValue, valueIsYocto);
  }

  function decodeSuccessValue(outcome) {
    const encoded = outcome && outcome.status && outcome.status.SuccessValue;
    if (!encoded) return null;
    try {
      const decoded = atob(encoded);
      return JSON.parse(decoded);
    } catch (_error) {
      return null;
    }
  }

  function transactionErrorKind(error) {
    return confirmationTools.errorKind(error);
  }

  function transactionFriendlyMessage(error, kind, fallback) {
    return confirmationTools.friendlyError(error, fallback);
  }

  async function performTransaction(button, label, action, successMessage, options = {}) {
    if (!ensureSignedIn()) {
      options.onPhase?.("wallet-rejected", "Wallet confirmation required", "Connect a wallet before signing this action.");
      return null;
    }
    if (button && state.pendingTransactions.has(button)) return null;
    if (button) state.pendingTransactions.add(button);
    setBusy(button, true, "Waiting for wallet…");
    options.onPhase?.(
      "wallet",
      "Review the request in your wallet…",
      "Approve only after checking the account, amount, and action.",
    );
    if (!options.suppressToast) showToast("Review the request in your wallet.");
    try {
      const walletWait = await confirmationTools.waitForWalletResult(
        Promise.resolve().then(action),
        { timeoutMs: WALLET_RESULT_TIMEOUT_MS, onLateResult: options.onLateResult },
      );
      if (walletWait.state === "pending") {
        const error = new Error("Meteor has not returned a final response yet.");
        error.transactionState = "pending";
        error.walletResponseTimedOut = true;
        throw error;
      }
      if (walletWait.state === "rejected") throw walletWait.error;
      const walletResult = walletWait.value;
      options.onPhase?.("submitted", "Your request was submitted.", "We’re checking the result now.");
      if (!options.suppressToast) showToast("Request sent. Checking the result.");
      const outcome = confirmedTransaction(walletResult);
      if (options.confirmOnReturn !== false) {
        options.onPhase?.("confirmed", options.confirmedTitle || "Action confirmed", successMessage);
        if (!options.suppressToast) showToast(successMessage, "success");
      }
      return outcome;
    } catch (error) {
      const kind = transactionErrorKind(error);
      if (kind === "network-error" && !error.transactionState) {
        error.transactionState = "pending";
        error.networkFailure = true;
      }
      const message = transactionFriendlyMessage(error, kind, options.failureMessage);
      const phaseCopy = kind === "wallet-rejected"
        ? ["wallet-rejected", "Wallet rejected the action", "No state changed on-chain. Your draft is safe."]
        : kind === "state-changed"
          ? ["full", "Contract state changed", "No action was accepted. Your draft is safe."]
          : error?.transactionState === "pending"
            ? ["awaiting", label, "We’re checking the result automatically. Your draft is safe."]
            : ["failed", "Transaction failed", "The contract did not confirm this action. Your draft is safe."];
      options.onPhase?.(...phaseCopy);
      options.onError?.(message, error);
      if (!options.suppressToast) showToast(message, error?.transactionState === "pending" ? "" : "error");
      return null;
    } finally {
      setBusy(button, false);
      if (button) state.pendingTransactions.delete(button);
    }
  }

  function communityTime(ns) {
    try {
      const milliseconds = Number(BigInt(String(ns || "0")) / 1_000_000n);
      return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(milliseconds));
    } catch (_error) {
      return "Time unavailable";
    }
  }

  function communityVerificationTime(activity) {
    const value = activity?.historyVerifiedAt
      || (activity?.contributions || []).map((item) => item.verifiedAt).filter(Boolean).sort().at(-1)
      || activity?.treasuryBalanceVerifiedAt;
    if (!value) return "Time unavailable";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  }

  function communityExplorerLink(transactionHash, label = "View transaction") {
    if (!transactionHash) return '<span class="fund-reference-missing">Transaction reference is still being indexed</span>';
    return `<a class="text-link" href="https://testnet.nearblocks.io/txns/${encodeURIComponent(transactionHash)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} <span aria-hidden="true">↗</span></a>`;
  }

  function communityVoteCounts(allocation) {
    const votes = Object.values(allocation.votes || {});
    return {
      approve: votes.filter((vote) => vote === "Approve").length,
      reject: votes.filter((vote) => vote === "Reject").length,
      remove: votes.filter((vote) => vote === "Remove").length,
    };
  }

  function verifiedCommunityPayment(allocation, activity) {
    return communityFundTools.verifiedPayment(allocation, activity);
  }

  function communityTokenId(goal = appConfig.communityGoal || {}) {
    return goal.currency === "USDC" ? String(goal.tokenId || "") : "";
  }

  function communityAmount(value, goal = appConfig.communityGoal || {}) {
    return goal.currency === "USDC"
      ? usdFromTokenUnits(value, Number(goal.decimals || 6))
      : `${communityFundTools.formatNear(value)} Testnet NEAR`;
  }

  function communityProgressPercent(value, target) {
    try {
      const basisPoints = (BigInt(String(value)) * 10_000n) / BigInt(String(target));
      const bounded = basisPoints > 10_000n ? 10_000n : basisPoints;
      return (Number(bounded) / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
    } catch (_error) {
      return null;
    }
  }

  function parseCommunityAmount(value, goal = appConfig.communityGoal || {}) {
    return goal.currency === "USDC"
      ? usdcTools.parseUnits(value, Number(goal.decimals || 6))
      : communityFundTools.decimalToYocto(value);
  }

  function communityProposalCard(proposal, safety, activity, goal) {
    const allocation = proposal?.receiverId ? proposal : communityFundTools.allocationFromProposal(proposal, communityTokenId(goal));
    if (!allocation) return "";
    const counts = communityVoteCounts(allocation);
    const required = safety?.requiredVotes || 0;
    const ownVote = state.accountId ? allocation.votes[state.accountId] : null;
    const payment = verifiedCommunityPayment(allocation, activity);
    const matchesGoalRecipient = !goal?.recipient || allocation.receiverId === goal.recipient;
    const canVote = Boolean(
      safety?.ready && state.accountId && safety.voterAccounts.has(state.accountId)
      && allocation.status === "InProgress" && !ownVote && !payment
    );
    const decidingVote = canVote && counts.approve + 1 >= required;
    const voters = Object.entries(allocation.votes || {}).map(([account, vote]) =>
      `<li><code>${escapeHtml(account)}</code><strong>${escapeHtml(vote)}</strong></li>`
    ).join("");
    const statusCopy = payment
      ? `Paid by the DAO · contract status ${allocation.status}`
      : allocation.status === "Approved"
        ? "Payment confirmation pending"
      : allocation.status === "InProgress"
        ? "Needs member approval"
        : allocation.status;
    const actions = canVote
      ? matchesGoalRecipient
        ? `<div class="fund-proposal-actions"><button class="button button-primary" type="button" data-community-action="vote" data-proposal-id="${allocation.id}" data-vote-action="VoteApprove">Approve</button><button class="button button-outline" type="button" data-community-action="vote" data-proposal-id="${allocation.id}" data-vote-action="VoteReject">Reject</button></div><p class="field-help">${decidingVote ? "This is the deciding approval. The DAO sends the payment in the same on-chain action if execution succeeds." : `The payment is sent when ${required} approvals are recorded.`}</p>`
        : `<div class="fund-proposal-actions"><button class="button button-outline" type="button" data-community-action="vote" data-proposal-id="${allocation.id}" data-vote-action="VoteReject">Reject different recipient</button></div><p class="field-help">HarvestPool will not submit an approval for a recipient that differs from the configured goal.</p>`
      : ownVote
        ? `<p class="fund-own-vote">Your recorded vote: <strong>${escapeHtml(ownVote)}</strong></p>`
        : "";
    return `<article class="fund-proposal-card"><div class="fund-proposal-top"><span class="status ${payment ? "status-funded" : allocation.status === "InProgress" || allocation.status === "Approved" ? "status-pending" : "status-failed"}"><span></span>${escapeHtml(statusCopy)}</span><span class="section-kicker">Request #${allocation.id}</span></div><h3>${escapeHtml(communityAmount(allocation.amount, goal))} to <code>${escapeHtml(allocation.receiverId)}</code></h3><p class="proposal-recipient-check ${matchesGoalRecipient ? "matches" : "differs"}">${matchesGoalRecipient ? "Matches this goal’s intended recipient" : "Warning: this request names a different recipient than the Community Goal"}</p><p>${escapeHtml(allocation.reason)}</p><dl class="fund-proposal-details"><div><dt>Requested by</dt><dd><code>${escapeHtml(allocation.proposer)}</code></dd></div><div><dt>Approvals needed</dt><dd>${required} of ${safety?.memberCount || 0} voting members</dd></div><div><dt>Votes</dt><dd>${counts.approve} approve · ${counts.reject} reject${counts.remove ? ` · ${counts.remove} remove` : ""}</dd></div><div><dt>Submitted</dt><dd>${escapeHtml(communityTime(allocation.submissionTime))}</dd></div></dl>${voters ? `<details class="fund-voters"><summary>See recorded votes</summary><ul>${voters}</ul></details>` : ""}${payment || allocation.status === "Approved" ? `<div class="fund-payment-reference"><strong>${payment ? "Payment confirmed" : "Payment confirmation pending"}</strong>${communityExplorerLink(payment?.transactionHash, "View payment")}</div>` : actions}</article>`;
  }

  function communityHistoryMarkup(fund, allocations, goal, mode = "all") {
    const activity = fund.activity;
    if (!activity || activity.error) {
      return `<div class="fund-history-unavailable"><strong>Money in and out is temporarily unavailable</strong><p>${escapeHtml(activity?.error || "The public transaction service did not return a complete record.")} The balance and requests still come directly from the DAO.</p><button class="button button-outline button-small" type="button" data-community-action="refresh-history">Retry activity</button></div>`;
    }
    const records = (activity.contributions || []).map((item) => ({
      type: "Contribution",
      amount: item.amount,
      account: item.contributor,
      reason: `Direct contribution toward ${goal?.title || "the Community Goal"}`,
      timestamp: item.timestamp,
      transactionHash: item.transactionHash,
    }));
    if (mode !== "contributions") allocations.forEach((allocation) => {
      const payment = verifiedCommunityPayment(allocation, activity);
      if (!payment) return;
      records.push({
        type: "Approved payment",
        amount: allocation.amount,
        account: allocation.receiverId,
        reason: allocation.reason,
        timestamp: payment.timestamp || allocation.submissionTime,
        transactionHash: payment.transactionHash,
        proposer: allocation.proposer,
        approvers: Object.entries(allocation.votes || {}).filter(([, vote]) => vote === "Approve").map(([account]) => account),
      });
    });
    records.sort((left, right) => {
      try { return BigInt(right.timestamp) > BigInt(left.timestamp) ? 1 : -1; } catch (_error) { return 0; }
    });
    const verifiedAt = communityVerificationTime(activity);
    const freshness = `<div class="fund-history-freshness ${activity.stale ? "is-stale" : ""}" role="status"><span>${activity.stale ? "Showing the last confirmed record" : "Last checked"}: ${escapeHtml(verifiedAt)}</span><button class="button button-outline button-small" type="button" data-community-action="refresh-history">Retry activity</button></div>`;
    const coverage = activity.contributionHistoryComplete
      ? ""
      : '<p class="fund-public-note"><strong>Partial discovery coverage.</strong> These exact receipts are preserved and included in Confirmed, but the indexer did not prove that every historical contribution has been discovered. Confirmed is never inferred from the current treasury balance.</p>';
    if (!records.length) return `${freshness}<div class="dashboard-empty compact"><p>No contributions or confirmed payments are recorded yet.</p></div>`;
    return `${freshness}${coverage}<div class="fund-history-list">${records.map((record) => `<article class="fund-history-row"><div><span class="section-kicker">${escapeHtml(record.type)}</span><strong>${escapeHtml(communityAmount(record.amount, goal))}</strong><p>${escapeHtml(record.reason)}</p></div><dl><div><dt>${record.type === "Contribution" ? "From" : "To"}</dt><dd><code>${escapeHtml(record.account)}</code></dd></div>${record.proposer ? `<div><dt>Requested by</dt><dd><code>${escapeHtml(record.proposer)}</code></dd></div><div><dt>Approved by</dt><dd>${record.approvers.map((account) => `<code>${escapeHtml(account)}</code>`).join(", ")}</dd></div>` : ""}<div><dt>Date</dt><dd>${escapeHtml(communityTime(record.timestamp))}</dd></div></dl>${communityExplorerLink(record.transactionHash)}</article>`).join("")}</div>`;
  }

  const COMMUNITY_TABS = new Set(["overview", "contributions", "payment-requests", "votes", "activity"]);

  function requestedCommunityTab() {
    const requested = new URL(window.location.href).searchParams.get("view");
    return COMMUNITY_TABS.has(requested) ? requested : "overview";
  }

  function activateCommunityTab(tab, { focus = false } = {}) {
    const nextTab = COMMUNITY_TABS.has(tab) ? tab : "overview";
    state.communityFund.activeTab = nextTab;
    const url = new URL(window.location.href);
    if (nextTab === "overview") url.searchParams.delete("view");
    else url.searchParams.set("view", nextTab);
    window.history.replaceState({}, "", url);
    renderCommunityFundPage();
    if (focus) $(`[data-community-tab="${nextTab}"]`)?.focus();
  }

  function personalContributionMarkup(fund, goal) {
    if (!state.accountId) return "";
    const currentDao = String(appConfig.communityDaoId || "");
    const pending = pendingActionStore.list(state.accountId).filter((action) =>
      action.methodName === "community_contribute_usdc"
      && String(action.context?.daoId || "") === currentDao
    );
    const confirmed = (fund.activity?.contributions || [])
      .filter((record) => String(record.contributor || record.account || "") === String(state.accountId))
      .map((record) => ({
        id: record.receiptId || record.transactionHash,
        amount: String(record.amount || "0"),
        state: "confirmed",
        transactionHash: record.transactionHash,
        receiptId: record.receiptId,
        updatedAt: Number(record.timestamp || 0) / 1_000_000,
      }));
    const confirmedHashes = new Set(confirmed.map((record) => String(record.transactionHash || "")));
    const visiblePending = pending.filter((action) =>
      !action.transactionHash || !confirmedHashes.has(String(action.transactionHash))
    );
    const seen = new Set([
      ...visiblePending.map((action) => String(action.transactionHash || action.id)),
      ...confirmed.map((record) => String(record.transactionHash || record.id)),
    ]);
    const resolved = personalContributionOutcomes().filter((record) => {
      const identity = String(record.transactionHash || record.id);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
    const records = [
      ...visiblePending.map((action) => ({
        id: action.id,
        actionId: action.id,
        amount: String(action.args?.amount || "0"),
        state: action.transactionHash
          ? "awaiting"
          : action.phase === "wallet-unresponsive"
            ? "wallet-unresponsive"
            : "unresolved",
        transactionHash: action.transactionHash || null,
        updatedAt: Number(action.savedAt || 0),
      })),
      ...confirmed,
      ...resolved,
    ].sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
    if (!records.length) return "";
    const contributionRow = (record, { previous = false } = {}) => {
      const amount = communityAmount(record.amount, goal);
      const status = record.state === "confirmed"
        ? "Confirmed"
        : record.state === "failed"
          ? "Failed"
          : record.state === "wallet-rejected"
            ? "Not submitted"
          : record.state === "wallet-failed"
            ? "Wallet launch failed"
          : record.state === "wallet-unresponsive"
            ? "Meteor did not respond"
          : record.state === "unresolved"
            ? "Checking your payment"
            : "Checking your payment";
      const message = record.state === "confirmed"
        ? `Your ${amount} payment is confirmed.`
        : record.state === "failed"
          ? `Your ${amount} transaction reached a final outcome without a verified contribution.`
          : record.state === "wallet-rejected"
            ? `Meteor cancelled or rejected your ${amount} request. HarvestPool has no evidence that money was submitted or received.`
          : record.state === "wallet-failed"
            ? `Meteor did not launch for your ${amount} request. HarvestPool has no evidence that money was submitted or received.`
          : record.state === "wallet-unresponsive"
            ? `Meteor did not return a transaction for your ${amount} request. HarvestPool has no evidence that money was submitted or received. Check Meteor activity before trying again.`
          : record.state === "unresolved"
            ? `We're checking your ${amount} request, but no submitted transaction is visible yet. It is not included in Awaiting confirmation.`
            : `We're checking your ${amount} payment. You don't need to pay again. This observed payment is included in the community awaiting total.`;
      const statusClass = record.state === "confirmed"
        ? "status-funded"
        : ["failed", "wallet-rejected", "wallet-failed"].includes(record.state)
          ? "status-failed"
          : "status-pending";
      const primaryAction = record.actionId
        ? `<button class="button button-outline button-small" type="button" data-action="check-pending-actions" data-pending-action-id="${escapeHtml(record.actionId)}">Check payment status</button>`
        : record.state === "confirmed" && record.transactionHash
          ? communityExplorerLink(record.transactionHash, "View receipt")
          : "";
      const dismiss = !previous && ["failed", "wallet-rejected", "wallet-failed"].includes(record.state)
        ? `<button class="button button-outline button-small" type="button" data-action="dismiss-personal-contribution" data-contribution-outcome-id="${escapeHtml(record.id)}">Dismiss</button>`
        : "";
      const actions = primaryAction || dismiss
        ? `<div class="personal-contribution-actions">${primaryAction}${dismiss}</div>`
        : "";
      const transaction = record.transactionHash
        ? `<code>${escapeHtml(record.transactionHash)}</code>`
        : "Not returned by Meteor";
      return `<article class="personal-contribution-row${previous ? " personal-contribution-previous" : ""}" data-personal-contribution><div class="personal-contribution-heading"><div>${previous ? "" : '<span class="personal-contribution-label">Your contribution</span>'}<strong>${escapeHtml(amount)}</strong><span class="status ${statusClass}"><span></span>${escapeHtml(status)}</span></div>${actions}</div>${previous ? "" : `<p>${escapeHtml(message)}</p><details class="technical-details"><summary>Technical transaction details</summary><dl class="checkout-status-facts"><div><dt>Transaction</dt><dd>${transaction}</dd></div>${record.receiptId ? `<div><dt>Receipt</dt><dd><code>${escapeHtml(record.receiptId)}</code></dd></div>` : ""}</dl></details><p class="field-help" role="status" aria-live="polite" data-pending-check-result></p>`}</article>`;
    };
    const latest = records[0];
    const previousConfirmed = records.slice(1).filter((record) => record.state === "confirmed");
    const previous = previousConfirmed.length
      ? `<details class="previous-contributions"><summary>Previous contributions (${previousConfirmed.length})</summary><div class="personal-contribution-list">${previousConfirmed.map((record) => contributionRow(record, { previous: true })).join("")}</div></details>`
      : "";
    return `<section class="personal-contribution-card" aria-labelledby="personal-contribution-heading"><span class="section-kicker">Payment status</span><h3 id="personal-contribution-heading">Latest payment</h3><div class="personal-contribution-list">${contributionRow(latest)}</div>${previous}</section>`;
  }

  function persistedCommunityFundMarkup(fund, goal) {
    const activity = fund.activity;
    if (!activity) return "";
    const subtotal = String(activity.verifiedContributionSubtotal || "0");
    const awaiting = String(activity.awaitingConfirmation || "0");
    const target = String(goal.targetUnits || goal.targetYocto || "0");
    const remaining = /^\d+$/.test(target) && /^\d+$/.test(subtotal)
      ? (BigInt(target) > BigInt(subtotal) ? BigInt(target) - BigInt(subtotal) : 0n).toString()
      : null;
    const percentage = communityProgressPercent(subtotal, target);
    const checked = communityVerificationTime(activity);
    const progress = percentage === null
      ? '<div class="goal-progress-neutral" role="status">Checking the durable receipt ledger…</div>'
      : `<div class="goal-progress" role="progressbar" aria-label="Confirmed contributions toward ${escapeHtml(goal.title)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percentage}"><span style="width:${percentage}%"></span></div><div class="goal-progress-label"><strong>${percentage}% confirmed</strong><span>${escapeHtml(communityAmount(remaining, goal))} left to reach the goal</span></div>`;
    const status = BigInt(subtotal) >= BigInt(target) ? "Goal reached" : "Open for contributions";
    const error = fund.error
      ? '<p class="fund-inline-retry" role="status">Live treasury and governance checks are temporarily unavailable. Saved verified figures remain visible. <button class="button button-outline button-small" type="button" data-community-action="refresh">Retry live checks</button></p>'
      : '<p class="fund-inline-retry" role="status">Live treasury, governance, and contribution controls are loading independently.</p>';
    return `<div class="community-fund-primary"><div class="community-summary-column"><section class="community-goal-card" aria-labelledby="community-goal-heading"><div class="goal-card-top"><div><span class="section-kicker">Fundraising progress</span><h2 id="community-goal-heading">${escapeHtml(goal.title)}</h2></div><span class="status status-pending"><span></span>${escapeHtml(status)}</span></div><p class="goal-purpose">${escapeHtml(goal.purpose)}</p><dl class="goal-summary-figures"><div><dt>Goal</dt><dd>${escapeHtml(communityAmount(target, goal))}</dd></div><div><dt>Confirmed</dt><dd>${escapeHtml(communityAmount(subtotal, goal))}</dd></div><div><dt>Awaiting confirmation</dt><dd>${escapeHtml(communityAmount(awaiting, goal))}</dd></div></dl>${progress}<p class="goal-testnet-note">Last exact receipt verification: ${escapeHtml(checked)} · Testnet only. Awaiting confirmation includes only reported payments whose exact transaction was observed; hashless or provider-unseen actions are excluded.</p></section></div><aside class="fund-action-card fund-contribution-card"><span class="section-kicker">Support this fund</span><h2>Contribute</h2><p>Contribution controls will appear after the independent token and DAO safety checks finish.</p></aside></div>${error}`;
  }

  function renderCommunityFundPage() {
    const root = $("#community-fund-root");
    if (!root) return;
    const fund = state.communityFund;
    if (!fund.activeTab) fund.activeTab = requestedCommunityTab();
    const goal = appConfig.communityGoal || {};
    if (!appConfig.communityDaoId || !goal.configured) {
      const configurationNote = goal.configurationError
        ? `<p class="fund-configuration-error">${escapeHtml(goal.configurationError)}</p>`
        : "";
      root.innerHTML = `<div class="fund-setup-state"><span class="section-kicker">Configuration required</span><h2>Community Goals is not live yet.</h2><p>The SputnikDAO integration is prepared, but one dedicated goal and its hardened DAO treasury must be authorized and configured together. No goal balance, progress, vote, or payment is presented as real.</p>${configurationNote}<p class="fund-account-line">Expected factory: <code>${escapeHtml(appConfig.communityDaoFactoryId || "sputnikv2.testnet")}</code></p></div>`;
      return;
    }
    if (!fund.loaded) {
      const persistedMarkup = persistedCommunityFundMarkup(fund, goal);
      if (persistedMarkup) root.innerHTML = persistedMarkup;
      return;
    }
    if (fund.error) {
      const persistedMarkup = persistedCommunityFundMarkup(fund, goal);
      if (persistedMarkup) {
        root.innerHTML = persistedMarkup;
        return;
      }
      showError(root, "Community Goal reads are unavailable", "HarvestPool could not verify the goal treasury contract, policy, balance, proposals, factory permissions, and access keys. Financial actions stay disabled.", '<button class="button button-outline" type="button" data-community-action="refresh">Retry authoritative reads</button>');
      return;
    }
    const safety = fund.safety;
    const tokenId = communityTokenId(goal);
    const sections = communityFundTools.proposalSections(fund.proposals, fund.activity, safety, state.accountId, tokenId);
    const allocations = sections.allocations;
    const isUsdc = goal.currency === "USDC";
    const assetReady = Boolean(fund.asset?.ready);
    const availableBalance = isUsdc ? String(fund.asset?.daoBalance || "0") : fund.availableAmount;
    const verifiedPayments = allocations.filter((allocation) => verifiedCommunityPayment(allocation, fund.activity));
    let activityComplete = Boolean(fund.activity && !fund.activity.error && fund.activity.complete);
    if (activityComplete && fund.activity.boundedEvidence) {
      try {
        const evidenceContributions = (fund.activity.contributions || [])
          .reduce((total, item) => total + BigInt(item.amount), 0n);
        const evidencePayments = verifiedPayments
          .reduce((total, allocation) => total + BigInt(allocation.amount), 0n);
        activityComplete = isUsdc && assetReady && evidenceContributions >= evidencePayments
          && evidenceContributions - evidencePayments === BigInt(availableBalance);
      } catch (_error) {
        activityComplete = false;
      }
    }
    const spent = fund.proposalsComplete && (allocations.length === 0 || activityComplete)
      ? verifiedPayments.reduce((total, allocation) => total + BigInt(allocation.amount), 0n).toString()
      : null;
    const verifiedSubtotal = fund.activity?.verifiedContributionSubtotal === undefined
      ? null
      : String(fund.activity.verifiedContributionSubtotal);
    const contributed = verifiedSubtotal;
    const awaitingConfirmation = String(fund.activity?.awaitingConfirmation || "0");
    const goalSnapshot = communityFundTools.goalSnapshot(goal, contributed, allocations, fund.activity);
    const pending = fund.proposalsComplete ? communityFundTools.sumAllocations(fund.proposals, ["InProgress"], tokenId) : null;
    const approvedUnverified = fund.proposalsComplete
      ? allocations.filter((allocation) => allocation.status === "Approved" && !verifiedCommunityPayment(allocation, fund.activity))
        .reduce((total, allocation) => total + BigInt(allocation.amount), 0n).toString()
      : null;
    const isMemberAccount = Boolean(state.accountId && safety.members.includes(state.accountId));
    const canPropose = Boolean(state.accountId && safety.proposerAccounts.has(state.accountId));
    const targetUnits = String(goal.targetUnits || goal.targetYocto || "0");
    const contributionLimit = goalSnapshot
      ? communityFundTools.contributionLimit(goal, goalSnapshot.contributed)
      : { allowed: false, reached: false, remaining: null };
    const assetLabel = isUsdc ? "USDC on NEAR Testnet" : "Testnet NEAR";
    const safetyMarkup = safety.ready
      ? `<details class="fund-protection-details"><summary>How your money is protected</summary><p>Everyone can see how much money the community has, where it goes, and how much remains. A payment needs ${safety.requiredVotes} of ${safety.memberCount} member approvals.</p><ul><li>No DAO account access keys</li><li>Factory auto-updates are off</li><li>No policy-change, upgrade, or arbitrary-call permission</li><li>The app fixes this goal’s intended recipient; the DAO contract itself relies on member approval of the recipient named in each request.</li></ul><p>Contributions and votes are public on Testnet. Contributions are not private and cannot be personally withdrawn or automatically refunded.</p></details>`
      : `<div class="fund-safety-blocked" role="alert"><strong>Financial actions are disabled</strong><p>HarvestPool cannot make the no-unilateral-withdrawal promise for this DAO:</p><ul>${safety.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></div>`;
    const connectMarkup = !state.accountId
      ? '<button class="button button-dark" type="button" data-connect-wallet>Connect wallet to contribute or vote</button>'
      : `<div class="fund-membership ${isMemberAccount ? "is-member" : ""}"><strong>${isMemberAccount ? "You can contribute and vote" : "You can contribute · voting is for members"}</strong><span><code>${escapeHtml(state.accountId)}</code>${isMemberAccount ? " is one of the fixed DAO members." : " is not in the fixed voting group."}</span></div>`;
    const personalContribution = personalContributionMarkup(fund, goal);
    const registrationAction = isUsdc && safety.ready && state.accountId && !fund.asset?.daoStorage
      ? `<div class="fund-action-card"><span class="section-kicker">One-time setup</span><h2>Register the treasury for USDC</h2><p>The DAO must be registered with the USDC contract before it can receive tokens. This uses the token contract’s exact minimum storage deposit and transfers no USDC.</p><button class="button button-primary" type="button" data-community-action="register-token">Review registration</button></div>`
      : "";
    const contributionForm = safety.ready && assetReady && state.accountId && goalSnapshot
      && (!goal.uiContributionCap || !contributionLimit.reached)
      ? `<form class="fund-action-card fund-contribution-card" id="community-contribution-form" data-community-contribution novalidate><span class="section-kicker">Support this fund</span><h2>Contribute</h2><p>Choose an amount to support this fund.</p><label for="fund-contribution-amount">${isUsdc ? "Amount ($)" : `Amount in ${assetLabel}`}</label><input id="fund-contribution-amount" name="amount" type="number" inputmode="decimal" min="0.000001" step="0.000001" required><div class="form-error-summary" tabindex="-1" role="alert" hidden></div><button class="button button-primary" type="submit">Contribute</button>${personalContribution}</form>`
      : "";
    const goalReachedNotice = goal.uiContributionCap && contributionLimit.reached
      ? `<div class="fund-action-card fund-contribution-card" id="community-contribution-panel" tabindex="-1"><span class="section-kicker">Goal reached</span><h2>Contributions are closed in HarvestPool</h2><p>The ${escapeHtml(communityAmount(targetUnits, goal))} goal has been reached. This is an application-level restriction; the blockchain contracts do not enforce the fundraising goal.</p></div>`
      : "";
    const connectContribution = !state.accountId && !contributionLimit.reached
      ? `<aside class="fund-action-card fund-contribution-card" id="community-contribution-panel" tabindex="-1"><span class="section-kicker">Support this fund</span><h2>Contribute</h2><p>Connect your wallet to choose an amount.</p><button class="button button-dark" type="button" data-connect-wallet>Connect wallet</button></aside>`
      : "";
    const contributionUnavailable = state.accountId && !registrationAction && !contributionForm && !goalReachedNotice
      ? '<aside class="fund-action-card fund-contribution-card" id="community-contribution-panel" tabindex="-1"><span class="section-kicker">Contribution status</span><h2>Contributions unavailable</h2><p>HarvestPool has not completed every treasury and token verification required to enable this action.</p></aside>'
      : "";
    const primaryContributionAction = registrationAction || contributionForm || goalReachedNotice || connectContribution || contributionUnavailable;
    const contributionColumn = `<div class="community-contribution-column">${primaryContributionAction}${contributionForm ? "" : personalContribution}</div>`;
    const proposalForm = safety.ready && assetReady && canPropose && activityComplete && goalSnapshot
      && sections.open.length === 0
      ? `<form class="fund-action-card" data-community-proposal novalidate><span class="section-kicker">Request payment</span><h2>Ask members to approve</h2><div class="goal-fixed-recipient"><span>Intended recipient</span><code>${escapeHtml(goal.recipient)}</code><small>HarvestPool fixes this recipient in its request form. SputnikDAO itself relies on members checking and approving the recipient written into the request.</small></div><div class="field"><label for="fund-allocation-amount">${isUsdc ? "Amount ($)" : `Amount in ${assetLabel}`}</label><input id="fund-allocation-amount" name="amount" type="number" inputmode="decimal" min="0.000001" step="0.000001" required></div><div class="field"><label for="fund-allocation-reason">Why is this payment needed?</label><textarea id="fund-allocation-reason" name="reason" maxlength="500" rows="3" required></textarea></div><p class="field-help">This public request uses a ${communityFundTools.formatNear(fund.policy.proposal_bond)} Testnet NEAR proposal bond. The payment is sent only after the required approvals.</p><div class="form-error-summary" tabindex="-1" role="alert" hidden></div><button class="button button-primary" type="submit">Request payment</button></form>`
      : "";
    const proposalCards = (items) => items.map((proposal) => communityProposalCard(proposal, safety, fund.activity, goal)).filter(Boolean).join("");
    const goalProgress = goalSnapshot
      ? `<div class="goal-progress" role="progressbar" aria-label="Confirmed contributions toward ${escapeHtml(goal.title)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${communityProgressPercent(goalSnapshot.contributed, goalSnapshot.target)}" aria-valuetext="${escapeHtml(`${communityAmount(goalSnapshot.contributed, goal)} confirmed of ${communityAmount(goalSnapshot.target, goal)}`)}"><span style="width:${communityProgressPercent(goalSnapshot.contributed, goalSnapshot.target)}%"></span></div>`
      : '<div class="goal-progress-unavailable">The durable receipt ledger is unavailable.</div>';
    const remaining = goalSnapshot
      ? (BigInt(goalSnapshot.target) > BigInt(goalSnapshot.contributed)
        ? (BigInt(goalSnapshot.target) - BigInt(goalSnapshot.contributed)).toString()
        : "0")
      : null;
    const goalStatusClass = goalSnapshot?.status === "Goal reached" ? "status-funded" : goalSnapshot ? "status-open" : "status-pending";
    const confirmedDisplay = goalSnapshot
      ? communityAmount(goalSnapshot.contributed, goal)
      : "Unavailable";
    const progressCopy = goalSnapshot
      ? `<div class="goal-progress-label"><strong>${communityProgressPercent(goalSnapshot.contributed, goalSnapshot.target)}% confirmed</strong><span>${escapeHtml(communityAmount(remaining, goal))} left to reach the goal</span></div>`
      : "";
    const goalCard = `<section class="community-goal-card" aria-labelledby="community-goal-heading"><div class="goal-card-top"><div><span class="section-kicker">Fundraising progress</span><h2 id="community-goal-heading">${escapeHtml(goal.title)}</h2></div><span class="status ${goalStatusClass}"><span></span>${escapeHtml(goalSnapshot?.status || "Verification incomplete")}</span></div><p class="goal-purpose">${escapeHtml(goal.purpose)}</p><dl class="goal-summary-figures"><div><dt>Goal</dt><dd>${escapeHtml(communityAmount(targetUnits, goal))}</dd></div><div><dt>Confirmed</dt><dd>${escapeHtml(confirmedDisplay)}</dd></div><div><dt>Awaiting confirmation</dt><dd>${escapeHtml(communityAmount(awaitingConfirmation, goal))}</dd></div></dl>${goalProgress}${progressCopy}<p class="goal-testnet-note">Awaiting confirmation includes community payments with trustworthy submission evidence that are still being verified.</p></section>`;
    const activeTab = state.communityFund.activeTab || requestedCommunityTab();
    state.communityFund.activeTab = activeTab;
    const countLabel = (count) => count === null ? "" : ` <span>(${count})</span>`;
    const needsVoteCount = state.accountId && fund.proposalsComplete ? sections.needsVote.length : null;
    const requestCount = fund.proposalsComplete ? sections.open.length + sections.completed.length : null;
    const tabs = [
      ["overview", "Overview", null],
      ["contributions", "Contributions", (fund.activity?.contributions || []).length],
      ["payment-requests", "Payment Requests", requestCount],
      ["votes", "Votes", needsVoteCount],
      ["activity", "Activity", null],
    ];
    const tabMarkup = `<div class="fund-tabs" role="tablist" aria-label="Community Goal sections">${tabs.map(([id, label, count]) => `<button class="fund-tab" id="community-tab-${id}" type="button" role="tab" aria-selected="${activeTab === id}" aria-controls="community-panel-${id}" tabindex="${activeTab === id ? "0" : "-1"}" data-community-tab="${id}">${label}${countLabel(count)}</button>`).join("")}</div>`;
    let panelMarkup = "";
    if (activeTab === "overview") {
      panelMarkup = `<section class="fund-overview" id="community-panel-overview" role="tabpanel" aria-labelledby="community-tab-overview"><div class="fund-overview-heading"><div><span class="section-kicker">Fund details</span><h2>Verified treasury and governance</h2><p><code>${escapeHtml(appConfig.communityDaoId)}</code></p></div>${connectMarkup}</div><div class="fund-stat-grid compact"><div><span>Current treasury</span><strong>${assetReady ? escapeHtml(communityAmount(availableBalance, goal)) : "Unavailable"}</strong><small>Finalized token balance; distinct from lifetime raised</small></div><div><span>Paid</span><strong>${spent === null ? "Unavailable" : escapeHtml(communityAmount(spent, goal))}</strong><small>Only successful transfer receipts count</small></div><div><span>Needs approval</span><strong>${pending === null ? "Unavailable" : escapeHtml(communityAmount(pending, goal))}</strong><small>Open payment requests</small></div>${approvedUnverified !== "0" ? `<div><span>Confirmation pending</span><strong>${approvedUnverified === null ? "Unavailable" : escapeHtml(communityAmount(approvedUnverified, goal))}</strong><small>Not counted as paid</small></div>` : ""}</div><p class="fund-public-note">Any registered Testnet wallet can contribute. Only the fixed DAO members can request or approve payments.</p>${safetyMarkup}</section>`;
    } else if (activeTab === "contributions") {
      panelMarkup = `<section class="fund-history" id="community-panel-contributions" role="tabpanel" aria-labelledby="community-tab-contributions"><div class="section-heading-inline"><div><span class="section-kicker">Verified transfers in</span><h2>Contributions</h2></div></div>${communityHistoryMarkup(fund, [], goal, "contributions")}</section>`;
    } else if (activeTab === "votes") {
      const content = !state.accountId
        ? '<div class="dashboard-empty compact"><p>Connect your wallet to see requests you can vote on.</p><button class="button button-dark" type="button" data-connect-wallet>Connect wallet</button></div>'
        : sections.needsVote.length
          ? proposalCards(sections.needsVote)
          : `<div class="dashboard-empty compact"><p>${isMemberAccount ? "You have no payment requests waiting for your vote." : "This wallet is not one of the fixed voting members."}</p></div>`;
      panelMarkup = `<section class="fund-proposals" id="community-panel-votes" role="tabpanel" aria-labelledby="community-tab-votes"><div class="section-heading-inline"><div><span class="section-kicker">DAO approval rule</span><h2>Votes</h2><p>${safety.requiredVotes} of ${safety.memberCount} fixed DAO members must approve a payment. Contributors do not automatically become voters.</p></div></div>${content}</section>`;
    } else if (activeTab === "payment-requests") {
      const allRequests = [...sections.open, ...sections.completed];
      panelMarkup = `<section class="fund-proposals" id="community-panel-payment-requests" role="tabpanel" aria-labelledby="community-tab-payment-requests"><div class="section-heading-inline"><div><span class="section-kicker">Treasury decisions</span><h2>Payment Requests</h2></div></div>${proposalForm ? `<div class="fund-action-grid single">${proposalForm}</div>` : ""}${proposalCards(allRequests) || '<div class="dashboard-empty compact"><p>No payment requests are recorded.</p></div>'}</section>`;
    } else {
      panelMarkup = `<section class="fund-history" id="community-panel-activity" role="tabpanel" aria-labelledby="community-tab-activity"><div class="section-heading-inline"><div><span class="section-kicker">Public transaction record</span><h2>Money in and out</h2></div><a class="text-link" href="${escapeHtml(fund.activity?.sourceUrl || `https://testnet.nearblocks.io/address/${appConfig.communityDaoId}`)}" target="_blank" rel="noopener noreferrer">Open NearBlocks <span aria-hidden="true">↗</span></a></div>${communityHistoryMarkup(fund, allocations, goal)}</section>`;
    }
    root.innerHTML = `<div class="community-fund-primary"><div class="community-summary-column">${goalCard}</div>${contributionColumn}</div>${tabMarkup}${panelMarkup}`;
  }

  function renderCurrentPage() {
    if (appConfig.page === "explore") renderExplore();
    if (appConfig.page === "details") {
      renderDetailsPage();
      decorateDetailsActions();
    }
    if (appConfig.page === "agreement") renderAgreementPage();
    if (appConfig.page === "supplier_invitation") renderSupplierInvitationPage();
    if (appConfig.page === "dashboard") {
      renderDashboard();
      renderDashboardSummary();
    }
    if (appConfig.page === "decisions") renderDecisions();
    if (appConfig.page === "issue_form") renderIssueFormPage();
    if (appConfig.page === "farmer") {
      renderFarmer();
      renderFarmerPaymentTotals();
    }
    if (appConfig.page === "community_fund") renderCommunityFundPage();
    if (appConfig.page === "create" && state.recoveredCreateRecord) renderRecoveredCreateSuccess(state.recoveredCreateRecord);
    decorateMoneyText();
    restoreDraftsInDom();
    $$('[data-decision-form]').forEach(updateDecisionFormType);
    updateActionCenterCount();
    focusHashTarget();
  }

  function disconnectedAccountMarkup(message) {
    return `<div class="wallet-empty-state"><strong>Wallet not connected</strong><span>${escapeHtml(message)} Use Connect wallet in the navigation when you are ready.</span></div>`;
  }

  function accountDataLoadingMarkup(title, message) {
    return `<div class="wallet-empty-state data-loading-state" role="status" aria-live="polite"><span class="loading-label"><span class="loading-spinner" aria-hidden="true"></span><strong>${escapeHtml(title)}</strong></span><span>${escapeHtml(message)}</span><span class="loading-bar short" aria-hidden="true"></span></div>`;
  }

  function accountDataUnavailableMarkup(message) {
    return `<div class="issues-unavailable" role="status"><strong>Live account data is temporarily unavailable.</strong><p>${escapeHtml(message)}</p><button class="button button-outline button-small" type="button" data-action="retry-live-data">Retry live data</button></div>`;
  }

  function accountAuthorityReady() {
    return !state.accountId || state.accountDataVerified;
  }

  function relativeRefreshTime(timestamp) {
    const ageSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (ageSeconds < 5) return "just now";
    if (ageSeconds < 60) return `${ageSeconds} seconds ago`;
    const minutes = Math.floor(ageSeconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }

  function liveRefreshStatusMarkup() {
    if (!state.lastVerifiedRefreshAt) return "";
    return `<div class="live-refresh-status" role="status" aria-live="polite"><span>Updated ${escapeHtml(relativeRefreshTime(state.lastVerifiedRefreshAt))} · Checking for updates…</span><button class="button button-outline button-small" type="button" data-action="retry-live-data">Refresh</button></div>`;
  }

  function accountReadWarningMarkup() {
    if (!state.accountDataError) return "";
    return `<div class="live-read-warning" role="status"><strong>Couldn't check the latest wallet data.</strong><span>Showing the last verified account records. Restricted actions stay disabled until the wallet state is verified.</span><button class="button button-outline button-small" type="button" data-action="retry-live-data">Refresh</button></div>`;
  }

  function purchaseReadWarningMarkup() {
    return state.liveDataError
      ? `<div class="live-read-warning" role="status"><strong>Couldn't check for updates.</strong><span>Showing the last verified deals. Restricted actions remain disabled until fresh authoritative state is available.</span><button class="button button-outline button-small" type="button" data-action="retry-live-data">Refresh</button></div>`
      : "";
  }

  function renderRecoveredCreateSuccess(purchase) {
    const form = $("#create-purchase-form");
    const section = form?.closest(".form-section");
    if (!section || !purchase) return;
    section.innerHTML = `<section class="checkout-confirmed" role="status" aria-live="polite"><div class="checkout-confirmed-mark" aria-hidden="true">${icon("shield")}</div><div class="checkout-confirmed-main"><span class="section-kicker">Confirmed on-chain</span><h2>${escapeHtml(livePurchaseTitle(purchase))}</h2><p>Your Group Deal was confirmed after HarvestPool recovered the submitted transaction state. The saved draft for this action was cleared.</p><div class="checkout-confirmed-actions"><a class="button button-primary" href="/purchases/${encodeURIComponent(purchase.id)}">View Group Deal</a><a class="button button-outline" href="/create">Post another deal</a></div></div></section>`;
  }

  function decorateMoneyText() {
    if (isV5()) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    nodes.forEach((textNode) => {
      if (textNode.parentElement?.closest(".money-primary, .money-secondary, script, style")) return;
      const source = textNode.nodeValue || "";
      const pattern = /(?<![\w.])(\d+(?:\.\d{1,24})?) NEAR(?![A-Za-z])/g;
      if (!pattern.test(source)) return;
      pattern.lastIndex = 0;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      let match;
      while ((match = pattern.exec(source))) {
        fragment.append(source.slice(cursor, match.index));
        const yocto = parseNearAmount(match[1]);
        if (yocto === null) {
          fragment.append(match[0]);
        } else {
          const wrapper = document.createElement("span");
          wrapper.className = "money-inline";
          wrapper.innerHTML = moneyMarkup(yocto);
          fragment.append(wrapper);
        }
        cursor = match.index + match[0].length;
      }
      fragment.append(source.slice(cursor));
      textNode.replaceWith(fragment);
    });
  }

  function renderDashboardSummary() {
    const toolbar = $("#dashboard-root .dashboard-toolbar");
    if (!toolbar) return;
    let total = 0n;
    state.purchases.forEach((purchase) => {
      const commitment = commitmentFor(purchase);
      if (!commitment) return;
      try { total += BigInt(commitment.amount); } catch (_error) { /* ignore malformed view data */ }
    });
    const summary = document.createElement("div");
    summary.className = "dashboard-summary";
    summary.innerHTML = `<span>Total recorded contributions</span><strong>${isV5() ? escapeHtml(usdFromTokenUnits(total)) : moneyMarkup(total)}</strong>`;
    toolbar.append(summary);
  }

  function renderFarmerPaymentTotals() {
    const cards = $("#farmer-root") ? $$(".farmer-card", $("#farmer-root")) : [];
    const purchases = state.purchases.filter((purchase) => String(supplierAccount(purchase)) === String(state.accountId));
    cards.forEach((card, index) => {
      const purchase = purchases[index];
      if (!purchase) return;
      const summary = document.createElement("p");
      summary.className = "farmer-payment-total";
      summary.innerHTML = `<strong>Supplier payment</strong> ${escapeHtml(customerPaymentLabel(purchase, purchase.total_funded_amount))} after approved fulfillment`;
      const anchor = card.querySelector("form, .evidence-hash, .field-help, .text-link");
      if (anchor) card.insertBefore(summary, anchor);
      else card.append(summary);
    });
  }

  function livePurchaseTitle(purchase) {
    return purchase.product_name || purchase.title || `Community purchase #${purchase.id}`;
  }

  function livePurchaseDescription(purchase) {
    return purchase.description || "This purchase has quantity, price, deadlines, and a named supplier in its terms.";
  }

  function renderPurchaseCard(purchase) {
    const max = Number(purchase.max_quantity || 0);
    const total = Number(purchase.total_quantity || 0);
    const progress = max ? Math.min(100, Math.round((total / max) * 100)) : 0;
    const supplierId = supplierAccount(purchase);
    const supplier = purchase.supplier_business_name || (supplierId ? `Supplier · ${shortAccount(supplierId)}` : "Supplier not set");
    const detailsUrl = `/deals/${encodeURIComponent(purchase.id)}`;
    const memberAlreadyJoined = isFundedMember(purchase) || Boolean(commitmentFor(purchase));
    const canJoin = !memberAlreadyJoined && filterTools.isAvailable(purchase);
    const primaryUrl = canJoin ? `/deals/${encodeURIComponent(purchase.id)}/join` : detailsUrl;
    const primaryLabel = canJoin ? "Join This Deal" : memberAlreadyJoined ? "View Your Group Buy" : "View Deal";
    const price = listedUsd(purchase);
    const { unit } = unitDetails(purchase);
    const primaryAction = purchase.state === "AwaitingSupplier"
      ? `<a class="button button-outline button-small" href="/supplier-invitations/${encodeURIComponent(purchase.id)}">View proposal</a>`
      : `<a class="button button-primary button-small" href="${primaryUrl}">${primaryLabel}</a>`;
    const outcome = purchase.state === "Failed"
      ? `<p class="deal-outcome deal-outcome-failed"><strong>Did not proceed.</strong> ${escapeHtml(failureReason(purchase))} ${participantCount(purchase)} ${participantCount(purchase) === 1 ? "buyer participated" : "buyers participated"}.</p>`
      : purchase.state === "Completed"
        ? `<p class="deal-outcome deal-outcome-success"><strong>Completed.</strong> Fulfillment was approved and the deal is closed.</p>`
        : purchase.state === "Declined"
          ? `<p class="deal-outcome deal-outcome-failed"><strong>Supplier declined.</strong> The organizer can revise the terms and send a new proposal.</p>`
          : terminalOutcomeMarkup(purchase);
    return `<article class="purchase-card purchase-card-live" data-status="${escapeHtml(presentationState(purchase))}"><div class="purchase-card-main"><div class="purchase-card-top">${statusPill(presentationState(purchase))}<span class="section-kicker">Deal #${escapeHtml(purchase.id)}</span></div><h2>${escapeHtml(livePurchaseTitle(purchase))}</h2><p class="purchase-description">${escapeHtml(livePurchaseDescription(purchase))}</p>${outcome}${packageContentsMarkup(purchase)}<p class="purchase-supplier">${escapeHtml(supplier)}</p><div class="purchase-card-price"><strong>${price ? escapeHtml(price) : escapeHtml(paymentLabel(purchase, purchase.price_per_unit))}</strong><span>per ${escapeHtml(unit)}</span>${price && !isV5(purchase) ? `<small>Wallet contribution: ${escapeHtml(paymentLabel(purchase, purchase.price_per_unit))} per ${escapeHtml(unit)}</small>` : ""}</div><div class="progress-label"><span>${quantityLabel(purchase, total)} of ${quantityLabel(purchase, max)} reserved</span><span>${participantCount(purchase)} ${participantCount(purchase) === 1 ? "buyer" : "buyers"}</span></div><div class="progress-track"><span style="width: ${progress}%"></span></div></div><div class="purchase-card-actions"><span>${presentationState(purchase) === "DeadlinePassed" ? "Closed · final result pending" : `Join by ${escapeHtml(formatDate(purchase.deadline_ns))}`}</span><div>${primaryAction}<button class="card-share-link" type="button" data-action="share-purchase" data-purchase-id="${escapeHtml(purchase.id)}">Share</button></div></div></article>`;
  }

  function renderExplore() {
    const grid = $("#purchase-grid");
    const empty = $("#explore-empty");
    const disclaimer = $("#explore-disclaimer");
    const chainRead = $(".chain-read");
    if (!grid) return;
    if (state.purchaseDiscoveryStatus === "idle" || state.purchaseDiscoveryStatus === "loading") {
      grid.setAttribute("aria-busy", "true");
      grid.innerHTML = `<div class="loading-shell" role="status"><strong class="loading-heading">Loading available deals…</strong><span class="loading-bar"></span><span class="loading-bar short"></span><span class="loading-block"></span></div>`;
      if (empty) empty.hidden = true;
      return;
    }
    const initialLoadFailed = state.purchaseDiscoveryStatus === "error" && !state.dataLoaded;
    if (initialLoadFailed) {
      grid.setAttribute("aria-busy", "false");
      grid.innerHTML = `<div class="live-unavailable" role="status"><strong>We couldn't load the deals.</strong><p>Try again to load the latest Group Deals.</p><button class="button button-outline button-small" type="button" data-action="reload-live-data">Retry</button></div>`;
      if (empty) empty.hidden = true;
      if (chainRead) chainRead.hidden = true;
      return;
    }
    if (chainRead) chainRead.hidden = false;
    const activeFilter = filterTools.normalizeFilter($("[data-filter].filter-tab.active")?.dataset.filter || "available");
    const allPurchases = state.purchases;
    const visiblePurchases = filterTools.filterPurchases(allPurchases, activeFilter);
    const liveVisible = visiblePurchases;
    const filterLabels = { available: "available deals", "in-progress": "in-progress deals", closed: "closed deals", all: "all deals" };
    const filterLabel = filterLabels[activeFilter] || "deals";
    const liveContent = state.dataLoaded
      ? liveVisible.length ? liveVisible.map(renderPurchaseCard).join("") : `<div class="lane-empty"><h3>No ${escapeHtml(filterLabel)} yet.</h3><p>When a purchase is open, its terms and contribution action will appear here.</p>${activeFilter === "available" ? '<a class="button button-outline button-small" href="/deals?filter=all">View all deals</a> ' : ""}<a class="button button-outline button-small" href="/create">Start a purchase</a></div>`
      : "";
    const totalVisible = visiblePurchases.length;
    const degraded = state.liveDataError
      ? `<div class="live-read-warning" role="status"><strong>Couldn't check for updates.</strong><span>Showing the last verified deals. Some records may be temporarily unavailable.</span><button class="button button-outline button-small" type="button" data-action="retry-live-data">Retry</button></div>`
      : "";
    grid.innerHTML = `<section class="purchase-source live-source">${degraded}${liveRefreshStatusMarkup()}<div class="source-heading source-heading-compact"><strong>${totalVisible} ${totalVisible === 1 ? "deal" : "deals"}</strong><span class="live-source-label"><span class="live-pulse"></span>Authoritative Testnet state</span></div><div class="purchase-grid purchase-grid-live">${liveContent}</div></section>`;
    grid.setAttribute("aria-busy", "false");
    if (liveVisible.length && !document.documentElement.dataset.harvestpoolFirstPurchaseCardMs) {
      document.documentElement.dataset.harvestpoolFirstPurchaseCardMs = performance.now().toFixed(1);
    }
    if (empty) {
      empty.hidden = !state.dataLoaded || totalVisible !== 0;
      const heading = $("h2", empty);
      const copy = $("p", empty);
      if (heading) heading.textContent = `No ${filterLabel} match this filter.`;
      if (copy) copy.textContent = "Try another view or start a purchase for your community.";
    }
    if (disclaimer) disclaimer.textContent = "Purchase cards and actions are read from the Testnet contract.";
  }

  function normalizeExploreFilters() {
    const tabs = $(".filter-tabs");
    if (!tabs) return;
    const labels = { available: "Available", "in-progress": "In Progress", closed: "Closed", all: "All" };
    $$(".filter-tab", tabs).forEach((button) => {
      const filter = String(button.dataset.filter || "all").toLowerCase();
      button.dataset.filter = filter;
      if (!labels[filter]) {
        button.remove();
        return;
      }
      button.textContent = labels[filter];
      button.setAttribute("aria-pressed", String(button.classList.contains("active")));
    });
    const requestedValue = new URLSearchParams(window.location.search).get("filter");
    const requested = requestedValue ? filterTools.normalizeFilter(requestedValue) : "";
    const requestedButton = requested
      ? $$('[data-filter]', tabs).find((button) => button.dataset.filter === requested)
      : null;
    if (requestedButton) {
      $$("[data-filter]", tabs).forEach((button) => {
        const active = button === requestedButton;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
    }
  }

  function detailsEligibility(purchase, mode = "contribute") {
    const commitment = commitmentFor(purchase);
    if (appConfig.page === "details" && !state.detailAuthorityReady) return `<div class="eligibility-callout warning">${icon("shield")}<span>Wallet eligibility is still being verified. No contribution, refund, supplier action, or vote is enabled until the authoritative state is confirmed.</span></div>`;
    if (state.accountId && !accountAuthorityReady()) return `<div class="eligibility-callout warning">${icon("shield")}<span>Latest wallet-specific eligibility could not be verified. Restricted actions remain disabled until Refresh succeeds.</span></div>`;
    if (!state.accountId) return `<div class="eligibility-callout warning">${icon("shield")}<span>Connect a wallet to check whether this purchase is available to you. Opening this link does not reserve a place.</span></div>`;
    if (!isOpenMembership(purchase) && !isMember()) return `<div class="eligibility-callout error">${icon("shield")}<span><strong>This wallet is not in the current community.</strong><br>Joining by link cannot add membership under the Phase 1 contract, so no contribution or vote will be attempted.</span></div>`;
    if (commitment && commitment.state === "Active") return `<div class="eligibility-callout">${icon("shield")}<span><strong>This wallet is a funded member.</strong><br>${mode === "vote" ? "You may vote once on the current decision." : "This purchase is already on your dashboard."}</span></div>`;
    if (["Open", "AwaitingSupplier"].includes(purchase.state) && deadlineHasPassed(purchase.deadline_ns)) return `<div class="eligibility-callout warning">${icon("shield")}<span><strong>The deadline passed.</strong><br>No new contribution can be submitted. The contract must be finalized before the outcome is shown as Funded or Failed.</span></div>`;
    if (purchase.state === "Open" && (availableCapacity(purchase) === 0 || fundedMemberCapacity(purchase) === 0)) return `<div class="eligibility-callout warning">${icon("shield")}<span><strong>Group Full</strong><br>Another contribution has taken the last available unit or household spot.</span></div>`;
    if (mode === "vote") return `<div class="eligibility-callout warning">${icon("shield")}<span>Only an active funded commitment creates voting eligibility. This wallet has not funded this purchase.</span></div>`;
    return `<div class="eligibility-callout">${icon("shield")}<span>${isOpenMembership(purchase) ? "This purchase is open to funded households." : "This wallet is in the community."} Your funded place appears after the exact contribution succeeds.</span></div>`;
  }

  function issueStateLabel(stateValue) {
    const labels = {
      Open: "Open",
      NeedsGroupDecision: "Needs group decision",
      Resolved: "Resolved",
    };
    return labels[stateValue] || stateValue || "Open";
  }

  function decisionStateLabel(stateValue) {
    const labels = {
      Open: "Vote is open",
      AwaitingSupplier: "Waiting for supplier",
      Approved: "Decision approved",
      Rejected: "Decision declined",
      NoConsensus: "No option reached agreement",
      Expired: "Decision expired",
    };
    return labels[stateValue] || stateValue || "Decision";
  }

  function decisionForIssue(issue) {
    if (issue?.active_decision_id === null || issue?.active_decision_id === undefined) return null;
    return state.decisions.find((decision) => String(decision.id) === String(issue.active_decision_id)) || null;
  }

  function decisionVoteFor(decision) {
    if (!state.accountId || !decision) return null;
    return (decision.votes || []).find((vote) => String(vote.voter) === String(state.accountId)) || null;
  }

  function canSeeIssue(issue) {
    const purchase = state.purchases.find((item) => String(item.id) === String(issue.purchase_id));
    return Boolean(purchase && state.accountId && (isFundedMember(purchase) || String(issue.raised_by) === String(state.accountId)));
  }

  function decisionControls(decision) {
    if (!decision) return "";
    const recorded = decisionVoteFor(decision);
    const eligible = state.accountId && (decision.eligible_voters || []).some((voter) => String(voter) === String(state.accountId));
    if (recorded && ["Open", "AwaitingSupplier"].includes(decision.state)) {
      const next = decision.state === "AwaitingSupplier"
        ? " The required member threshold was reached. The named supplier's response is next."
        : " Votes are public and fixed to one choice per eligible member.";
      return `<div class="decision-recorded" role="status"><strong>Your choice is recorded: ${escapeHtml(decision.options[recorded.option] || "Choice")}</strong><span>${escapeHtml(next.trim())}</span></div>`;
    }
    if (state.v3Error) return `<p class="issue-help">Latest vote state is temporarily unavailable. Retry before taking this restricted action.</p>`;
    if (decision.state === "Open" && eligible) {
      return `<div class="issue-vote-actions" role="group" aria-label="Choices for this decision">${decision.options.map((option, index) => `<button class="button button-approve" type="button" data-action="decision-vote" data-decision-id="${escapeHtml(decision.id)}" data-option="${index}">${escapeHtml(option)}</button>`).join("")}</div>`;
    }
    if (decision.state === "Open") return `<p class="issue-help">Only the members funded when this decision opened can vote.</p>`;
    if (decision.state === "AwaitingSupplier") return `<p class="issue-help">${decision.vote_type === "YesNo" ? "Enough funded members approved the proposal." : `${escapeHtml(decision.options[decision.selected_option] || "This option")} reached the required threshold.`} The named supplier's response is next.</p>`;
    if (decision.state === "Approved") return `<div class="decision-recorded decision-approved" role="status"><strong>${decision.vote_type === "YesNo" ? "Proposal approved" : "Decision approved"}</strong><span>${decision.selected_option === null ? "" : `Result: ${escapeHtml(decision.options[decision.selected_option] || "Choice")}`}</span></div>`;
    if (decision.state === "NoConsensus") return `<p class="issue-help">No option reached the required two-thirds threshold. The original agreement is unchanged.</p>`;
    if (decision.state === "Expired") return `<p class="issue-help">The deadline passed before one choice reached the approval threshold.</p>`;
    if (decision.selected_option !== null && decision.selected_option !== undefined) return `<p class="issue-help">The supplier declined the passed proposal. The original agreement is unchanged.</p>`;
    return `<p class="issue-help">The proposal did not receive enough Yes votes. The original agreement is unchanged.</p>`;
  }

  function updateDecisionFormType(form) {
    if (!form) return;
    const multiple = form.elements.vote_type?.value === "multiple_choice";
    const fields = $("[data-multiple-choice-fields]", form);
    if (fields) fields.hidden = !multiple;
    ["option_a", "option_b"].forEach((name) => {
      if (form.elements[name]) form.elements[name].required = multiple;
    });
  }

  function issueDecisionRequestForm(issue, purchase) {
    if (!state.accountId || !purchase || !isFundedMember(purchase) || issue.state !== "Open" || !state.v3Available || state.v3Error) return "";
    const deadline = new Date(Date.now() + 3 * 86400000);
    return `<form class="issue-decision-form" data-decision-form data-draft-form="request-group-vote" data-draft-purchase-id="${escapeHtml(issue.purchase_id)}" data-draft-issue-id="${escapeHtml(issue.id)}" data-issue-id="${escapeHtml(issue.id)}"><div class="issue-form-heading"><strong>Suggest a group decision</strong><span>Public vote · pickup arrangements only</span></div><label for="vote-type-${escapeHtml(issue.id)}">How should members answer?</label><select id="vote-type-${escapeHtml(issue.id)}" name="vote_type"><option value="yes_no">Yes or No on one proposal</option><option value="multiple_choice">Choose from several options</option></select><label for="proposal-${escapeHtml(issue.id)}">What should the group decide?</label><input id="proposal-${escapeHtml(issue.id)}" name="proposal" type="text" maxlength="500" value="${escapeHtml(issue.suggested_solution || "Approve a pickup arrangement for this order.")}" required><div data-multiple-choice-fields hidden><p class="field-help">Add two to four different choices. An option must receive two-thirds of all eligible members; a simple plurality does not win.</p><div class="issue-options-grid"><div><label for="option-a-${escapeHtml(issue.id)}">Choice 1</label><input id="option-a-${escapeHtml(issue.id)}" name="option_a" type="text" maxlength="120" placeholder="Saturday morning"></div><div><label for="option-b-${escapeHtml(issue.id)}">Choice 2</label><input id="option-b-${escapeHtml(issue.id)}" name="option_b" type="text" placeholder="Sunday afternoon" maxlength="120"></div><div><label for="option-c-${escapeHtml(issue.id)}">Choice 3 (optional)</label><input id="option-c-${escapeHtml(issue.id)}" name="option_c" type="text" placeholder="Tuesday evening" maxlength="120"></div><div><label for="option-d-${escapeHtml(issue.id)}">Choice 4 (optional)</label><input id="option-d-${escapeHtml(issue.id)}" name="option_d" type="text" placeholder="Another valid time" maxlength="120"></div></div></div><p class="field-help">Votes and voter accounts are public. Supplier approval is requested only after members pass a change.</p><label for="deadline-${escapeHtml(issue.id)}">Voting closes</label><input id="deadline-${escapeHtml(issue.id)}" name="deadline" type="datetime-local" value="${escapeHtml(localDateValue(deadline))}" required><div class="draft-actions"><button class="button button-outline button-small" type="button" data-action="discard-draft">Discard draft</button><button class="button button-outline button-small" type="submit">Request a group vote</button></div></form>`;
  }

  function renderIssueCard(issue, options = {}) {
    const purchase = state.purchases.find((item) => String(item.id) === String(issue.purchase_id));
    const decision = decisionForIssue(issue);
    const showRequest = options.showRequest !== false;
    const purchaseLabel = purchase ? livePurchaseTitle(purchase) : `Purchase #${issue.purchase_id}`;
    const actions = [];
    if (!state.v3Error && accountAuthorityReady() && issue.state === "Open" && purchase && (String(purchase.proposer) === String(state.accountId) || String(purchase.farmer_id) === String(state.accountId))) {
      actions.push(`<button class="button button-outline button-small" type="button" data-action="resolve-issue" data-issue-id="${escapeHtml(issue.id)}">Mark resolved</button>`);
    }
    if (!state.v3Error && accountAuthorityReady() && decision && String(decision.supplier_id) === String(state.accountId) && decision.state === "AwaitingSupplier" && decision.requires_supplier_consent) {
      actions.push(`<button class="button button-primary button-small" type="button" data-action="agree-decision" data-decision-id="${escapeHtml(decision.id)}">Accept pickup change</button><button class="button button-reject button-small" type="button" data-action="decline-decision" data-decision-id="${escapeHtml(decision.id)}">Decline pickup change</button>`);
    }
    if (!state.v3Error && accountAuthorityReady() && decision && (decision.state === "Open" || decision.state === "AwaitingSupplier") && deadlineHasPassed(decision.deadline_ns)) {
      actions.push(`<button class="button button-outline button-small" type="button" data-action="expire-decision" data-decision-id="${escapeHtml(decision.id)}">Close expired vote</button>`);
    }
    return `<article class="issue-card" data-issue-id="${escapeHtml(issue.id)}"><div class="issue-card-top"><span class="issue-status issue-status-${escapeHtml(String(issue.state).toLowerCase())}">${escapeHtml(issueStateLabel(issue.state))}</span><span class="section-kicker">Issue #${escapeHtml(issue.id)}</span></div><h3>${escapeHtml(issue.subject)}</h3><p class="issue-purchase">${escapeHtml(purchaseLabel)} · raised by ${escapeHtml(shortAccount(issue.raised_by))}</p><p class="issue-description">${escapeHtml(issue.description)}</p>${issue.suggested_solution ? `<div class="issue-suggestion"><strong>Suggested solution</strong><span>${escapeHtml(issue.suggested_solution)}</span></div>` : ""}${decision ? `<div class="issue-decision"><div class="issue-decision-top"><strong>${escapeHtml(decisionStateLabel(decision.state))}</strong><span>Public ${decision.vote_type === "YesNo" ? "Yes/No proposal" : "multiple-choice decision"} · ${decision.votes.length} of ${decision.eligible_voters.length} members voted · ${decision.required_yes_votes} ${decision.vote_type === "YesNo" ? "Yes votes" : "matching votes"} needed</span></div><p>${escapeHtml(decision.proposal)}</p><div class="issue-choice-list">${decision.options.map((option, index) => `<span class="issue-choice ${decision.selected_option === index ? "is-selected" : ""}">${escapeHtml(option)}${decision.selected_option === index ? " · result" : ""}</span>`).join("")}</div>${decisionControls(decision)}</div>` : showRequest ? issueDecisionRequestForm(issue, purchase) : ""}${actions.length ? `<div class="issue-actions">${actions.join("")}</div>` : ""}<div class="issue-card-footer"><a class="text-link" href="/purchases/${encodeURIComponent(issue.purchase_id)}">Open purchase <span aria-hidden="true">↗</span></a></div></article>`;
  }

  function renderPurchaseIssues(purchase) {
    if (!appConfig.v3ContractId) {
      return `<section class="issues-section"><div class="section-heading-inline"><div><span class="section-kicker">Issues &amp; decisions</span><h2>Make space for concerns.</h2></div></div><div class="issues-unavailable"><p>Member issues will appear here when this community turns them on.</p></div></section>`;
    }
    if (!state.v3Available) {
      return `<section class="issues-section"><div class="section-heading-inline"><div><span class="section-kicker">Issues &amp; decisions</span><h2>Issues are temporarily unavailable.</h2></div></div><div class="issues-unavailable"><p>Refresh this page to check the latest issue and decision status.</p><button class="button button-outline button-small" type="button" data-action="retry-live-data">Retry live data</button></div></section>`;
    }
    const issues = state.issues.filter((issue) => String(issue.purchase_id) === String(purchase.id));
    const raiseAction = state.detailAuthorityReady && !state.v3Error && isFundedMember(purchase) ? `<a class="button button-primary button-small" href="/purchases/${encodeURIComponent(purchase.id)}/issue">Raise an issue</a>` : "";
    const warning = state.v3Error ? `<div class="issues-unavailable" role="status"><p>Latest issue or decision reads are temporarily unavailable. Existing records remain visible; retry before taking a restricted action.</p><button class="button button-outline button-small" type="button" data-action="retry-live-data">Retry live data</button></div>` : "";
    return `<section class="issues-section"><div class="section-heading-inline"><div><span class="section-kicker">Issues &amp; decisions</span><h2>Raise a concern without a confrontation.</h2><p class="section-heading-copy">Ask a question, suggest a practical fix, or request a group decision when one is needed.</p></div>${raiseAction}</div>${warning}${issues.length ? `<div class="issue-list">${issues.map((issue) => renderIssueCard(issue, { showRequest: true })).join("")}</div>` : `<div class="issues-empty"><p>No issues have been raised for this purchase.</p>${isFundedMember(purchase) ? "<span>You're one of the funded members who can start the conversation.</span>" : "<span>Funded members can raise a concern about this purchase.</span>"}</div>`}</section>`;
  }

  function publicShareUrl(purchaseId) {
    const base = String(appConfig.publicBaseUrl || window.location.origin).replace(/\/$/, "");
    return `${base}/share/${encodeURIComponent(purchaseId)}`;
  }

  function supplierName(purchase) {
    return purchase.supplier_business_name || "Named supplier";
  }

  function renderV4Details(root, purchase) {
    const total = Number(purchase.total_quantity || 0);
    const max = Number(purchase.max_quantity || 0);
    const progress = max ? Math.min(100, Math.round((total / max) * 100)) : 0;
    const agreement = purchase.supplier_agreement;
    const namedSupplierWallet = String(state.accountId || "") === String(purchase.supplier_id || "");
    const organizerWallet = String(state.accountId || "") === String(purchase.proposer || purchase.organizer_id || "");
    const authorityReady = (appConfig.page !== "details" || state.detailAuthorityReady) && accountAuthorityReady();
    const alreadyJoined = authorityReady && (isFundedMember(purchase) || Boolean(commitmentFor(purchase)));
    const canJoin = authorityReady && Boolean(state.accountId) && !alreadyJoined && purchase.state === "Open" && !deadlineHasPassed(purchase.deadline_ns) && availableCapacity(purchase) > 0 && fundedMemberCapacity(purchase) > 0;
    const action = !authorityReady
      ? `<span class="button button-outline" aria-disabled="true">Checking availability…</span>`
      : alreadyJoined
      ? `<a class="button button-dark" href="/dashboard">View in My Group Buys</a>`
      : canJoin
      ? `<a class="button button-primary" href="/purchases/${encodeURIComponent(purchase.id)}/join">Join This Deal</a>`
      : purchase.state === "AwaitingSupplier"
        ? namedSupplierWallet
          ? `<a class="button button-primary" href="/supplier-invitations/${encodeURIComponent(purchase.id)}">Review Proposal</a>`
          : organizerWallet
            ? `<a class="button button-outline" href="/supplier-invitations/${encodeURIComponent(purchase.id)}">View Invitation</a>`
            : ""
        : "";
    const listed = listedUsd(purchase) || "Listed USD price unavailable";
    const { unit } = unitDetails(purchase);
    const relevantTasks = actionCenterTasks().filter((task) => String(task.purchaseId) === String(purchase.id));
    const failed = purchase.state === "Failed" ? `<div class="deal-state-explanation"><strong>Why this deal failed</strong><span>${escapeHtml(failureReason(purchase))}</span></div>` : "";
    const joinDeadlineCopy = presentationState(purchase) === "DeadlinePassed"
      ? "New contributions are blocked. HarvestPool is processing the authoritative final result automatically."
      : "Buyers can join until this cutoff.";
    const deadlineGuidance = `<section class="deal-deadlines" aria-label="Deal deadlines"><div><span>Last day to join</span><strong>${escapeHtml(formatDate(purchase.deadline_ns, true))}</strong><small>${escapeHtml(dealTimeTools.deadlineSummary(purchase.deadline_ns))} ${escapeHtml(joinDeadlineCopy)}</small></div><div><span>Fulfillment deadline</span><strong>${escapeHtml(formatDate(purchase.fulfillment_evidence_deadline_ns, true))}</strong><small>${escapeHtml(dealTimeTools.fulfillmentWindow(purchase.deadline_ns, purchase.fulfillment_evidence_deadline_ns).summary)} This gives the supplier time to prepare the group order.</small></div></section>`;
    root.innerHTML = `<div class="details-top"><div><p class="eyebrow">Group Deal #${escapeHtml(purchase.id)}</p><h1>${escapeHtml(livePurchaseTitle(purchase))}</h1><p class="supplier-line">From <strong>${escapeHtml(supplierName(purchase))}</strong> · ${escapeHtml(purchase.supplier_location || "Location not listed")}</p></div><div class="details-actions"><button class="share-button" type="button" data-action="share-purchase" data-purchase-id="${escapeHtml(purchase.id)}">${icon("link")}Share Group Deal</button>${action}</div></div>${actionAlertsMarkup(relevantTasks, "This deal needs your attention")}${refundNoticeMarkup(purchase)}${deadlineGuidance}
      <div class="details-layout"><div><section class="detail-panel funding-panel">${statusPill(presentationState(purchase))}<h2>${escapeHtml(listed)} per ${escapeHtml(unit)}</h2><p class="funding-description">${escapeHtml(livePurchaseDescription(purchase))}</p>${failed}<div class="funding-big"><strong>${total} / ${max}</strong><span>${escapeHtml(pluralUnit(unit, max))} reserved</span></div><div class="progress-label"><span>${participantCount(purchase)} ${participantCount(purchase) === 1 ? "buyer participated" : "buyers participated"}</span><span>${quantityLabel(purchase, availableCapacity(purchase))} available</span></div><div class="progress-track"><span style="width: ${progress}%"></span></div><div class="funding-meta"><div><strong>${quantityLabel(purchase, purchase.min_quantity)}</strong><span>minimum needed</span></div><div><strong>Maximum ${quantityLabel(purchase, purchase.max_quantity_per_household)}</strong><span>per buyer</span></div><div><strong>${escapeHtml(formatDate(purchase.deadline_ns))}</strong><span>last day to join or cancel</span></div><div><strong>${escapeHtml(formatDate(purchase.fulfillment_evidence_deadline_ns))}</strong><span>fulfillment due</span></div></div></section><section class="detail-panel" style="margin-top:18px"><span class="section-kicker">Pickup or delivery</span><h2>How members receive the order</h2><p>${escapeHtml(purchase.pickup_or_delivery)}</p><p><strong>Contact the supplier:</strong> ${escapeHtml(purchase.supplier_public_contact)}</p></section></div>
      <aside><section class="detail-panel detail-panel-dark"><span class="section-kicker">Deal Terms</span><h2>What everyone agreed to</h2><dl class="term-list"><div class="term-row"><dt>You receive</dt><dd>${escapeHtml(purchase.description)}${unitDetails(purchase).contents ? ` · ${escapeHtml(unitDetails(purchase).contents)}` : ""}</dd></div><div class="term-row"><dt>Listed price</dt><dd>${escapeHtml(listed)} per ${escapeHtml(unit)}</dd></div><div class="term-row"><dt>Payment details</dt><dd>${isV5(purchase) ? `${escapeHtml(listed)} per ${escapeHtml(unit)}, settled as exactly ${escapeHtml(paymentLabel(purchase, purchase.price_per_unit))} on Testnet. Test tokens are not a real USD card charge and are not promised to be redeemable for dollars.` : `${escapeHtml(paymentLabel(purchase, purchase.price_per_unit))} per ${escapeHtml(unit)}`}</dd></div><div class="term-row"><dt>Group target</dt><dd>At least ${quantityLabel(purchase, purchase.min_quantity)} by ${escapeHtml(formatDate(purchase.deadline_ns, true))}</dd></div><div class="term-row"><dt>Buyer limit</dt><dd>Maximum ${quantityLabel(purchase, purchase.max_quantity_per_household)} per buyer</dd></div><div class="term-row"><dt>Voluntary cancellation</dt><dd>Available until the same group closing time</dd></div><div class="term-row"><dt>If the order fails</dt><dd>${escapeHtml(purchase.cancellation_and_refund_terms)}</dd></div><div class="term-row"><dt>${isV5(purchase) ? "Testnet fulfillment test" : "Delivery and payment"}</dt><dd>${isV5(purchase) ? "For this smoke test, the supplier submits a simulation reference and funded buyers approve only that Testnet evidence. This does not claim physical delivery. The contract still uses its fulfillment and payment methods." : "The supplier submits a delivery reference. Funded buyers confirm fulfillment before payment can be released."}</dd></div></dl>${detailsEligibility(purchase)}<details class="technical-details"><summary>Agreement record</summary><p>Supplier wallet: ${escapeHtml(purchase.supplier_id)}</p><p>Terms fingerprint: <code>${escapeHtml(purchase.terms_hash)}</code></p>${agreement ? `<p>Accepted on ${escapeHtml(formatDate(agreement.accepted_at_ns, true))}.</p>` : "<p>The named supplier has not accepted these terms.</p>"}</details></section></aside></div>`;
  }

  function renderV4Agreement(root, purchase) {
    const capacity = availableCapacity(purchase);
    const fundedSpots = fundedMemberCapacity(purchase);
    const commitment = commitmentFor(purchase);
    const listed = listedUsd(purchase) || "USD price unavailable";
    const { unit, contents } = unitDetails(purchase);
    const pendingContribution = state.accountId && pendingActionStore.list(state.accountId).find((action) =>
      ["commit", "commit_usdc"].includes(action.methodName)
      && String(action.args?.purchase_id) === String(purchase.id));
    const phase = state.contributionStatus && String(state.contributionStatus.purchaseId) === String(purchase.id)
      ? state.contributionStatus
      : null;
    const checkoutState = checkoutStateTools.resolve({ purchase, accountId: state.accountId, pending: Boolean(pendingContribution), phase });

    if (checkoutState.kind === "confirmed") {
      const confirmedCommitment = checkoutState.commitment;
      clearDraft(root);
      const total = Number(purchase.total_quantity || 0);
      const minimum = Number(purchase.min_quantity || 0);
      const maximum = Number(purchase.max_quantity || 0);
      const progress = maximum ? Math.min(100, Math.round((total / maximum) * 100)) : 0;
      const minimumReached = total >= minimum;
      const paid = isV5(purchase)
        ? usdFromTokenUnits(confirmedCommitment.amount, Number(purchase.token_decimals || state.config?.token_decimals || 6))
        : paymentLabel(purchase, confirmedCommitment.amount);
      const paymentDetails = isV5(purchase)
        ? `${paymentLabel(purchase, confirmedCommitment.amount)} accepted through Circle’s native Testnet USDC contract ${purchase.token_contract_id || state.config?.token_contract_id}. No USD card charge.`
        : `${paymentLabel(purchase, confirmedCommitment.amount)} accepted through the connected NEAR Testnet wallet.`;
      root.innerHTML = `<div class="agreement-header checkout-confirmed-header"><p class="eyebrow">Confirmed · Group Deal #${escapeHtml(purchase.id)}</p><h1>You've joined the Group Deal!</h1><p>Your contribution was confirmed on-chain. Your ${escapeHtml(unit)} is now reserved.</p></div><section class="checkout-confirmed" role="status" aria-live="polite"><div class="checkout-confirmed-mark" aria-hidden="true">${icon("shield")}</div><div class="checkout-confirmed-main"><span class="section-kicker">Place confirmed</span><h2>${escapeHtml(livePurchaseTitle(purchase))}</h2><div class="checkout-confirmed-facts"><div><span>Deal</span><strong>#${escapeHtml(purchase.id)}</strong></div><div><span>Quantity reserved</span><strong>${quantityLabel(purchase, confirmedCommitment.quantity)}</strong></div><div><span>Amount paid</span><strong>${escapeHtml(paid)}</strong></div><div><span>Group progress</span><strong>${quantityLabel(purchase, total)} of ${quantityLabel(purchase, maximum)}</strong></div><div><span>Buyer capacity</span><strong>${escapeHtml(spotLabel(fundedSpots))}</strong></div></div><div class="progress-label"><span>${quantityLabel(purchase, total)} reserved</span><span>${quantityLabel(purchase, capacity)} available</span></div><div class="progress-track"><span style="width: ${progress}%"></span></div><div class="checkout-minimum ${minimumReached ? "is-reached" : ""}"><strong>${minimumReached ? "Group minimum reached" : `${quantityLabel(purchase, Math.max(0, minimum - total))} still needed`}</strong><span>${minimumReached ? "The group has enough reserved quantity to proceed after the joining deadline." : `The deal needs ${quantityLabel(purchase, minimum)} total before the deadline.`}</span></div><div class="checkout-next"><h3>What happens next</h3><p>Track the group in My Group Buys. After the joining deadline, the deal must be finalized before the supplier can submit fulfillment evidence. In this Testnet smoke test, funded buyers approve simulated evidence only; that approval does not claim physical delivery.</p></div><details class="technical-details"><summary>Testnet transaction details</summary><p>${escapeHtml(paymentDetails)}</p><p>Confirmed buyer: <code>${escapeHtml(state.accountId)}</code></p></details><div class="checkout-confirmed-actions"><a class="button button-primary" href="/dashboard">View My Group Buys</a><a class="button button-outline" href="/purchases/${encodeURIComponent(purchase.id)}">Back to Group Deal</a></div></div></section>`;
      return;
    }

    const confirming = checkoutState.kind === "confirming";
    if (confirming) {
      const quantity = Math.max(1, Number(pendingContribution?.args?.quantity || 1));
      const rawAmount = (BigInt(String(purchase.price_per_unit || "0")) * BigInt(quantity)).toString();
      const total = isV5(purchase) ? customerPaymentLabel(purchase, rawAmount) : paymentLabel(purchase, rawAmount);
      const walletAuthorization = phase?.kind === "wallet";
      const submitted = phase?.kind === "awaiting";
      const title = walletAuthorization ? "Approve the payment in your wallet" : submitted ? "Your payment was submitted" : "Unable to verify payment yet";
      const message = walletAuthorization
        ? `${testPaymentLabel(purchase, rawAmount)} will pay the listed ${total}. No USD card charge.`
        : submitted
          ? "We’re confirming that Circle completed the transfer and that the contract reserved your place."
          : "We haven't confirmed the result yet. Please don't pay again while we check.";
      const hash = pendingContribution?.transactionHash
        ? `<p class="checkout-status-hash">Transaction: <code>${escapeHtml(pendingContribution.transactionHash)}</code></p>`
        : "";
      root.innerHTML = `<div class="agreement-header checkout-confirmed-header"><p class="eyebrow">Payment status · Group Deal #${escapeHtml(purchase.id)}</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div><section class="checkout-payment-status" role="status" aria-live="polite"><div class="checkout-status-spinner" aria-hidden="true"></div><div><span class="section-kicker">${walletAuthorization ? "Wallet authorization" : "Blockchain confirmation"}</span><h2>${escapeHtml(livePurchaseTitle(purchase))}</h2><dl class="checkout-status-facts"><div><dt>Quantity</dt><dd>${quantityLabel(purchase, quantity)}</dd></div><div><dt>Total</dt><dd>${escapeHtml(total)}</dd></div></dl><p>${walletAuthorization ? "Complete or reject the request in Meteor. Connecting or closing the wallet does not submit another payment." : "HarvestPool will replace this screen as soon as your funded membership appears in authoritative contract state."}</p>${hash}<div class="checkout-confirmed-actions"><button class="button button-primary" type="button" data-action="check-pending-actions">Check payment status</button><a class="button button-outline" href="/purchases/${encodeURIComponent(purchase.id)}">Back to Group Deal</a></div></div></section>`;
      return;
    }

    const canContribute = Boolean(state.accountId && accountAuthorityReady() && !commitment && !confirming && purchase.state === "Open" && !deadlineHasPassed(purchase.deadline_ns) && capacity > 0 && fundedSpots > 0);
    const contributionState = confirming
      ? `<div class="contribution-state state-awaiting" id="contribution-state" role="status" aria-live="polite"><span class="state-dot"></span><div><strong>Confirming your payment</strong><span>HarvestPool is checking the Circle transfer and your funded membership. Do not submit another payment.</span></div></div>`
      : phase
        ? `<div class="contribution-state state-${escapeHtml(phase.kind)}" id="contribution-state" role="status" aria-live="polite"><span class="state-dot"></span><div><strong>${escapeHtml(phase.title)}</strong><span>${escapeHtml(phase.message)}</span></div></div>`
        : "";
    const paymentCopy = isV5(purchase)
      ? `Total: ${escapeHtml(listed)} per ${escapeHtml(unit)}. Payment uses ${escapeHtml(testPaymentLabel(purchase, purchase.price_per_unit))} per ${escapeHtml(unit)} through your wallet. No USD card charge.`
      : `Total: ${escapeHtml(paymentLabel(purchase, purchase.price_per_unit))} per ${escapeHtml(unit)} through your NEAR Testnet wallet.`;
    const totalLabel = isV5(purchase) ? "Total" : "Wallet contribution";
    const closedCopy = presentationState(purchase) === "DeadlinePassed" ? `<div class="eligibility-callout warning"><span><strong>Joining is closed.</strong><br>HarvestPool is processing the authoritative result automatically. This status alone does not mean the worker failed.</span></div>` : "";
    root.innerHTML = `<div class="agreement-header"><p class="eyebrow">Deal Terms · #${escapeHtml(purchase.id)}</p><h1>${canContribute || !state.accountId ? "Review the deal before you join." : "Review this deal's current status."}</h1></div>${closedCopy}<div class="agreement-grid"><section class="agreement-copy"><span class="section-kicker">Deal Terms</span><h2>${escapeHtml(livePurchaseTitle(purchase))}</h2><dl class="term-list agreement-terms"><div class="term-row"><dt>What you receive</dt><dd>${escapeHtml(purchase.description)}</dd></div>${contents ? `<div class="term-row"><dt>Package contents</dt><dd>Each ${escapeHtml(unit)} contains ${escapeHtml(contents)}</dd></div>` : ""}<div class="term-row"><dt>Supplier</dt><dd>${escapeHtml(supplierName(purchase))} · ${escapeHtml(purchase.supplier_location)}</dd></div><div class="term-row"><dt>Listed price</dt><dd>${escapeHtml(listed)} per ${escapeHtml(unit)}</dd></div><div class="term-row"><dt>Payment details</dt><dd>${isV5(purchase) ? `${escapeHtml(paymentLabel(purchase, purchase.price_per_unit))} per ${escapeHtml(unit)} using native Circle Testnet USDC. No USD card charge.` : `${escapeHtml(paymentLabel(purchase, purchase.price_per_unit))} per ${escapeHtml(unit)} using native Testnet NEAR.`}</dd></div><div class="term-row"><dt>Group target</dt><dd>${quantityLabel(purchase, purchase.min_quantity)} by ${escapeHtml(formatDate(purchase.deadline_ns, true))}</dd></div><div class="term-row"><dt>Buyer limit</dt><dd>Maximum ${quantityLabel(purchase, purchase.max_quantity_per_household)} per buyer</dd></div><div class="term-row"><dt>Voluntary cancellation ends</dt><dd>${escapeHtml(formatDate(purchase.cancellation_deadline_ns, true))}</dd></div><div class="term-row"><dt>If the deal does not go ahead</dt><dd>${escapeHtml(purchase.cancellation_and_refund_terms)}</dd></div><div class="term-row"><dt>How delivery is confirmed</dt><dd>Each funded buyer gets one public fulfillment vote, regardless of quantity.</dd></div><div class="term-row"><dt>When the supplier is paid</dt><dd>Only after the supplier submits delivery details and enough funded buyers approve fulfillment.</dd></div></dl>${detailsEligibility(purchase)}</section><aside class="contribution-panel"><span class="section-kicker">${canContribute ? "Join This Deal" : escapeHtml(formatStatus(presentationState(purchase)))}</span><h2>${escapeHtml(listed)} per ${escapeHtml(unit)}</h2><p>${paymentCopy}</p><div class="contribution-summary"><div><span>Buyer spots</span><strong>${escapeHtml(spotLabel(fundedSpots))}</strong></div><div><span>Available</span><strong>${quantityLabel(purchase, capacity)}</strong></div><div><span>Buyer limit</span><strong>${quantityLabel(purchase, purchase.max_quantity_per_household)}</strong></div><div><span>Last day to join</span><strong>${escapeHtml(formatDate(purchase.deadline_ns))}</strong></div></div>${contributionState}${!state.accountId ? `<button class="button contribution-connect" type="button" data-connect-wallet>Connect wallet</button>` : ""}<div class="quantity-field"><label for="contribution-quantity">How many ${escapeHtml(pluralUnit(unit))}?</label><div class="quantity-input-wrap"><button type="button" aria-label="Decrease quantity" data-action="quantity-minus" ${canContribute ? "" : "disabled"}>−</button><input id="contribution-quantity" type="number" min="1" max="${Math.max(1, Math.min(capacity, Number(purchase.max_quantity_per_household || capacity)))}" value="1" ${canContribute ? "" : "disabled"}><button type="button" aria-label="Increase quantity" data-action="quantity-plus" ${canContribute ? "" : "disabled"}>+</button></div></div><div class="quantity-total"><span>${totalLabel}</span><strong id="contribution-total">${isV5(purchase) ? escapeHtml(listed) : moneyMarkup(purchase.price_per_unit)}</strong></div><div class="agreement-acceptance"><input id="agreement-acceptance" type="checkbox" required ${canContribute ? "" : "disabled"}><label for="agreement-acceptance">I have read and accept the Deal Terms, contribution amount, cancellation rules, and refund conditions.</label></div><button class="button" type="button" data-action="contribute" data-purchase-id="${escapeHtml(purchase.id)}" data-eligible="${canContribute ? "true" : "false"}" disabled>${confirming ? "Confirming Payment…" : canContribute ? "Join This Deal" : "Joining unavailable"}</button><p class="contribution-footnote">Your spot appears in My Group Buys only after the contribution is confirmed.</p></aside></div>`;
    const terms = $(".agreement-terms", root);
    if (terms) {
      terms.insertAdjacentHTML("beforeend", `<div class="term-row"><dt>Joining deadline</dt><dd>${escapeHtml(formatDate(purchase.deadline_ns, true))} · New contributions stop after this contract cutoff.</dd></div><div class="term-row"><dt>Fulfillment deadline</dt><dd>${escapeHtml(formatDate(purchase.fulfillment_evidence_deadline_ns, true))} · The supplier must submit fulfillment evidence by this deadline.</dd></div><div class="term-row"><dt>Pickup or delivery time</dt><dd>${escapeHtml(purchase.pickup_or_delivery || "Not specified")} · This is the agreed handoff arrangement, not the joining or fulfillment deadline.</dd></div>`);
    }
    root.dataset.price = purchase.price_per_unit;
    updateContributionTotal();
    updateAgreementAcceptance();
  }

  function renderSupplierInvitationPage() {
    const root = $("#supplier-invitation-content");
    const id = $("#supplier-invitation-root")?.dataset.purchaseId;
    if (!root || !id || !state.dataLoaded) return;
    const purchase = state.currentPurchase || state.purchases.find((item) => String(item.id) === String(id));
    if (!purchase || !["V4", "V5"].includes(String(purchase.version).toUpperCase())) { showError(root, "Invitation unavailable", "This link does not point to a supported supplier invitation."); return; }
    const namedWallet = String(state.accountId || "") === String(purchase.supplier_id);
    const organizerWallet = String(state.accountId || "") === String(purchase.proposer || purchase.organizer_id);
    const accepted = Boolean(purchase.supplier_agreement) && purchase.state !== "Declined";
    const declined = purchase.state === "Declined";
    const controls = purchase.state === "AwaitingSupplier" && namedWallet && accountAuthorityReady()
      ? `<div class="supplier-invitation-actions"><button class="button button-accept" type="button" data-action="accept-supplier-request" data-purchase-id="${escapeHtml(purchase.id)}">Accept Proposal</button><button class="button button-reject" type="button" data-action="decline-supplier-request" data-purchase-id="${escapeHtml(purchase.id)}">Decline Proposal</button></div>`
      : purchase.state === "AwaitingSupplier" && namedWallet && !accountAuthorityReady() ? `<div class="eligibility-callout warning">${icon("shield")}<span><strong>Supplier wallet state is still being verified.</strong><br>Refresh before accepting or declining this proposal.</span><button class="button button-outline button-small" type="button" data-action="retry-live-data">Refresh</button></div>`
      : purchase.state === "AwaitingSupplier" && !state.accountId ? `<div class="wallet-empty-state"><strong>Supplier wallet required</strong><span>Use Connect wallet in the navigation to respond.</span></div>`
      : purchase.state === "AwaitingSupplier" && organizerWallet ? `<div class="eligibility-callout"><span><strong>Waiting for supplier review</strong><br>The named supplier must accept or decline. You do not need to send another transaction.</span></div>`
      : purchase.state === "AwaitingSupplier" ? `<div class="eligibility-callout warning">${icon("shield")}<span>This invitation names a different supplier wallet. The link alone cannot accept the terms.</span></div>`
      : accepted ? `<div class="invitation-result invitation-result-success" role="status"><strong>Supplier accepted</strong><span>The proposal is published with these exact terms.</span><a class="button button-primary button-small" href="/deals/${encodeURIComponent(purchase.id)}">View published deal</a></div>`
      : declined ? `<div class="invitation-result invitation-result-declined" role="status"><strong>Supplier declined</strong><span>No deal was published and no buyer could contribute. The organizer may revise the terms and create a new proposal.</span>${organizerWallet ? '<a class="button button-outline button-small" href="/create">Create a revised proposal</a>' : ""}</div>`
      : `<div class="eligibility-callout">${icon("shield")}<span>${escapeHtml(formatStatus(purchase.state))}</span></div>`;
    const workflow = `<ol class="invitation-workflow" aria-label="Proposal progress"><li class="is-complete"><span>1</span><strong>Proposal created</strong></li><li class="is-complete"><span>2</span><strong>Sent to supplier</strong></li><li class="${purchase.state === "AwaitingSupplier" ? "is-current" : "is-complete"}"><span>3</span><strong>Supplier review</strong></li><li class="${declined || accepted ? "is-complete" : ""}"><span>4</span><strong>${declined ? "Declined" : accepted ? "Accepted" : "Response"}</strong></li><li class="${accepted ? "is-complete" : ""}"><span>5</span><strong>${accepted ? "Published" : "Publish"}</strong></li></ol>`;
    const { unit, contents } = unitDetails(purchase);
    root.innerHTML = `<div class="agreement-header"><p class="eyebrow">Supplier proposal · Deal #${escapeHtml(purchase.id)}</p><h1>${escapeHtml(livePurchaseTitle(purchase))}</h1><p>${purchase.state === "AwaitingSupplier" ? `${escapeHtml(supplierName(purchase))} must review these exact terms before buyers can join.` : "The supplier response below is confirmed by the contract."}</p></div>${workflow}<div class="agreement-grid"><section class="agreement-copy"><span class="section-kicker">Proposed Deal Terms</span><h2>What the supplier is agreeing to</h2><dl class="term-list agreement-terms"><div class="term-row"><dt>Product</dt><dd>${escapeHtml(purchase.description)}</dd></div>${contents ? `<div class="term-row"><dt>Package contents</dt><dd>Each ${escapeHtml(unit)} contains ${escapeHtml(contents)}</dd></div>` : ""}<div class="term-row"><dt>Listed price</dt><dd>${escapeHtml(listedUsd(purchase) || "Unavailable")} per ${escapeHtml(unit)}</dd></div><div class="term-row"><dt>Payment details</dt><dd>${isV5(purchase) ? `${escapeHtml(listedUsd(purchase) || "Unavailable")} per ${escapeHtml(unit)}, settled as exactly ${escapeHtml(paymentLabel(purchase, purchase.price_per_unit))} on Testnet. Test tokens have no cash value.` : `${escapeHtml(paymentLabel(purchase, purchase.price_per_unit))} per ${escapeHtml(unit)}`}</dd></div><div class="term-row"><dt>Deal range</dt><dd>${quantityLabel(purchase, purchase.min_quantity)}–${quantityLabel(purchase, purchase.max_quantity)}</dd></div><div class="term-row"><dt>Buyer limit</dt><dd>Up to ${quantityLabel(purchase, purchase.max_quantity_per_household)} per buyer</dd></div><div class="term-row"><dt>Buyer capacity</dt><dd>Up to ${purchase.max_funded_members} funded buyers</dd></div><div class="term-row"><dt>Group closes</dt><dd>${escapeHtml(formatDate(purchase.deadline_ns, true))}</dd></div><div class="term-row"><dt>Fulfillment due</dt><dd>${escapeHtml(formatDate(purchase.fulfillment_evidence_deadline_ns, true))}</dd></div><div class="term-row"><dt>Pickup or delivery</dt><dd>${escapeHtml(purchase.pickup_or_delivery)}</dd></div><div class="term-row"><dt>Refund promise</dt><dd>${escapeHtml(purchase.cancellation_and_refund_terms)}</dd></div></dl><details class="technical-details"><summary>Agreement record</summary><code>${escapeHtml(purchase.terms_hash)}</code></details></section><aside class="contribution-panel" id="supplier-response"><span class="section-kicker">${namedWallet ? "Your supplier response" : organizerWallet ? "Supplier response" : "Proposal status"}</span><h2>${escapeHtml(formatStatus(purchase.state))}</h2><p>${purchase.state === "AwaitingSupplier" ? "Accepting publishes these immutable terms and opens contributions. Declining closes this proposal without publishing it." : "This result is authoritative contract state."}</p>${controls}</aside></div>`;
  }

  function renderDetailsPage() {
    const root = $("#details-content");
    const id = $("#details-root")?.dataset.purchaseId;
    if (!root || !id) {
      showError(root, "No purchase selected", "Use a deal link from Explore to view its live terms.", '<a class="button button-outline" href="/deals">Explore Deals</a>');
      return;
    }
    if (!state.dataLoaded) return;
    const purchase = state.currentPurchase || state.purchases.find((item) => String(item.id) === String(id));
    if (!purchase) {
      showError(root, "Deal not found", "This deal is not available in the current Testnet contract.", '<a class="button button-outline" href="/deals">Back to Explore</a>');
      return;
    }
    state.currentPurchase = purchase;
    if (["V4", "V5"].includes(String(purchase.version).toUpperCase())) {
      renderV4Details(root, purchase);
      if (!document.documentElement.dataset.harvestpoolDetailFirstContentMs) {
        document.documentElement.dataset.harvestpoolDetailFirstContentMs = performance.now().toFixed(1);
      }
      root.insertAdjacentHTML("beforeend", renderPurchaseIssues(purchase));
      return;
    }
    const active = activeCommitments(purchase);
    const fundedCount = fundedMemberCount(purchase);
    const fundedCapacity = maxFundedMembers(purchase);
    const total = Number(purchase.total_quantity || 0);
    const max = Number(purchase.max_quantity || 0);
    const progress = max ? Math.min(100, Math.round((total / max) * 100)) : 0;
    let primaryAction = "";
    if (purchase.state === "Open" && !deadlineHasPassed(purchase.deadline_ns) && availableCapacity(purchase) > 0 && fundedMemberCapacity(purchase) > 0) primaryAction = `<a class="button button-primary" href="/purchases/${encodeURIComponent(purchase.id)}/join">Join &amp; Contribute <span aria-hidden="true">↗</span></a>`;
    else if (purchase.state === "Open" && (availableCapacity(purchase) === 0 || fundedMemberCapacity(purchase) === 0)) primaryAction = `<span class="group-full-label" role="status">Group Full</span>`;
    else if (purchase.state === "Proposed") primaryAction = `<a class="button button-primary" href="/decisions">Review offer vote <span aria-hidden="true">↗</span></a>`;
    else if (isFundedMember(purchase)) primaryAction = `<a class="button button-dark" href="/dashboard">Open your dashboard <span aria-hidden="true">↗</span></a>`;
    const finalizeAction = "";
    const shareUrl = `${window.location.origin}/share/${encodeURIComponent(purchase.id)}`;
    root.innerHTML = `<div class="details-top"><div><p class="eyebrow">Purchase #${escapeHtml(purchase.id)} · existing V2 terms</p><h1>${escapeHtml(livePurchaseTitle(purchase))}</h1><p class="supplier-line">Named supplier wallet: <strong>${escapeHtml(shortAccount(purchase.farmer_id))}</strong></p><p class="details-description">${escapeHtml(livePurchaseDescription(purchase))}</p></div><div class="details-actions"><button class="share-button" type="button" data-action="share-purchase" data-purchase-id="${escapeHtml(purchase.id)}">${icon("link")}Share purchase</button>${finalizeAction}${primaryAction}</div></div><div class="details-layout"><div><section class="detail-panel funding-panel"><span class="section-kicker">Group funding</span><h2>${escapeHtml(formatStatus(purchase.state))}</h2><p class="funding-description">${escapeHtml(livePurchaseDescription(purchase))}</p><div class="funding-big"><strong>${total} / ${max}</strong><span>units funded</span></div><div class="progress-label"><span>${fundedCount} / ${fundedCapacity} funded households</span><span>${progress}% of units</span></div><div class="progress-track"><span style="width: ${progress}%"></span></div><div class="funding-meta"><div><strong>${escapeHtml(formatNear(purchase.price_per_unit))} NEAR</strong><span>price / unit</span></div><div><strong>${escapeHtml(spotLabel(fundedMemberCapacity(purchase)))}</strong><span>household capacity</span></div><div><strong>${availableCapacity(purchase)} units</strong><span>unit capacity left</span></div><div><strong>${escapeHtml(formatDate(purchase.deadline_ns))}</strong><span>last day to contribute</span></div></div></section><section class="detail-panel" style="margin-top: 18px"><span class="section-kicker">Group members</span><h2>Who has a funded place</h2><p class="field-help">Only active contributions count as funded members.</p><div class="members-list">${active.length ? active.map((commitment) => `<div class="member-row"><span class="member-id">${escapeHtml(shortAccount(commitment.account_id))}</span><span class="member-quantity">${commitment.quantity} unit${commitment.quantity === 1 ? "" : "s"} · ${escapeHtml(formatNear(commitment.amount))} NEAR</span></div>`).join("") : '<p class="field-help">No funded members yet.</p>'}</div></section></div><aside><section class="detail-panel detail-panel-dark"><span class="section-kicker">Purchase agreement</span><h2>What you receive, pay, and approve</h2><dl class="term-list"><div class="term-row"><dt>Product</dt><dd>${escapeHtml(livePurchaseTitle(purchase))}</dd></div><div class="term-row"><dt>Minimum order</dt><dd>${purchase.min_quantity} units</dd></div><div class="term-row"><dt>Maximum order</dt><dd>${purchase.max_quantity} units</dd></div><div class="term-row"><dt>Contribution</dt><dd>${escapeHtml(formatNear(purchase.price_per_unit))} Testnet NEAR per unit</dd></div><div class="term-row"><dt>Before contributions open</dt><dd>This existing V2 purchase requires ${purchase.required_offer_yes_votes} community approvals.</dd></div><div class="term-row"><dt>Delivery confirmation</dt><dd>${purchase.required_fulfillment_yes_votes ? `${purchase.required_fulfillment_yes_votes} funded households must approve` : "Set after the group is funded"}</dd></div><div class="term-row"><dt>Cancel by</dt><dd>${escapeHtml(formatDate(purchase.cancellation_deadline_ns, true))}</dd></div><div class="term-row"><dt>Fulfillment review by</dt><dd>${escapeHtml(formatDate(purchase.fulfillment_evidence_deadline_ns, true))}</dd></div><div class="term-row"><dt>Supplier payment</dt><dd>Only after approved delivery evidence</dd></div><div class="term-row"><dt>If the order fails</dt><dd>${refundRateLabel(purchase.failed_order_refund_bps)} refund becomes claimable</dd></div></dl>${detailsEligibility(purchase)}<details class="technical-details"><summary>Wallet and contract details</summary><p>Supplier wallet: ${escapeHtml(purchase.farmer_id)}</p><p>Organizer wallet: ${escapeHtml(purchase.proposer)}</p></details></section></aside></div>`;
    if (!document.documentElement.dataset.harvestpoolDetailFirstContentMs) {
      document.documentElement.dataset.harvestpoolDetailFirstContentMs = performance.now().toFixed(1);
    }
    root.insertAdjacentHTML("beforeend", renderPurchaseIssues(purchase));
  }

  function financialReadinessMarkup(purchase) {
    if (!isV5(purchase)) return "";
    const readiness = state.financialReadiness;
    if (!readiness || readiness.error) {
      return `<section class="detail-panel payout-readiness"><span class="section-kicker">Escrow safety check</span><h2>Payout checks are unavailable.</h2><p>No payment action is enabled until the Circle balance, liability, supplier registration, reconciliation snapshot, and outbound operations can all be read.</p><button class="button button-outline button-small" type="button" data-action="refresh-payout-checks">Retry payout checks</button></section>`;
    }
    const accounting = readiness.accounting || {};
    const decimals = Number(purchase.token_decimals || state.config?.token_decimals || 6);
    const balance = `${usdcTools.formatUnits(readiness.balance, decimals)} USDC`;
    const liability = `${usdcTools.formatUnits(readiness.liability, decimals)} USDC`;
    const reconciliation = usdcTools.reconciliationSnapshot(
      accounting,
      readiness.balance,
      readiness.liability,
      Date.parse(readiness.checkedAt),
      RECONCILIATION_MAX_AGE_MS,
    );
    const pendingFinancialAction = state.accountId && pendingActionStore.list(state.accountId).some((action) =>
      ["reconcile_token_balance", "release_payment"].includes(action.methodName));
    const blockingPurchaseOperation = hasBlockingPurchaseOperation(readiness, purchase);
    const payoutReady = purchase.state === "FulfillmentApproved"
      && readiness.figuresMatch
      && Boolean(readiness.supplierRegistration)
      && !blockingPurchaseOperation
      && reconciliation.ready
      && !pendingFinancialAction;
    const operationSummary = readiness.operations.length === 0
      ? "None"
      : readiness.operations.map((operation) => `#${operation.id} ${operation.kind} · ${operation.state} · ${customerPaymentLabel(purchase, operation.amount)} to ${operation.recipient_id}`).join("; ");
    const reconciliationLabel = reconciliation.ready
      ? "balanced · fresh and matches the final reads"
      : reconciliation.matches
        ? "balanced · snapshot is stale; reconcile again"
        : `${accounting.reconciliation_status || "not-reconciled"} · fresh matching snapshot required`;
    const reconciliationNext = purchase.state === "Completed"
      ? "Post-payment escrow is recorded at zero balance and zero liability."
      : reconciliation.fresh
        ? "Next action: review supplier payment. No payment has been submitted."
        : "This confirmed snapshot is stale for payment authorization; reconcile again before payment.";
    const successMarkup = reconciliation.matches
      ? `<div class="reconciliation-success" role="status"><strong>Escrow reconciliation successful</strong><span>Observed balance: ${escapeHtml(balance)} · Outstanding liability: ${escapeHtml(liability)} · Status: balanced.</span><span>${escapeHtml(reconciliationNext)}</span></div>`
      : "";
    const pendingCopy = pendingFinancialAction ? " An unresolved financial transaction is still being checked." : "";
    return `<section class="detail-panel payout-readiness" aria-labelledby="payout-readiness-heading"><span class="section-kicker">Escrow safety check</span><h2 id="payout-readiness-heading">Fresh reads required before supplier payment</h2><p>These are finality reads, not permission to move funds. Refresh immediately before reconciliation and again before payment.</p><dl class="term-list"><div class="term-row"><dt>Circle balance held by V5</dt><dd>${escapeHtml(balance)}</dd></div><div class="term-row"><dt>Outstanding liability</dt><dd>${escapeHtml(liability)}</dd></div><div class="term-row"><dt>Purchase financial state</dt><dd>${escapeHtml(purchase.state)} · ${escapeHtml(customerPaymentLabel(purchase, purchase.total_funded_amount))} recorded for Deal #${escapeHtml(purchase.id)}</dd></div><div class="term-row"><dt>Supplier token registration</dt><dd>${readiness.supplierRegistration ? "Registered" : "Not registered — payout blocked"}</dd></div><div class="term-row"><dt>Previous outbound operations</dt><dd>${escapeHtml(operationSummary)}</dd></div><div class="term-row"><dt>Stored reconciliation</dt><dd>${escapeHtml(reconciliationLabel)}</dd></div></dl>${successMarkup}<p class="field-help">Checked in this browser at ${escapeHtml(formatQuoteTime(readiness.checkedAt))}. ${readiness.figuresMatch ? "Circle balance and liability match." : "STOP: Circle balance and liability disagree."}${escapeHtml(pendingCopy)}</p><div class="payout-readiness-actions"><button class="button button-outline button-small" type="button" data-action="refresh-payout-checks">Refresh payout checks</button>${["FulfillmentApproved", "Completed"].includes(purchase.state) ? `<button class="button button-outline button-small" type="button" data-action="reconcile-escrow">${purchase.state === "Completed" ? "Authorize post-payout reconciliation" : "Authorize fresh reconciliation"}</button>` : ""}${purchase.state === "FulfillmentApproved" ? `<button class="button button-primary" type="button" data-action="release-payment" data-purchase-id="${escapeHtml(purchase.id)}" ${payoutReady ? "" : "disabled aria-disabled=\"true\""}>Review &amp; release ${escapeHtml(customerPaymentLabel(purchase, purchase.total_funded_amount))}</button>` : ""}</div>${purchase.state === "FulfillmentApproved" && !payoutReady ? `<p class="field-help"><strong>Payment remains blocked.</strong> Complete a fresh matching reconciliation and resolve every failed check first.</p>` : ""}${purchase.state === "Completed" ? `<p class="field-help">Run the separately authorized post-payout reconciliation, then verify both the Circle balance and outstanding liability are zero.</p>` : ""}</section>`;
  }

  function hasBlockingPurchaseOperation(readiness, purchase) {
    const blockingStates = new Set(["RegistrationPending", "TransferPending", "ReconciliationRequired"]);
    return (readiness?.operations || []).some((operation) =>
      String(operation.purchase_id) === String(purchase?.id) && blockingStates.has(String(operation.state)));
  }

  function decorateDetailsActions() {
    const purchase = state.currentPurchase;
    const actions = $(".details-actions");
    if (!purchase || !actions) return;
    const actionMarkup = [];
    if ((purchase.state === "Funded" || purchase.state === "FulfillmentPending") && deadlineHasPassed(purchase.fulfillment_evidence_deadline_ns)) actionMarkup.push(`<button class="button button-outline" type="button" data-action="expire-unfulfilled" data-purchase-id="${escapeHtml(purchase.id)}">Mark unfulfilled</button>`);
    if (actionMarkup.length) actions.insertAdjacentHTML("beforeend", actionMarkup.join(""));
    // Contract-wide escrow controls intentionally stay off public purchase pages.
  }

  function renderAgreementPage() {
    const root = $("#agreement-content");
    const id = $("#agreement-root")?.dataset.purchaseId;
    if (!root || !id || !state.dataLoaded) return;
    const purchase = state.currentPurchase || state.purchases.find((item) => String(item.id) === String(id));
    if (!purchase) {
      showError(root, "Deal not found", "This deal is not available in the current Testnet contract.", '<a class="button button-outline" href="/deals">Back to Explore</a>');
      return;
    }
    if (["V4", "V5"].includes(String(purchase.version).toUpperCase())) {
      renderV4Agreement(root, purchase);
      return;
    }
    const capacity = availableCapacity(purchase);
    const fundedSpots = fundedMemberCapacity(purchase);
    const commitment = commitmentFor(purchase);
    const eligibility = filterTools.contributionEligibility(purchase, {
      accountId: state.accountId,
      member: isMember(),
      memberCount: state.config?.member_count,
      commitment,
      agreementAccepted: true,
    });
    const canContribute = accountAuthorityReady() && eligibility.eligibleBeforeAgreement && !deadlineHasPassed(purchase.deadline_ns);
    const contributionCopy = !state.accountId
      ? "Connect a wallet to check availability and authorize the exact amount."
      : !isOpenMembership(purchase) && !isMember()
        ? "This wallet is not in the community for this purchase."
        : commitment
          ? "This wallet already has a commitment for this purchase."
          : purchase.state !== "Open"
            ? `Contributions are closed while this purchase is ${formatStatus(purchase.state).toLowerCase()}.`
            : capacity === 0 || fundedSpots === 0
              ? "Group Full: no funded household capacity remains."
              : "Choose a quantity, accept the terms, and authorize the exact amount.";
    const contributionState = state.contributionStatus && String(state.contributionStatus.purchaseId) === String(purchase.id)
      ? `<div class="contribution-state state-${escapeHtml(state.contributionStatus.kind)}" id="contribution-state" role="status" aria-live="polite"><span class="state-dot"></span><div><strong>${escapeHtml(state.contributionStatus.title)}</strong><span>${escapeHtml(state.contributionStatus.message)}</span></div></div>`
      : `<div class="contribution-state state-ready" id="contribution-state" role="status" aria-live="polite"><span class="state-dot"></span><div><strong>Capacity is checked before authorization</strong><span>The latest purchase state is read again before your wallet is asked to sign.</span></div></div>`;
    const deliveryVotes = purchase.required_fulfillment_yes_votes
      ? `${purchase.required_fulfillment_yes_votes} funded-member yes votes`
      : "Set after the funded-member count is known";
    const connectAction = !state.accountId ? `<button class="button contribution-connect" type="button" data-connect-wallet>Connect wallet</button>` : "";
    const quantityButtonsDisabled = canContribute ? "" : "disabled";
    root.innerHTML = `<div class="agreement-header"><p class="eyebrow">Purchase agreement · #${escapeHtml(purchase.id)}</p><h1>Know the terms before you contribute.</h1><p>Review the purchase, the group rules, and the refund path. Your funded place appears only after the exact contribution is confirmed by the contract.</p></div><div class="agreement-grid"><section class="agreement-copy"><span class="section-kicker">Purchase terms</span><h2>${escapeHtml(formatStatus(purchase.state))}</h2><dl class="term-list agreement-terms"><div class="term-row"><dt>Product</dt><dd>${escapeHtml(livePurchaseTitle(purchase))}</dd></div><div class="term-row"><dt>Supplier</dt><dd>${escapeHtml(purchase.farmer_id)}</dd></div><div class="term-row"><dt>Quantity</dt><dd>${purchase.min_quantity}–${purchase.max_quantity} units · ${escapeHtml(formatNear(purchase.price_per_unit))} NEAR / unit</dd></div><div class="term-row"><dt>Minimum funded households</dt><dd>Not separate from the ${purchase.min_quantity}-unit minimum target</dd></div><div class="term-row"><dt>Maximum funded households</dt><dd>${fundedCapacityLabel(purchase)}</dd></div><div class="term-row"><dt>Current capacity</dt><dd>${fundedMemberCount(purchase)} / ${maxFundedMembers(purchase)} households · ${capacity} units left</dd></div><div class="term-row"><dt>Contribution deadline</dt><dd>${escapeHtml(formatDate(purchase.deadline_ns, true))}</dd></div><div class="term-row"><dt>Payment</dt><dd>Native NEAR · ${escapeHtml(formatNear(purchase.price_per_unit))} NEAR per unit</dd></div><div class="term-row"><dt>Group voting</dt><dd>${purchase.required_offer_yes_votes} community yes votes open the offer; ${escapeHtml(deliveryVotes)} approve delivery</dd></div><div class="term-row"><dt>Farmer payment</dt><dd>Paid only after delivery evidence and the required funded-member approval</dd></div><div class="term-row"><dt>Refund conditions</dt><dd>${refundRateLabel(purchase.cancellation_refund_bps)} cancellation refund by ${escapeHtml(formatDate(purchase.cancellation_deadline_ns, true))}; ${refundRateLabel(purchase.failed_order_refund_bps)} if the purchase fails</dd></div></dl><div class="agreement-rule"><span class="agreement-rule-number">1</span><div><h3>Exact payment, exact place.</h3><p>The contract accepts only price × quantity. A funded member is counted only after the transaction succeeds.</p></div></div><div class="agreement-rule"><span class="agreement-rule-number">2</span><div><h3>One funded member, one vote.</h3><p>Quantity changes what you contribute, not your voting weight on delivery.</p></div></div><div class="agreement-rule"><span class="agreement-rule-number">3</span><div><h3>Refunds follow the dates and state.</h3><p>Cancellation and failed-order refunds become available only under the terms above.</p></div></div>${detailsEligibility(purchase)}</section><aside class="contribution-panel"><span class="section-kicker">Join &amp; Contribute</span><h2>${escapeHtml(formatNear(purchase.price_per_unit))} NEAR / unit</h2><p>${escapeHtml(contributionCopy)}</p><div class="contribution-summary"><div><span>Current capacity</span><strong>${fundedMemberCount(purchase)} / ${maxFundedMembers(purchase)} households</strong></div><div><span>${escapeHtml(spotLabel(fundedSpots))}</span><strong>${capacity} units</strong></div><div><span>Contribution deadline</span><strong>${escapeHtml(formatDate(purchase.deadline_ns))}</strong></div><div><span>Asset</span><strong>Native NEAR</strong></div></div>${contributionState}${connectAction}<div class="quantity-field"><label for="contribution-quantity">Quantity</label><div class="quantity-input-wrap"><button type="button" aria-label="Decrease quantity" data-action="quantity-minus" ${quantityButtonsDisabled}>−</button><input id="contribution-quantity" type="number" min="1" max="${Math.max(1, capacity)}" value="1" ${quantityButtonsDisabled}><button type="button" aria-label="Increase quantity" data-action="quantity-plus" ${quantityButtonsDisabled}>+</button></div></div><div class="quantity-total"><span>Exact amount to authorize</span><strong id="contribution-total">${escapeHtml(formatNear(purchase.price_per_unit))} NEAR</strong></div><div class="agreement-acceptance"><input id="agreement-acceptance" type="checkbox" required aria-describedby="agreement-acceptance-help"><label for="agreement-acceptance">I have read and agree to the purchase terms, contribution amount, and refund conditions.</label></div><p class="agreement-acceptance-help" id="agreement-acceptance-help">Select the checkbox to enable the contribution.</p><button class="button" type="button" data-action="contribute" data-purchase-id="${escapeHtml(purchase.id)}" data-eligible="${canContribute ? "true" : "false"}" disabled>Join &amp; Contribute <span aria-hidden="true">↗</span></button><p class="contribution-footnote">Your wallet signs directly with the NEAR contract. Membership and capacity update only after the contract confirms the contribution.</p></aside></div>`;
    root.dataset.price = purchase.price_per_unit;
    updateContributionTotal();
    updateAgreementAcceptance();
  }

  function renderDashboard() {
    const root = $("#dashboard-root");
    if (!root) return;
    if (state.walletStatus === "initializing") {
      root.innerHTML = accountDataLoadingMarkup("Loading your purchases", "Restoring your wallet and reading confirmed Group Deal records.");
      return;
    }
    if (state.purchaseDiscoveryStatus === "loading" || state.purchaseDiscoveryStatus === "idle") {
      root.innerHTML = accountDataLoadingMarkup("Loading your purchases", "Reading confirmed Group Deal records before showing an empty state.");
      return;
    }
    if (state.purchaseDiscoveryStatus === "error" && !state.dataLoaded) {
      root.innerHTML = accountDataUnavailableMarkup("HarvestPool could not verify the purchase directory. No empty account result is being shown.");
      return;
    }
    if (!state.accountId) {
      root.innerHTML = disconnectedAccountMarkup("Your confirmed contributions and posted deals will appear here.");
      return;
    }
    const activeDashboardFilter = root.dataset.dashboardFilter || "all";
    const matchesDashboardFilter = (purchase) => activeDashboardFilter === "all" || filterTools.dashboardCategory(purchase) === activeDashboardFilter;
    const joinedDeals = state.purchases.filter((purchase) => commitmentFor(purchase)).filter(matchesDashboardFilter);
    const createdDeals = state.purchases.filter((purchase) => String(purchase.proposer || "") === String(state.accountId)).filter(matchesDashboardFilter);
    const joinedCard = (purchase) => {
      const commitment = commitmentFor(purchase);
      const funded = commitment.state === "Active" && isFundedMember(purchase);
      const listed = listedUsd(purchase);
      const refundAction = commitment.state === "Refundable" ? `<button class="button button-primary button-small" type="button" data-action="claim-refund" data-purchase-id="${escapeHtml(purchase.id)}">Claim ${escapeHtml(customerPaymentLabel(purchase, commitment.amount))} refund</button>` : "";
      const cancelAction = funded && purchase.state === "Open" && !deadlineHasPassed(purchase.cancellation_deadline_ns) ? `<button class="button button-outline button-small" type="button" data-action="cancel-commitment" data-purchase-id="${escapeHtml(purchase.id)}">Cancel Before Deadline</button>` : "";
      const issueAction = funded && appConfig.v3ContractId ? `<a class="button button-outline button-small" href="/purchases/${encodeURIComponent(purchase.id)}/issue">Raise an Issue</a>` : "";
      const listedTotal = listed ? `${listed} × ${commitment.quantity}` : "Listed price unavailable";
      return `<article class="member-purchase-card" id="${commitment.state === "Refundable" ? `action-refund-${escapeHtml(purchase.id)}` : `deal-${escapeHtml(purchase.id)}`}"><div class="purchase-card-top">${statusPill(presentationState(purchase))}<span class="section-kicker">Deal #${escapeHtml(purchase.id)}</span></div><h3>${escapeHtml(livePurchaseTitle(purchase))}</h3><p class="purchase-supplier">Supplier: ${escapeHtml(supplierName(purchase))}</p>${refundNoticeMarkup(purchase)}${packageContentsMarkup(purchase)}<p><span class="member-funded-status ${funded ? "is-funded" : ""}">${funded ? "Spot secured" : `Order status: ${escapeHtml(commitment.state)}`}</span></p><div class="member-card-meta"><span><strong>${quantityLabel(purchase, commitment.quantity)}</strong> reserved</span><span><strong>${escapeHtml(listedTotal)}</strong> listed value</span><span><strong>${escapeHtml(customerPaymentLabel(purchase, commitment.amount))}</strong> contributed</span><span><strong>${quantityLabel(purchase, purchase.total_quantity)} of ${quantityLabel(purchase, purchase.min_quantity)}</strong> toward minimum</span><span><strong>${escapeHtml(formatDate(purchase.deadline_ns))}</strong> deal closes</span><span><strong>${escapeHtml(formatDate(purchase.fulfillment_evidence_deadline_ns))}</strong> fulfillment due</span></div><div class="card-actions"><a class="button button-dark button-small" href="/purchases/${encodeURIComponent(purchase.id)}">View Group Buy</a>${issueAction}${cancelAction}${refundAction}</div></article>`;
    };
    const createdCard = (purchase) => {
      const organizerRequest = purchase.origin === "OrganizerRequest";
      const invitation = organizerRequest ? `<a class="button button-outline button-small" href="/supplier-invitations/${encodeURIComponent(purchase.id)}">View Invitation</a>` : "";
      const workflowResult = !organizerRequest ? ""
        : purchase.state === "AwaitingSupplier" ? `<p class="organizer-result is-pending"><strong>Next step:</strong> Waiting for ${escapeHtml(supplierName(purchase))} to accept or decline. No buyer can join yet.</p>`
          : purchase.state === "Declined" ? `<p class="organizer-result is-declined"><strong>Supplier declined.</strong> This proposal was not published. Revise the terms before sending a new one.</p>`
            : `<p class="organizer-result is-accepted"><strong>Supplier accepted.</strong> The deal is published and its link is ready to share.</p>`;
      return `<article class="member-purchase-card"><div class="purchase-card-top">${statusPill(presentationState(purchase))}<span class="section-kicker">Deal #${escapeHtml(purchase.id)}</span></div><h3>${escapeHtml(livePurchaseTitle(purchase))}</h3><p class="purchase-supplier">Supplier: ${escapeHtml(supplierName(purchase))}</p>${workflowResult}${purchase.state === "Failed" ? `<p class="deal-state-explanation"><strong>Why it failed:</strong> ${escapeHtml(failureReason(purchase))}</p>` : ""}<div class="member-card-meta"><span><strong>${quantityLabel(purchase, purchase.total_quantity)} of ${quantityLabel(purchase, purchase.min_quantity)}</strong> reserved</span><span><strong>${quantityLabel(purchase, availableCapacity(purchase))}</strong> available</span><span><strong>${participantCount(purchase)}</strong> buyers participated</span><span><strong>${escapeHtml(formatDate(purchase.deadline_ns))}</strong> deal closes</span></div><div class="card-actions"><a class="button button-outline button-small" href="/deals/${encodeURIComponent(purchase.id)}">View Group Deal</a>${invitation}</div></article>`;
    };
    const joinedSection = joinedDeals.length ? `<section class="dashboard-group"><div class="section-heading-inline"><div><span class="section-kicker">Deals you joined</span><h2>Your secured group buys</h2></div></div><div class="dashboard-grid">${joinedDeals.map(joinedCard).join("")}</div></section>` : state.liveDataError ? `<section class="dashboard-group"><div class="dashboard-empty"><h2>Some joined deals need a retry.</h2><p>HarvestPool could not verify every purchase record, so it is not claiming that your list is empty.</p></div></section>` : `<section class="dashboard-group"><div class="dashboard-empty"><h2>No joined deals yet.</h2><p>When a contribution is confirmed, your quantity, supplier, progress, and deadlines will appear here.</p><a class="button button-primary" href="/deals">Explore Deals</a></div></section>`;
    const createdSection = createdDeals.length ? `<section class="dashboard-group"><div class="section-heading-inline"><div><span class="section-kicker">Deals you created</span><h2>Your posted Group Deals</h2></div></div><div class="dashboard-grid">${createdDeals.map(createdCard).join("")}</div></section>` : state.liveDataError ? `<section class="dashboard-group"><div class="dashboard-empty"><h2>Some posted deals need a retry.</h2><p>HarvestPool could not verify every purchase record, so it is not claiming that your list is empty.</p></div></section>` : `<section class="dashboard-group"><div class="dashboard-empty"><h2>No posted deals yet.</h2><p>Post a Group Deal when you are ready to organize an order or publish a supplier offer.</p><a class="button button-outline" href="/create">Post a Group Deal</a></div></section>`;
    const relevantTasks = actionCenterTasks().filter((task) => task.kind !== "supplier-consent");
    const filterLabels = [["all", "All"], ["active", "Active"], ["completed", "Completed"], ["unsuccessful", "Unsuccessful"]];
    const filters = `<div class="dashboard-filters filter-tabs" role="group" aria-label="Filter My Group Buys">${filterLabels.map(([value, label]) => `<button class="filter-tab ${activeDashboardFilter === value ? "active" : ""}" type="button" data-dashboard-filter="${value}" aria-pressed="${activeDashboardFilter === value}">${label}</button>`).join("")}</div>`;
    root.innerHTML = `<div class="dashboard-toolbar"><div><span class="section-kicker">Connected wallet</span><h2>My Group Buys</h2></div><span class="wallet-caption">${escapeHtml(shortAccount(state.accountId))}</span></div>${purchaseReadWarningMarkup()}${accountReadWarningMarkup()}${liveRefreshStatusMarkup()}${filters}${actionAlertsMarkup(relevantTasks)}${joinedSection}${createdSection}`;
  }

  function renderDecisionCard(purchase, type) {
    const isOffer = type === "offer";
    const required = isOffer ? Number(purchase.required_offer_yes_votes || 0) : Number(purchase.required_fulfillment_yes_votes || 0);
    const yes = isOffer ? Number(purchase.offer_yes_votes || 0) : Number(purchase.fulfillment_yes_votes || 0);
    const no = isOffer ? Number(purchase.offer_no_votes || 0) : Number(purchase.fulfillment_no_votes || 0);
    const eligible = accountAuthorityReady() && (isOffer ? isMember() : isFundedMember(purchase));
    const simulated = !isOffer && isV5(purchase);
    const title = isOffer ? "Cast Your Vote" : simulated ? "Approve Testnet Evidence" : "Approve Fulfillment";
    const copy = isOffer ? "The current V2 contract uses this community vote to open contributions. It does not authorize a purchase payment." : simulated ? "This smoke test records approval of simulated fulfillment evidence only. No physical delivery is represented. Only an Active funded commitment is eligible." : "Only an Active funded commitment makes this wallet eligible to review the farmer’s fulfillment evidence.";
    const recorded = recordedVote(purchase.id, type);
    const decision = recorded
      ? `<div class="decision-recorded" role="status"><strong>Your recorded decision: ${recorded.approve ? "Yes" : "No"}</strong><span>Current group status: ${escapeHtml(formatStatus(purchase.state))}. This vote attaches 0 NEAR; network gas may apply.</span></div>`
      : eligible
        ? `<div class="vote-actions"><button class="button button-approve" type="button" data-action="vote" data-vote-type="${isOffer ? "offer" : "fulfillment"}" data-purchase-id="${escapeHtml(purchase.id)}" data-approve="true">${isOffer ? "Cast Your Vote · Yes" : simulated ? "Approve Simulated Evidence" : "Approve Fulfillment"}</button><button class="button button-reject" type="button" data-action="vote" data-vote-type="${isOffer ? "offer" : "fulfillment"}" data-purchase-id="${escapeHtml(purchase.id)}" data-approve="false">${isOffer ? "Cast Your Vote · No" : simulated ? "Reject Simulated Evidence" : "Reject Fulfillment"}</button></div>`
        : `<div class="eligibility-label">${state.accountId ? (isOffer ? "This wallet is not in the initialized community." : "Only funded members can vote on fulfillment.") : "Connect a wallet to check eligibility."}</div>`;
    return `<article class="decision-card" id="action-${isOffer ? "offer" : "fulfillment"}-${escapeHtml(purchase.id)}"><div class="purchase-card-top">${statusPill(presentationState(purchase))}<span class="section-kicker">#${escapeHtml(purchase.id)}</span></div><h3>${title}</h3><p>${copy}</p><div class="decision-count"><strong>${yes} / ${required}</strong><span>yes votes · ${no} no</span></div><p class="decision-cost">Voting attaches 0 NEAR. The wallet may charge network gas.</p>${decision}<a class="text-link" style="margin-top: 17px" href="/purchases/${encodeURIComponent(purchase.id)}" target="_blank" rel="noopener noreferrer">Review purchase <span aria-hidden="true">↗</span></a></article>`;
  }

  function renderDecisionHistory(purchases) {
    const rows = [];
    purchases.forEach((purchase) => {
      const offerDecision = recordedVote(purchase.id, "offer");
      const fulfillmentDecision = recordedVote(purchase.id, "fulfillment");
      if (isMember() && offerDecision && purchase.state !== "Proposed") rows.push(`<div class="decision-history-row"><div><strong>Offer decision · purchase #${escapeHtml(purchase.id)}</strong><span>Your recorded decision: ${offerDecision.approve ? "Yes" : "No"} · ${purchase.state === "Failed" ? "Order did not complete" : "Offer moved past proposal"}</span></div><a href="/purchases/${encodeURIComponent(purchase.id)}" target="_blank" rel="noopener noreferrer">Review <span aria-hidden="true">↗</span></a></div>`);
      if (isFundedMember(purchase) && fulfillmentDecision && ["FulfillmentApproved", "PaymentPending", "Completed", "Failed"].includes(purchase.state)) rows.push(`<div class="decision-history-row"><div><strong>${isV5(purchase) ? "Testnet evidence decision" : "Fulfillment decision"} · purchase #${escapeHtml(purchase.id)}</strong><span>Your recorded decision: ${fulfillmentDecision.approve ? "Approve" : "Reject"} · ${purchase.state === "Failed" ? "Order failed; refunds follow contract" : isV5(purchase) ? (purchase.state === "Completed" ? "Simulated evidence approved; Testnet payment completed. No physical delivery is represented." : "Simulated evidence approved. No physical delivery is represented.") : purchase.state === "Completed" ? "Delivery approved; payment completed" : "Delivery approved"}</span></div><a href="/purchases/${encodeURIComponent(purchase.id)}" target="_blank" rel="noopener noreferrer">Review <span aria-hidden="true">↗</span></a></div>`);
    });
    state.decisions.forEach((decision) => {
      const vote = decisionVoteFor(decision);
      if (!vote || ["Open", "AwaitingSupplier"].includes(decision.state)) return;
      rows.push("<div class=\"decision-history-row\"><div><strong>" + escapeHtml(decision.proposal) + "</strong><span>" + escapeHtml(decisionStateLabel(decision.state)) + " · your choice: " + escapeHtml(decision.options[vote.option] || "Choice") + "</span></div><a href=\"/purchases/" + encodeURIComponent(decision.purchase_id) + "\">Open purchase <span aria-hidden=\"true\">↗</span></a></div>");
    });
    const dataUnavailable = Boolean(state.v3Error || state.liveDataError);
    const historyContent = rows.length
      ? "<div class=\"decision-history-list\">" + rows.join("") + "</div>"
      : dataUnavailable ? "" : "<div class=\"issues-empty\"><p>No completed actions yet.</p><span>Confirmed votes and resolved actions will appear here.</span></div>";
    const readWarning = dataUnavailable
      ? `<div class="issues-unavailable"><p>Latest issue and decision data could not be refreshed. Previously confirmed history is labeled below; retry before relying on current status.</p><button class="button button-outline button-small" type="button" data-action="retry-live-data">Retry</button></div>`
      : "";
    return `<section class="action-center-section action-history">${readWarning}${historyContent}</section>`;
  }

  function renderRaiseIssueForm(selectedPurchaseId = "") {
    if (!state.accountId) return `<div class="issues-empty"><p>Connect your wallet to check which funded purchases can open an issue.</p><button class="button button-dark button-small" type="button" data-connect-wallet>Connect wallet</button></div>`;
    if (!appConfig.v3ContractId) return `<div class="issues-unavailable"><p>Member issues are not turned on for this community yet.</p></div>`;
    if (!accountAuthorityReady()) return `<div class="issues-unavailable"><p>Wallet-specific eligibility could not be verified. Refresh before raising an issue or relying on an empty result.</p><button class="button button-outline button-small" type="button" data-action="retry-live-data">Refresh</button></div>`;
    if (!state.v3Available || state.v3Error) return `<div class="issues-unavailable"><p>Issues are temporarily unavailable. Previously confirmed issue records remain protected; retry before relying on current eligibility.</p><button class="button button-outline button-small" type="button" data-action="retry-live-data">Retry live data</button></div>`;
    const eligiblePurchases = state.purchases.filter((purchase) => isFundedMember(purchase) && !["Completed", "Failed"].includes(purchase.state));
    if (!eligiblePurchases.length) return `<div class="issues-empty"><p>No active funded purchases are currently eligible for a new issue.</p><span>Review your confirmed participation and purchase status in My Group Buys.</span><a class="button button-outline button-small" href="/dashboard">My Group Buys</a></div>`;
    const selected = eligiblePurchases.some((purchase) => String(purchase.id) === String(selectedPurchaseId)) ? String(selectedPurchaseId) : String(eligiblePurchases[0].id);
    return `<form class="issue-form" id="raise-issue-form" data-issue-form data-draft-form="raise-issue" data-draft-purchase-id="${escapeHtml(selected)}"><div class="form-intro"><span class="form-step">Raise an issue</span><p>Keep it practical. You can ask for a clarification or suggest a safe pickup change.</p></div><div class="field"><label for="issue-purchase">Which purchase is this about?</label><select id="issue-purchase" name="purchase_id" required>${eligiblePurchases.map((purchase) => `<option value="${escapeHtml(purchase.id)}" ${String(purchase.id) === selected ? "selected" : ""}>${escapeHtml(livePurchaseTitle(purchase))} · purchase #${escapeHtml(purchase.id)}</option>`).join("")}</select></div><div class="field"><label for="issue-subject">What is the issue about?</label><input id="issue-subject" name="subject" type="text" maxlength="120" placeholder="Pickup time no longer works" required></div><div class="field"><label for="issue-description">Describe the problem or concern.</label><textarea id="issue-description" name="description" maxlength="2000" rows="5" placeholder="Tell the group what changed and what would help." required></textarea></div><div class="field"><label for="issue-solution">What solution do you suggest? <span class="field-optional">Optional</span></label><textarea id="issue-solution" name="suggested_solution" maxlength="1000" rows="3" placeholder="A practical suggestion, if you have one."></textarea></div><div class="form-error-summary" id="issue-form-error" tabindex="-1" role="alert" hidden></div><div class="form-actions"><span class="form-safety">Only confirmed funded members can raise issues.</span><div class="draft-actions"><button class="button button-outline button-small" type="button" data-action="discard-draft">Discard draft</button><button class="button button-primary" type="submit">Submit issue</button></div></div></form>`;
  }

  function renderV3Dashboard() {
    if (!appConfig.v3ContractId) {
      return `<section class="action-center-section action-issues"><div class="issues-unavailable"><p>Member issues are not turned on for this community yet.</p></div></section>`;
    }
    if (!state.v3Available) {
      return `<section class="action-center-section action-issues"><div class="action-issues-toolbar"><a class="button button-primary button-small" href="#raise-an-issue" data-action="show-raise-issue">Raise an Issue</a></div><div class="issues-unavailable"><p>Issues are temporarily unavailable. Previously confirmed records have not been replaced by an empty result.</p><button class="button button-outline button-small" type="button" data-action="retry-live-data">Retry</button></div></section>`;
    }
    const seenIssueIds = new Set();
    const visibleIssues = state.issues.filter((issue) => {
      const id = String(issue.id);
      if (!canSeeIssue(issue) || seenIssueIds.has(id)) return false;
      seenIssueIds.add(id);
      return true;
    });
    const issuesMarkup = visibleIssues.length
      ? `<div class="issue-list">${visibleIssues.map((issue) => renderIssueCard(issue)).join("")}</div>`
      : `<div class="issues-empty"><p>No issues have been raised in your funded purchases.</p><span>Start with a practical concern if something has changed.</span></div>`;
    const openRaiseForm = window.location.hash === "#raise-an-issue";
    const warning = state.v3Error ? `<div class="issues-unavailable" role="status"><p>Latest issue or decision reads are temporarily unavailable. Existing records remain visible; retry before taking a restricted action.</p><button class="button button-outline button-small" type="button" data-action="retry-live-data">Retry live data</button></div>` : "";
    return `<section class="action-center-section action-issues"><div class="action-issues-toolbar"><a class="button button-primary button-small" href="#raise-an-issue" data-action="show-raise-issue">Raise an Issue</a></div>${warning}${issuesMarkup}<div class="raise-issue-block" id="raise-an-issue" tabindex="-1" ${openRaiseForm ? "" : "hidden"}><div class="section-heading-inline"><div><h3>Raise an Issue</h3></div></div>${renderRaiseIssueForm()}</div></section>`;
  }

  const ACTION_CENTER_TABS = ["active", "archived", "history", "issues"];

  function actionCenterTabFromHash(hash = window.location.hash) {
    if (hash === "#archived") return "archived";
    if (hash === "#history") return "history";
    if (hash === "#issues" || hash === "#raise-an-issue") return "issues";
    return "active";
  }

  function actionCenterTabsMarkup(activeTab, activeCount, archivedCount) {
    const labels = { active: "Active", archived: "Archived", history: "History", issues: "Issues" };
    return `<div class="action-center-tabs" role="tablist" aria-label="Action Center views">${ACTION_CENTER_TABS.map((tab) => {
      const selected = tab === activeTab;
      const value = tab === "active" ? activeCount : tab === "archived" ? archivedCount : null;
      const count = value === null ? "" : `<span class="action-center-tab-count" aria-label="${value} ${tab}">${value}</span>`;
      return `<button class="action-center-tab" id="action-tab-${tab}" type="button" role="tab" aria-selected="${selected}" aria-controls="action-panel-${tab}" tabindex="${selected ? "0" : "-1"}" data-action-center-tab="${tab}">${labels[tab]}${count}</button>`;
    }).join("")}</div>`;
  }

  function actionCenterPanelMarkup(tab, activeTab, content) {
    return `<div class="action-center-tabpanel" id="action-panel-${tab}" role="tabpanel" aria-labelledby="action-tab-${tab}" ${tab === activeTab ? "" : "hidden"}>${content}</div>`;
  }

  function activateActionCenterTab(tab, { updateHash = true, focus = false } = {}) {
    const selectedTab = ACTION_CENTER_TABS.includes(tab) ? tab : "active";
    $$('[role="tab"][data-action-center-tab]', $("#decisions-root")).forEach((button) => {
      const selected = button.dataset.actionCenterTab === selectedTab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    });
    $$(".action-center-tabpanel", $("#decisions-root")).forEach((panel) => {
      panel.hidden = panel.id !== `action-panel-${selectedTab}`;
    });
    if (updateHash) {
      $("#raise-an-issue")?.setAttribute("hidden", "");
      if (window.location.hash !== `#${selectedTab}`) window.history.pushState(null, "", `#${selectedTab}`);
    } else if (selectedTab !== "issues") {
      $("#raise-an-issue")?.setAttribute("hidden", "");
    }
  }

  function showRaiseIssueForm({ focus = true } = {}) {
    activateActionCenterTab("issues", { updateHash: false });
    const block = $("#raise-an-issue");
    if (!block) return;
    block.hidden = false;
    if (window.location.hash !== "#raise-an-issue") window.history.pushState(null, "", "#raise-an-issue");
    block.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    if (focus) ($("#issue-purchase", block) || block).focus({ preventScroll: true });
  }

  function renderDecisions() {
    const root = $("#decisions-root");
    if (!root) return;
    if (state.walletStatus === "initializing" || state.purchaseDiscoveryStatus === "loading" || state.purchaseDiscoveryStatus === "idle") {
      root.innerHTML = accountDataLoadingMarkup("Loading decisions", "Restoring the wallet and reading confirmed purchases, issues, and votes.");
      return;
    }
    if (state.purchaseDiscoveryStatus === "error" && !state.dataLoaded) {
      root.innerHTML = accountDataUnavailableMarkup("HarvestPool could not verify the purchase records needed to build Action Center tasks.");
      return;
    }
    const tasks = actionCenterTasks();
    const archivedTasks = actionCenterTasks({ scope: "archived" });
    const renderTask = (task, { archived = false } = {}) => {
      if (["offer-vote", "fulfillment-vote"].includes(task.kind)) {
        const purchase = state.purchases.find((item) => String(item.id) === String(task.purchaseId));
        return purchase ? renderDecisionCard(purchase, task.kind === "offer-vote" ? "offer" : "fulfillment") : "";
      }
      if (["community-vote", "supplier-consent"].includes(task.kind)) {
        const issue = state.issues.find((item) => String(item.id) === String(task.issueId));
        return issue ? `<div id="action-${escapeHtml(task.id)}">${renderIssueCard(issue, { showRequest: false })}</div>` : "";
      }
      if (task.kind === "supplier-invitation") {
        const purchase = state.purchases.find((item) => String(item.id) === String(task.purchaseId));
        return purchase ? `<article class="decision-card action-card-priority" id="action-${escapeHtml(task.id)}"><div class="purchase-card-top">${statusPill(presentationState(purchase))}<span class="section-kicker">Deal #${escapeHtml(purchase.id)}</span></div><h3>Review a supplier proposal</h3><p>${escapeHtml(purchase.proposer || "An organizer")} proposed ${escapeHtml(livePurchaseTitle(purchase))}. Review every term before accepting or declining.</p><div class="vote-actions"><a class="button button-primary" href="/supplier-invitations/${encodeURIComponent(purchase.id)}#supplier-response">Review proposal</a></div></article>` : "";
      }
      if (task.kind === "refund") {
        const purchase = state.purchases.find((item) => String(item.id) === String(task.purchaseId));
        const commitment = purchase ? commitmentFor(purchase) : null;
        return purchase && commitment ? `<article class="decision-card action-card-priority" id="action-${escapeHtml(task.id)}"><div class="purchase-card-top">${statusPill(presentationState(purchase))}<span class="section-kicker">Deal #${escapeHtml(purchase.id)}</span></div><h3>Refund ready</h3><p>${escapeHtml(customerPaymentLabel(purchase, commitment.amount))} is available to the original buyer account.</p><div class="vote-actions"><button class="button button-primary" type="button" data-action="claim-refund" data-purchase-id="${escapeHtml(purchase.id)}">Claim refund</button><a class="button button-outline" href="/purchases/${encodeURIComponent(purchase.id)}">Review deal</a></div></article>` : "";
      }
      if (task.kind === "pending-transaction") {
        const isContribution = task.methodName === "community_contribute_usdc";
        const amount = isContribution && /^\d+$/.test(String(task.amount || ""))
          ? usdFromTokenUnits(task.amount, 6)
          : escapeHtml(String(task.amount || "Not applicable"));
        const hash = task.transactionHash
          ? communityExplorerLink(task.transactionHash, task.transactionHash)
          : "Not saved — Meteor did not return a hash to this page";
        const message = archived
          ? "This alert is hidden from Active and the notification count. Automatic verification and duplicate protection continue."
          : isContribution && !task.transactionHash
            ? "No submitted transaction is identifiable yet. Checking status never sends another payment."
            : "HarvestPool is checking the exact saved transaction. Checking status never resubmits it.";
        const status = archived ? "Archived alert" : isContribution ? "Checking your payment" : "Checking status";
        const heading = isContribution ? `Your contribution: ${amount}` : "Saved action under verification";
        const archiveButton = archived
          ? ""
          : `<button class="button button-outline" type="button" data-action="archive-pending-alert" data-pending-action-id="${escapeHtml(task.actionId)}">Archive alert</button>`;
        return `<article class="decision-card" id="action-${escapeHtml(task.id)}" ${archived ? 'data-archived-action="true"' : ""}><span class="status status-pending"><span></span>${escapeHtml(status)}</span><h3>${escapeHtml(heading)}</h3><p>${escapeHtml(message)}</p><details class="technical-details"><summary>Saved action details</summary><dl class="checkout-status-facts"><div><dt>Signer</dt><dd><code>${escapeHtml(task.signerId)}</code></dd></div><div><dt>Token contract</dt><dd><code>${escapeHtml(task.receiverId)}</code></dd></div><div><dt>DAO</dt><dd><code>${escapeHtml(task.daoId || "Not applicable")}</code></dd></div><div><dt>Amount</dt><dd>${amount}</dd></div><div><dt>Transaction</dt><dd>${hash}</dd></div></dl></details><div class="vote-actions"><button class="button button-primary" type="button" data-action="check-pending-actions" data-pending-action-id="${escapeHtml(task.actionId)}">Check status</button>${archiveButton}</div><p class="field-help" role="status" aria-live="polite" data-pending-check-result></p></article>`;
      }
      return "";
    };
    const cards = tasks.map((task) => renderTask(task)).filter(Boolean);
    const archivedCards = archivedTasks.map((task) => renderTask(task, { archived: true })).filter(Boolean);
    const walletView = actionCenterTools.walletViewState(state.walletStatus, state.accountId);
    const liveVerificationUnavailable = Boolean(appConfig.v3ContractId && !state.v3Available && state.v3Error);
    const active = liveVerificationUnavailable
      ? `<section class="action-center-section"><div class="issues-unavailable" role="status"><strong>Loading decisions is temporarily unavailable.</strong><p>HarvestPool could not verify the latest issue and vote state, so it is not showing a false empty result.</p><button class="button button-outline button-small" type="button" data-action="retry-live-data">Retry live data</button></div></section>`
      : walletView === "restoring"
      ? `<section class="action-center-section"><div class="wallet-empty-state" role="status"><strong>Checking wallet connection...</strong></div></section>`
      : cards.length
      ? `<section class="action-center-active" aria-labelledby="active-actions-heading"><div class="section-heading-inline"><div><span class="section-kicker">Active</span><h2 id="active-actions-heading">${cards.length} ${cards.length === 1 ? "action" : "actions"} need your attention</h2></div></div><div class="decision-grid">${cards.join("")}</div></section>`
      : state.accountId && !accountAuthorityReady()
        ? `<section class="action-center-section"><div class="issues-unavailable" role="status"><strong>Wallet-specific actions are temporarily unavailable.</strong><p>HarvestPool could not verify this wallet's membership and vote state, so it is not claiming that you are caught up.</p><button class="button button-outline button-small" type="button" data-action="retry-live-data">Refresh</button></div></section>`
      : walletView === "connected"
        ? `<section class="action-center-section action-center-empty"><div class="empty-icon">${icon("shield")}</div><h2>You're all caught up.</h2><p>No actions need your attention right now.</p></section>`
        : `<section class="action-center-section"><div class="wallet-empty-state"><strong>Wallet not connected.</strong><span>Connect your wallet to view your actions.</span></div></section>`;
    const archived = archivedCards.length
      ? `<section class="action-center-active" aria-labelledby="archived-actions-heading"><div class="section-heading-inline"><div><span class="section-kicker">Archived</span><h2 id="archived-actions-heading">${archivedCards.length} hidden ${archivedCards.length === 1 ? "alert" : "alerts"}</h2></div></div><div class="decision-grid">${archivedCards.join("")}</div></section>`
      : `<section class="action-center-section action-center-empty"><div class="empty-icon">${icon("shield")}</div><h2>No archived alerts</h2><p>Archived unresolved alerts remain here while automatic verification continues.</p></section>`;
    const activeTab = actionCenterTabFromHash();
    root.innerHTML = `<p class="sr-only" role="status" aria-live="polite" data-action-center-announcement></p>${purchaseReadWarningMarkup()}${accountReadWarningMarkup()}${liveRefreshStatusMarkup()}${actionCenterTabsMarkup(activeTab, cards.length, archivedCards.length)}${actionCenterPanelMarkup("active", activeTab, active)}${actionCenterPanelMarkup("archived", activeTab, archived)}${actionCenterPanelMarkup("history", activeTab, renderDecisionHistory(state.purchases))}${actionCenterPanelMarkup("issues", activeTab, renderV3Dashboard())}`;
  }

  function renderIssueFormPage() {
    const root = $("#issue-form-content");
    if (!root) return;
    const id = $("#issue-form-root")?.dataset.purchaseId || "";
    if (!state.accountId) {
      root.innerHTML = `<div class="connect-card"><div class="connect-card-mark">${icon("shield")}</div><div><h2>Connect a wallet to raise an issue.</h2><p>Only a confirmed funded member can start an issue for a purchase.</p></div><button class="button button-dark" type="button" data-connect-wallet>Connect wallet</button></div>`;
      return;
    }
    const purchase = state.purchases.find((item) => String(item.id) === String(id));
    const pendingIssue = pendingActionStore.list(state.accountId).find((action) =>
      action.methodName === "raise_issue" && String(action.args?.purchase_id) === String(id));
    const requestedNewIssue = new URLSearchParams(window.location.search).get("new") === "1";
    const confirmedIssue = state.issues.find((issue) =>
      String(issue.purchase_id) === String(id)
      && String(issue.raised_by) === String(state.accountId)
      && (state.confirmedIssueId === null || String(issue.id) === String(state.confirmedIssueId)));
    if (!requestedNewIssue && confirmedIssue) {
      const decision = decisionForIssue(confirmedIssue);
      const issueHref = `/purchases/${encodeURIComponent(id)}`;
      const canRequest = confirmedIssue.state === "Open"
        && (confirmedIssue.active_decision_id === null || confirmedIssue.active_decision_id === undefined)
        && Boolean(purchase && isFundedMember(purchase));
      root.innerHTML = `<section class="checkout-confirmed issue-confirmed" role="status" aria-live="polite"><div class="checkout-confirmed-mark" aria-hidden="true">${icon("shield")}</div><div class="checkout-confirmed-main"><span class="section-kicker">Issue confirmed on-chain</span><h1>Your issue has been submitted!</h1><dl class="checkout-status-facts"><div><dt>Issue subject</dt><dd>${escapeHtml(confirmedIssue.subject)}</dd></div><div><dt>Issue ID</dt><dd>#${escapeHtml(confirmedIssue.id)}</dd></div><div><dt>Group Deal</dt><dd>#${escapeHtml(confirmedIssue.purchase_id)}</dd></div><div><dt>Current issue status</dt><dd>${escapeHtml(issueStateLabel(confirmedIssue.state))}</dd></div><div><dt>Submitted by</dt><dd>${escapeHtml(confirmedIssue.raised_by)}</dd></div></dl><div class="checkout-confirmed-actions"><a class="button button-outline" href="${issueHref}">${decision ? "View Group Vote" : "View issue"}</a>${canRequest ? `<a class="button button-primary" href="${issueHref}">Request Group Vote</a>` : ""}</div><p class="field-help">This V3 record does not change Deal #${escapeHtml(confirmedIssue.purchase_id)}'s immutable terms or move funds.</p><a class="text-link" href="/purchases/${encodeURIComponent(id)}/issue?new=1">Raise a different issue</a></div></section>`;
      return;
    }
    if (pendingIssue) {
      root.innerHTML = `<section class="checkout-payment-status" role="status" aria-live="polite"><div class="checkout-status-spinner" aria-hidden="true"></div><div><span class="section-kicker">Blockchain confirmation</span><h1>Confirming your issue…</h1><p>We haven't confirmed the result yet. Please don't submit again while we check.</p>${pendingIssue.transactionHash ? `<p>Transaction: <code>${escapeHtml(pendingIssue.transactionHash)}</code></p>` : ""}<div class="checkout-confirmed-actions"><button class="button button-primary" type="button" data-action="check-pending-actions">Check issue status</button><a class="button button-outline" href="/purchases/${encodeURIComponent(id)}">Back to Group Deal</a></div></div></section>`;
      return;
    }
    root.innerHTML = `<div class="issue-form-header"><p class="eyebrow">Purchase conversation</p><h1>Raise a concern without the awkward conversation.</h1><p>Share what changed. The group can clarify it or decide together when a vote is needed.</p></div>${renderRaiseIssueForm(id)}<p class="contract-note">Your issue is recorded with the purchase. It does not change price, quantity, supplier, refunds, or pooled funds.</p>`;
  }

  function renderFarmer() {
    const root = $("#farmer-root");
    if (!root) return;
    if (state.walletStatus === "initializing" || state.purchaseDiscoveryStatus === "loading" || state.purchaseDiscoveryStatus === "idle") {
      root.innerHTML = accountDataLoadingMarkup("Loading your sales", "Restoring the supplier wallet and reading confirmed orders.");
      return;
    }
    if (state.purchaseDiscoveryStatus === "error" && !state.dataLoaded) {
      root.innerHTML = accountDataUnavailableMarkup("HarvestPool could not verify the supplier order directory. No empty sales result is being shown.");
      return;
    }
    if (!state.accountId) {
      root.innerHTML = disconnectedAccountMarkup("Supplier invitations and accepted orders will appear here.");
      return;
    }
    const ownPurchases = state.purchases.filter((purchase) => String(supplierAccount(purchase)) === String(state.accountId));
    const financialPurchases = state.purchases.filter((purchase) => isV5(purchase) && ["FulfillmentApproved", "Completed"].includes(purchase.state));
    const canReviewFinancialOperations = Boolean(state.accountId && financialPurchases.length);
    if (!ownPurchases.length && !canReviewFinancialOperations) {
      root.innerHTML = `<div class="dashboard-toolbar"><div><span class="section-kicker">Connected wallet</span><h2>${escapeHtml(shortAccount(state.accountId))}</h2></div><span class="wallet-caption">Named supplier</span></div>${state.liveDataError ? accountDataUnavailableMarkup("HarvestPool could not verify every purchase record, so it is not claiming that this wallet has no sales.") : `<div class="dashboard-empty"><div class="empty-icon">${icon("leaf")}</div><h2>No assigned purchases yet.</h2><p>Purchases appear here when this wallet is the named supplier.</p></div>`}`;
      return;
    }
    const supplierTasks = actionCenterTasks().filter((task) => ["supplier-invitation", "supplier-consent", "pending-transaction"].includes(task.kind));
    const invitations = ownPurchases.filter((purchase) => purchase.state === "AwaitingSupplier");
    const orders = ownPurchases.filter((purchase) => purchase.state !== "AwaitingSupplier");
    const operations = canReviewFinancialOperations
      ? `<section class="management-area"><div class="section-heading-inline"><div><span class="section-kicker">Permissionless contract operation</span><h2>Financial operations</h2><p class="section-heading-copy">The contract permits any connected account to initiate these zero-deposit reads and actions. Fresh balance, liability, supplier-registration, and duplicate-operation checks still gate every payout.</p></div></div><div class="management-deal-list">${financialPurchases.map((purchase) => `<button class="button button-outline button-small" type="button" data-action="open-financial-operations" data-purchase-id="${escapeHtml(purchase.id)}">Review Deal #${escapeHtml(purchase.id)} controls</button>`).join("") || "<p>No deal currently has an available management operation.</p>"}</div><div id="financial-operations-root"></div></section>`
      : "";
    const invitationSection = invitations.length ? `<section class="supplier-work-group"><div class="section-heading-inline"><div><span class="section-kicker">Review first</span><h2>Proposals awaiting your response</h2></div><span class="meta-label">${invitations.length} pending</span></div><div class="farmer-grid">${invitations.map((purchase) => `<article class="farmer-card invitation-card"><div class="purchase-card-top">${statusPill(presentationState(purchase))}<span class="section-kicker">Deal #${escapeHtml(purchase.id)}</span></div><h3>${escapeHtml(livePurchaseTitle(purchase))}</h3><p>${escapeHtml(purchase.proposer)} proposed ${quantityLabel(purchase, purchase.min_quantity)}–${quantityLabel(purchase, purchase.max_quantity)} under fixed terms.</p><a class="button button-primary button-small" href="/supplier-invitations/${encodeURIComponent(purchase.id)}#supplier-response">Review and respond</a></article>`).join("")}</div></section>` : "";
    const orderCards = orders.map((purchase) => {
      const simulated = isV5(purchase);
      const fulfillmentExpired = purchase.state === "Funded" && deadlineHasPassed(purchase.fulfillment_evidence_deadline_ns);
      const evidence = purchase.fulfillment_evidence_hash
        ? `<div class="evidence-hash">${simulated ? "Simulated fulfillment evidence recorded" : "Delivery details submitted"}: ${escapeHtml(purchase.fulfillment_evidence_hash)}</div>`
        : purchase.state !== "Funded"
          ? `<p class="field-help">Fulfillment evidence is not needed at this stage.</p>`
          : !accountAuthorityReady()
            ? `<div class="eligibility-callout warning"><span><strong>Supplier wallet state is still being verified.</strong><br>Refresh before submitting fulfillment evidence or marking this order unfulfilled.</span><button class="button button-outline button-small" type="button" data-action="retry-live-data">Refresh</button></div>`
          : fulfillmentExpired
            ? `<div class="eligibility-callout error"><span><strong>Fulfillment deadline passed.</strong><br>The contract will reject new evidence. A permitted account must mark this purchase unfulfilled; buyers can then claim refunds when the contract records them as refundable.</span><button class="button button-outline button-small" type="button" data-action="expire-unfulfilled" data-purchase-id="${escapeHtml(purchase.id)}">Mark unfulfilled</button></div>`
            : `<form class="evidence-form" data-evidence-form data-draft-form="fulfillment-evidence" data-draft-purchase-id="${escapeHtml(purchase.id)}" data-purchase-id="${escapeHtml(purchase.id)}"><label for="evidence-${escapeHtml(purchase.id)}">${simulated ? "Testnet simulation reference" : "Delivery reference"}</label><input id="evidence-${escapeHtml(purchase.id)}" name="evidence" type="text" maxlength="256" placeholder="${simulated ? "TESTNET_SIMULATION_NO_PHYSICAL_DELIVERY" : "Order or delivery reference"}" required><span class="field-help">${simulated ? "The contract stores this in its fulfillment-evidence field. Use wording that explicitly says no physical delivery occurred." : "Provide the agreed fulfillment reference."}</span><div class="draft-actions"><button class="button button-outline button-small" type="button" data-action="discard-draft">Start fresh</button><button class="button button-primary" type="submit">${simulated ? "Review & Submit Simulated Evidence" : "Submit Delivery Details"} <span aria-hidden="true">↗</span></button></div></form>`;
      return `<article class="farmer-card"><div class="purchase-card-top">${statusPill(presentationState(purchase))}<span class="section-kicker">#${escapeHtml(purchase.id)}</span></div><h3>${escapeHtml(livePurchaseTitle(purchase))}</h3><p>${quantityLabel(purchase, purchase.total_quantity)} of ${quantityLabel(purchase, purchase.max_quantity)} reserved · fulfillment evidence due ${escapeHtml(formatDate(purchase.fulfillment_evidence_deadline_ns))}</p>${packageContentsMarkup(purchase)}${simulated ? `<div class="eligibility-callout warning"><span><strong>Testnet simulation</strong><br>Submit a simulation reference only. This demo does not claim physical delivery.</span></div>` : ""}${evidence}<a class="text-link" style="margin-top: 18px" href="/deals/${encodeURIComponent(purchase.id)}">Review Group Deal <span aria-hidden="true">↗</span></a></article>`;
    }).join("");
    const ordersSection = `<section class="supplier-work-group"><div class="section-heading-inline"><div><span class="section-kicker">Accepted deals</span><h2>Orders and fulfillment</h2></div><span class="meta-label">${orders.length} deals</span></div>${orderCards ? `<div class="farmer-grid">${orderCards}</div>` : '<div class="dashboard-empty compact"><p>No accepted orders yet.</p></div>'}</section>`;
    root.innerHTML = `<div class="dashboard-toolbar"><div><span class="section-kicker">Connected supplier wallet</span><h2>My Sales</h2></div><span class="wallet-caption">${escapeHtml(shortAccount(state.accountId))}</span></div>${purchaseReadWarningMarkup()}${accountReadWarningMarkup()}${liveRefreshStatusMarkup()}${actionAlertsMarkup(supplierTasks)}${invitationSection}${ordersSection}${operations}`;
    if (state.openFinancialOperationsId && String(state.currentPurchase?.id) === String(state.openFinancialOperationsId)) {
      const target = $("#financial-operations-root", root);
      if (target) target.innerHTML = financialReadinessMarkup(state.currentPurchase);
    }
  }

  function updateCreatePricePreview() {
    const preview = $("#create-price-preview");
    const input = $("#price-per-unit");
    if (!preview || !input) return;
    if (isV5()) {
      const listedInput = $("#listed-usd-price");
      const derived = usdcTools.usdPrice(listedInput?.value, Number(state.config?.token_decimals || 6));
      input.value = derived?.tokenUnits || "";
      preview.innerHTML = !derived
        ? "<strong>Enter a USD price with no more than two decimals</strong><span>The test payment amount will match it exactly.</span>"
        : `<strong>${escapeHtml(usdcTools.formatUnits(derived.tokenUnits, 6))} Testnet USDC per ${escapeHtml(dealFormTools.selectedUnit($("#sale-unit")?.value, $("#custom-unit")?.value))}</strong><span>This matches the listed USD amount at a nominal 1:1 rate. It is not a real USD card charge.</span>`;
      return;
    }
    const yocto = parseNearAmount(input.value);
    if (yocto === null) {
      preview.innerHTML = "<strong>Enter an exact NEAR amount</strong><span>The USD estimate appears after the amount is valid.</span>";
      return;
    }
    preview.innerHTML = `<strong>Exact Testnet contribution: ${escapeHtml(formatNear(yocto))} NEAR</strong><span>Separate from the listed USD product price · Testnet NEAR has no cash value</span>`;
  }

  function updateContributionTotal() {
    const root = $("#agreement-root");
    const input = $("#contribution-quantity");
    const total = $("#contribution-total");
    if (!root || !input || !total) return;
    try {
      const amount = BigInt(root.dataset.price || "0") * BigInt(Math.max(1, Number(input.value || 1)));
      total.innerHTML = isV5(state.currentPurchase)
        ? `<span class="money-primary">${escapeHtml(customerPaymentLabel(state.currentPurchase, amount))}</span>`
        : moneyMarkup(amount, "", state.currentPurchase);
    } catch (_error) {
      total.textContent = `Exact ${paymentAsset(state.currentPurchase).symbol} amount unavailable`;
    }
  }

  function updateAgreementAcceptance() {
    const root = $("#agreement-root");
    const checkbox = $("#agreement-acceptance", root);
    const button = $("[data-action=contribute]", root);
    if (!checkbox || !button) return;
    const eligible = button.dataset.eligible === "true";
    button.disabled = !(eligible && checkbox.checked);
    button.setAttribute("aria-disabled", String(button.disabled));
  }

  function refreshAgreementCheckout() {
    renderAgreementPage();
    decorateMoneyText();
    restoreDraftsInDom();
    updateContributionTotal();
    updateAgreementAcceptance();
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.focus();
    helper.select();
    document.execCommand("copy");
    helper.remove();
    return Promise.resolve();
  }

  async function handleVote(button) {
    const purchaseId = button.dataset.purchaseId;
    const method = button.dataset.voteType === "offer" ? "vote_on_offer" : "vote_on_fulfillment";
    const approve = button.dataset.approve === "true";
    const purchase = state.purchases.find((item) => String(item.id) === String(purchaseId));
    if (method === "vote_on_fulfillment" && isV5(purchase)) {
      const choice = approve ? "approve" : "reject";
      const reviewed = await reviewTransaction({
        title: `${approve ? "Approve" : "Reject"} Testnet evidence`,
        summary: `Record your choice to ${choice} the simulated fulfillment evidence for Deal #${purchaseId}.`,
        signer: state.accountId,
        receiver: appConfig.contractId,
        method,
        args: { purchase_id: String(purchaseId), approve },
        gas: "30 Tgas (30000000000000 gas)",
        deposit: "0 NEAR",
        warning: "No physical delivery is represented. Reaching the threshold only makes a separate, explicitly authorized payment action available.",
        confirmLabel: `Record ${approve ? "approval" : "rejection"}`,
      });
      if (!reviewed) return null;
    }
    return performVerifiedAction(button, method, { purchase_id: String(purchaseId), approve }, method === "vote_on_fulfillment" && isV5(purchase) ? "Your simulated-evidence vote has been recorded; no physical delivery is represented." : "Your vote has been recorded.", {
      failureMessage: "We couldn't record your vote. Your draft is safe. Please try again.",
      alreadyMessage: `Your recorded choice is already ${approve ? "Yes" : "No"}.`,
    });
  }

  async function handleReconcile(button) {
    const purchase = state.currentPurchase;
    if (!purchase || !isV5(purchase)) return;
    if (state.accountId && pendingActionStore.list(state.accountId).some((action) =>
      ["reconcile_token_balance", "release_payment"].includes(action.methodName))) {
      showToast("A financial transaction is still unresolved. Payment remains blocked while HarvestPool checks it.", "error");
      return;
    }
    const freshPurchase = await loadPurchase(purchase.id).catch(() => null);
    const readiness = freshPurchase ? await loadFinancialReadiness(freshPurchase).catch(() => null) : null;
    if (!readiness || readiness.error || !readiness.figuresMatch) {
      showToast("STOP: the fresh Circle balance and outstanding liability could not be verified as equal.", "error");
      renderCurrentPage();
      return;
    }
    const decimals = Number(freshPurchase.token_decimals || 6);
    const reviewed = await reviewTransaction({
      title: `Reconcile Deal #${freshPurchase.id} escrow`,
      summary: `Circle balance ${usdcTools.formatUnits(readiness.balance, decimals)} USDC and outstanding liability ${usdcTools.formatUnits(readiness.liability, decimals)} USDC currently match. This action records a new snapshot and transfers no USDC.`,
      signer: state.accountId,
      receiver: appConfig.contractId,
      method: "reconcile_token_balance",
      args: {},
      gas: "50 Tgas (50000000000000 gas)",
      deposit: "0 NEAR",
      warning: "HarvestPool will keep supplier payment blocked until the Circle read and V5 callback are authoritatively confirmed.",
      confirmLabel: "Authorize reconciliation",
    });
    if (!reviewed) return;
    const result = await performVerifiedAction(button, "reconcile_token_balance", {}, "Escrow reconciliation successful", {
      context: { previousReconciledAt: readiness.accounting?.last_reconciled_at_ns ?? null, purchaseId: String(freshPurchase.id) },
      failureMessage: "Reconciliation was not confirmed. No payout was submitted.",
    });
    if (result?.state === "confirmed") {
      await loadPurchase(freshPurchase.id).catch(() => null);
      renderCurrentPage();
    }
  }

  function payoutSafetyState(purchase, readiness) {
    const accounting = readiness?.accounting || {};
    const reconciliation = readiness && !readiness.error
      ? usdcTools.reconciliationSnapshot(
        accounting,
        readiness.balance,
        readiness.liability,
        Date.parse(readiness.checkedAt),
        RECONCILIATION_MAX_AGE_MS,
      )
      : { ready: false };
    const pendingFinancialAction = state.accountId && pendingActionStore.list(state.accountId).some((action) =>
      ["reconcile_token_balance", "release_payment"].includes(action.methodName));
    return {
      safe: purchase?.state === "FulfillmentApproved"
        && readiness && !readiness.error && readiness.figuresMatch
        && Boolean(readiness.supplierRegistration)
        && !hasBlockingPurchaseOperation(readiness, purchase)
        && reconciliation.ready
        && !pendingFinancialAction,
      reconciliation,
      pendingFinancialAction,
    };
  }

  async function handleReleasePayment(button, purchase) {
    if (!purchase || !isV5(purchase)) return;
    const freshPurchase = await loadPurchase(purchase.id).catch(() => null);
    const readiness = freshPurchase ? await loadFinancialReadiness(freshPurchase).catch(() => null) : null;
    const initialSafety = payoutSafetyState(freshPurchase, readiness);
    if (!initialSafety.safe) {
      showToast("STOP: payout checks are incomplete, stale, or inconsistent. Refresh and reconcile before trying again.", "error");
      renderCurrentPage();
      return;
    }
    const amount = customerPaymentLabel(freshPurchase, freshPurchase.total_funded_amount);
    const reviewed = await reviewTransaction({
      title: `Review supplier payment for Deal #${freshPurchase.id}`,
      summary: `Release ${amount} from V5 escrow to ${freshPurchase.supplier_id}. HarvestPool will repeat every safety read after this review and before opening Meteor.`,
      signer: state.accountId,
      receiver: appConfig.contractId,
      method: "release_payment",
      args: { purchase_id: String(freshPurchase.id) },
      gas: "100 Tgas (100000000000000 gas)",
      deposit: "0 NEAR",
      warning: "This is a real Circle Testnet USDC transfer. Do not approve if any full account ID, argument, amount, or contract differs from what you expect.",
      confirmLabel: "Continue to payment authorization",
    });
    if (!reviewed) return;
    const finalPurchase = await loadPurchase(freshPurchase.id).catch(() => null);
    const finalReadiness = finalPurchase ? await loadFinancialReadiness(finalPurchase).catch(() => null) : null;
    if (!payoutSafetyState(finalPurchase, finalReadiness).safe) {
      showToast("STOP: a fresh pre-payment check changed or expired. Reconcile again; no payout was submitted.", "error");
      renderCurrentPage();
      return;
    }
    return handleSimpleAction(button, "release_payment", { purchase_id: String(freshPurchase.id) }, `${amount} release submitted. Wait for the Circle transfer callback and contract confirmation before any further action.`);
  }

  async function handleContribution(button) {
    const purchaseId = button.dataset.purchaseId;
    const input = $("#contribution-quantity");
    const quantity = Number(input?.value || 0);
    const accepted = $("#agreement-acceptance")?.checked === true;
    if (!accepted) {
      showToast("Accept the purchase terms before contributing.", "error");
      return;
    }
    saveDraft($("#agreement-root"));

    let verified;
    try {
      verified = await verifyContributionEligibility(purchaseId, quantity, accepted);
    } catch (error) {
      const message = String(error?.message || error || "This purchase is not available for contribution.");
      const displayMessage = /group full|no longer open|capacity/i.test(message)
        ? "The latest contract state has no available funded household spot. No contribution was authorized."
        : /does not have enough native Testnet USDC/i.test(message)
          ? "This wallet does not have enough native Testnet USDC for that contribution. No tokens were authorized."
          : /register this wallet/i.test(message)
            ? "This wallet is not registered with the configured USDC contract. Register it before contributing."
            : "We couldn't verify the latest purchase state. Your draft is safe. Please try again.";
      state.contributionStatus = /group full|no longer open|capacity/i.test(message)
        ? { purchaseId, kind: "full", title: "Group Full", message: "The latest contract state has no available funded household spot. No contribution was authorized." }
        : { purchaseId, kind: "failed", title: "Contribution unavailable", message: displayMessage };
      showToast(displayMessage, "error");
      try {
        await loadPurchase(purchaseId);
        refreshAgreementCheckout();
      } catch (_refreshError) {
        refreshAgreementCheckout();
      }
      return;
    }

    const contributionArgs = { purchase_id: String(purchaseId), quantity };
    const contributionOptions = {
      depositValue: verified.depositYocto,
      valueIsYocto: true,
      confirmationAttempts: 30,
      confirmationDelayMs: 1000,
      failureMessage: "We couldn't submit your contribution. Your draft is safe. Please try again.",
    };
    let confirmationMethod = "commit";
    if (isV5(verified.purchase)) {
      confirmationMethod = "commit_usdc";
      contributionOptions.receiverId = String(state.config.token_contract_id);
      contributionOptions.transactionMethodName = "ft_transfer_call";
      contributionOptions.transactionArgs = usdcTools.transferCall({
        receiverId: appConfig.contractId,
        purchaseId,
        quantity,
        amount: verified.depositYocto,
      });
      contributionOptions.depositValue = "1";
    }
    contributionOptions.onPhase = (kind, title, message) => {
      const exactPayment = isV5(verified.purchase)
        ? `Payment uses ${testPaymentLabel(verified.purchase, verified.depositYocto)} through your wallet. No USD card charge.`
        : `Payment uses ${paymentLabel(verified.purchase, verified.depositYocto)} through your wallet.`;
      state.contributionStatus = {
        purchaseId,
        kind,
        title: kind === "wallet" ? "Authorize your payment" : title,
        message: kind === "wallet" ? exactPayment : message,
      };
      refreshAgreementCheckout();
    };
    const confirmation = await performVerifiedAction(button, confirmationMethod, contributionArgs, "You’re in! Your spot is secured.", contributionOptions);
    if (!confirmation || confirmation.state !== "confirmed") return;
    try {
      await loadBaseData();
      await loadPurchase(purchaseId);
      const confirmedPurchase = state.currentPurchase;
      const confirmedCommitment = commitmentFor(confirmedPurchase);
      const confirmed = Boolean(
        confirmedCommitment
        && confirmedCommitment.state === "Active"
        && isFundedMember(confirmedPurchase),
      );
      if (confirmed) {
        clearDraft($("#agreement-root"));
        state.contributionStatus = {
          purchaseId,
          kind: "confirmed",
          title: "You’re in!",
          message: "Your spot is secured and this deal is now in My Group Buys.",
        };
        showToast("You’re in! Your spot is secured.", "success");
      } else {
        state.contributionStatus = {
          purchaseId,
          kind: "awaiting",
          title: "Checking contract state",
          message: "The wallet returned, but membership is not confirmed yet. Refresh again before treating this contribution as complete.",
        };
        showToast("The contribution is not confirmed yet; no funded membership is shown.", "error");
      }
      refreshAgreementCheckout();
    } catch (_error) {
      if (!state.contributionStatus || String(state.contributionStatus.purchaseId) !== String(purchaseId)) {
        state.contributionStatus = {
          purchaseId,
          kind: "awaiting",
          title: "Confirmation still pending",
          message: "The contract state could not be reread yet. Refresh before treating this contribution as complete.",
        };
      }
      refreshAgreementCheckout();
      showToast("The contribution was submitted, but membership still needs contract confirmation.", "error");
    }
  }

  async function handleEvidence(form) {
    const button = $("button[type=submit]", form);
    const evidence = String(new FormData(form).get("evidence") || "").trim();
    if (!evidence) return;
    const current = state.purchases.find((item) => String(item.id) === String(form.dataset.purchaseId));
    const identifiesSimulation = /simulation|simulated/i.test(evidence);
    const deniesPhysicalDelivery = /no[_ -]?physical[_ -]?delivery/i.test(evidence);
    if (isV5(current) && (!identifiesSimulation || !deniesPhysicalDelivery)) {
      showFormTransactionError(form, "Use a truthful Testnet reference that explicitly identifies this as a simulation with no physical delivery.");
      return;
    }
    if (isV5(current)) {
      const reviewed = await reviewTransaction({
        title: `Submit Testnet evidence for Deal #${form.dataset.purchaseId}`,
        summary: evidence,
        signer: state.accountId,
        receiver: appConfig.contractId,
        method: "submit_fulfillment_evidence",
        args: { purchase_id: String(form.dataset.purchaseId), evidence_hash: evidence },
        gas: "30 Tgas (30000000000000 gas)",
        deposit: "0 NEAR",
        warning: "This records a simulation reference. It does not prove or claim physical delivery.",
        confirmLabel: "Submit evidence",
      });
      if (!reviewed) return;
    }
    saveDraft(form);
    const confirmation = await performVerifiedAction(button, "submit_fulfillment_evidence", { purchase_id: String(form.dataset.purchaseId), evidence_hash: evidence }, isV5(current) ? "Simulated Testnet evidence recorded on-chain; no physical delivery is represented." : "Fulfillment evidence submitted on-chain.", {
      failureMessage: "We couldn't submit the fulfillment evidence. Your draft is safe. Please try again.",
    });
    if (!confirmation || confirmation.state !== "confirmed") return;
    try {
      await loadBaseData();
      const purchase = state.purchases.find((item) => String(item.id) === String(form.dataset.purchaseId));
      if (purchase?.fulfillment_evidence_hash !== evidence) {
        showFormTransactionError(form, "The wallet returned, but fulfillment evidence is not confirmed yet. Your draft is safe. Refresh before trying again.");
        return;
      }
      clearDraft(form);
      renderFarmer();
      renderFarmerPaymentTotals();
      decorateMoneyText();
    } catch (error) {
      showFormTransactionError(form, "The wallet returned, but fulfillment evidence could not be verified yet. Your draft is safe. Refresh before trying again.", error);
    }
  }

  function setIssueError(message, error = null) {
    const summary = $("#issue-form-error");
    setErrorSummary(summary, message, error);
  }

  function completeIssueConfirmation(form, issue, requesterId) {
    pendingActionStore.list(requesterId).filter((action) => action.methodName === "raise_issue" && issueMatches(issue, {
      purchaseId: action.args?.purchase_id,
      requesterId,
      subject: action.args?.subject,
      description: action.args?.description,
      suggestedSolution: action.args?.suggested_solution,
    })).forEach((action) => pendingActionStore.remove(action.id));
    renderPendingConfirmationNotice();
    clearDraftForContext(form, {
      walletId: requesterId,
      purchaseId: issue.purchase_id,
      issueId: "global",
    });
    clearV3ConfirmationUncertainty(form);
    state.confirmedIssueId = String(issue.id);
    showToast("Your issue has been submitted.", "success");
    renderCurrentPage();
  }

  function completeDecisionConfirmation(form, decision, requesterId) {
    pendingActionStore.list(requesterId).filter((action) => action.methodName === "request_group_vote" && decisionMatches(decision, {
      issueId: action.args?.issue_id,
      proposal: action.args?.proposal,
      options: action.args?.options,
      voteType: action.args?.vote_type,
    })).forEach((action) => pendingActionStore.remove(action.id));
    renderPendingConfirmationNotice();
    clearDraftForContext(form, {
      walletId: requesterId,
      purchaseId: form.dataset.draftPurchaseId || "global",
      issueId: form.dataset.issueId || "global",
    });
    clearV3ConfirmationUncertainty(form);
    showToast("Group vote confirmed. The eligible voter list is now fixed.", "success");
    renderCurrentPage();
  }

  async function handleCheckV3Confirmation(button) {
    const form = button.closest("form");
    const kind = button.dataset.confirmationKind;
    if (!form || !["issue", "decision"].includes(kind)) return;
    setBusy(button, true, "Checking state…");
    try {
      const requesterId = form.dataset.v3ConfirmationRequester || state.accountId || "";
      if (kind === "issue") {
        const values = new FormData(form);
        const issue = await waitForV3RecordWithLock(button, (issues) => issues.find((item) => issueMatches(item, {
          purchaseId: String(values.get("purchase_id") || ""),
          requesterId,
          subject: String(values.get("subject") || "").trim(),
          description: String(values.get("description") || "").trim(),
          suggestedSolution: String(values.get("suggested_solution") || "").trim(),
        })));
        if (issue) {
          completeIssueConfirmation(form, issue, requesterId);
          return;
        }
      } else {
        const values = new FormData(form);
        const { voteType, options } = votingTools.normalizeRequest(values.get("vote_type"),
          ["option_a", "option_b", "option_c", "option_d"].map((name) => values.get(name)));
        const decision = await waitForV3RecordWithLock(button, (_issues, decisions) => decisions.find((item) => decisionMatches(item, {
          issueId: form.dataset.issueId,
          proposal: String(values.get("proposal") || "").trim(),
          options,
          voteType,
        })));
        if (decision) {
          completeDecisionConfirmation(form, decision, requesterId);
          return;
        }
      }
      const message = kind === "issue"
        ? "The issue is still not visible in the contract. No retry was submitted; your draft remains safe."
        : "The group vote is still not visible in the contract. No retry was submitted; your draft remains safe.";
      showFormTransactionError(form, message);
      appendV3CheckAction(form, kind);
    } finally {
      setBusy(button, false);
    }
  }

  async function handleRaiseIssue(form) {
    setIssueError("");
    if (!ensureSignedIn()) return;
    if (!state.v3Available) {
      setIssueError("Member issues are not available for this community yet.");
      return;
    }
    const values = new FormData(form);
    const purchaseId = String(values.get("purchase_id") || "");
    const purchase = state.purchases.find((item) => String(item.id) === purchaseId);
    if (!purchase || !isFundedMember(purchase)) {
      setIssueError("Only a confirmed funded member can raise an issue for this purchase.");
      return;
    }
    const subject = String(values.get("subject") || "").trim();
    const description = String(values.get("description") || "").trim();
    const suggested = String(values.get("suggested_solution") || "").trim();
    if (!subject || !description) {
      setIssueError("Add a short subject and describe the concern.");
      return;
    }
    const requesterId = String(state.accountId);
    const liveV3 = await loadV3Data();
    if (!liveV3) {
      setIssueError("We couldn't verify the latest issue state. Your draft is safe. Please try again.");
      return;
    }
    const alreadyRecorded = state.issues.find((issue) => issueMatches(issue, {
      purchaseId,
      requesterId,
      subject,
      description,
      suggestedSolution: suggested,
    }));
    if (alreadyRecorded) {
      completeIssueConfirmation(form, alreadyRecorded, requesterId);
      return;
    }
    form.dataset.draftPurchaseId = purchaseId;
    form.dataset.v3ConfirmationRequester = requesterId;
    saveDraft(form);
    const button = $("button[type=submit]", form);
    const issueArgs = {
      purchase_id: purchaseId,
      subject,
      description,
      suggested_solution: suggested || null,
    };
    const confirmation = await performVerifiedAction(button, "raise_issue", issueArgs, "Your issue has been submitted.", {
      receiverId: appConfig.v3ContractId,
      failureMessage: "We couldn't submit your issue. Your draft is safe. Please try again.",
      onError: (message, error) => setIssueError(message, error),
    });
    if (confirmation?.state === "confirmed") completeIssueConfirmation(form, confirmation.record, requesterId);
    else if (pendingActionStore.list(requesterId).some((item) => item.id === confirmationTools.actionId(pendingAction("raise_issue", issueArgs, appConfig.v3ContractId)))) markV3ConfirmationUncertain(form, button, "issue");
  }

  async function handleRequestDecision(form) {
    if (!ensureSignedIn() || !state.v3Available) return;
    const values = new FormData(form);
    const issueId = String(form.dataset.issueId || "");
    const proposal = String(values.get("proposal") || "").trim();
    let voteType;
    let options;
    try {
      ({ voteType, options } = votingTools.normalizeRequest(values.get("vote_type"),
        ["option_a", "option_b", "option_c", "option_d"].map((name) => values.get(name))));
    } catch (error) {
      showToast(error.message || "Add two to four different pickup choices.", "error");
      return;
    }
    if (!proposal) {
      showToast("Describe the pickup proposal members should decide.", "error");
      return;
    }
    let deadlineNs;
    try {
      deadlineNs = toNanoseconds(String(values.get("deadline") || ""));
      const remaining = BigInt(deadlineNs) - BigInt(Date.now()) * 1000000n;
      if (remaining <= 0n || remaining > 30n * 86400n * 1000000000n) throw new Error("Choose a voting deadline within the next 30 days.");
    } catch (error) {
      showToast(error.message || "Choose a valid voting deadline.", "error");
      return;
    }
    const requesterId = String(state.accountId);
    const liveV3 = await loadV3Data();
    const liveIssue = liveV3 ? state.issues.find((item) => String(item.id) === issueId) : null;
    if (!liveIssue) {
      showFormTransactionError(form, "The referenced issue is not confirmed on-chain. Your draft is safe; no vote request was submitted.");
      return;
    }
    const existingDecision = liveIssue.active_decision_id === null || liveIssue.active_decision_id === undefined
      ? null
      : state.decisions.find((item) => String(item.id) === String(liveIssue.active_decision_id));
    if (existingDecision && decisionMatches(existingDecision, { issueId, proposal, options, voteType })) {
      completeDecisionConfirmation(form, existingDecision, requesterId);
      return;
    }
    if (liveIssue.state !== "Open" || liveIssue.active_decision_id !== null && liveIssue.active_decision_id !== undefined) {
      showFormTransactionError(form, "This issue already has a contract state change. Your draft is safe; no duplicate vote request was submitted.");
      return;
    }
    form.dataset.draftPurchaseId = form.dataset.draftPurchaseId || "global";
    form.dataset.v3ConfirmationRequester = requesterId;
    saveDraft(form);
    const button = $("button[type=submit]", form);
    const decisionArgs = {
      issue_id: issueId,
      decision_type: "pickup_arrangement",
      vote_type: voteType,
      proposal,
      options,
      deadline_ns: deadlineNs,
    };
    const confirmation = await performVerifiedAction(button, "request_group_vote", decisionArgs, "Group vote requested. The eligible voter list is now fixed.", {
      receiverId: appConfig.v3ContractId,
      failureMessage: "We couldn't request the group vote. Your draft is safe. Please try again.",
      onError: (message, error) => showFormTransactionError(form, message, error),
    });
    if (confirmation?.state === "confirmed") completeDecisionConfirmation(form, confirmation.record, requesterId);
    else if (pendingActionStore.list(requesterId).some((item) => item.id === confirmationTools.actionId(pendingAction("request_group_vote", decisionArgs, appConfig.v3ContractId)))) markV3ConfirmationUncertain(form, button, "decision");
  }

  async function performVerifiedAction(button, methodName, args, successMessage, options = {}) {
    if (button?.dataset.submissionLock === "true") return null;
    if (button) {
      button.dataset.submissionLock = "true";
      setBusy(button, true, "Preparing wallet request…");
    }
    const receiverId = options.receiverId || appConfig.contractId;
    const reference = draftReference(button);
    const action = pendingAction(methodName, args, receiverId, {
      ...(options.context || {}),
      ...(reference ? { draft: reference } : {}),
    });
    const actionKey = confirmationTools.actionId(action);
    const existingPending = pendingActionStore.list(action.signerId).find((item) => item.id === actionKey);
    if (existingPending) {
      renderPendingConfirmationNotice();
      if (methodName === "community_contribute_usdc") {
        renderCurrentPage();
        scheduleCommunityReconciliation();
      } else {
        showToast(`${actionProgressCopy(methodName)} We’ll update this page automatically.`);
      }
      return null;
    }

    const existing = await readActionConfirmation(action).catch(() => ({ state: "uncertain" }));
    if (!["create_purchase", "create_open_purchase", "create_supplier_offer", "create_purchase_request"].includes(methodName) && existing.state === "confirmed") {
      if (["vote_on_offer", "vote_on_fulfillment"].includes(methodName)) {
        recordVote(args.purchase_id, methodName === "vote_on_offer" ? "offer" : "fulfillment", Boolean(args.approve));
      }
      if (methodName === "community_contribute_usdc") {
        if (appConfig.page === "community_fund") await loadCommunityFundData({ refreshActivity: false });
      } else {
        const [refreshResult] = await Promise.allSettled([refreshAffectedAction(action)]);
        if (refreshResult.status === "rejected") state.liveDataError = refreshResult.reason;
      }
      renderCurrentPage();
      showToast(options.alreadyMessage || "This action is already confirmed on-chain.", "success");
      return existing;
    }

    const saved = pendingActionStore.save({
      ...action,
      phase: "wallet",
      startedAtNs: (BigInt(Date.now()) * 1_000_000n).toString(),
    });
    renderPendingConfirmationNotice();
    let transactionError = null;
    const captureLateWalletResult = (lateResult) => {
      if (lateResult?.state !== "returned") return null;
      const updated = confirmationTools.persistTransactionHash(pendingActionStore, saved, lateResult.value);
      if (!updated) return null;
      renderPendingConfirmationNotice();
      if (methodName !== "community_contribute_usdc") {
        showToast("Meteor returned the transaction. Checking finalized on-chain state.");
      }
      window.setTimeout(() => reconcilePendingActions({ poll: true }).catch(() => null), 0);
      return updated;
    };
    const outcome = await performTransaction(
      button,
      actionProgressCopy(methodName),
      () => sendChangeTo(
        receiverId,
        options.transactionMethodName || methodName,
        options.transactionArgs || args,
        options.depositValue || "0",
        options.valueIsYocto || false,
      ),
      successMessage,
      {
        confirmOnReturn: false,
        suppressToast: methodName === "community_contribute_usdc",
        onLateResult: captureLateWalletResult,
        failureMessage: options.failureMessage || "We couldn't complete this action. Your selection is safe. Please check its status before trying again.",
        onPhase: options.onPhase,
        onError: (message, error) => {
          transactionError = error;
          if (methodName === "community_contribute_usdc") {
            console.warn("Community contribution wallet request did not complete.", {
              kind: transactionErrorKind(error),
              timedOut: error?.walletResponseTimedOut === true,
              message: String(error?.message || error || "Unknown wallet error"),
            });
          }
          options.onError?.(message, error);
        },
      },
    );
    if (!outcome && transactionError?.transactionState !== "pending") {
      if (methodName === "community_contribute_usdc") {
        savePersonalContributionOutcome(saved, {
          state: transactionErrorKind(transactionError) === "wallet-rejected"
            ? "wallet-rejected"
            : "wallet-failed",
        });
      }
      pendingActionStore.remove(saved.id);
      if (button) {
        delete button.dataset.submissionLock;
        setBusy(button, false);
      }
      renderPendingConfirmationNotice();
      return null;
    }

    state.pendingTransactions.add(button);
    setBusy(button, true, actionProgressCopy(methodName));
    const transactionHash = confirmationTools.transactionHash(outcome);
    const latestSaved = pendingActionStore.list(saved.signerId).find((item) => item.id === saved.id) || saved;
    const walletUnresponsive = !outcome && transactionError?.walletResponseTimedOut === true;
    const submittedAction = pendingActionStore.save({
      ...latestSaved,
      phase: walletUnresponsive ? "wallet-unresponsive" : "confirming",
      transactionHash: transactionHash || latestSaved.transactionHash || null,
    });
    if (methodName === "community_contribute_usdc") {
      // Paint the personal outcome immediately, including hashless Meteor returns,
      // while strict discovery/finalized receipt verification continues below.
      renderCurrentPage();
    }
    const result = await waitForActionConfirmation(submittedAction, {
      attempts: options.confirmationAttempts,
      delayMs: options.confirmationDelayMs,
    });
    setBusy(button, false);
    state.pendingTransactions.delete(button);
    if (result?.state === "confirmed") {
      if (["vote_on_offer", "vote_on_fulfillment"].includes(methodName)) {
        recordVote(args.purchase_id, methodName === "vote_on_offer" ? "offer" : "fulfillment", Boolean(args.approve));
        const voteActions = button?.closest(".vote-actions");
        if (voteActions) $$('button[data-action="vote"]', voteActions).forEach((voteButton) => {
          voteButton.disabled = true;
          voteButton.setAttribute("aria-disabled", "true");
          voteButton.textContent = voteButton === button && args.approve ? "Approved" : "Recorded";
        });
      }
      savePersonalContributionOutcome(submittedAction, result);
      pendingActionStore.remove(submittedAction.id);
      if (methodName === "community_contribute_usdc") {
        renderCurrentPage();
        loadCommunityFundData({ refreshActivity: false })
          .then(() => renderCurrentPage())
          .catch(() => null);
      } else {
        const [refreshResult] = await Promise.allSettled([refreshAffectedAction(submittedAction)]);
        if (refreshResult.status === "rejected") state.liveDataError = refreshResult.reason;
      }
      renderCurrentPage();
      renderPendingConfirmationNotice();
      if (methodName !== "community_contribute_usdc") showToast(successMessage, "success");
      return result;
    }
    if (result?.state === "failed") {
      savePersonalContributionOutcome(submittedAction, result);
      pendingActionStore.remove(submittedAction.id);
      if (button) delete button.dataset.submissionLock;
      renderPendingConfirmationNotice();
      if (methodName === "community_contribute_usdc") renderCurrentPage();
      else showToast("The contract rejected this action. No retry was submitted.", "error");
      return result;
    }
    const stillPending = pendingActionStore.list(submittedAction.signerId).find((item) => item.id === submittedAction.id);
    if (stillPending) {
      pendingActionStore.save({
        ...stillPending,
        phase: stillPending.transactionHash
          ? "confirming"
          : stillPending.phase === "wallet-unresponsive"
            ? "wallet-unresponsive"
            : "unresolved",
      });
    }
    renderPendingConfirmationNotice();
    if (methodName === "community_contribute_usdc") renderCurrentPage();
    if (button) setBusy(button, true, actionProgressCopy(methodName));
    if (methodName === "community_contribute_usdc") scheduleCommunityReconciliation();
    else showToast(`${actionProgressCopy(methodName)} We’ll update this page automatically.`);
    return null;
  }

  async function handleV3Action(button, methodName, args, successMessage) {
    return performVerifiedAction(button, methodName, args, successMessage, {
      receiverId: appConfig.v3ContractId,
      failureMessage: methodName === "vote_on_decision"
        ? "We couldn't record your choice. It is safe; check the decision before trying again."
        : "We couldn't complete this group action. Check its status before trying again.",
    });
  }

  async function handleSimpleAction(button, methodName, args, successMessage) {
    return performVerifiedAction(button, methodName, args, successMessage);
  }

  async function handleSupplierRequestAction(button, purchase, decision) {
    if (!purchase || !["accept", "decline"].includes(decision)) return null;
    const accepting = decision === "accept";
    const methodName = accepting ? "accept_supplier_request" : "decline_supplier_request";
    const reviewed = await reviewTransaction({
      title: accepting ? `Accept and publish Deal #${purchase.id}?` : `Decline Deal #${purchase.id}?`,
      summary: accepting
        ? `This accepts the organizer's exact terms and opens ${livePurchaseTitle(purchase)} for buyer contributions.`
        : `This closes the proposal without publishing it. The organizer would need to create a new proposal to change the terms.`,
      signer: state.accountId,
      receiver: appConfig.contractId,
      method: methodName,
      args: { purchase_id: String(purchase.id) },
      gas: "30 Tgas (30000000000000 gas)",
      deposit: "0 NEAR",
      warning: accepting
        ? "The accepted Deal Terms are immutable. Review the price, quantity, deadlines, fulfillment, and refund terms first."
        : "Declining cannot be undone on this proposal. No buyer funds are involved because contributions never opened.",
      confirmLabel: accepting ? "Accept & publish" : "Decline proposal",
    });
    if (!reviewed) return null;
    return performVerifiedAction(
      button,
      methodName,
      { purchase_id: String(purchase.id) },
      accepting ? "Supplier accepted the proposal. The Group Deal is now published." : "Supplier declined the proposal. It was not published.",
    );
  }

  async function handleSupplierDecisionAction(button, decision, response) {
    if (!decision || !["accept", "decline"].includes(response)) return null;
    const accepting = response === "accept";
    const methodName = accepting ? "agree_to_decision" : "decline_decision";
    const reviewed = await reviewTransaction({
      title: accepting ? "Accept this pickup change?" : "Decline this pickup change?",
      summary: accepting
        ? "This records supplier consent to the group-approved pickup arrangement."
        : "This rejects the proposed pickup change. The original Deal Terms remain unchanged.",
      signer: state.accountId,
      receiver: appConfig.v3ContractId,
      method: methodName,
      args: { decision_id: String(decision.id) },
      gas: "110 Tgas (110000000000000 gas)",
      deposit: "0 NEAR",
      warning: accepting ? "This consent is recorded publicly on-chain." : "Declining is final for this proposal and reopens the underlying issue.",
      confirmLabel: accepting ? "Accept change" : "Decline change",
    });
    if (!reviewed) return null;
    return handleV3Action(
      button,
      methodName,
      { decision_id: String(decision.id) },
      accepting ? "Supplier consent recorded on-chain." : "The proposal was declined and the issue is open again.",
    );
  }

  function localDateValue(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  const BUSINESS_TIMEZONE_KEY = "harvestpool:business-timezone:v1";

  function businessTimeZone() {
    const selected = $("#business-timezone")?.value;
    const saved = window.localStorage.getItem(BUSINESS_TIMEZONE_KEY);
    const candidate = selected || saved || dealTimeTools.DEFAULT_BUSINESS_TIME_ZONE;
    try {
      return dealTimeTools.assertTimeZone(candidate);
    } catch (_error) {
      return dealTimeTools.DEFAULT_BUSINESS_TIME_ZONE;
    }
  }

  function setBusinessTimeZone(timeZone) {
    const valid = dealTimeTools.assertTimeZone(timeZone);
    window.localStorage.setItem(BUSINESS_TIMEZONE_KEY, valid);
    return valid;
  }

  function updateTimezoneOptionLabels() {
    $$("#business-timezone option").forEach((option) => {
      option.textContent = dealTimeTools.zoneOptionLabel(option.dataset.zoneLabel || option.textContent, option.value);
    });
  }

  function updateDeadlinePreview(inputId, previewId) {
    const input = $(inputId);
    const preview = $(previewId);
    if (!input || !preview) return;
    if (!input.value) {
      preview.textContent = "Choose a date and time.";
      preview.classList.remove("is-error");
      return;
    }
    try {
      const instant = dealTimeTools.instantFromWallTime(input.value, businessTimeZone());
      const nanoseconds = (BigInt(instant.getTime()) * 1000000n).toString();
      preview.textContent = `${dealTimeTools.formatInstant(instant, businessTimeZone(), dealTimeTools.browserTimeZone())} · ${dealTimeTools.deadlineSummary(nanoseconds)}`;
      preview.classList.remove("is-error");
    } catch (error) {
      preview.textContent = error.message || "Choose a valid date and time.";
      preview.classList.add("is-error");
    }
  }

  function updateFulfillmentWindow() {
    const joinInput = $("#purchase-deadline");
    const fulfillmentInput = $("#fulfillment-deadline");
    const summary = $("#fulfillment-window-summary");
    const warning = $("#fulfillment-window-warning");
    if (!joinInput || !fulfillmentInput || !summary || !warning) return;
    try {
      const join = dealTimeTools.instantFromWallTime(joinInput.value, businessTimeZone());
      const fulfillment = dealTimeTools.instantFromWallTime(fulfillmentInput.value, businessTimeZone());
      const windowState = dealTimeTools.fulfillmentWindow(join, fulfillment);
      summary.textContent = windowState.summary;
      summary.classList.toggle("is-error", !windowState.valid);
      warning.hidden = !windowState.valid || !windowState.short;
    } catch (_error) {
      summary.textContent = "Choose both deadlines to review the supplier’s preparation time.";
      summary.classList.remove("is-error");
      warning.hidden = true;
    }
  }

  function updateTimezoneControls() {
    const select = $("#business-timezone");
    if (!select) return;
    updateTimezoneOptionLabels();
    const saved = window.localStorage.getItem(BUSINESS_TIMEZONE_KEY);
    if (saved && [...select.options].some((option) => option.value === saved) && !select.closest("form")?.dataset.draftRestored) {
      select.value = saved;
    }
    updateDeadlinePreview("#purchase-deadline", "#purchase-deadline-preview");
    updateDeadlinePreview("#fulfillment-deadline", "#fulfillment-deadline-preview");
    updateFulfillmentWindow();
  }

  function updateSaleUnitFields() {
    const select = $("#sale-unit");
    const customField = $("#custom-unit-field");
    const customInput = $("#custom-unit");
    const contentsField = $("#package-contents-field");
    const contentsInput = $("#package-contents");
    if (!select) return;
    const custom = select.value === "custom";
    if (customField) customField.hidden = !custom;
    if (customInput) customInput.required = custom;
    const labels = dealFormTools.labels(select.value, customInput?.value);
    $$('[data-unit-label]').forEach((label) => {
      const key = label.dataset.unitLabel;
      if (labels[key]) label.textContent = labels[key];
    });
    const packageUnit = dealFormTools.supportsPackageContents(select.value);
    if (contentsField) contentsField.hidden = !packageUnit;
    if (contentsInput) contentsInput.disabled = !packageUnit;
    if (contentsInput) contentsInput.placeholder = "";
    updateCreatePricePreview();
  }

  function updateSupplierSelection() {
    const select = $("#farmer-account");
    const summary = $("#supplier-selection-summary");
    if (!select || !summary) return;
    const supplier = state.suppliers.find((item) => String(item.account_id) === String(select.value));
    summary.innerHTML = supplier
      ? `<strong>${escapeHtml(supplier.business_name)}</strong><span>${escapeHtml(supplier.location)} · ${escapeHtml(supplier.account_id)}</span>`
      : "";
  }

  function updateCreationModeCopy() {
    const selected = $('input[name="creation_mode"]:checked');
    const help = $("#creation-mode-help");
    const button = $("#create-purchase-button");
    if (!selected || !button) return;
    const selectedMode = dealCreationTools.mode(selected.value);
    if (help) help.textContent = selectedMode.help;
    const review = $("#creation-review-copy");
    if (review) review.lastChild.textContent = selectedMode.review;
    button.innerHTML = `${selectedMode.cta} <span aria-hidden="true">↗</span>`;
  }

  function setCreateDefaults() {
    const form = $("#create-purchase-form");
    if (!form) return;
    form.reset();
    $$("input, textarea, select", form).forEach((field) => {
      if (field.name === "creation_mode") field.checked = field.value === "organizer_request";
      else if (field.name === "fulfillment_method") field.value = "Pickup";
      else if (field.name === "business_timezone") field.value = dealTimeTools.DEFAULT_BUSINESS_TIME_ZONE;
      else if (field.type === "checkbox" || field.type === "radio") field.checked = false;
      else field.value = "";
    });
    delete form.dataset.draftRestored;
    $(".draft-restored-note", form)?.remove();
    $(".draft-restoration", form)?.remove();
    clearCreateValidationState(form);
    updateTimezoneControls();
  }

  function clearSubmittedCreateReturn() {
    if (appConfig.page !== "create") return;
    let submitted = false;
    try {
      submitted = window.sessionStorage.getItem(CREATE_SUBMITTED_KEY) === "true";
      if (submitted) window.sessionStorage.removeItem(CREATE_SUBMITTED_KEY);
    } catch (_error) {
      return;
    }
    if (!submitted) return;
    const form = $("#create-purchase-form");
    if (!form) return;
    clearDraft(form);
    setCreateDefaults();
    setCreateError("");
  }

  function toNanoseconds(value, timeZone = dealTimeTools.browserTimeZone()) {
    return dealTimeTools.toNanoseconds(value, timeZone);
  }

  function setCreateError(message, error = null) {
    const summary = $("#create-form-error");
    setErrorSummary(summary, message, error);
  }

  function createField(form, name) {
    return form?.elements?.namedItem(name) || form?.querySelector("[name=\"" + name + "\"]");
  }

  function clearFieldError(field) {
    if (!field) return;
    const container = field.closest(".field, .choice-fieldset") || field.parentElement;
    container?.classList.remove("field-invalid");
    field.removeAttribute("aria-invalid");
    const errorId = field.dataset.errorId;
    if (errorId) document.getElementById(errorId)?.remove();
    delete field.dataset.errorId;
    const describedBy = String(field.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    if (errorId) field.setAttribute("aria-describedby", describedBy.filter((id) => id !== errorId).join(" "));
    if (!field.getAttribute("aria-describedby")) field.removeAttribute("aria-describedby");
  }

  function clearCreateValidationState(form) {
    if (!form) return;
    $$("[data-error-id]", form).forEach(clearFieldError);
    $$(".field-invalid", form).forEach((field) => field.classList.remove("field-invalid"));
    const summary = $(".form-error-summary", form);
    if (summary) {
      summary.replaceChildren();
      summary.hidden = true;
    }
    delete form.dataset.validationActive;
  }

  function setFieldError(field, message) {
    if (!field) return;
    const container = field.closest(".field, .choice-fieldset") || field.parentElement;
    clearFieldError(field);
    const errorId = String(field.id || field.name) + "-error";
    const error = document.createElement("span");
    error.id = errorId;
    error.className = "field-error";
    error.textContent = message;
    error.setAttribute("role", "alert");
    container?.classList.add("field-invalid");
    container?.appendChild(error);
    field.dataset.errorId = errorId;
    field.setAttribute("aria-invalid", "true");
    const describedBy = String(field.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    field.setAttribute("aria-describedby", [...describedBy, errorId].join(" "));
  }

  function showCreateValidationErrors(form, errors) {
    clearCreateValidationState(form);
    const linkedErrors = errors.map((error) => {
      const field = createField(form, error.name);
      setFieldError(field, error.message);
      return { ...error, id: field?.id || error.id || error.name };
    });
    const summary = $(".form-error-summary", form);
    if (!summary) return;
    summary.innerHTML = "<strong>Check " + (linkedErrors.length === 1 ? "this field" : "these fields") + " before continuing.</strong><ul>" + linkedErrors.map((error) => "<li><a href=\"#" + escapeHtml(error.id) + "\">" + escapeHtml(error.message) + "</a></li>").join("") + "</ul>";
    summary.hidden = false;
    form.dataset.validationActive = "true";
    summary.focus();
  }

  function focusCreateErrorLink(link) {
    if (!link?.matches("#create-form-error a[href^='#']")) return false;
    const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
    if (!target) return false;
    const fieldContainer = target.closest(".field, .choice-fieldset") || target;
    fieldContainer.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    target.focus({ preventScroll: true });
    return true;
  }

  function validateCreateForm(form, version) {
    const values = new FormData(form);
    const errors = [];
    const required = [
      ["product_name", "Enter a product name."],
      ["description", "Describe what buyers receive."],
      ["farmer_id", "Choose a verified supplier."],
      ["sale_unit", "Choose how the product is sold."],
      ["listed_price_usd", "Enter the listed price."],
      ["min_quantity", "Enter the minimum quantity."],
      ["max_quantity", "Enter the total quantity available."],
      ["max_quantity_per_household", "Enter the buyer limit."],
      ["max_funded_members", "Enter the maximum number of buyers."],
      ["deadline", "Choose the last day to join."],
      ["fulfillment_deadline", "Choose the fulfillment deadline."],
      ["handoff_time", "Choose a pickup date and time."],
      ["fulfillment_location", "Enter a pickup location."],
      ["cancellation_and_refund_terms", "Explain the cancellation and refund policy."],
    ];
    required.forEach(([name, message]) => {
      if (!String(values.get(name) || "").trim()) errors.push({ name, message });
    });
    const minQuantity = Number(values.get("min_quantity"));
    const maxQuantity = Number(values.get("max_quantity"));
    const maxFundedMembers = Number(values.get("max_funded_members"));
    const perBuyer = Number(values.get("max_quantity_per_household"));
    if (String(values.get("min_quantity") || "").trim() && (!Number.isInteger(minQuantity) || minQuantity < 1)) {
      errors.push({ name: "min_quantity", message: "Use a whole-number minimum of at least 1." });
    }
    if (String(values.get("max_quantity") || "").trim() && (!Number.isInteger(maxQuantity) || maxQuantity < 1 || maxQuantity < minQuantity)) {
      errors.push({ name: "max_quantity", message: "Use a whole number at least as large as the minimum." });
    }
    const maxAllowedFundedMembers = Number(state.config?.max_funded_members || 20);
    if (String(values.get("max_funded_members") || "").trim() && (!Number.isInteger(maxFundedMembers) || maxFundedMembers < 1 || maxFundedMembers > maxAllowedFundedMembers)) {
      errors.push({ name: "max_funded_members", message: "Use a whole number from 1 to " + maxAllowedFundedMembers + "." });
    }
    if (String(values.get("max_quantity_per_household") || "").trim() && (!Number.isInteger(perBuyer) || perBuyer < 1 || perBuyer > maxQuantity)) {
      errors.push({ name: "max_quantity_per_household", message: "The buyer limit must be between 1 and the total quantity." });
    }
    if ([minQuantity, maxFundedMembers, perBuyer].every(Number.isInteger) && maxFundedMembers * perBuyer < minQuantity) {
      errors.push({ name: "max_funded_members", message: "These limits cannot reach the minimum of " + minQuantity + ". Increase buyers or the per-buyer limit." });
    }
    const listedPrice = Number(values.get("listed_price_usd"));
    if (String(values.get("listed_price_usd") || "").trim() && (!Number.isFinite(listedPrice) || listedPrice <= 0)) {
      errors.push({ name: "listed_price_usd", message: "Enter a price greater than $0.00." });
    }
    if (version !== "V5" && String(values.get("price_per_unit") || "").trim() && Number(values.get("price_per_unit")) <= 0) {
      errors.push({ name: "price_per_unit", message: "Enter a Testnet contribution greater than zero." });
    }
    try {
      const zone = String(values.get("business_timezone") || businessTimeZone());
      const deadline = toNanoseconds(String(values.get("deadline") || ""), zone);
      const fulfillment = toNanoseconds(String(values.get("fulfillment_deadline") || ""), zone);
      dealCreationTools.validateDeadlines(deadline, fulfillment);
    } catch (error) {
      if (String(values.get("deadline") || "").trim() && String(values.get("fulfillment_deadline") || "").trim()) {
        errors.push({ name: "fulfillment_deadline", message: error.message || "Choose a valid fulfillment deadline after the join deadline." });
      }
    }
    return { errors, values };
  }

  async function handleCreate(form) {
    setCreateError("");
    const version = String(state.config?.version || appConfig.contractVersion || "").toUpperCase();
    const isV4 = ["V4", "V5"].includes(version);
    if (!isV4) {
      setCreateError("New purchases are paused while this app remains connected to the preserved V2 contract. The corrected supplier-authorized flow requires a separately deployed V4 contract; no transaction was attempted.");
      return;
    }
    const validation = validateCreateForm(form, version);
    if (validation.errors.length) {
      showCreateValidationErrors(form, validation.errors);
      return;
    }
    if (!state.wallet || !state.accountId) {
      saveDraft(form);
      const selectedMode = $('input[name="creation_mode"]:checked', form)?.value || "organizer_request";
      dealCreationTools.markConnectionIntent(window.sessionStorage, selectedMode);
      setCreateError("Connect Meteor Wallet first. Connecting does not publish or send this deal; your draft will be restored so you can review it and choose the action again.");
      const connected = await connectWallet();
      if (connected) showCreateConnectionFollowup();
      return;
    }
    const values = validation.values;
    const minQuantity = Number(values.get("min_quantity"));
    const maxQuantity = Number(values.get("max_quantity"));
    const maxFundedMembers = Number(values.get("max_funded_members"));
    const perBuyer = Number(values.get("max_quantity_per_household"));
    const price = String(values.get("price_per_unit") || "");
    const listedPrice = String(values.get("listed_price_usd") || "");
    const deadline = String(values.get("deadline") || "");
    const cancellationDeadline = String(values.get("cancellation_deadline") || deadline);
    const fulfillmentDeadline = String(values.get("fulfillment_deadline") || "");
    const handoffTime = String(values.get("handoff_time") || "");
    const businessZone = String(values.get("business_timezone") || businessTimeZone());
    clearCreateValidationState(form);
    if (!Number.isInteger(minQuantity) || !Number.isInteger(maxQuantity) || minQuantity < 1 || maxQuantity < minQuantity) { setCreateError("Check the quantities: the maximum must be at least the positive minimum."); return; }
    const maxAllowedFundedMembers = Number(state.config?.max_funded_members || 20);
    if (!Number.isInteger(maxFundedMembers) || maxFundedMembers < 1 || maxFundedMembers > maxAllowedFundedMembers) { setCreateError(`Funded household capacity must be a whole number from 1 to ${maxAllowedFundedMembers}.`); return; }
    if (!Number.isInteger(perBuyer) || perBuyer < 1 || perBuyer > maxQuantity) { setCreateError("The buyer limit must be between 1 and the maximum deal quantity."); return; }
    if (maxFundedMembers * perBuyer < minQuantity) { setCreateError(`This deal cannot reach its minimum. ${maxFundedMembers} buyers at ${perBuyer} each can reserve at most ${maxFundedMembers * perBuyer}.`); return; }
    let deadlineNs, cancellationNs, fulfillmentNs, handoffLabel, priceYocto, v5Price;
    try {
      setBusinessTimeZone(businessZone);
      deadlineNs = toNanoseconds(deadline, businessZone);
      cancellationNs = toNanoseconds(cancellationDeadline, businessZone);
      fulfillmentNs = toNanoseconds(fulfillmentDeadline, businessZone);
      const handoffInstant = dealTimeTools.instantFromWallTime(handoffTime, businessZone);
      handoffLabel = dealTimeTools.formatInstant(handoffInstant, businessZone, dealTimeTools.browserTimeZone());
      if (version === "V5") {
        v5Price = usdcTools.usdPrice(listedPrice, Number(state.config?.token_decimals || 6));
        priceYocto = v5Price?.tokenUnits || null;
      } else {
        priceYocto = parseNearAmount(price);
      }
      if (!priceYocto || BigInt(priceYocto) <= 0n) throw new Error("Price must be greater than zero.");
      if (BigInt(cancellationNs) > BigInt(deadlineNs)) throw new Error("Cancellation cannot end after contributions.");
      dealCreationTools.validateDeadlines(deadlineNs, fulfillmentNs);
    } catch (error) { setCreateError(error.message || "Check the dates and price."); return; }
    const button = $("#create-purchase-button");
    saveDraft(form);
    const supplierId = String(values.get("farmer_id") || "").trim();
    const creationMode = String(values.get("creation_mode") || "organizer_request");
    let methodName = "create_open_purchase";
    let createArgs = { min_quantity: minQuantity, max_quantity: maxQuantity, max_funded_members: maxFundedMembers, price_per_unit: priceYocto, deadline_ns: deadlineNs, cancellation_deadline_ns: cancellationNs, fulfillment_evidence_deadline_ns: fulfillmentNs, farmer_id: supplierId };
    if (isV4) {
      const productName = String(values.get("product_name") || "").trim();
      const description = String(values.get("description") || "").trim();
      const selectedUnit = String(values.get("sale_unit") || "").trim();
      const customUnit = String(values.get("custom_unit") || "").trim();
      const unit = selectedUnit === "custom" ? customUnit : selectedUnit;
      const packageContents = String(values.get("package_contents") || "").trim();
      const quantityUnit = packageContents ? `${unit}${UNIT_SEPARATOR}${packageContents}` : unit;
      const fulfillmentMethod = String(values.get("fulfillment_method") || "").trim();
      const fulfillmentLocation = String(values.get("fulfillment_location") || "").trim();
      const pickupInstructions = String(values.get("pickup_or_delivery") || "").trim();
      const pickup = `${fulfillmentMethod} · ${handoffLabel} · ${fulfillmentLocation}${pickupInstructions ? `. ${pickupInstructions}` : ""}`;
      const refundTerms = String(values.get("cancellation_and_refund_terms") || "").trim();
      const perHousehold = perBuyer;
      const usdScaled = version === "V5" ? BigInt(v5Price.cents) : parseScaledDecimal(listedPrice, 100n);
      if (!productName || !description || !quantityUnit || !fulfillmentMethod || !fulfillmentLocation || !refundTerms || !supplierId) { setCreateError("Complete the product, sale unit, supplier, pickup, and refund details."); return; }
      if (new TextEncoder().encode(quantityUnit).length > 160) { setCreateError("Shorten the custom unit or package contents so the complete sale-unit description is 160 characters or fewer."); return; }
      if (new TextEncoder().encode(pickup).length > 2000) { setCreateError("Shorten the pickup or delivery details so the complete handoff terms are 2,000 characters or fewer."); return; }
      if (!Number.isInteger(perHousehold) || perHousehold < 1 || perHousehold > maxQuantity) { setCreateError("The household item limit must be between 1 and the maximum quantity."); return; }
      if (usdScaled === null || usdScaled <= 0n) { setCreateError("Enter a positive listed USD price."); return; }
      const terms = { product_name: productName, description, quantity_unit: quantityUnit, price_per_unit: priceYocto, listed_price_usd_cents: usdScaled.toString(), min_quantity: minQuantity, max_quantity: maxQuantity, max_quantity_per_household: perHousehold, max_funded_members: maxFundedMembers, pickup_or_delivery: pickup, join_deadline_ns: deadlineNs, fulfillment_deadline_ns: fulfillmentNs, cancellation_and_refund_terms: refundTerms };
      try {
        const creation = dealCreationTools.transaction(creationMode, terms, supplierId, state.accountId);
        methodName = creation.methodName;
        createArgs = creation.args;
      } catch (error) {
        setCreateError(`${error.message} Choose your connected supplier wallet, or use organizer mode to send a request.`);
        return;
      }
    }
    const baselinePurchaseCount = Number(await view("get_purchase_count"));
    const successCopy = actionSuccessCopy(methodName);
    const creationCopy = dealCreationTools.mode(creationMode);
    const confirmation = await performVerifiedAction(button, methodName, createArgs, successCopy, {
      context: { minimumPurchaseId: baselinePurchaseCount },
      failureMessage: creationMode === "supplier_offer"
        ? "We couldn't publish your Group Deal. Your draft is safe."
        : "We couldn't send the request to the supplier. Your draft is safe.",
      onError: (message, error) => setCreateError(message || creationCopy.connected, error),
    });
    if (!confirmation || confirmation.state !== "confirmed") return;
    try {
      const id = confirmation.record?.id;
      await loadBaseData();
      const created = id !== null && id !== undefined
        && state.purchases.some((purchase) => String(purchase.id) === String(id));
      if (!created) {
        setCreateError("The wallet returned, but the new purchase is not confirmed by the contract yet. Your draft is safe. Refresh before trying again.");
        return;
      }
      clearDraft(form);
      window.sessionStorage.setItem(CREATE_SUBMITTED_KEY, "true");
      window.location.href = `/purchases/${encodeURIComponent(String(id))}`;
    } catch (error) {
      setCreateError("The wallet returned, but the new purchase could not be verified yet. Your draft is safe. Refresh before trying again.", error);
    }
  }

  const GUARDED_TRANSACTION_ACTIONS = new Set([
    "contribute", "accept-supplier-request", "decline-supplier-request", "vote",
    "cancel-commitment", "claim-refund", "expire-unfulfilled", "reconcile-escrow", "release-payment",
    "decision-vote", "resolve-issue", "agree-decision", "decline-decision", "expire-decision",
  ]);

  async function handleCommunityTokenRegistration(button) {
    const fund = state.communityFund;
    const goal = appConfig.communityGoal || {};
    if (!state.accountId || goal.currency !== "USDC" || !fund.safety?.ready || fund.asset?.daoStorage) {
      showToast("The treasury does not currently need USDC registration.", "error");
      return;
    }
    const minimum = String(fund.asset?.storageBounds?.min || "");
    if (!/^\d+$/.test(minimum) || BigInt(minimum) <= 0n) {
      showToast("The USDC contract did not return a valid minimum storage deposit.", "error");
      return;
    }
    const args = communityFundTools.storageRegistration(appConfig.communityDaoId);
    const approved = await reviewTransaction({
      title: "Register the DAO treasury for USDC",
      summary: "Pay the USDC contract’s exact storage minimum so the DAO can receive USDC. This transfers no USDC.",
      signer: state.accountId,
      receiver: goal.tokenId,
      method: "storage_deposit",
      args,
      gas: "30000000000000",
      deposit: `${minimum} yoctoNEAR (${communityFundTools.formatNear(minimum)} Testnet NEAR)`,
      warning: "This public Testnet transaction registers only the DAO account with the canonical USDC token contract.",
    });
    if (!approved) return;
    const outcome = await performTransaction(
      button,
      "Registration submitted",
      () => sendChangeTo(goal.tokenId, "storage_deposit", args, minimum, true),
      "DAO USDC registration returned from the wallet.",
      { confirmOnReturn: false },
    );
    if (!outcome) return;
    const confirmed = await confirmationTools.waitForState(
      async () => viewOnContract(goal.tokenId, "storage_balance_of", { account_id: appConfig.communityDaoId }),
      (storage) => storage ? { state: "registered", storage } : null,
      { attempts: 12, delayMs: 1500 },
    );
    if (!confirmed) {
      showToast("The wallet returned, but DAO USDC registration is not confirmed yet. Refresh before trying again.", "error");
      return;
    }
    await refreshLiveData({ force: true });
  }

  async function handleCommunityContribution(form) {
    const summary = $(".form-error-summary", form);
    if (!form.reportValidity()) {
      setErrorSummary(summary, "Enter a contribution amount greater than zero.");
      return;
    }
    const goal = appConfig.communityGoal || {};
    const amount = parseCommunityAmount(form.elements.amount.value, goal);
    if (!amount) {
      setErrorSummary(summary, `Enter a contribution with no more than ${goal.currency === "USDC" ? 6 : 24} decimal places.`);
      return;
    }
    if (!state.accountId || !state.communityFund.safety?.ready || !appConfig.communityGoal?.configured) {
      setErrorSummary(summary, "Connect a Testnet wallet and wait for the goal treasury safety checks before contributing.");
      return;
    }
    const isUsdc = goal.currency === "USDC";
    if (isUsdc && (!state.communityFund.asset?.ready || !state.communityFund.asset?.accountStorage)) {
      setErrorSummary(summary, "This wallet must already be registered with the USDC contract, and the DAO treasury registration must be confirmed.");
      return;
    }
    if (isUsdc && BigInt(amount) > BigInt(state.communityFund.asset.accountBalance || "0")) {
      setErrorSummary(summary, "This wallet does not have enough Testnet USDC for that contribution.");
      return;
    }
    const preflightButton = $("button[type='submit']", form);
    setBusy(preflightButton, true, "Checking contribution total…");
    try {
      // This endpoint reads the durable local receipt/attempt ledger only. A forced
      // indexer crawl and a DAO balance RPC do not make this direct token transfer
      // safer, and previously delayed the review dialog by many seconds.
      const freshActivity = await fetchCommunityActivity(false);
      if (!freshActivity?.error) applyCommunityActivity(freshActivity);
    } finally {
      setBusy(preflightButton, false);
    }
    if (goal.uiContributionCap) {
      const contributed = state.communityFund.activity?.verifiedContributionSubtotal;
      if (!/^\d+$/.test(String(contributed ?? ""))) {
        setErrorSummary(summary, "The durable confirmed contribution total is required before another contribution can be reviewed.");
        return;
      }
      const limit = communityFundTools.contributionLimit(goal, String(contributed), amount);
      if (!limit.allowed) {
        const message = limit.reached
          ? "Goal reached. HarvestPool has disabled additional contributions for this fund."
          : `This contribution exceeds the remaining ${communityAmount(limit.remaining, goal)} application target.`;
        setErrorSummary(summary, message);
        return;
      }
    }
    const receiver = isUsdc ? goal.tokenId : appConfig.communityDaoId;
    const method = isUsdc ? "ft_transfer" : "Native NEAR transfer";
    const args = isUsdc
      ? communityFundTools.tokenContribution(appConfig.communityDaoId, amount, goal.title)
      : { purpose: `Contribution toward ${goal.title}` };
    const confirmedBeforeApproval = BigInt(String(state.communityFund.activity?.verifiedContributionSubtotal || "0"));
    const awaitingBeforeApproval = BigInt(String(state.communityFund.activity?.awaitingConfirmation || "0"));
    const targetBeforeApproval = BigInt(String(goal.targetUnits || goal.targetYocto || "0"));
    const overfundingRisk = awaitingBeforeApproval > 0n
      && confirmedBeforeApproval + awaitingBeforeApproval + BigInt(amount) > targetBeforeApproval;
    setErrorSummary(summary, "");
    const approved = await reviewTransaction({
      title: "Review Community Goal contribution",
      summary: `Send ${communityAmount(amount, goal)}${isUsdc ? " USDC on NEAR Testnet" : ""} toward ${goal.title}. The recipient treasury is ${appConfig.communityDaoId}.`,
      signer: state.accountId,
      receiver,
      method,
      args,
      gas: isUsdc ? "30000000000000" : "Wallet-estimated transfer fee",
      deposit: isUsdc ? "1 yoctoNEAR" : `${amount} yoctoNEAR (${communityFundTools.formatNear(amount)} Testnet NEAR)`,
      warning: `Testnet only. This public transfer goes to ${appConfig.communityDaoId}; it cannot be personally withdrawn or automatically refunded, and members approve spending.${overfundingRisk ? " Known pending payments plus this payment could exceed the goal because the cap is not enforced atomically." : " The fundraising cap is not enforced atomically."}`,
      confirmLabel: "Continue to Meteor",
    });
    if (!approved) return;
    const button = $("button[type='submit']", form);
    if (!isUsdc) {
      const outcome = await performTransaction(
        button,
        "Contribution submitted",
        () => state.wallet.signAndSendTransaction({
          ...transactionTools.buildTransferTransaction({
            actionCreators: state.actionCreators,
            signerId: state.accountId,
            receiverId: appConfig.communityDaoId,
            amountYocto: amount,
          }),
          callbackUrl: window.location.href,
        }),
        "Community Goal contribution confirmed on Testnet.",
        { onError: (message, error) => showFormTransactionError(form, message, error) },
      );
      if (!outcome) return;
      form.reset();
      await refreshLiveData({ force: true });
      return;
    }
    const confirmation = await performVerifiedAction(
      button,
      "community_contribute_usdc",
      args,
      "Community Goal contribution confirmed on Testnet.",
      {
        receiverId: goal.tokenId,
        transactionMethodName: "ft_transfer",
        transactionArgs: args,
        depositValue: "1",
        valueIsYocto: true,
        context: {
          daoId: appConfig.communityDaoId,
          activityUrl: appConfig.communityActivityUrl,
        },
        confirmationAttempts: 30,
        failureMessage: "We couldn't confirm this contribution. Do not submit it again until HarvestPool reconciles the transaction.",
        onError: (message, error) => showFormTransactionError(form, message, error),
      },
    );
    if (confirmation?.state !== "confirmed") return;
    form.reset();
    state.communityFund.activeTab = "contributions";
    await loadCommunityFundData({ refreshActivity: true });
    state.lastLiveRefreshAt = Date.now();
    renderCurrentPage();
  }

  async function handleCommunityProposal(form) {
    const summary = $(".form-error-summary", form);
    if (!form.reportValidity()) {
      setErrorSummary(summary, "Complete the amount and reason before continuing.");
      return;
    }
    const fund = state.communityFund;
    const goal = appConfig.communityGoal || {};
    if (!goal.configured || !fund.safety?.ready || !fund.safety.proposerAccounts.has(state.accountId)) {
      setErrorSummary(summary, "This connected wallet does not have the on-chain permission to propose transfers.");
      return;
    }
    const tokenId = communityTokenId(goal);
    const amount = parseCommunityAmount(form.elements.amount.value, goal);
    try {
      if (!amount) throw new Error(`Enter a goal payment amount greater than zero with no more than ${goal.currency === "USDC" ? 6 : 24} decimal places.`);
      if (!fund.asset?.ready) throw new Error("The configured payment asset is not ready for DAO payments.");
      if (!fund.activity?.complete) {
        throw new Error("Complete verified contribution history is required before proposing the goal payment.");
      }
      const verifiedContributions = (fund.activity.contributions || [])
        .reduce((total, item) => total + BigInt(item.amount), 0n);
      const verifiedSpent = fund.proposals.map((proposal) => communityFundTools.allocationFromProposal(proposal, tokenId)).filter(Boolean)
        .reduce((total, allocation) => verifiedCommunityPayment(allocation, fund.activity)
          ? total + BigInt(allocation.amount)
          : total, 0n);
      const verifiedGoalPaid = fund.proposals.map((proposal) => communityFundTools.allocationFromProposal(proposal, tokenId)).filter(Boolean)
        .reduce((total, allocation) => allocation.receiverId === goal.recipient
          && verifiedCommunityPayment(allocation, fund.activity)
          ? total + BigInt(allocation.amount)
          : total, 0n);
      const verifiedUnspentContributions = verifiedContributions > verifiedSpent
        ? verifiedContributions - verifiedSpent
        : 0n;
      const target = BigInt(goal.targetUnits || goal.targetYocto);
      const remainingTarget = target > verifiedGoalPaid
        ? target - verifiedGoalPaid
        : 0n;
      if (BigInt(amount) > verifiedUnspentContributions) {
        throw new Error("The proposed payment is greater than verified unspent goal contributions.");
      }
      if (BigInt(amount) > remainingTarget) {
        throw new Error("The proposed payment is greater than the unpaid portion of this goal’s published target.");
      }
      const assetBalance = goal.currency === "USDC" ? fund.asset.daoBalance : fund.availableAmount;
      if (BigInt(amount) > BigInt(assetBalance)) {
        throw new Error("The proposed payment is greater than the DAO’s current available balance.");
      }
      const proposal = communityFundTools.transferProposal(
        goal.recipient,
        amount,
        form.elements.reason.value,
        tokenId,
      );
      setErrorSummary(summary, "");
      const bond = String(fund.policy.proposal_bond);
      const approved = await reviewTransaction({
        title: "Review goal payment proposal",
        summary: `${communityAmount(amount, goal)} to ${proposal.kind.Transfer.receiver_id}: ${communityFundTools.decodeDescription(proposal.description)}`,
        signer: state.accountId,
        receiver: appConfig.communityDaoId,
        method: "add_proposal",
        args: { proposal },
        gas: "30000000000000",
        deposit: `${bond} yoctoNEAR proposal bond (${communityFundTools.formatNear(bond)} Testnet NEAR)`,
        warning: `This does not pay the recipient. The DAO requires ${fund.safety.requiredVotes} member approvals; the deciding approval executes the payment.`,
      });
      if (!approved) return;
      const button = $("button[type='submit']", form);
      const outcome = await performTransaction(
        button,
        "Proposal submitted",
        () => sendChangeTo(appConfig.communityDaoId, "add_proposal", { proposal }, bond, true),
        "Goal payment proposal confirmed on-chain.",
        { onError: (message, error) => showFormTransactionError(form, message, error) },
      );
      if (!outcome) return;
      form.reset();
      await refreshLiveData({ force: true });
    } catch (error) {
      setErrorSummary(summary, error.message || "The proposal is invalid.");
    }
  }

  async function handleCommunityVote(button) {
    const fund = state.communityFund;
    const goal = appConfig.communityGoal || {};
    const proposalId = Number(button.dataset.proposalId);
    const proposal = fund.proposals.find((item) => Number(item.id) === proposalId);
    const allocation = communityFundTools.allocationFromProposal(proposal, communityTokenId(goal));
    const action = button.dataset.voteAction;
    const existingPayment = verifiedCommunityPayment(allocation, fund.activity);
    if (!allocation || allocation.status !== "InProgress" || !["VoteApprove", "VoteReject"].includes(action)) {
      showToast("This proposal is no longer available for that vote.", "error");
      return;
    }
    if (existingPayment) {
      showToast("This allocation already has a verified DAO payment receipt. No further vote was sent.", "error");
      return;
    }
    if (action === "VoteApprove" && (!appConfig.communityGoal?.configured || allocation.receiverId !== appConfig.communityGoal.recipient)) {
      showToast("This proposal does not match the configured Community Goal recipient, so HarvestPool will not submit a vote.", "error");
      return;
    }
    if (!fund.safety?.ready || !fund.safety.voterAccounts.has(state.accountId) || allocation.votes[state.accountId]) {
      showToast("This wallet is not eligible to cast this vote.", "error");
      return;
    }
    const counts = communityVoteCounts(allocation);
    const decidingApproval = action === "VoteApprove" && counts.approve + 1 >= fund.safety.requiredVotes;
    const args = { id: proposalId, action };
    const approved = await reviewTransaction({
      title: decidingApproval ? "Approve and execute this payment?" : action === "VoteApprove" ? "Approve this goal payment?" : "Reject this goal payment?",
      summary: `${communityAmount(allocation.amount, goal)} to ${allocation.receiverId}: ${allocation.reason}`,
      signer: state.accountId,
      receiver: appConfig.communityDaoId,
      method: "act_proposal",
      args,
      gas: "30000000000000",
      deposit: "0 yoctoNEAR",
      warning: decidingApproval
        ? "This is the threshold-crossing vote. SputnikDAO will transfer the funds in this same on-chain action if the payment execution succeeds."
        : "Your vote is public and permanent. Network gas may still apply.",
      confirmLabel: decidingApproval ? "Approve payment in Meteor" : "Continue to Meteor",
    });
    if (!approved) return;
    const outcome = await performTransaction(
      button,
      "Vote submitted",
      () => sendChangeTo(appConfig.communityDaoId, "act_proposal", args),
      "DAO vote transaction returned from the wallet.",
      { confirmOnReturn: false },
    );
    if (!outcome) return;
    let verificationAttempt = 0;
    const confirmed = await confirmationTools.waitForState(
      async () => {
        verificationAttempt += 1;
        const refreshActivity = decidingApproval && [1, 5, 9].includes(verificationAttempt);
        await loadCommunityFundData({ refreshActivity });
        const updatedProposal = state.communityFund.proposals.find((item) => Number(item.id) === proposalId);
        return {
          allocation: communityFundTools.allocationFromProposal(updatedProposal, communityTokenId(goal)),
          activity: state.communityFund.activity,
        };
      },
      ({ allocation: updated, activity }) => {
        if (!updated) return null;
        if (decidingApproval) {
          const payment = verifiedCommunityPayment(updated, activity);
          if (payment) return { state: "paid", allocation: updated, payment };
          if (["Failed", "Rejected", "Removed", "Expired"].includes(updated.status)) {
            return { state: "failed", allocation: updated };
          }
          return null;
        }
        if (updated.votes?.[state.accountId] === (action === "VoteApprove" ? "Approve" : "Reject")) {
          return { state: "voted", allocation: updated };
        }
        return null;
      },
      { attempts: 12, delayMs: 1500 },
    );
    renderCurrentPage();
    if (confirmed?.state === "paid") {
      showToast("The deciding approval and matching DAO payment receipt are confirmed.", "success");
    } else if (confirmed?.state === "voted") {
      showToast("Your recorded DAO vote is confirmed on-chain.", "success");
    } else if (confirmed?.state === "failed") {
      showToast("The proposal reached a terminal state without a verified payment. Review the on-chain record.", "error");
    } else {
      showToast("The vote was submitted, but the payment or vote record is still being verified. Do not submit again.");
    }
  }

  async function dispatchGuardedTransaction(action, button) {
    const purchase = state.purchases.find((item) => String(item.id) === String(button.dataset.purchaseId));
    const decision = state.decisions.find((item) => String(item.id) === String(button.dataset.decisionId));
    const commitment = purchase ? commitmentFor(purchase) : null;
    if (action === "contribute") return handleContribution(button);
    if (action === "accept-supplier-request") return handleSupplierRequestAction(button, purchase, "accept");
    if (action === "decline-supplier-request") return handleSupplierRequestAction(button, purchase, "decline");
    if (action === "vote") return handleVote(button);
    if (action === "cancel-commitment") return handleSimpleAction(button, "cancel_commitment", { purchase_id: String(button.dataset.purchaseId) }, "Commitment cancelled on-chain. The refund is now claimable.");
    if (action === "claim-refund") return handleSimpleAction(button, "claim_refund", { purchase_id: String(button.dataset.purchaseId) }, `${commitment ? customerPaymentLabel(purchase, commitment.amount) : "Refund"} claim submitted. Wait for confirmation before trying again.`);
    if (action === "expire-unfulfilled") return handleSimpleAction(button, "expire_unfulfilled_purchase", { purchase_id: String(button.dataset.purchaseId) }, "Purchase marked failed on-chain. Refunds are now claimable.");
    if (action === "reconcile-escrow") return handleReconcile(button);
    if (action === "release-payment") return handleReleasePayment(button, purchase);
    if (action === "decision-vote") return handleV3Action(button, "vote_on_decision", { decision_id: String(button.dataset.decisionId), option: Number(button.dataset.option) }, "Your vote has been recorded.");
    if (action === "resolve-issue") return handleV3Action(button, "resolve_issue", { issue_id: String(button.dataset.issueId) }, "Issue marked resolved.");
    if (action === "agree-decision") return handleSupplierDecisionAction(button, decision, "accept");
    if (action === "decline-decision") return handleSupplierDecisionAction(button, decision, "decline");
    if (action === "expire-decision") return handleV3Action(button, "expire_decision", { decision_id: String(button.dataset.decisionId) }, "Expired decision closed. The issue is open for another proposal.");
    return null;
  }

  function bindGlobalEvents() {
    normalizeExploreFilters();
    $("#wallet-button")?.addEventListener("click", () => {
      if (state.accountId) openWalletPanel();
      else if (state.walletStatus === "unavailable") setupNear();
      else connectWallet();
    });
    $("#wallet-panel-close")?.addEventListener("click", closeWalletPanel);
    $("#wallet-signout")?.addEventListener("click", disconnectWallet);
    $("#menu-toggle")?.addEventListener("click", () => {
      const menu = $("#site-nav");
      const open = menu.classList.toggle("open");
      $("#menu-toggle").setAttribute("aria-expanded", String(open));
      $("#menu-toggle").setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    });
    $$('[data-filter].filter-tab').forEach((button) => button.addEventListener("click", () => {
      $$('[data-filter].filter-tab').forEach((tab) => {
        const active = tab === button;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-pressed", String(active));
      });
      const url = new URL(window.location.href);
      url.searchParams.set("filter", button.dataset.filter);
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      renderExplore();
    }));
    $("#create-purchase-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      runGuardedSubmission(event.currentTarget, () => handleCreate(event.currentTarget));
    });
    $("#price-per-unit")?.addEventListener("input", updateCreatePricePreview);
    $("#listed-usd-price")?.addEventListener("input", updateCreatePricePreview);
    $("#custom-unit")?.addEventListener("input", updateSaleUnitFields);
    $("#sale-unit")?.addEventListener("change", updateSaleUnitFields);
    $("#farmer-account")?.addEventListener("change", updateSupplierSelection);
    $("#dashboard-root")?.addEventListener("click", (event) => {
      const link = event.target.closest?.("a[href]");
      if (!link) return;
      const url = new URL(link.href, window.location.origin);
      if (!/^\/(?:purchases|deals)\/\d+$/.test(url.pathname)) return;
      url.searchParams.set("from", "dashboard");
      link.href = `${url.pathname}${url.search}${url.hash}`;
    });
    document.addEventListener("click", async (event) => {
      const communityButton = event.target.closest("[data-community-action]");
      if (communityButton) {
        event.preventDefault();
        const action = communityButton.dataset.communityAction;
        if (action === "refresh") await refreshLiveData({ force: true });
        if (action === "refresh-history") {
          await loadCommunityFundData({ refreshActivity: true });
          state.lastLiveRefreshAt = Date.now();
          renderCurrentPage();
        }
        if (action === "register-token") await runGuardedSubmission(communityButton, () => handleCommunityTokenRegistration(communityButton));
        if (action === "vote") await runGuardedSubmission(communityButton, () => handleCommunityVote(communityButton));
        return;
      }
      const communityTab = event.target.closest("[data-community-tab]");
      if (communityTab) {
        event.preventDefault();
        activateCommunityTab(communityTab.dataset.communityTab, { focus: true });
        return;
      }
      const connectButton = event.target.closest("[data-connect-wallet]");
      if (connectButton) {
        event.preventDefault();
        if (connectButton.dataset.connecting === "true") return;
        connectButton.dataset.connecting = "true";
        setBusy(connectButton, true, "Opening Meteor…");
        try { await connectWallet(); }
        finally {
          delete connectButton.dataset.connecting;
          if (connectButton.isConnected) setBusy(connectButton, false);
        }
        return;
      }
      const actionCenterTab = event.target.closest("[data-action-center-tab]");
      if (actionCenterTab) {
        event.preventDefault();
        activateActionCenterTab(actionCenterTab.dataset.actionCenterTab, { focus: true });
        return;
      }
      const raiseIssueButton = event.target.closest('[data-action="show-raise-issue"]');
      if (raiseIssueButton) {
        event.preventDefault();
        showRaiseIssueForm();
        return;
      }
      const actionButton = event.target.closest("[data-action]");
      if (!actionButton) return;
      const action = actionButton.dataset.action;
      if (action === "check-v3-confirmation") {
        await handleCheckV3Confirmation(actionButton);
        return;
      }
      if (action === "archive-pending-alert") {
        archivePendingActionAlert(actionButton.dataset.pendingActionId);
        return;
      }
      if (action === "dismiss-personal-contribution") {
        if (dismissPersonalContributionOutcome(actionButton.dataset.contributionOutcomeId)) {
          renderCurrentPage();
        }
        return;
      }
      if (action === "check-pending-actions") {
        const pendingActionId = actionButton.dataset.pendingActionId;
        const personalContribution = actionButton.closest("[data-personal-contribution]");
        const checkedAction = pendingActionId
          ? pendingActionStore.list().find((item) => String(item.id) === String(pendingActionId))
          : null;
        const suppressCommunityToast = checkedAction?.methodName === "community_contribute_usdc";
        const resultNode = (personalContribution || actionButton.closest(".decision-card"))?.querySelector("[data-pending-check-result]");
        setBusy(actionButton, true, "Checking state…");
        if (resultNode) resultNode.textContent = "Checking finalized Testnet state…";
        try {
          if (pendingActionId) {
            const result = await checkPendingAction(pendingActionId);
            if (resultNode?.isConnected) resultNode.textContent = result.message;
            if (!personalContribution && !suppressCommunityToast) {
              showToast(result.message, result.state === "confirmed" ? "success" : result.state === "failed" ? "error" : "");
            }
          } else {
            const remaining = await reconcilePendingActions({ poll: true });
            const message = remaining.length
              ? "Finalized state is still unavailable. The saved action remains protected and no retry was submitted."
              : "The submitted action is no longer pending.";
            if (resultNode?.isConnected) resultNode.textContent = message;
            if (!personalContribution && !suppressCommunityToast) showToast(message, remaining.length ? "" : "success");
          }
        } catch (error) {
          const message = `On-chain verification could not finish: ${String(error?.message || error)} The saved action was preserved and no transaction was submitted.`;
          if (resultNode?.isConnected) resultNode.textContent = message;
          if (!personalContribution && !suppressCommunityToast) showToast(message, "error");
        } finally {
          if (actionButton.isConnected) {
            setBusy(actionButton, false);
            if (personalContribution) startManualPaymentCheckCooldown(actionButton, 5);
          }
        }
        return;
      }
      if (action === "discard-draft") {
        discardDraftForSurface(actionButton);
        return;
      }
      if (action === "restore-draft") {
        const surface = draftSurface(actionButton);
        if (restoreDraftForSurface(surface)) showToast("Saved draft restored.", "success");
        return;
      }
      if (action === "retry-live-data") {
        setBusy(actionButton, true, "Retrying…");
        try {
          await refreshLiveData({ force: true });
          showToast("Live Testnet data refreshed.", "success");
        } catch (_error) {
          showToast("Live Testnet data is still unavailable. No transaction was submitted.", "error");
        } finally {
          if (actionButton.isConnected) setBusy(actionButton, false);
        }
        return;
      }
      if (action === "reload-live-data") {
        try {
          await loadBaseData();
          renderExplore();
          showToast("Live testnet data refreshed.", "success");
        } catch (_error) {
          showToast("Live Testnet data is still unavailable. Try again; no form draft was changed.", "error");
        }
        return;
      }
      if (action === "copy-link") {
        await copyText(actionButton.dataset.shareUrl);
        showToast("Share link copied.", "success");
      }
      if (action === "share-purchase") {
        const url = publicShareUrl(actionButton.dataset.purchaseId);
        if (navigator.share) {
          try { await navigator.share({ title: "HarvestPool purchase", url }); }
          catch (error) { if (error?.name !== "AbortError") { await copyText(url); showToast("Purchase link copied.", "success"); } }
        } else {
          await copyText(url);
          showToast("Purchase link copied.", "success");
        }
      }
      if (action === "quantity-minus" || action === "quantity-plus") {
        const input = $("#contribution-quantity");
        if (!input || input.disabled) return;
        const change = action === "quantity-plus" ? 1 : -1;
        const next = Math.min(Number(input.max || 1), Math.max(Number(input.min || 1), Number(input.value || 1) + change));
        input.value = next;
        updateContributionTotal();
      }
      if (action === "refresh-payout-checks") {
        await loadFinancialReadiness(state.currentPurchase).catch(() => { state.financialReadiness = { error: true }; });
        if (appConfig.page === "farmer") {
          const target = $("#financial-operations-root");
          if (target && state.currentPurchase) target.innerHTML = financialReadinessMarkup(state.currentPurchase);
        } else renderCurrentPage();
      }
      if (action === "open-financial-operations") {
        if (!state.accountId) {
          showToast("Connect a wallet before reviewing financial operations.", "error");
          return;
        }
        setBusy(actionButton, true, "Loading final reads…");
        const purchase = await loadPurchase(actionButton.dataset.purchaseId).catch(() => null);
        if (purchase) await loadFinancialReadiness(purchase).catch(() => { state.financialReadiness = { error: true }; });
        state.openFinancialOperationsId = purchase ? String(purchase.id) : null;
        const target = $("#financial-operations-root");
        if (target) target.innerHTML = purchase ? financialReadinessMarkup(purchase) : '<div class="error-state"><p>Financial reads are unavailable. No operation is enabled.</p></div>';
        setBusy(actionButton, false);
      }
      if (GUARDED_TRANSACTION_ACTIONS.has(action)) {
        await runGuardedSubmission(actionButton, () => dispatchGuardedTransaction(action, actionButton));
      }
    });
    document.addEventListener("click", (event) => {
      const link = event.target.closest?.("#create-form-error a[href^='#']");
      if (!link) return;
      event.preventDefault();
      focusCreateErrorLink(link);
    });
    document.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-dashboard-filter]");
      if (!button) return;
      const root = $("#dashboard-root");
      if (!root) return;
      root.dataset.dashboardFilter = button.dataset.dashboardFilter;
      renderDashboard();
    });
    document.addEventListener("keydown", (event) => {
      const communityCurrent = event.target.closest?.('[role="tab"][data-community-tab]');
      if (communityCurrent && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const tabs = $$('[role="tab"][data-community-tab]', communityCurrent.closest('[role="tablist"]'));
        const index = tabs.indexOf(communityCurrent);
        const nextIndex = event.key === "Home" ? 0
          : event.key === "End" ? tabs.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        activateCommunityTab(tabs[nextIndex].dataset.communityTab, { focus: true });
        return;
      }
      const current = event.target.closest?.('[role="tab"][data-action-center-tab]');
      if (!current || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const tabs = $$('[role="tab"][data-action-center-tab]', current.closest('[role="tablist"]'));
      const index = tabs.indexOf(current);
      const nextIndex = event.key === "Home" ? 0
        : event.key === "End" ? tabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      activateActionCenterTab(tabs[nextIndex].dataset.actionCenterTab, { focus: true });
    });
    document.addEventListener("input", (event) => {
      const createForm = event.target.closest?.("#create-purchase-form");
      if (createForm) {
        clearFieldError(event.target);
        if (!$(".field-invalid", createForm)) {
          $(".form-error-summary", createForm)?.setAttribute("hidden", "");
        }
      }
      if (event.target.id === "contribution-quantity") updateContributionTotal();
      if (event.target.id === "price-per-unit") updateCreatePricePreview();
      if (event.target.id === "listed-usd-price") updateCreatePricePreview();
      if (event.target.id === "custom-unit") updateSaleUnitFields();
      if (["purchase-deadline", "fulfillment-deadline"].includes(event.target.id)) updateTimezoneControls();
      saveDraft(event.target);
    });
    document.addEventListener("change", (event) => {
      const createForm = event.target.closest?.("#create-purchase-form");
      if (createForm) clearFieldError(event.target);
      handleDraftContextChange(event.target);
      if (event.target.id === "agreement-acceptance") updateAgreementAcceptance();
      if (event.target.id === "sale-unit") updateSaleUnitFields();
      if (event.target.name === "creation_mode") updateCreationModeCopy();
      if (event.target.id === "business-timezone") {
        setBusinessTimeZone(event.target.value);
        updateTimezoneControls();
      }
      if (event.target.name === "vote_type") updateDecisionFormType(event.target.form);
      saveDraft(event.target);
    });
    document.addEventListener("submit", (event) => {
      if (event.target.matches("[data-community-contribution]")) {
        event.preventDefault();
        runGuardedSubmission(event.target, () => handleCommunityContribution(event.target));
        return;
      }
      if (event.target.matches("[data-community-proposal]")) {
        event.preventDefault();
        runGuardedSubmission(event.target, () => handleCommunityProposal(event.target));
        return;
      }
      if (!event.target.matches("[data-evidence-form]")) return;
      event.preventDefault();
      runGuardedSubmission(event.target, () => handleEvidence(event.target));
    });
    document.addEventListener("submit", (event) => {
      if (!event.target.matches("[data-issue-form]")) return;
      event.preventDefault();
      runGuardedSubmission(event.target, () => handleRaiseIssue(event.target));
    });
    document.addEventListener("submit", (event) => {
      if (!event.target.matches("[data-decision-form]")) return;
      event.preventDefault();
      runGuardedSubmission(event.target, () => handleRequestDecision(event.target));
    });
  }

  async function init() {
    bindGlobalEvents();
    updateTimezoneControls();
    setCreateDefaults();
    clearSubmittedCreateReturn();
    updateSaleUnitFields();
    updateCreationModeCopy();
    updateCreatePricePreview();
    if (appConfig.page === "explore") {
      document.documentElement.dataset.harvestpoolExploreShellMs = performance.now().toFixed(1);
    }
    try {
      const walletPromise = setupNear();
      if (appConfig.page === "decisions") {
        document.body.classList.remove("wallet-session-loading");
        renderDecisions();
        document.documentElement.dataset.harvestpoolUsefulContentMs = performance.now().toFixed(1);
      }
      if (appConfig.page === "community_fund") {
        const persistedActivityPromise = loadPersistedCommunityActivity();
        const liveFundPromise = loadCommunityFundData({ loadActivity: false });
        await Promise.allSettled([persistedActivityPromise]);
        document.body.classList.remove("wallet-session-loading");
        renderCurrentPage();
        await Promise.allSettled([liveFundPromise, loadNearPrice()]);
        renderCurrentPage();
        window.setTimeout(() => refreshCommunityActivityInBackground().catch(() => null), 500);
        await walletPromise;
      } else if (appConfig.page === "decisions" || appConfig.page === "explore") {
        await Promise.allSettled([loadBaseData(), loadNearPrice(), walletPromise]);
      } else if (appConfig.page === "details") {
        const detailId = $("[data-purchase-id]")?.dataset.purchaseId;
        await Promise.allSettled([
          loadNearPrice(),
          walletPromise,
          detailId ? loadDetailData(detailId, { walletReady: walletPromise }) : Promise.resolve(),
        ]);
      } else if (appConfig.page === "create") {
        document.body.classList.remove("wallet-session-loading");
        await Promise.allSettled([loadCreatePublicData(), loadNearPrice(), walletPromise]);
      } else {
        document.body.classList.remove("wallet-session-loading");
        await Promise.allSettled([loadBaseData(), loadNearPrice(), walletPromise]);
      }
      captureWalletCallbackHash();
      state.lastLiveRefreshAt = Date.now();
      if (["agreement", "issue_form", "supplier_invitation"].includes(appConfig.page)) {
        const id = $("[data-purchase-id]")?.dataset.purchaseId;
        if (id && !state.currentPurchase) await loadPurchase(id);
      }
      updateWalletUi();
      showCreateConnectionFollowup();
      const remaining = await reconcilePendingActions();
      if (remaining.length) {
        window.setTimeout(() => reconcilePendingActions({ poll: true }).catch(() => null), 250);
      }
    } catch (_error) {
      if (appConfig.page !== "home" && appConfig.page !== "explore") showToast("Live Testnet data is unavailable right now. Refresh to try again.", "error");
    }
    document.body.classList.remove("wallet-session-loading");
    renderCurrentPage();
    window.setInterval(loadNearPrice, 60_000);
    window.addEventListener("pageshow", async () => {
      clearSubmittedCreateReturn();
      if (document.visibilityState === "visible") {
        if (state.wallet) await syncWalletAccount().catch(() => null);
        await refreshLiveData({ force: true }).catch(() => null);
        const remaining = await reconcilePendingActions().catch(() => []);
        if (remaining.length) {
          window.setTimeout(() => reconcilePendingActions({ poll: true }).catch(() => null), 250);
        }
        scheduleExploreRefresh();
        scheduleActionCenterRefresh();
      }
    });
    window.addEventListener("focus", () => refreshLiveData().catch(() => null));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        refreshLiveData().catch(() => null);
        scheduleExploreRefresh();
        scheduleActionCenterRefresh();
      } else {
        stopExploreRefresh();
        stopActionCenterRefresh();
      }
    });
    window.addEventListener("pagehide", () => {
      stopExploreRefresh();
      stopActionCenterRefresh();
    });
    window.addEventListener("hashchange", () => {
      if (appConfig.page !== "decisions") return;
      const tab = actionCenterTabFromHash();
      activateActionCenterTab(tab, { updateHash: false });
      if (window.location.hash === "#raise-an-issue") showRaiseIssueForm({ focus: false });
      else $("#raise-an-issue")?.setAttribute("hidden", "");
    });
    window.addEventListener("popstate", async () => {
      if (appConfig.page !== "decisions") return;
      const tab = actionCenterTabFromHash();
      activateActionCenterTab(tab, { updateHash: false });
      if (state.wallet) await syncWalletAccount().catch(() => null);
      await refreshLiveData({ force: true }).catch(() => renderDecisions());
    });
    scheduleExploreRefresh();
    scheduleActionCenterRefresh();
    if (["details", "agreement", "issue_form", "supplier_invitation"].includes(appConfig.page)) {
      if (state.currentPurchase) {
        if (appConfig.page === "details") { renderDetailsPage(); decorateDetailsActions(); }
        else if (appConfig.page === "agreement") renderAgreementPage();
        else if (appConfig.page === "issue_form") renderIssueFormPage();
        else renderSupplierInvitationPage();
        decorateMoneyText();
      } else {
        const target = $("#details-content") || $("#agreement-content") || $("#supplier-invitation-content");
        showError(target, "Live deal data is unavailable", "This page only acts on the contract returned by NEAR Testnet. No mock deal, membership, vote, or payment is shown as successful.", '<button class="button button-primary" type="button" data-action="retry-live-data">Retry live data</button> <a class="button button-outline" href="/deals">Back to Explore</a>');
      }
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
