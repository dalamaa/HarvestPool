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
  const pendingActionStore = confirmationTools.pendingStore(window.localStorage);
  const state = {
    near: null,
    selector: null,
    wallet: null,
    actionCreators: null,
    accountId: null,
    members: [],
    suppliers: [],
    config: null,
    purchases: [],
    memberStatus: null,
    fundedMembership: new Map(),
    dataLoaded: false,
    walletError: null,
    currentPurchase: null,
    contributionStatus: null,
    nearPrice: null,
    recordedVotes: new Map(),
    issues: [],
    decisions: [],
    v3Config: null,
    v3Available: false,
    v3Error: null,
    pendingTransactions: new Set(),
    reconcilingPending: false,
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
    "claim_refund",
    "raise_issue",
    "request_group_vote",
    "resolve_issue",
    "vote_on_decision",
    "agree_to_decision",
    "decline_decision",
    "expire_decision",
  ];
  const WALLET_SELECTOR_VERSION = "10.1.4";
  const METEOR_SDK_NEAR_API_VERSION = "6.5.1";
  const YOCTO_PER_NEAR = 10n ** 24n;
  const PRICE_SCALE = 1_000_000n;

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
          discardButton.textContent = "Discard draft";
          contributeButton.parentNode.insertBefore(discardButton, contributeButton);
        }
      }
      const restored = draftTools.restore(surface, formId, draftContext(surface));
      const purchaseField = $("[name='purchase_id']", surface);
      if (purchaseField?.value) surface.dataset.draftPurchaseId = purchaseField.value;
      if (restored) surface.dataset.draftRestored = "true";
      if (surface.id === "create-purchase-form") updateSaleUnitFields();
    });
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

  function technicalDetailsMarkup(error) {
    const detail = String(error?.message || error || "Unknown transaction error").slice(0, 1600);
    return `<details class="technical-details"><summary>Technical details</summary><code>${escapeHtml(detail)}</code></details>`;
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
    showFormTransactionError(form, "We’re checking the result automatically. Your draft is safe, and you can return later.");
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
    showToast("Draft discarded.");
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
    return isV5(purchase)
      ? `${usdcTools.formatUnits(amount, Number(purchase?.token_decimals ?? state.config?.token_decimals ?? 6))} USDC`
      : `${formatNear(amount)} Testnet NEAR`;
  }

  function normalizePaymentCopy(root, purchase) {
    if (!root || !isV5(purchase)) return;
    root.innerHTML = root.innerHTML.replaceAll(
      `${formatNear(purchase.price_per_unit)} Testnet NEAR`,
      paymentLabel(purchase, purchase.price_per_unit),
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
  const PACKAGE_UNITS = new Set(["box", "basket", "bag", "pack", "bundle", "crate", "carton", "sack", "tray", "bunch"]);

  function unitDetails(purchaseOrValue) {
    const raw = String(typeof purchaseOrValue === "object" ? purchaseOrValue?.quantity_unit : purchaseOrValue || "unit");
    const [unitValue, ...contentsParts] = raw.split(UNIT_SEPARATOR);
    return { unit: unitValue.trim() || "unit", contents: contentsParts.join(UNIT_SEPARATOR).trim() };
  }

  function pluralUnit(unitValue, count = 2) {
    const unit = String(unitValue || "unit").trim();
    if (Number(count) === 1 || ["lb", "kg", "L", "dozen"].includes(unit)) return unit;
    if (/[^aeiou]y$/i.test(unit)) return `${unit.slice(0, -1)}ies`;
    if (/(s|x|z|ch|sh)$/i.test(unit)) return `${unit}es`;
    return unit.endsWith("s") ? unit : `${unit}s`;
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
    if (["create_purchase", "create_open_purchase", "create_supplier_offer", "create_purchase_request"].includes(methodName)) return "Publishing your deal…";
    if (["commit", "commit_usdc"].includes(methodName)) return "Securing your spot…";
    if (methodName === "raise_issue") return "Submitting your issue…";
    if (["vote_on_offer", "vote_on_fulfillment", "vote_on_decision"].includes(methodName)) return "Recording your vote…";
    if (methodName === "submit_fulfillment_evidence") return "Submitting delivery details…";
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
      return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value));
    } catch (_error) {
      return "unknown time";
    }
  }

  function updatePriceStatus() {
    const status = $("#near-price-status");
    if (!status) return;
    status.textContent = "Listed USD price first · exact Testnet NEAR shown at checkout";
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

  function formatDate(ns, includeTime = false) {
    if (!ns) return "Not set";
    try {
      const milliseconds = Number(BigInt(String(ns)) / 1000000n);
      const date = new Date(milliseconds);
      if (Number.isNaN(date.getTime())) return "Not set";
      return new Intl.DateTimeFormat("en-US", includeTime
        ? { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }
        : { month: "short", day: "numeric", year: "numeric" }).format(date);
    } catch (_error) {
      return "Not set";
    }
  }

  function formatStatus(status) {
    const labels = {
      Proposed: "Needs approval",
      AwaitingSupplier: "Awaiting supplier confirmation",
      Declined: "Supplier declined",
      Open: "Open for contributions",
      Funded: "Funded · awaiting delivery",
      FulfillmentPending: "Delivery review",
      FulfillmentApproved: "Delivery approved",
      PaymentPending: "Payment pending",
      Completed: "Completed",
      Failed: "Failed · refunds available",
    };
    return labels[status] || status || "Unknown state";
  }

  function statusClass(status) {
    if (status === "Proposed" || status === "AwaitingSupplier") return "status-proposed";
    if (status === "Declined") return "status-failed";
    if (status === "Open") return "status-open";
    if (status === "Failed") return "status-failed";
    if (status === "PaymentPending" || status === "FulfillmentPending") return "status-pending";
    return "status-funded";
  }

  function statusPill(status) {
    return `<span class="status ${statusClass(status)}"><span></span>${escapeHtml(formatStatus(status))}</span>`;
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
    state.near = { networkId: "testnet", nodeUrl: "https://test.rpc.fastnear.com" };
    try {
      const [{ setupWalletSelector, actionCreators }, { setupMeteorWallet }] = await Promise.all([
        import(`https://esm.sh/@near-wallet-selector/core@${WALLET_SELECTOR_VERSION}?bundle`),
        // Meteor SDK 1.0.24 requires near-api-js ^6.0.0. Pin the ESM dependency
        // so esm.sh does not resolve the incompatible latest major version.
        import(`https://esm.sh/@near-wallet-selector/meteor-wallet@${WALLET_SELECTOR_VERSION}?bundle&deps=near-api-js@${METEOR_SDK_NEAR_API_VERSION}`),
      ]);
      state.selector = await setupWalletSelector({
        network: "testnet",
        modules: [setupMeteorWallet()],
      });
      state.actionCreators = actionCreators;
      state.wallet = await state.selector.wallet("meteor-wallet");
      await syncWalletAccount();
      state.selector.store?.observable?.subscribe(() => syncWalletAccount());
    } catch (error) {
      state.walletError = error;
      state.wallet = null;
    }
    updateWalletUi();
  }

  async function syncWalletAccount() {
    if (!state.wallet || typeof state.wallet.getAccounts !== "function") return;
    try {
      const previousAccountId = state.accountId;
      const accounts = await state.wallet.getAccounts();
      state.accountId = accounts?.[0]?.accountId || null;
      state.memberStatus = null;
      state.fundedMembership = new Map();
      updateWalletUi();
      if (state.dataLoaded) {
        await loadWalletState();
        updateWalletUi();
        const accountChanged = String(previousAccountId || "") !== String(state.accountId || "");
        if (accountChanged || !editableSurfaceOpen()) renderCurrentPage();
        else restoreDraftsInDom();
      }
    } catch (_error) {
      state.accountId = null;
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
    const response = await fetch(state.near.nodeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "harvestpool-ui",
        method: "query",
        params: { request_type: "call_function", finality: "final", account_id: contractId, method_name: methodName, args_base64: encodeArgs(args) },
      }),
    });
    if (!response.ok) throw new Error(`The testnet read returned HTTP ${response.status}.`);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error.message || "The testnet read failed.");
    const raw = new TextDecoder().decode(new Uint8Array(payload.result.result));
    return JSON.parse(raw);
  }

  async function view(methodName, args = {}) {
    return viewOnContract(appConfig.contractId, methodName, args);
  }

  async function viewV3(methodName, args = {}) {
    if (!appConfig.v3ContractId) throw new Error("Member issues are not enabled for this community yet.");
    return viewOnContract(appConfig.v3ContractId, methodName, args);
  }

  async function loadBaseData() {
    const config = await view("get_config");
    const isV4 = ["V4", "V5"].includes(String(config.version || "").toUpperCase());
    const [members, suppliers, countValue] = await Promise.all([
      isV4 ? Promise.resolve([]) : view("get_members"),
      isV4 ? view("get_suppliers") : Promise.resolve([]),
      view("get_purchase_count"),
    ]);
    state.config = config;
    state.members = members || [];
    state.suppliers = suppliers || [];
    const supplierOptions = $("#supplier-options");
    if (supplierOptions) supplierOptions.innerHTML = state.suppliers.map((supplier) => `<option value="${escapeHtml(supplier.account_id)}">${escapeHtml(supplier.business_name)} · ${escapeHtml(supplier.location)}</option>`).join("");
    const count = Math.min(Number(countValue || 0), 500);
    const purchases = await Promise.all(Array.from({ length: count }, (_, id) => view("get_purchase", { purchase_id: String(id) })));
    state.purchases = purchases.filter(Boolean).reverse();
    state.dataLoaded = true;
    await loadWalletState();
    await loadV3Data();
  }

  async function loadV3Data() {
    state.issues = [];
    state.decisions = [];
    state.v3Config = null;
    state.v3Available = false;
    state.v3Error = null;
    if (!appConfig.v3ContractId) return false;
    try {
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
      const [issues, decisions] = await Promise.all([
        Promise.all(Array.from({ length: issueCount }, (_, id) => viewV3("get_issue", { issue_id: String(id) }))),
        Promise.all(Array.from({ length: decisionCount }, (_, id) => viewV3("get_decision", { decision_id: String(id) }))),
      ]);
      state.v3Config = config;
      state.issues = issues.filter(Boolean).reverse();
      state.decisions = decisions.filter(Boolean).reverse();
      state.v3Available = true;
      return true;
    } catch (error) {
      state.v3Error = error;
      return false;
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
      if (purchase?.state === "Completed") return { state: "confirmed", record: purchase };
      return { state: "uncertain", record: purchase };
    }
    if (methodName === "claim_refund") {
      if (commitment?.state === "Refunded") return { state: "confirmed", record: purchase };
      return { state: "uncertain", record: purchase };
    }
    return { state: "uncertain" };
  }

  async function waitForActionConfirmation(action, options = {}) {
    return confirmationTools.waitForState(
      () => readActionConfirmation(action),
      (result) => result && result.state !== "uncertain" ? result : null,
      { attempts: options.attempts || 8, delayMs: options.delayMs ?? 750 },
    );
  }

  function renderPendingConfirmationNotice() {
    let notice = $("#pending-transaction-notice");
    const pending = state.accountId ? pendingActionStore.list(state.accountId) : [];
    if (!pending.length) {
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
    const current = pending[0];
    notice.innerHTML = `<div><strong>${escapeHtml(actionProgressCopy(current.methodName))}</strong><span>We’re checking the result automatically. You can safely leave this page and return later.</span></div>`;
  }

  async function reconcilePendingActions({ poll = false } = {}) {
    if (!state.accountId || state.reconcilingPending) return [];
    state.reconcilingPending = true;
    const pending = pendingActionStore.list(state.accountId);
    const remaining = [];
    try {
      for (const action of pending) {
        const result = poll ? await waitForActionConfirmation(action) : await readActionConfirmation(action).catch(() => ({ state: "uncertain" }));
        if (result?.state === "confirmed") {
          pendingActionStore.remove(action.id);
          showToast(actionSuccessCopy(action.methodName), "success");
        } else if (result?.state === "failed") {
          pendingActionStore.remove(action.id);
          showToast("That action did not complete. Your saved information is unchanged.", "error");
        } else {
          remaining.push(action);
        }
      }
      if (pending.length) {
        await Promise.allSettled([loadBaseData()]);
        renderCurrentPage();
      }
      renderPendingConfirmationNotice();
      return remaining;
    } finally {
      state.reconcilingPending = false;
    }
  }

  function actionSuccessCopy(methodName) {
    if (["create_purchase", "create_open_purchase", "create_supplier_offer"].includes(methodName)) return "Your deal is live!";
    if (methodName === "create_purchase_request") return "Your supplier invitation is ready.";
    if (["commit", "commit_usdc"].includes(methodName)) return "You’re in! Your spot is secured.";
    if (methodName === "raise_issue") return "Your issue has been submitted.";
    if (["vote_on_offer", "vote_on_fulfillment", "vote_on_decision"].includes(methodName)) return "Your vote has been recorded.";
    return "Your update is confirmed.";
  }

  function issueMatches(issue, { purchaseId, requesterId, subject, description, suggestedSolution }) {
    return issue
      && String(issue.purchase_id) === String(purchaseId)
      && String(issue.raised_by) === String(requesterId)
      && issue.subject === subject
      && issue.description === description
      && (suggestedSolution === undefined || String(issue.suggested_solution || "") === String(suggestedSolution || ""));
  }

  function decisionMatches(decision, { issueId, proposal, options, voteType }) {
    const expectedOptions = voteType === "YesNo" ? ["Yes", "No"] : (options || []);
    return decision
      && String(decision.issue_id) === String(issueId)
      && decision.proposal === proposal
      && (!voteType || decision.vote_type === voteType)
      && JSON.stringify(decision.options || []) === JSON.stringify(expectedOptions);
  }

  async function loadWalletState() {
    if (!state.accountId || !state.dataLoaded) {
      state.memberStatus = null;
      state.fundedMembership = new Map();
      return;
    }
    try {
      const isV4 = String(state.config?.version || "").toUpperCase() === "V4";
      state.memberStatus = isV4 ? true : Boolean(await view("is_member", { account_id: state.accountId }));
      const fundedEntries = await Promise.all(state.purchases.map(async (purchase) => {
        try {
          const funded = await view("is_funded_member", { purchase_id: String(purchase.id), account_id: state.accountId });
          return [String(purchase.id), Boolean(funded)];
        } catch (_error) {
          return [String(purchase.id), Boolean(commitmentFor(purchase)?.state === "Active")];
        }
      }));
      state.fundedMembership = new Map(fundedEntries);
      state.recordedVotes = new Map();
      const voteTypes = isV4 ? [["fulfillment", "get_fulfillment_vote"]] : [["offer", "get_offer_vote"], ["fulfillment", "get_fulfillment_vote"]];
      const voteEntries = await Promise.all(state.purchases.flatMap((purchase) => voteTypes.map(async ([type, methodName]) => {
        try {
          const vote = await view(methodName, { purchase_id: String(purchase.id), account_id: state.accountId });
          return [voteStateKey(purchase.id, type), vote === null ? null : { approve: Boolean(vote) }];
        } catch (_error) {
          // Older deployed V2 accounts may not expose the additive per-voter view yet.
          return [voteStateKey(purchase.id, type), null];
        }
      })));
      voteEntries.forEach(([key, vote]) => {
        if (vote) state.recordedVotes.set(key, vote);
      });
    } catch (_error) {
      state.memberStatus = Boolean(state.members.some((member) => String(member) === String(state.accountId)));
      state.fundedMembership = new Map(state.purchases.map((purchase) => [String(purchase.id), Boolean(commitmentFor(purchase)?.state === "Active")]));
      state.recordedVotes = new Map();
    }
  }

  async function loadPurchase(purchaseId) {
    if (!state.dataLoaded) await loadBaseData();
    const purchase = await view("get_purchase", { purchase_id: String(purchaseId) });
    if (!purchase) throw new Error("That purchase does not exist on the current contract.");
    state.currentPurchase = purchase;
    const index = state.purchases.findIndex((item) => String(item.id) === String(purchase.id));
    if (index >= 0) state.purchases[index] = purchase;
    else state.purchases.unshift(purchase);
    return purchase;
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
      showToast(state.walletError ? "The Meteor connector could not load. Reload the page and check the wallet guide." : "The Meteor connector is still loading. Reload the page and try again.", "error");
      return;
    }
    try {
      const accounts = await state.wallet.signIn({
        contractId: appConfig.contractId,
        methodNames: CHANGE_METHODS,
        successUrl: window.location.href,
        failureUrl: window.location.href,
      });
      state.accountId = accounts?.[0]?.accountId || state.accountId;
      await syncWalletAccount();
      if (!state.accountId) showToast("Meteor Wallet did not return a Testnet account.", "error");
    } catch (error) {
      const browserHint = /popup|window|localhost|permission|extension|not supported/i.test(String(error?.message || error || ""))
        ? " Check that Meteor is enabled for this localhost site and that wallet pop-ups are allowed."
        : "";
      showToast(`Meteor Wallet did not connect. Check the selected Testnet account and try again.${browserHint}`, "error");
    }
  }

  async function disconnectWallet() {
    if (state.wallet) await state.wallet.signOut();
    state.accountId = null;
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
    if (state.accountId) {
      if (walletButton) walletButton.textContent = shortAccount(state.accountId);
      if (accountLabel) accountLabel.textContent = state.accountId;
      if (copy) copy.textContent = isMember() ? "Connected with Meteor Wallet. This account is in the initialized community." : "Connected with Meteor Wallet. This account is not in the initialized community.";
      if (signout) signout.hidden = false;
    } else {
      if (walletButton) walletButton.textContent = "Connect wallet";
      if (accountLabel) accountLabel.textContent = "Not connected";
      if (copy) copy.textContent = state.walletError
        ? "The Meteor connector could not load. Public browsing still works; reload after checking the wallet guide."
        : "Meteor Wallet is ready on NEAR Testnet. Connect the account you intend to use to check eligibility and sign actions.";
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
    const message = String(error?.message || error || "").toLowerCase();
    if (/reject|denied|cancelled|canceled|user rejected|declined/.test(message)) return "wallet-rejected";
    if (/capacity|full|oversubscribed|last spot|already has a commitment|duplicate/.test(message)) return "full";
    if (/not enough.*near|insufficient.*near|insufficient balance|lack balance|gas.*balance/.test(message)) return "network-fees";
    return "failed";
  }

  function transactionFriendlyMessage(error, kind, fallback) {
    if (error?.transactionState === "pending") {
      return "We’re still checking the result. Your draft is safe and this action will update automatically.";
    }
    if (kind === "wallet-rejected") return "Your wallet declined this action. Your draft is safe.";
    if (kind === "full") return "This action is no longer available because the latest contract state changed. Your draft is safe.";
    if (kind === "network-fees") return "This wallet does not have enough Testnet NEAR for network fees. No contribution is confirmed.";
    return fallback || "We couldn't complete this action. Your draft is safe. Please try again.";
  }

  async function performTransaction(button, label, action, successMessage, options = {}) {
    if (!ensureSignedIn()) {
      options.onPhase?.("wallet-rejected", "Wallet confirmation required", "Connect a wallet before signing this action.");
      return null;
    }
    if (button && state.pendingTransactions.has(button)) return null;
    if (button) state.pendingTransactions.add(button);
    setBusy(button, true, label);
    options.onPhase?.("wallet", "Wallet confirmation required", "Review the exact action and approve it in your wallet.");
    showToast(label);
    try {
      const pendingAction = Promise.resolve().then(action);
      options.onPhase?.("awaiting", label, "Your wallet request was sent. HarvestPool is checking the result.");
      const outcome = confirmedTransaction(await pendingAction);
      if (options.confirmOnReturn !== false) {
        options.onPhase?.("confirmed", options.confirmedTitle || "Action confirmed", successMessage);
        showToast(successMessage, "success");
      }
      return outcome;
    } catch (error) {
      const kind = transactionErrorKind(error);
      const message = transactionFriendlyMessage(error, kind, options.failureMessage);
      const phaseCopy = kind === "wallet-rejected"
        ? ["wallet-rejected", "Wallet rejected the action", "No state changed on-chain. Your draft is safe."]
        : kind === "full"
          ? ["full", "Contract state changed", "No action was accepted. Your draft is safe."]
          : error?.transactionState === "pending"
            ? ["awaiting", label, "We’re checking the result automatically. Your draft is safe."]
            : ["failed", "Transaction failed", "The contract did not confirm this action. Your draft is safe."];
      options.onPhase?.(...phaseCopy);
      options.onError?.(message, error);
      showToast(message, error?.transactionState === "pending" ? "" : "error");
      return null;
    } finally {
      setBusy(button, false);
      if (button) state.pendingTransactions.delete(button);
    }
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
    decorateMoneyText();
    restoreDraftsInDom();
    $$('[data-decision-form]').forEach(updateDecisionFormType);
  }

  function decorateMoneyText() {
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
    summary.innerHTML = `<span>Total recorded contributions</span><strong>${moneyMarkup(total)}</strong>`;
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
      summary.innerHTML = `<strong>Supplier payment</strong> ${moneyMarkup(purchase.total_funded_amount)} after approved fulfillment`;
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
    const active = fundedMemberCount(purchase);
    const max = Number(purchase.max_quantity || 0);
    const total = Number(purchase.total_quantity || 0);
    const progress = max ? Math.min(100, Math.round((total / max) * 100)) : 0;
    const supplierId = supplierAccount(purchase);
    const supplier = purchase.supplier_business_name || (supplierId ? `Supplier · ${shortAccount(supplierId)}` : "Supplier not set");
    const detailsUrl = `/purchases/${encodeURIComponent(purchase.id)}`;
    const shareUrl = `/share/${encodeURIComponent(purchase.id)}`;
    const spots = fundedMemberCapacity(purchase);
    const memberAlreadyJoined = isFundedMember(purchase) || Boolean(commitmentFor(purchase));
    const canJoin = !memberAlreadyJoined && purchase.state === "Open" && availableCapacity(purchase) > 0 && spots > 0;
    const primaryUrl = canJoin ? `/purchases/${encodeURIComponent(purchase.id)}/join` : detailsUrl;
    const primaryLabel = canJoin ? "Join This Deal" : memberAlreadyJoined ? "View Your Group Buy" : "View Deal";
    const price = listedUsd(purchase);
    const { unit } = unitDetails(purchase);
    const waiting = purchase.state === "AwaitingSupplier" ? `<a href="/supplier-invitations/${encodeURIComponent(purchase.id)}">Review supplier invitation</a>` : `<a href="${primaryUrl}">${primaryLabel}</a>`;
    return `<article class="purchase-card purchase-card-live" data-status="${escapeHtml(purchase.state)}"><div class="purchase-card-top">${statusPill(purchase.state)}<span class="live-card-label">${["V4", "V5"].includes(String(purchase.version).toUpperCase()) ? "Supplier-approved Deal Terms" : "Earlier deal format"}</span></div><h2>${escapeHtml(livePurchaseTitle(purchase))}</h2><p class="purchase-description">${escapeHtml(livePurchaseDescription(purchase))}</p>${packageContentsMarkup(purchase)}<p class="purchase-supplier">${escapeHtml(supplier)}</p><div class="purchase-card-price"><strong>${price ? escapeHtml(price) : escapeHtml(paymentLabel(purchase, purchase.price_per_unit))}</strong><span>per ${escapeHtml(unit)}</span>${price ? `<small>Wallet contribution: ${escapeHtml(paymentLabel(purchase, purchase.price_per_unit))} per ${escapeHtml(unit)}</small>` : ""}</div><div class="progress-label"><span>${quantityLabel(purchase, total)} of ${quantityLabel(purchase, max)} reserved</span><span>${quantityLabel(purchase, availableCapacity(purchase))} available</span></div><div class="progress-track"><span style="width: ${progress}%"></span></div><div class="purchase-card-footer"><span>Last day to join: ${escapeHtml(formatDate(purchase.deadline_ns))}</span>${waiting}</div><button class="card-share-link" type="button" data-action="share-purchase" data-purchase-id="${escapeHtml(purchase.id)}">Share Group Deal</button></article>`;
  }

  function renderExplore() {
    const grid = $("#purchase-grid");
    const empty = $("#explore-empty");
    const disclaimer = $("#explore-disclaimer");
    if (!grid) return;
    const activeFilter = filterTools.normalizeFilter($(".filter-tab.active")?.dataset.filter || "all");
    const allPurchases = state.purchases;
    const visiblePurchases = filterTools.filterPurchases(allPurchases, activeFilter);
    const liveVisible = visiblePurchases;
    const filterLabel = activeFilter === "all" ? "all purchases" : activeFilter === "live" ? "live purchases" : `${activeFilter} purchases`;
    const liveContent = state.dataLoaded
      ? liveVisible.length ? liveVisible.map(renderPurchaseCard).join("") : `<div class="lane-empty"><h3>No ${escapeHtml(activeFilter === "all" ? "available" : activeFilter)} purchases yet.</h3><p>When a purchase is open, its terms and contribution action will appear here.</p><a class="button button-outline button-small" href="/create">Start a purchase</a></div>`
      : `<div class="live-unavailable"><span class="status status-pending"><span></span>Purchases are temporarily unavailable</span><p>We could not read the available purchase list right now. No membership, vote, or payment is shown until the purchase data is confirmed.</p><button class="button button-outline button-small" type="button" data-action="reload-live-data">Try again</button></div>`;
    const totalVisible = visiblePurchases.length;
    grid.innerHTML = `<section class="purchase-source live-source"><div class="source-heading"><div><span class="section-kicker">Available purchases</span><h2>Purchases in motion.</h2><p>Read the terms, shared target, and next decision before you connect a wallet.</p></div><span class="live-source-label"><span class="live-pulse"></span>Live</span></div><div class="purchase-grid purchase-grid-live">${liveContent}</div></section>`;
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
    const labels = { all: "All", live: "Live", open: "Open", funded: "Funded", completed: "Completed" };
    $$(".filter-tab", tabs).forEach((button) => {
      const filter = String(button.dataset.filter || "all").toLowerCase();
      button.dataset.filter = filter;
      if (labels[filter]) button.textContent = labels[filter];
    });
    if (!$(".filter-tab[data-filter=live]", tabs)) {
      const live = document.createElement("button");
      live.className = "filter-tab";
      live.type = "button";
      live.dataset.filter = "live";
      live.textContent = "Live";
      tabs.insertBefore(live, $(".filter-tab[data-filter=open]", tabs) || null);
    }
  }

  function detailsEligibility(purchase, mode = "contribute") {
    const commitment = commitmentFor(purchase);
    if (!state.accountId) return `<div class="eligibility-callout warning">${icon("shield")}<span>Connect a wallet to check whether this purchase is available to you. Opening this link does not reserve a place.</span></div>`;
    if (!isOpenMembership(purchase) && !isMember()) return `<div class="eligibility-callout error">${icon("shield")}<span><strong>This wallet is not in the current community.</strong><br>Joining by link cannot add membership under the Phase 1 contract, so no contribution or vote will be attempted.</span></div>`;
    if (commitment && commitment.state === "Active") return `<div class="eligibility-callout">${icon("shield")}<span><strong>This wallet is a funded member.</strong><br>${mode === "vote" ? "You may vote once on the current decision." : "This purchase is already on your dashboard."}</span></div>`;
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
    if (!issue?.active_decision_id) return null;
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
    if (!state.accountId || !purchase || !isFundedMember(purchase) || issue.state !== "Open" || !state.v3Available) return "";
    const deadline = new Date(Date.now() + 3 * 86400000);
    return `<form class="issue-decision-form" data-decision-form data-draft-form="request-group-vote" data-draft-purchase-id="${escapeHtml(issue.purchase_id)}" data-draft-issue-id="${escapeHtml(issue.id)}" data-issue-id="${escapeHtml(issue.id)}"><div class="issue-form-heading"><strong>Suggest a group decision</strong><span>Public vote · pickup arrangements only</span></div><label for="vote-type-${escapeHtml(issue.id)}">How should members answer?</label><select id="vote-type-${escapeHtml(issue.id)}" name="vote_type"><option value="yes_no">Yes or No on one proposal</option><option value="multiple_choice">Choose from several options</option></select><label for="proposal-${escapeHtml(issue.id)}">What should the group decide?</label><input id="proposal-${escapeHtml(issue.id)}" name="proposal" type="text" maxlength="500" value="${escapeHtml(issue.suggested_solution || "Approve a pickup arrangement for this order.")}" required><div data-multiple-choice-fields hidden><p class="field-help">Add two to four different choices. An option must receive two-thirds of all eligible members; a simple plurality does not win.</p><div class="issue-options-grid"><div><label for="option-a-${escapeHtml(issue.id)}">Choice 1</label><input id="option-a-${escapeHtml(issue.id)}" name="option_a" type="text" maxlength="120" placeholder="Saturday morning"></div><div><label for="option-b-${escapeHtml(issue.id)}">Choice 2</label><input id="option-b-${escapeHtml(issue.id)}" name="option_b" type="text" placeholder="Sunday afternoon" maxlength="120"></div><div><label for="option-c-${escapeHtml(issue.id)}">Choice 3 (optional)</label><input id="option-c-${escapeHtml(issue.id)}" name="option_c" type="text" placeholder="Tuesday evening" maxlength="120"></div><div><label for="option-d-${escapeHtml(issue.id)}">Choice 4 (optional)</label><input id="option-d-${escapeHtml(issue.id)}" name="option_d" type="text" placeholder="Another valid time" maxlength="120"></div></div></div><p class="field-help">Votes and voter accounts are public. Supplier approval is requested only after members pass a change.</p><label for="deadline-${escapeHtml(issue.id)}">Voting closes</label><input id="deadline-${escapeHtml(issue.id)}" name="deadline" type="datetime-local" value="${escapeHtml(localDateValue(deadline))}" required><div class="draft-actions"><button class="button button-outline button-small" type="button" data-action="discard-draft">Discard draft</button><button class="button button-outline button-small" type="submit">Request a group vote</button></div></form>`;
  }

  function renderIssueCard(issue, options = {}) {
    const purchase = state.purchases.find((item) => String(item.id) === String(issue.purchase_id));
    const decision = decisionForIssue(issue);
    const showRequest = options.showRequest !== false;
    const purchaseLabel = purchase ? livePurchaseTitle(purchase) : `Purchase #${issue.purchase_id}`;
    const actions = [];
    if (issue.state === "Open" && purchase && (String(purchase.proposer) === String(state.accountId) || String(purchase.farmer_id) === String(state.accountId))) {
      actions.push(`<button class="button button-outline button-small" type="button" data-action="resolve-issue" data-issue-id="${escapeHtml(issue.id)}">Mark resolved</button>`);
    }
    if (decision && String(decision.supplier_id) === String(state.accountId) && decision.state === "AwaitingSupplier" && decision.requires_supplier_consent) {
      actions.push(`<button class="button button-primary button-small" type="button" data-action="agree-decision" data-decision-id="${escapeHtml(decision.id)}">Agree to this pickup plan</button><button class="button button-outline button-small" type="button" data-action="decline-decision" data-decision-id="${escapeHtml(decision.id)}">Decline</button>`);
    }
    if (decision && (decision.state === "Open" || decision.state === "AwaitingSupplier") && deadlineHasPassed(decision.deadline_ns)) {
      actions.push(`<button class="button button-outline button-small" type="button" data-action="expire-decision" data-decision-id="${escapeHtml(decision.id)}">Close expired vote</button>`);
    }
    return `<article class="issue-card" data-issue-id="${escapeHtml(issue.id)}"><div class="issue-card-top"><span class="issue-status issue-status-${escapeHtml(String(issue.state).toLowerCase())}">${escapeHtml(issueStateLabel(issue.state))}</span><span class="section-kicker">Issue #${escapeHtml(issue.id)}</span></div><h3>${escapeHtml(issue.subject)}</h3><p class="issue-purchase">${escapeHtml(purchaseLabel)} · raised by ${escapeHtml(shortAccount(issue.raised_by))}</p><p class="issue-description">${escapeHtml(issue.description)}</p>${issue.suggested_solution ? `<div class="issue-suggestion"><strong>Suggested solution</strong><span>${escapeHtml(issue.suggested_solution)}</span></div>` : ""}${decision ? `<div class="issue-decision"><div class="issue-decision-top"><strong>${escapeHtml(decisionStateLabel(decision.state))}</strong><span>Public ${decision.vote_type === "YesNo" ? "Yes/No proposal" : "multiple-choice decision"} · ${decision.votes.length} of ${decision.eligible_voters.length} members voted · ${decision.required_yes_votes} ${decision.vote_type === "YesNo" ? "Yes votes" : "matching votes"} needed</span></div><p>${escapeHtml(decision.proposal)}</p><div class="issue-choice-list">${decision.options.map((option, index) => `<span class="issue-choice ${decision.selected_option === index ? "is-selected" : ""}">${escapeHtml(option)}${decision.selected_option === index ? " · result" : ""}</span>`).join("")}</div>${decisionControls(decision)}</div>` : showRequest ? issueDecisionRequestForm(issue, purchase) : ""}${actions.length ? `<div class="issue-actions">${actions.join("")}</div>` : ""}<div class="issue-card-footer"><a class="text-link" href="/purchases/${encodeURIComponent(issue.purchase_id)}">Open purchase <span aria-hidden="true">↗</span></a></div></article>`;
  }

  function renderPurchaseIssues(purchase) {
    if (!appConfig.v3ContractId) {
      return `<section class="issues-section"><div class="section-heading-inline"><div><span class="section-kicker">Issues &amp; decisions</span><h2>Make space for concerns.</h2></div></div><div class="issues-unavailable"><p>Member issues will appear here when this community turns them on.</p></div></section>`;
    }
    if (!state.v3Available) {
      return `<section class="issues-section"><div class="section-heading-inline"><div><span class="section-kicker">Issues &amp; decisions</span><h2>Issues are temporarily unavailable.</h2></div></div><div class="issues-unavailable"><p>Refresh this page to check the latest issue and decision status.</p></div></section>`;
    }
    const issues = state.issues.filter((issue) => String(issue.purchase_id) === String(purchase.id));
    const raiseAction = isFundedMember(purchase) ? `<a class="button button-primary button-small" href="/purchases/${encodeURIComponent(purchase.id)}/issue">Raise an issue</a>` : "";
    return `<section class="issues-section"><div class="section-heading-inline"><div><span class="section-kicker">Issues &amp; decisions</span><h2>Raise a concern without a confrontation.</h2><p class="section-heading-copy">Ask a question, suggest a practical fix, or request a group decision when one is needed.</p></div>${raiseAction}</div>${issues.length ? `<div class="issue-list">${issues.map((issue) => renderIssueCard(issue, { showRequest: true })).join("")}</div>` : `<div class="issues-empty"><p>No issues have been raised for this purchase.</p>${isFundedMember(purchase) ? "<span>You're one of the funded members who can start the conversation.</span>" : "<span>Funded members can raise a concern about this purchase.</span>"}</div>`}</section>`;
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
    const alreadyJoined = isFundedMember(purchase) || Boolean(commitmentFor(purchase));
    const canJoin = !alreadyJoined && purchase.state === "Open" && availableCapacity(purchase) > 0 && fundedMemberCapacity(purchase) > 0;
    const action = alreadyJoined
      ? `<a class="button button-dark" href="/dashboard">View in My Group Buys</a>`
      : canJoin
      ? `<a class="button button-primary" href="/purchases/${encodeURIComponent(purchase.id)}/join">Join This Deal</a>`
      : purchase.state === "AwaitingSupplier"
        ? `<a class="button button-primary" href="/supplier-invitations/${encodeURIComponent(purchase.id)}">Supplier review</a>`
        : "";
    const listed = listedUsd(purchase) || "Listed USD price unavailable";
    const { unit } = unitDetails(purchase);
    root.innerHTML = `<div class="details-top"><div><p class="eyebrow">Group Deal #${escapeHtml(purchase.id)}</p><h1>${escapeHtml(livePurchaseTitle(purchase))}</h1><p class="supplier-line">From <strong>${escapeHtml(supplierName(purchase))}</strong> · ${escapeHtml(purchase.supplier_location || "Location not listed")}</p><p class="details-description">${escapeHtml(livePurchaseDescription(purchase))}</p>${packageContentsMarkup(purchase)}</div><div class="details-actions"><button class="share-button" type="button" data-action="share-purchase" data-purchase-id="${escapeHtml(purchase.id)}">${icon("link")}Share Group Deal</button>${action}</div></div>
      <div class="details-layout"><div><section class="detail-panel funding-panel">${statusPill(purchase.state)}<h2>${escapeHtml(listed)} per ${escapeHtml(unit)}</h2><p class="funding-description">At checkout, your wallet will show exactly ${escapeHtml(formatNear(purchase.price_per_unit))} Testnet NEAR per ${escapeHtml(unit)}. This is separate from the listed USD price.</p><div class="funding-big"><strong>${total} / ${max}</strong><span>${escapeHtml(pluralUnit(unit, max))} reserved</span></div><div class="progress-label"><span>${fundedMemberCount(purchase)} buyers joined</span><span>${quantityLabel(purchase, availableCapacity(purchase))} available</span></div><div class="progress-track"><span style="width: ${progress}%"></span></div><div class="funding-meta"><div><strong>${quantityLabel(purchase, purchase.min_quantity)}</strong><span>minimum needed</span></div><div><strong>Maximum ${quantityLabel(purchase, purchase.max_quantity_per_household)}</strong><span>per buyer</span></div><div><strong>${escapeHtml(formatDate(purchase.deadline_ns))}</strong><span>last day to join or cancel</span></div><div><strong>${escapeHtml(formatDate(purchase.fulfillment_evidence_deadline_ns))}</strong><span>fulfillment due</span></div></div></section><section class="detail-panel" style="margin-top:18px"><span class="section-kicker">Pickup or delivery</span><h2>How members receive the order</h2><p>${escapeHtml(purchase.pickup_or_delivery)}</p><p><strong>Contact the supplier:</strong> ${escapeHtml(purchase.supplier_public_contact)}</p></section></div>
      <aside><section class="detail-panel detail-panel-dark"><span class="section-kicker">Deal Terms</span><h2>What everyone agreed to</h2><dl class="term-list"><div class="term-row"><dt>You receive</dt><dd>${escapeHtml(purchase.description)}${unitDetails(purchase).contents ? ` · ${escapeHtml(unitDetails(purchase).contents)}` : ""}</dd></div><div class="term-row"><dt>Listed price</dt><dd>${escapeHtml(listed)} per ${escapeHtml(unit)}</dd></div><div class="term-row"><dt>Wallet contribution</dt><dd>${escapeHtml(formatNear(purchase.price_per_unit))} Testnet NEAR per ${escapeHtml(unit)}</dd></div><div class="term-row"><dt>Group target</dt><dd>At least ${quantityLabel(purchase, purchase.min_quantity)} by ${escapeHtml(formatDate(purchase.deadline_ns, true))}</dd></div><div class="term-row"><dt>Buyer limit</dt><dd>Maximum ${quantityLabel(purchase, purchase.max_quantity_per_household)} per buyer</dd></div><div class="term-row"><dt>Voluntary cancellation</dt><dd>Available until the same group closing time</dd></div><div class="term-row"><dt>If the order fails</dt><dd>${escapeHtml(purchase.cancellation_and_refund_terms)}</dd></div><div class="term-row"><dt>Delivery and payment</dt><dd>The supplier submits a delivery reference. Funded buyers confirm fulfillment before payment can be released.</dd></div></dl>${detailsEligibility(purchase)}<details class="technical-details"><summary>Agreement record</summary><p>Supplier wallet: ${escapeHtml(purchase.supplier_id)}</p><p>Terms fingerprint: <code>${escapeHtml(purchase.terms_hash)}</code></p>${agreement ? `<p>Accepted on ${escapeHtml(formatDate(agreement.accepted_at_ns, true))}.</p>` : "<p>The named supplier has not accepted these terms.</p>"}</details></section></aside></div>`;
    normalizePaymentCopy(root, purchase);
  }

  function renderV4Agreement(root, purchase) {
    const capacity = availableCapacity(purchase);
    const fundedSpots = fundedMemberCapacity(purchase);
    const commitment = commitmentFor(purchase);
    const canContribute = Boolean(state.accountId && !commitment && purchase.state === "Open" && capacity > 0 && fundedSpots > 0);
    const listed = listedUsd(purchase) || "USD price unavailable";
    const { unit, contents } = unitDetails(purchase);
    root.innerHTML = `<div class="agreement-header"><p class="eyebrow">Deal Terms · #${escapeHtml(purchase.id)}</p><h1>Review the deal before you join.</h1><p>Your spot is secured only after the contribution is confirmed. Every funded buyer gets one vote, regardless of quantity.</p></div><div class="agreement-grid"><section class="agreement-copy"><span class="section-kicker">Deal Terms</span><h2>${escapeHtml(livePurchaseTitle(purchase))}</h2><dl class="term-list agreement-terms"><div class="term-row"><dt>What you receive</dt><dd>${escapeHtml(purchase.description)}</dd></div>${contents ? `<div class="term-row"><dt>Package contents</dt><dd>Each ${escapeHtml(unit)} contains ${escapeHtml(contents)}</dd></div>` : ""}<div class="term-row"><dt>Supplier</dt><dd>${escapeHtml(supplierName(purchase))} · ${escapeHtml(purchase.supplier_location)}</dd></div><div class="term-row"><dt>Listed price</dt><dd>${escapeHtml(listed)} per ${escapeHtml(unit)}</dd></div><div class="term-row"><dt>Wallet contribution</dt><dd>${escapeHtml(formatNear(purchase.price_per_unit))} Testnet NEAR per ${escapeHtml(unit)}</dd></div><div class="term-row"><dt>Group target</dt><dd>${quantityLabel(purchase, purchase.min_quantity)} by ${escapeHtml(formatDate(purchase.deadline_ns, true))}</dd></div><div class="term-row"><dt>Buyer limit</dt><dd>Maximum ${quantityLabel(purchase, purchase.max_quantity_per_household)} per buyer</dd></div><div class="term-row"><dt>Voluntary cancellation ends</dt><dd>${escapeHtml(formatDate(purchase.cancellation_deadline_ns, true))}</dd></div><div class="term-row"><dt>If the deal does not go ahead</dt><dd>${escapeHtml(purchase.cancellation_and_refund_terms)}</dd></div><div class="term-row"><dt>How delivery is confirmed</dt><dd>Each funded buyer gets one public fulfillment vote, regardless of quantity.</dd></div><div class="term-row"><dt>When the supplier is paid</dt><dd>Only after the supplier submits delivery details and enough funded buyers approve fulfillment.</dd></div></dl>${detailsEligibility(purchase)}</section><aside class="contribution-panel"><span class="section-kicker">Join This Deal</span><h2>${escapeHtml(listed)} per ${escapeHtml(unit)}</h2><p>Before wallet approval, you’ll see the exact contribution of ${escapeHtml(formatNear(purchase.price_per_unit))} Testnet NEAR per ${escapeHtml(unit)}. It is separate from the listed USD price.</p><div class="contribution-summary"><div><span>Buyer spots</span><strong>${escapeHtml(spotLabel(fundedSpots))}</strong></div><div><span>Available</span><strong>${quantityLabel(purchase, capacity)}</strong></div><div><span>Buyer limit</span><strong>${quantityLabel(purchase, purchase.max_quantity_per_household)}</strong></div><div><span>Last day to join</span><strong>${escapeHtml(formatDate(purchase.deadline_ns))}</strong></div></div>${!state.accountId ? `<button class="button contribution-connect" type="button" data-connect-wallet>Connect wallet</button>` : ""}<div class="quantity-field"><label for="contribution-quantity">How many ${escapeHtml(pluralUnit(unit))}?</label><div class="quantity-input-wrap"><button type="button" aria-label="Decrease quantity" data-action="quantity-minus" ${canContribute ? "" : "disabled"}>−</button><input id="contribution-quantity" type="number" min="1" max="${Math.max(1, Math.min(capacity, Number(purchase.max_quantity_per_household || capacity)))}" value="1" ${canContribute ? "" : "disabled"}><button type="button" aria-label="Increase quantity" data-action="quantity-plus" ${canContribute ? "" : "disabled"}>+</button></div></div><div class="quantity-total"><span>Wallet contribution</span><strong id="contribution-total">${moneyMarkup(purchase.price_per_unit)}</strong></div><div class="agreement-acceptance"><input id="agreement-acceptance" type="checkbox" required><label for="agreement-acceptance">I have read and accept the Deal Terms, contribution amount, cancellation rules, and refund conditions.</label></div><button class="button" type="button" data-action="contribute" data-purchase-id="${escapeHtml(purchase.id)}" data-eligible="${canContribute ? "true" : "false"}" disabled>Join This Deal</button><p class="contribution-footnote">Your spot appears in My Group Buys only after the contribution is confirmed.</p></aside></div>`;
    root.dataset.price = purchase.price_per_unit;
    normalizePaymentCopy(root, purchase);
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
    const controls = purchase.state === "AwaitingSupplier" && namedWallet
      ? `<div class="supplier-invitation-actions"><button class="button button-primary" type="button" data-action="accept-supplier-request" data-purchase-id="${escapeHtml(purchase.id)}">Accept and open contributions</button><button class="button button-outline" type="button" data-action="decline-supplier-request" data-purchase-id="${escapeHtml(purchase.id)}">Decline</button></div>`
      : purchase.state === "AwaitingSupplier" && !state.accountId ? `<button class="button button-dark" type="button" data-connect-wallet>Connect supplier wallet</button>`
      : purchase.state === "AwaitingSupplier" ? `<div class="eligibility-callout warning">${icon("shield")}<span>This invitation names a different supplier wallet. The link alone cannot accept the terms.</span></div>`
      : `<div class="eligibility-callout">${icon("shield")}<span>${escapeHtml(formatStatus(purchase.state))}</span></div>`;
    const { unit, contents } = unitDetails(purchase);
    root.innerHTML = `<div class="agreement-header"><p class="eyebrow">Supplier invitation · Group Deal #${escapeHtml(purchase.id)}</p><h1>${escapeHtml(supplierName(purchase))}, review the complete offer.</h1><p>Only the named supplier wallet can approve these exact Deal Terms.</p></div><div class="agreement-grid"><section class="agreement-copy"><h2>${escapeHtml(livePurchaseTitle(purchase))}</h2><dl class="term-list agreement-terms"><div class="term-row"><dt>Product</dt><dd>${escapeHtml(purchase.description)}</dd></div>${contents ? `<div class="term-row"><dt>Package contents</dt><dd>Each ${escapeHtml(unit)} contains ${escapeHtml(contents)}</dd></div>` : ""}<div class="term-row"><dt>Listed price</dt><dd>${escapeHtml(listedUsd(purchase) || "Unavailable")} per ${escapeHtml(unit)}</dd></div><div class="term-row"><dt>Wallet contribution</dt><dd>${escapeHtml(formatNear(purchase.price_per_unit))} Testnet NEAR per ${escapeHtml(unit)}</dd></div><div class="term-row"><dt>Deal range</dt><dd>${quantityLabel(purchase, purchase.min_quantity)}–${quantityLabel(purchase, purchase.max_quantity)}</dd></div><div class="term-row"><dt>Buyer limit</dt><dd>Up to ${quantityLabel(purchase, purchase.max_quantity_per_household)} per buyer</dd></div><div class="term-row"><dt>Buyer capacity</dt><dd>Up to ${purchase.max_funded_members} funded buyers</dd></div><div class="term-row"><dt>Group closes</dt><dd>${escapeHtml(formatDate(purchase.deadline_ns, true))}</dd></div><div class="term-row"><dt>Fulfillment due</dt><dd>${escapeHtml(formatDate(purchase.fulfillment_evidence_deadline_ns, true))}</dd></div><div class="term-row"><dt>Pickup or delivery</dt><dd>${escapeHtml(purchase.pickup_or_delivery)}</dd></div><div class="term-row"><dt>Refund promise</dt><dd>${escapeHtml(purchase.cancellation_and_refund_terms)}</dd></div></dl><details class="technical-details"><summary>Agreement record</summary><code>${escapeHtml(purchase.terms_hash)}</code></details></section><aside class="contribution-panel"><span class="section-kicker">Supplier response</span><h2>${escapeHtml(formatStatus(purchase.state))}</h2><p>Approving locks your supplier account and these complete terms. Contributions then open.</p>${controls}</aside></div>`;
    normalizePaymentCopy(root, purchase);
  }

  function renderDetailsPage() {
    const root = $("#details-content");
    const id = $("#details-root")?.dataset.purchaseId;
    if (!root || !id) {
      showError(root, "No purchase selected", "Use a purchase link from Explore to view its live terms.", '<a class="button button-outline" href="/purchases">Explore purchases</a>');
      return;
    }
    if (!state.dataLoaded) return;
    const purchase = state.currentPurchase || state.purchases.find((item) => String(item.id) === String(id));
    if (!purchase) {
      showError(root, "Purchase not found", "This purchase is not available in the current testnet contract.", '<a class="button button-outline" href="/purchases">Back to Explore</a>');
      return;
    }
    state.currentPurchase = purchase;
    if (["V4", "V5"].includes(String(purchase.version).toUpperCase())) {
      renderV4Details(root, purchase);
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
    if (purchase.state === "Open" && availableCapacity(purchase) > 0 && fundedMemberCapacity(purchase) > 0) primaryAction = `<a class="button button-primary" href="/purchases/${encodeURIComponent(purchase.id)}/join">Join &amp; Contribute <span aria-hidden="true">↗</span></a>`;
    else if (purchase.state === "Open" && (availableCapacity(purchase) === 0 || fundedMemberCapacity(purchase) === 0)) primaryAction = `<span class="group-full-label" role="status">Group Full</span>`;
    else if (purchase.state === "Proposed") primaryAction = `<a class="button button-primary" href="/decisions">Review offer vote <span aria-hidden="true">↗</span></a>`;
    else if (isFundedMember(purchase)) primaryAction = `<a class="button button-dark" href="/dashboard">Open your dashboard <span aria-hidden="true">↗</span></a>`;
    const finalizeAction = (purchase.state === "Proposed" || purchase.state === "Open") && deadlineHasPassed(purchase.deadline_ns)
      ? `<button class="button button-outline" type="button" data-action="finalize" data-purchase-id="${escapeHtml(purchase.id)}">Finalize after deadline</button>`
      : "";
    const shareUrl = `${window.location.origin}/share/${encodeURIComponent(purchase.id)}`;
    root.innerHTML = `<div class="details-top"><div><p class="eyebrow">Purchase #${escapeHtml(purchase.id)} · existing V2 terms</p><h1>${escapeHtml(livePurchaseTitle(purchase))}</h1><p class="supplier-line">Named supplier wallet: <strong>${escapeHtml(shortAccount(purchase.farmer_id))}</strong></p><p class="details-description">${escapeHtml(livePurchaseDescription(purchase))}</p></div><div class="details-actions"><button class="share-button" type="button" data-action="share-purchase" data-purchase-id="${escapeHtml(purchase.id)}">${icon("link")}Share purchase</button>${finalizeAction}${primaryAction}</div></div><div class="details-layout"><div><section class="detail-panel funding-panel"><span class="section-kicker">Group funding</span><h2>${escapeHtml(formatStatus(purchase.state))}</h2><p class="funding-description">${escapeHtml(livePurchaseDescription(purchase))}</p><div class="funding-big"><strong>${total} / ${max}</strong><span>units funded</span></div><div class="progress-label"><span>${fundedCount} / ${fundedCapacity} funded households</span><span>${progress}% of units</span></div><div class="progress-track"><span style="width: ${progress}%"></span></div><div class="funding-meta"><div><strong>${escapeHtml(formatNear(purchase.price_per_unit))} NEAR</strong><span>price / unit</span></div><div><strong>${escapeHtml(spotLabel(fundedMemberCapacity(purchase)))}</strong><span>household capacity</span></div><div><strong>${availableCapacity(purchase)} units</strong><span>unit capacity left</span></div><div><strong>${escapeHtml(formatDate(purchase.deadline_ns))}</strong><span>last day to contribute</span></div></div></section><section class="detail-panel" style="margin-top: 18px"><span class="section-kicker">Group members</span><h2>Who has a funded place</h2><p class="field-help">Only active contributions count as funded members.</p><div class="members-list">${active.length ? active.map((commitment) => `<div class="member-row"><span class="member-id">${escapeHtml(shortAccount(commitment.account_id))}</span><span class="member-quantity">${commitment.quantity} unit${commitment.quantity === 1 ? "" : "s"} · ${escapeHtml(formatNear(commitment.amount))} NEAR</span></div>`).join("") : '<p class="field-help">No funded members yet.</p>'}</div></section></div><aside><section class="detail-panel detail-panel-dark"><span class="section-kicker">Purchase agreement</span><h2>What you receive, pay, and approve</h2><dl class="term-list"><div class="term-row"><dt>Product</dt><dd>${escapeHtml(livePurchaseTitle(purchase))}</dd></div><div class="term-row"><dt>Minimum order</dt><dd>${purchase.min_quantity} units</dd></div><div class="term-row"><dt>Maximum order</dt><dd>${purchase.max_quantity} units</dd></div><div class="term-row"><dt>Contribution</dt><dd>${escapeHtml(formatNear(purchase.price_per_unit))} Testnet NEAR per unit</dd></div><div class="term-row"><dt>Before contributions open</dt><dd>This existing V2 purchase requires ${purchase.required_offer_yes_votes} community approvals.</dd></div><div class="term-row"><dt>Delivery confirmation</dt><dd>${purchase.required_fulfillment_yes_votes ? `${purchase.required_fulfillment_yes_votes} funded households must approve` : "Set after the group is funded"}</dd></div><div class="term-row"><dt>Cancel by</dt><dd>${escapeHtml(formatDate(purchase.cancellation_deadline_ns, true))}</dd></div><div class="term-row"><dt>Fulfillment review by</dt><dd>${escapeHtml(formatDate(purchase.fulfillment_evidence_deadline_ns, true))}</dd></div><div class="term-row"><dt>Supplier payment</dt><dd>Only after approved delivery evidence</dd></div><div class="term-row"><dt>If the order fails</dt><dd>${refundRateLabel(purchase.failed_order_refund_bps)} refund becomes claimable</dd></div></dl>${detailsEligibility(purchase)}<details class="technical-details"><summary>Wallet and contract details</summary><p>Supplier wallet: ${escapeHtml(purchase.farmer_id)}</p><p>Organizer wallet: ${escapeHtml(purchase.proposer)}</p></details></section></aside></div>`;
    root.insertAdjacentHTML("beforeend", renderPurchaseIssues(purchase));
  }

  function decorateDetailsActions() {
    const purchase = state.currentPurchase;
    const actions = $(".details-actions");
    if (!purchase || !actions) return;
    const actionMarkup = [];
    if ((purchase.state === "Funded" || purchase.state === "FulfillmentPending") && deadlineHasPassed(purchase.fulfillment_evidence_deadline_ns)) actionMarkup.push(`<button class="button button-outline" type="button" data-action="expire-unfulfilled" data-purchase-id="${escapeHtml(purchase.id)}">Mark unfulfilled</button>`);
    if (purchase.state === "FulfillmentApproved") actionMarkup.push(`<button class="button button-primary" type="button" data-action="release-payment" data-purchase-id="${escapeHtml(purchase.id)}">Release supplier payment</button>`);
    if (actionMarkup.length) actions.insertAdjacentHTML("beforeend", actionMarkup.join(""));
  }

  function renderAgreementPage() {
    const root = $("#agreement-content");
    const id = $("#agreement-root")?.dataset.purchaseId;
    if (!root || !id || !state.dataLoaded) return;
    const purchase = state.currentPurchase || state.purchases.find((item) => String(item.id) === String(id));
    if (!purchase) {
      showError(root, "Purchase not found", "This purchase is not available in the current testnet contract.", '<a class="button button-outline" href="/purchases">Back to Explore</a>');
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
    const canContribute = eligibility.eligibleBeforeAgreement;
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
    if (!root || !state.accountId) return;
    const joinedDeals = state.purchases.filter((purchase) => commitmentFor(purchase));
    const createdDeals = state.purchases.filter((purchase) => String(purchase.proposer || "") === String(state.accountId));
    const joinedCard = (purchase) => {
      const commitment = commitmentFor(purchase);
      const funded = commitment.state === "Active" && isFundedMember(purchase);
      const listed = listedUsd(purchase);
      const refundAction = commitment.state === "Refundable" ? `<button class="button button-primary button-small" type="button" data-action="claim-refund" data-purchase-id="${escapeHtml(purchase.id)}">Claim Refund</button>` : "";
      const cancelAction = funded && purchase.state === "Open" && !deadlineHasPassed(purchase.cancellation_deadline_ns) ? `<button class="button button-outline button-small" type="button" data-action="cancel-commitment" data-purchase-id="${escapeHtml(purchase.id)}">Cancel Before Deadline</button>` : "";
      const issueAction = funded && appConfig.v3ContractId ? `<a class="button button-outline button-small" href="/purchases/${encodeURIComponent(purchase.id)}/issue">Raise an Issue</a>` : "";
      const listedTotal = listed ? `${listed} × ${commitment.quantity}` : "Listed price unavailable";
      return `<article class="member-purchase-card"><div class="purchase-card-top">${statusPill(purchase.state)}<span class="section-kicker">Deal #${escapeHtml(purchase.id)}</span></div><h3>${escapeHtml(livePurchaseTitle(purchase))}</h3><p class="purchase-supplier">Supplier: ${escapeHtml(supplierName(purchase))}</p>${packageContentsMarkup(purchase)}<p><span class="member-funded-status ${funded ? "is-funded" : ""}">${funded ? "Spot secured" : `Order status: ${escapeHtml(commitment.state)}`}</span></p><div class="member-card-meta"><span><strong>${quantityLabel(purchase, commitment.quantity)}</strong> reserved</span><span><strong>${escapeHtml(listedTotal)}</strong> listed value</span><span><strong>${escapeHtml(formatNear(commitment.amount))} Testnet NEAR</strong> contributed</span><span><strong>${quantityLabel(purchase, purchase.total_quantity)} of ${quantityLabel(purchase, purchase.min_quantity)}</strong> toward minimum</span><span><strong>${escapeHtml(formatDate(purchase.deadline_ns))}</strong> deal closes</span><span><strong>${escapeHtml(formatDate(purchase.fulfillment_evidence_deadline_ns))}</strong> fulfillment due</span></div><div class="card-actions"><a class="button button-dark button-small" href="/purchases/${encodeURIComponent(purchase.id)}">View Group Buy</a>${issueAction}${cancelAction}${refundAction}</div></article>`;
    };
    const createdCard = (purchase) => {
      const invitation = purchase.state === "AwaitingSupplier" ? `<a class="button button-primary button-small" href="/supplier-invitations/${encodeURIComponent(purchase.id)}">View Supplier Invitation</a>` : "";
      return `<article class="member-purchase-card"><div class="purchase-card-top">${statusPill(purchase.state)}<span class="section-kicker">Deal #${escapeHtml(purchase.id)}</span></div><h3>${escapeHtml(livePurchaseTitle(purchase))}</h3><p class="purchase-supplier">Supplier: ${escapeHtml(supplierName(purchase))}</p><div class="member-card-meta"><span><strong>${quantityLabel(purchase, purchase.total_quantity)} of ${quantityLabel(purchase, purchase.min_quantity)}</strong> reserved</span><span><strong>${quantityLabel(purchase, availableCapacity(purchase))}</strong> available</span><span><strong>${fundedMemberCount(purchase)}</strong> buyers joined</span><span><strong>${escapeHtml(formatDate(purchase.deadline_ns))}</strong> deal closes</span></div><div class="card-actions"><a class="button button-outline button-small" href="/purchases/${encodeURIComponent(purchase.id)}">View Group Deal</a>${invitation}</div></article>`;
    };
    const joinedSection = joinedDeals.length ? `<section class="dashboard-group"><div class="section-heading-inline"><div><span class="section-kicker">Deals you joined</span><h2>Your secured group buys</h2></div></div><div class="dashboard-grid">${joinedDeals.map(joinedCard).join("")}</div></section>` : `<section class="dashboard-group"><div class="dashboard-empty"><h2>No joined deals yet.</h2><p>When a contribution is confirmed, your quantity, supplier, progress, and deadlines will appear here.</p><a class="button button-primary" href="/purchases">Explore Deals</a></div></section>`;
    const createdSection = createdDeals.length ? `<section class="dashboard-group"><div class="section-heading-inline"><div><span class="section-kicker">Deals you created</span><h2>Your posted Group Deals</h2></div></div><div class="dashboard-grid">${createdDeals.map(createdCard).join("")}</div></section>` : `<section class="dashboard-group"><div class="dashboard-empty"><h2>No posted deals yet.</h2><p>Post a Group Deal when you are ready to organize an order or publish a supplier offer.</p><a class="button button-outline" href="/create">Post a Group Deal</a></div></section>`;
    root.innerHTML = `<div class="dashboard-toolbar"><div><span class="section-kicker">Connected wallet</span><h2>My Group Buys</h2></div><span class="wallet-caption">${escapeHtml(shortAccount(state.accountId))}</span></div>${joinedSection}${createdSection}`;
  }

  function renderDecisionCard(purchase, type) {
    const isOffer = type === "offer";
    const required = isOffer ? Number(purchase.required_offer_yes_votes || 0) : Number(purchase.required_fulfillment_yes_votes || 0);
    const yes = isOffer ? Number(purchase.offer_yes_votes || 0) : Number(purchase.fulfillment_yes_votes || 0);
    const no = isOffer ? Number(purchase.offer_no_votes || 0) : Number(purchase.fulfillment_no_votes || 0);
    const eligible = isOffer ? isMember() : isFundedMember(purchase);
    const title = isOffer ? "Cast Your Vote" : "Approve Fulfillment";
    const copy = isOffer ? "The current V2 contract uses this community vote to open contributions. It does not authorize a purchase payment." : "Only an Active funded commitment makes this wallet eligible to review the farmer’s fulfillment evidence.";
    const recorded = recordedVote(purchase.id, type);
    const decision = recorded
      ? `<div class="decision-recorded" role="status"><strong>Your recorded decision: ${recorded.approve ? "Yes" : "No"}</strong><span>Current group status: ${escapeHtml(formatStatus(purchase.state))}. This vote attaches 0 NEAR; network gas may apply.</span></div>`
      : eligible
        ? `<div class="vote-actions"><button class="button button-approve" type="button" data-action="vote" data-vote-type="${isOffer ? "offer" : "fulfillment"}" data-purchase-id="${escapeHtml(purchase.id)}" data-approve="true">${isOffer ? "Cast Your Vote · Yes" : "Approve Fulfillment"}</button><button class="button button-reject" type="button" data-action="vote" data-vote-type="${isOffer ? "offer" : "fulfillment"}" data-purchase-id="${escapeHtml(purchase.id)}" data-approve="false">${isOffer ? "Cast Your Vote · No" : "Reject Fulfillment"}</button></div>`
        : `<div class="eligibility-label">${state.accountId ? (isOffer ? "This wallet is not in the initialized community." : "Only funded members can vote on fulfillment.") : "Connect a wallet to check eligibility."}</div>`;
    return `<article class="decision-card"><div class="purchase-card-top">${statusPill(purchase.state)}<span class="section-kicker">#${escapeHtml(purchase.id)}</span></div><h3>${title}</h3><p>${copy}</p><div class="decision-count"><strong>${yes} / ${required}</strong><span>yes votes · ${no} no</span></div><p class="decision-cost">Voting attaches 0 NEAR. The wallet may charge network gas.</p>${decision}<a class="text-link" style="margin-top: 17px" href="/purchases/${encodeURIComponent(purchase.id)}" target="_blank" rel="noopener noreferrer">Review purchase <span aria-hidden="true">↗</span></a></article>`;
  }

  function renderDecisionHistory(purchases) {
    const rows = [];
    purchases.forEach((purchase) => {
      const offerDecision = recordedVote(purchase.id, "offer");
      const fulfillmentDecision = recordedVote(purchase.id, "fulfillment");
      if (isMember() && offerDecision && purchase.state !== "Proposed") rows.push(`<div class="decision-history-row"><div><strong>Offer decision · purchase #${escapeHtml(purchase.id)}</strong><span>Your recorded decision: ${offerDecision.approve ? "Yes" : "No"} · ${purchase.state === "Failed" ? "Order did not complete" : "Offer moved past proposal"}</span></div><a href="/purchases/${encodeURIComponent(purchase.id)}" target="_blank" rel="noopener noreferrer">Review <span aria-hidden="true">↗</span></a></div>`);
      if (isFundedMember(purchase) && fulfillmentDecision && ["FulfillmentApproved", "PaymentPending", "Completed", "Failed"].includes(purchase.state)) rows.push(`<div class="decision-history-row"><div><strong>Fulfillment decision · purchase #${escapeHtml(purchase.id)}</strong><span>Your recorded decision: ${fulfillmentDecision.approve ? "Approve" : "Reject"} · ${purchase.state === "Failed" ? "Order failed; refunds follow contract" : purchase.state === "Completed" ? "Delivery approved; payment completed" : "Delivery approved"}</span></div><a href="/purchases/${encodeURIComponent(purchase.id)}" target="_blank" rel="noopener noreferrer">Review <span aria-hidden="true">↗</span></a></div>`);
    });
    return rows.length ? `<section class="decision-history"><div class="section-heading-inline"><div><span class="section-kicker">Past decisions</span><h2>Outcomes from the contract</h2></div><span class="meta-label">Public voting record</span></div><div class="decision-history-list">${rows.join("")}</div></section>` : "";
  }

  function renderRaiseIssueForm(selectedPurchaseId = "") {
    if (!appConfig.v3ContractId) return `<div class="issues-unavailable"><p>Member issues are not turned on for this community yet.</p></div>`;
    if (!state.v3Available) return `<div class="issues-unavailable"><p>Issues are temporarily unavailable. Refresh to try again.</p></div>`;
    const eligiblePurchases = state.purchases.filter((purchase) => isFundedMember(purchase) && !["Completed", "Failed"].includes(purchase.state));
    if (!eligiblePurchases.length) return `<div class="issues-empty"><p>Fund a place in a purchase before raising an issue.</p><a class="button button-outline button-small" href="/purchases">Explore purchases</a></div>`;
    const selected = eligiblePurchases.some((purchase) => String(purchase.id) === String(selectedPurchaseId)) ? String(selectedPurchaseId) : String(eligiblePurchases[0].id);
    return `<form class="issue-form" id="raise-issue-form" data-issue-form data-draft-form="raise-issue" data-draft-purchase-id="${escapeHtml(selected)}"><div class="form-intro"><span class="form-step">Raise an issue</span><p>Keep it practical. You can ask for a clarification or suggest a safe pickup change.</p></div><div class="field"><label for="issue-purchase">Which purchase is this about?</label><select id="issue-purchase" name="purchase_id" required>${eligiblePurchases.map((purchase) => `<option value="${escapeHtml(purchase.id)}" ${String(purchase.id) === selected ? "selected" : ""}>${escapeHtml(livePurchaseTitle(purchase))} · purchase #${escapeHtml(purchase.id)}</option>`).join("")}</select></div><div class="field"><label for="issue-subject">What is the issue about?</label><input id="issue-subject" name="subject" type="text" maxlength="120" placeholder="Pickup time no longer works" required></div><div class="field"><label for="issue-description">Describe the problem or concern.</label><textarea id="issue-description" name="description" maxlength="2000" rows="5" placeholder="Tell the group what changed and what would help." required></textarea></div><div class="field"><label for="issue-solution">What solution do you suggest? <span class="field-optional">Optional</span></label><textarea id="issue-solution" name="suggested_solution" maxlength="1000" rows="3" placeholder="A practical suggestion, if you have one."></textarea></div><div class="form-error-summary" id="issue-form-error" tabindex="-1" role="alert" hidden></div><div class="form-actions"><span class="form-safety">Only confirmed funded members can raise issues.</span><div class="draft-actions"><button class="button button-outline button-small" type="button" data-action="discard-draft">Discard draft</button><button class="button button-primary" type="submit">Submit issue</button></div></div></form>`;
  }

  function renderV3Dashboard() {
    if (!appConfig.v3ContractId) {
      return `<section class="issues-section"><div class="section-heading-inline"><div><span class="section-kicker">Issues raised</span><h2>Make room for the practical stuff.</h2></div></div><div class="issues-unavailable"><p>Member issues will appear here when this community turns them on.</p></div></section>`;
    }
    if (!state.v3Available) {
      return `<section class="issues-section"><div class="section-heading-inline"><div><span class="section-kicker">Issues raised</span><h2>Issues are temporarily unavailable.</h2></div></div><div class="issues-unavailable"><p>Refresh to check the latest issues and group decisions.</p></div></section>`;
    }
    const waiting = state.decisions.filter((decision) => decision.state === "Open" && (decision.eligible_voters || []).some((voter) => String(voter) === String(state.accountId)) && !decisionVoteFor(decision));
    const visibleIssues = state.issues.filter(canSeeIssue);
    const past = state.decisions.filter((decision) => decisionVoteFor(decision) && !["Open", "AwaitingSupplier"].includes(decision.state));
    const waitingMarkup = waiting.length
      ? `<div class="decision-grid issue-decision-grid">${waiting.map((decision) => { const issue = state.issues.find((item) => String(item.id) === String(decision.issue_id)); return issue ? renderIssueCard(issue, { showRequest: false }) : ""; }).join("")}</div>`
      : `<div class="issues-empty"><p>Nothing needs your vote right now.</p><span>When a funded group needs to choose a pickup arrangement, it will appear here.</span></div>`;
    const issuesMarkup = visibleIssues.length
      ? `<div class="issue-list">${visibleIssues.map((issue) => renderIssueCard(issue)).join("")}</div>`
      : `<div class="issues-empty"><p>No issues have been raised in your funded purchases.</p><span>Start with a practical concern if something has changed.</span></div>`;
    const pastMarkup = past.length
      ? `<div class="decision-history-list">${past.map((decision) => `<div class="decision-history-row"><div><strong>${escapeHtml(decision.proposal)}</strong><span>${escapeHtml(decisionStateLabel(decision.state))} · your choice: ${escapeHtml(decision.options[decisionVoteFor(decision).option] || "Choice")}</span></div><a href="/purchases/${encodeURIComponent(decision.purchase_id)}">Open purchase <span aria-hidden="true">↗</span></a></div>`).join("")}</div>`
      : `<div class="issues-empty"><p>Your recorded group decisions will show here.</p><span>Votes remain public so everyone can see the same outcome.</span></div>`;
    return `<section class="decision-section-block"><div class="section-heading-inline"><div><span class="section-kicker">Decisions That Need Your Vote</span><h2>Choose when your voice is needed.</h2><p class="section-heading-copy">Only members funded when a decision opened can vote, and each eligible account gets one choice.</p></div></div>${waitingMarkup}</section><section class="issues-section"><div class="section-heading-inline"><div><span class="section-kicker">Issues Raised</span><h2>Concerns stay connected to the purchase.</h2></div><a class="button button-primary button-small" href="#raise-an-issue">Raise an issue</a></div>${issuesMarkup}</section><section class="decision-history"><div class="section-heading-inline"><div><span class="section-kicker">Your Past Decisions</span><h2>See what the group decided.</h2></div><span class="meta-label">Public voting record</span></div>${pastMarkup}</section><section class="raise-issue-block" id="raise-an-issue"><div class="section-heading-inline"><div><span class="section-kicker">Start a conversation</span><h2>Raise an issue</h2></div></div>${renderRaiseIssueForm()}</section>`;
  }

  function renderDecisions() {
    const root = $("#decisions-root");
    if (!root || !state.accountId) return;
    const offerVotes = state.purchases.filter((purchase) => purchase.state === "Proposed" && !recordedVote(purchase.id, "offer"));
    const fulfillmentVotes = state.purchases.filter((purchase) => purchase.state === "FulfillmentPending" && !recordedVote(purchase.id, "fulfillment"));
    const cards = [...offerVotes.map((purchase) => renderDecisionCard(purchase, "offer")), ...fulfillmentVotes.map((purchase) => renderDecisionCard(purchase, "fulfillment"))];
    root.innerHTML = `<div class="dashboard-toolbar"><div><span class="section-kicker">Connected wallet</span><h2>Your decisions</h2></div><span class="wallet-caption">${escapeHtml(shortAccount(state.accountId))}</span></div><div class="decision-boundary"><strong>Your vote comes from your funded place.</strong><span>V4 opens after supplier confirmation, without a community vote. Existing V2 offer approvals remain visible only for those historical purchases. Fulfillment and group decisions use financially eligible members.</span></div>${cards.length ? `<section class="decision-section-block"><div class="section-heading-inline"><div><span class="section-kicker">Purchase decisions</span><h2>Decisions waiting for you.</h2></div></div><div class="decision-grid">${cards.join("")}</div></section>` : ""}${renderDecisionHistory(state.purchases)}${renderV3Dashboard()}`;
  }

  function renderIssueFormPage() {
    const root = $("#issue-form-content");
    if (!root) return;
    const id = $("#issue-form-root")?.dataset.purchaseId || "";
    if (!state.accountId) {
      root.innerHTML = `<div class="connect-card"><div class="connect-card-mark">${icon("shield")}</div><div><h2>Connect a wallet to raise an issue.</h2><p>Only a confirmed funded member can start an issue for a purchase.</p></div><button class="button button-dark" type="button" data-connect-wallet>Connect wallet</button></div>`;
      return;
    }
    root.innerHTML = `<div class="issue-form-header"><p class="eyebrow">Purchase conversation</p><h1>Raise a concern without the awkward conversation.</h1><p>Share what changed. The group can clarify it or decide together when a vote is needed.</p></div>${renderRaiseIssueForm(id)}<p class="contract-note">Your issue is recorded with the purchase. It does not change price, quantity, supplier, refunds, or pooled funds.</p>`;
  }

  function renderFarmer() {
    const root = $("#farmer-root");
    if (!root || !state.accountId) return;
    const ownPurchases = state.purchases.filter((purchase) => String(supplierAccount(purchase)) === String(state.accountId));
    if (!ownPurchases.length) {
      root.innerHTML = `<div class="dashboard-toolbar"><div><span class="section-kicker">Connected wallet</span><h2>${escapeHtml(shortAccount(state.accountId))}</h2></div><span class="wallet-caption">Named supplier</span></div><div class="dashboard-empty"><div class="empty-icon">${icon("leaf")}</div><h2>No assigned purchases yet.</h2><p>Purchases appear here when this wallet is the named supplier.</p></div>`;
      return;
    }
    root.innerHTML = `<div class="dashboard-toolbar"><div><span class="section-kicker">Connected supplier wallet</span><h2>Orders needing your handoff</h2></div><span class="wallet-caption">${escapeHtml(shortAccount(state.accountId))}</span></div><div class="farmer-grid">${ownPurchases.map((purchase) => `<article class="farmer-card"><div class="purchase-card-top">${statusPill(purchase.state)}<span class="section-kicker">#${escapeHtml(purchase.id)}</span></div><h3>${escapeHtml(livePurchaseTitle(purchase))}</h3><p>${quantityLabel(purchase, purchase.total_quantity)} of ${quantityLabel(purchase, purchase.max_quantity)} reserved · fulfill by ${escapeHtml(formatDate(purchase.fulfillment_evidence_deadline_ns))}</p>${packageContentsMarkup(purchase)}${purchase.fulfillment_evidence_hash ? `<div class="evidence-hash">Delivery details submitted: ${escapeHtml(purchase.fulfillment_evidence_hash)}</div>` : purchase.state === "Funded" ? `<form class="evidence-form" data-evidence-form data-draft-form="fulfillment-evidence" data-draft-purchase-id="${escapeHtml(purchase.id)}" data-purchase-id="${escapeHtml(purchase.id)}"><label for="evidence-${escapeHtml(purchase.id)}">Delivery reference</label><input id="evidence-${escapeHtml(purchase.id)}" name="evidence" type="text" maxlength="256" placeholder="Order or delivery reference" required><div class="draft-actions"><button class="button button-outline button-small" type="button" data-action="discard-draft">Discard draft</button><button class="button button-primary" type="submit">Submit Delivery Details <span aria-hidden="true">↗</span></button></div></form>` : `<p class="field-help">Delivery details are not needed at this stage.</p>`}<a class="text-link" style="margin-top: 18px" href="/purchases/${encodeURIComponent(purchase.id)}">Review Group Deal <span aria-hidden="true">↗</span></a></article>`).join("")}</div>`;
  }

  function updateCreatePricePreview() {
    const preview = $("#create-price-preview");
    const input = $("#price-per-unit");
    if (!preview || !input) return;
    if (isV5()) {
      const units = usdcTools.parseUnits(input.value, Number(state.config?.token_decimals || 6));
      preview.innerHTML = units === null
        ? "<strong>Enter an exact USDC amount (up to 6 decimals)</strong><span>Amounts are never rounded.</span>"
        : `<strong>Exact Testnet contribution: ${escapeHtml(usdcTools.formatUnits(units, 6))} USDC</strong><span>Native Testnet USDC · network gas is paid separately in Testnet NEAR</span>`;
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
      total.innerHTML = moneyMarkup(amount, "", state.currentPurchase);
    } catch (_error) {
      total.textContent = "USD unavailable · exact NEAR unavailable";
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
    return performVerifiedAction(button, method, { purchase_id: String(purchaseId), approve }, "Your vote has been recorded.", {
      failureMessage: "We couldn't record your vote. Your draft is safe. Please try again.",
      alreadyMessage: `Your recorded choice is already ${approve ? "Yes" : "No"}.`,
    });
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
        renderAgreementPage();
        decorateMoneyText();
      } catch (_refreshError) {
        renderAgreementPage();
        decorateMoneyText();
      }
      return;
    }

    const contributionArgs = { purchase_id: String(purchaseId), quantity };
    const contributionOptions = {
      depositValue: verified.depositYocto,
      valueIsYocto: true,
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
      renderAgreementPage();
      decorateMoneyText();
    } catch (_error) {
      if (!state.contributionStatus || String(state.contributionStatus.purchaseId) !== String(purchaseId)) {
        state.contributionStatus = {
          purchaseId,
          kind: "awaiting",
          title: "Confirmation still pending",
          message: "The contract state could not be reread yet. Refresh before treating this contribution as complete.",
        };
      }
      renderAgreementPage();
      decorateMoneyText();
      showToast("The contribution was submitted, but membership still needs contract confirmation.", "error");
    }
  }

  async function handleEvidence(form) {
    const button = $("button[type=submit]", form);
    const evidence = String(new FormData(form).get("evidence") || "").trim();
    if (!evidence) return;
    saveDraft(form);
    const confirmation = await performVerifiedAction(button, "submit_fulfillment_evidence", { purchase_id: String(form.dataset.purchaseId), evidence_hash: evidence }, "Fulfillment evidence submitted on-chain.", {
      failureMessage: "We couldn't submit the delivery evidence. Your draft is safe. Please try again.",
    });
    if (!confirmation || confirmation.state !== "confirmed") return;
    try {
      await loadBaseData();
      const purchase = state.purchases.find((item) => String(item.id) === String(form.dataset.purchaseId));
      if (purchase?.fulfillment_evidence_hash !== evidence) {
        showFormTransactionError(form, "The wallet returned, but delivery evidence is not confirmed yet. Your draft is safe. Refresh before trying again.");
        return;
      }
      clearDraft(form);
      renderFarmer();
      renderFarmerPaymentTotals();
      decorateMoneyText();
    } catch (error) {
      showFormTransactionError(form, "The wallet returned, but delivery evidence could not be verified yet. Your draft is safe. Refresh before trying again.", error);
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
    showToast("Your issue has been submitted.", "success");
    if (appConfig.page === "issue_form") window.location.href = `/purchases/${encodeURIComponent(String(issue.purchase_id))}`;
    else renderCurrentPage();
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
      setBusy(button, true, actionProgressCopy(methodName));
    }
    const receiverId = options.receiverId || appConfig.contractId;
    const action = pendingAction(methodName, args, receiverId, options.context || {});
    const actionKey = confirmationTools.actionId(action);
    const existingPending = pendingActionStore.list(action.signerId).find((item) => item.id === actionKey);
    if (existingPending) {
      renderPendingConfirmationNotice();
      showToast(`${actionProgressCopy(methodName)} We’ll update this page automatically.`);
      return null;
    }

    const existing = await readActionConfirmation(action).catch(() => ({ state: "uncertain" }));
    if (!["create_purchase", "create_open_purchase", "create_supplier_offer", "create_purchase_request"].includes(methodName) && existing.state === "confirmed") {
      await Promise.allSettled([loadBaseData()]);
      renderCurrentPage();
      showToast(options.alreadyMessage || "This action is already confirmed on-chain.", "success");
      return existing;
    }

    const saved = pendingActionStore.save(action);
    renderPendingConfirmationNotice();
    let transactionError = null;
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
        failureMessage: options.failureMessage || "We couldn't complete this action. Your selection is safe. Please check its status before trying again.",
        onError: (message, error) => {
          transactionError = error;
          options.onError?.(message, error);
        },
      },
    );
    if (!outcome) {
      if (transactionError?.transactionState !== "pending") pendingActionStore.remove(saved.id);
      if (button) {
        if (transactionError?.transactionState === "pending") setBusy(button, true, actionProgressCopy(methodName));
        else {
          delete button.dataset.submissionLock;
          setBusy(button, false);
        }
      }
      renderPendingConfirmationNotice();
      return null;
    }

    state.pendingTransactions.add(button);
    setBusy(button, true, actionProgressCopy(methodName));
    const result = await waitForActionConfirmation(saved);
    setBusy(button, false);
    state.pendingTransactions.delete(button);
    if (result?.state === "confirmed") {
      pendingActionStore.remove(saved.id);
      await Promise.allSettled([loadBaseData()]);
      if (["details", "agreement", "supplier_invitation"].includes(appConfig.page)) await loadPurchase(args.purchase_id).catch(() => null);
      renderCurrentPage();
      renderPendingConfirmationNotice();
      showToast(successMessage, "success");
      return result;
    }
    if (result?.state === "failed") {
      pendingActionStore.remove(saved.id);
      if (button) delete button.dataset.submissionLock;
      renderPendingConfirmationNotice();
      showToast("The contract rejected this action. No retry was submitted.", "error");
      return result;
    }
    renderPendingConfirmationNotice();
    if (button) setBusy(button, true, actionProgressCopy(methodName));
    showToast(`${actionProgressCopy(methodName)} We’ll update this page automatically.`);
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

  function localDateValue(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
    const packageUnit = PACKAGE_UNITS.has(select.value) || custom;
    if (contentsField) contentsField.hidden = !packageUnit;
    if (contentsInput) contentsInput.disabled = !packageUnit;
  }

  function setCreateDefaults() {
    const deadline = $("#purchase-deadline");
    const cancel = $("#cancellation-deadline");
    const fulfillment = $("#fulfillment-deadline");
    if (!deadline || !fulfillment) return;
    const now = new Date();
    const orderDeadline = new Date(now.getTime() + 7 * 86400000);
    const reviewDeadline = new Date(now.getTime() + 14 * 86400000);
    deadline.value = localDateValue(orderDeadline);
    if (cancel) cancel.value = localDateValue(orderDeadline);
    fulfillment.value = localDateValue(reviewDeadline);
  }

  function toNanoseconds(value) {
    const milliseconds = new Date(value).getTime();
    if (!Number.isFinite(milliseconds)) throw new Error("Enter a valid date and time.");
    return (BigInt(Math.round(milliseconds)) * 1000000n).toString();
  }

  function setCreateError(message, error = null) {
    const summary = $("#create-form-error");
    setErrorSummary(summary, message, error);
  }

  async function handleCreate(form) {
    setCreateError("");
    const version = String(state.config?.version || appConfig.contractVersion || "").toUpperCase();
    const isV4 = ["V4", "V5"].includes(version);
    if (!isV4) {
      setCreateError("New purchases are paused while this app remains connected to the preserved V2 contract. The corrected supplier-authorized flow requires a separately deployed V4 contract; no transaction was attempted.");
      return;
    }
    if (!ensureSignedIn()) return;
    const values = new FormData(form);
    const minQuantity = Number(values.get("min_quantity"));
    const maxQuantity = Number(values.get("max_quantity"));
    const maxFundedMembers = Number(values.get("max_funded_members"));
    const perBuyer = Number(values.get("max_quantity_per_household"));
    const price = String(values.get("price_per_unit") || "");
    const deadline = String(values.get("deadline") || "");
    const cancellationDeadline = String(values.get("cancellation_deadline") || deadline);
    const fulfillmentDeadline = String(values.get("fulfillment_deadline") || "");
    if (!Number.isInteger(minQuantity) || !Number.isInteger(maxQuantity) || minQuantity < 1 || maxQuantity < minQuantity) { setCreateError("Check the quantities: the maximum must be at least the positive minimum."); return; }
    const maxAllowedFundedMembers = Number(state.config?.max_funded_members || 20);
    if (!Number.isInteger(maxFundedMembers) || maxFundedMembers < 1 || maxFundedMembers > maxAllowedFundedMembers) { setCreateError(`Funded household capacity must be a whole number from 1 to ${maxAllowedFundedMembers}.`); return; }
    if (!Number.isInteger(perBuyer) || perBuyer < 1 || perBuyer > maxQuantity) { setCreateError("The buyer limit must be between 1 and the maximum deal quantity."); return; }
    if (maxFundedMembers * perBuyer < minQuantity) { setCreateError(`This deal cannot reach its minimum. ${maxFundedMembers} buyers at ${perBuyer} each can reserve at most ${maxFundedMembers * perBuyer}.`); return; }
    let deadlineNs, cancellationNs, fulfillmentNs, priceYocto;
    try {
      deadlineNs = toNanoseconds(deadline);
      cancellationNs = toNanoseconds(cancellationDeadline);
      fulfillmentNs = toNanoseconds(fulfillmentDeadline);
      priceYocto = version === "V5" ? usdcTools.parseUnits(price, Number(state.config?.token_decimals || 6)) : parseNearAmount(price);
      if (!priceYocto || BigInt(priceYocto) <= 0n) throw new Error("Price must be greater than zero.");
      if (BigInt(cancellationNs) > BigInt(deadlineNs)) throw new Error("Cancellation cannot end after contributions.");
      if (BigInt(fulfillmentNs) <= BigInt(deadlineNs)) throw new Error("Fulfillment review must end after contributions.");
    } catch (error) { setCreateError(error.message || "Check the dates and price."); return; }
    const button = $("#create-purchase-button");
    saveDraft(form);
    const supplierId = String(values.get("farmer_id") || "").trim();
    const creationMode = String(values.get("creation_mode") || "organizer_request");
    if (isV4 && creationMode === "supplier_offer" && supplierId !== state.accountId) {
      setCreateError("A supplier offer must name the connected supplier wallet. Choose your own wallet, or send an organizer request for another supplier to review.");
      return;
    }
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
      const pickup = String(values.get("pickup_or_delivery") || "").trim();
      const refundTerms = String(values.get("cancellation_and_refund_terms") || "").trim();
      const perHousehold = perBuyer;
      const usdScaled = parseScaledDecimal(String(values.get("listed_price_usd") || ""), 100n);
      if (!productName || !description || !quantityUnit || !pickup || !refundTerms || !supplierId) { setCreateError("Complete the product, sale unit, supplier, pickup, and refund details."); return; }
      if (new TextEncoder().encode(quantityUnit).length > 160) { setCreateError("Shorten the custom unit or package contents so the complete sale-unit description is 160 characters or fewer."); return; }
      if (!Number.isInteger(perHousehold) || perHousehold < 1 || perHousehold > maxQuantity) { setCreateError("The household item limit must be between 1 and the maximum quantity."); return; }
      if (usdScaled === null || usdScaled <= 0n) { setCreateError("Enter a positive listed USD price."); return; }
      const terms = { product_name: productName, description, quantity_unit: quantityUnit, price_per_unit: priceYocto, listed_price_usd_cents: usdScaled.toString(), min_quantity: minQuantity, max_quantity: maxQuantity, max_quantity_per_household: perHousehold, max_funded_members: maxFundedMembers, pickup_or_delivery: pickup, join_deadline_ns: deadlineNs, fulfillment_deadline_ns: fulfillmentNs, cancellation_and_refund_terms: refundTerms };
      methodName = creationMode === "supplier_offer" ? "create_supplier_offer" : "create_purchase_request";
      createArgs = methodName === "create_supplier_offer" ? { terms } : { supplier_id: supplierId, terms };
    }
    const baselinePurchaseCount = Number(await view("get_purchase_count"));
    const successCopy = methodName === "create_purchase_request" ? "Your supplier invitation is ready." : "Your deal is live!";
    const confirmation = await performVerifiedAction(button, methodName, createArgs, successCopy, {
      context: { minimumPurchaseId: baselinePurchaseCount },
      failureMessage: "We couldn't create the purchase. Your draft is safe. Please try again.",
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
      window.location.href = `/purchases/${encodeURIComponent(String(id))}`;
    } catch (error) {
      setCreateError("The wallet returned, but the new purchase could not be verified yet. Your draft is safe. Refresh before trying again.", error);
    }
  }

  function bindGlobalEvents() {
    normalizeExploreFilters();
    $("#wallet-button")?.addEventListener("click", () => state.accountId ? openWalletPanel() : connectWallet());
    $("#wallet-panel-close")?.addEventListener("click", closeWalletPanel);
    $("#wallet-signout")?.addEventListener("click", disconnectWallet);
    $("#menu-toggle")?.addEventListener("click", () => {
      const menu = $("#site-nav");
      const open = menu.classList.toggle("open");
      $("#menu-toggle").setAttribute("aria-expanded", String(open));
      $("#menu-toggle").setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    });
    $$('[data-connect-wallet]').forEach((button) => button.addEventListener("click", connectWallet));
    $$(".filter-tab").forEach((button) => button.addEventListener("click", () => {
      $$(".filter-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
      renderExplore();
    }));
    $("#create-purchase-form")?.addEventListener("submit", (event) => { event.preventDefault(); handleCreate(event.currentTarget); });
    $("#price-per-unit")?.addEventListener("input", updateCreatePricePreview);
    $("#sale-unit")?.addEventListener("change", updateSaleUnitFields);
    document.addEventListener("click", async (event) => {
      const actionButton = event.target.closest("[data-action]");
      if (!actionButton) return;
      const action = actionButton.dataset.action;
      if (action === "check-v3-confirmation") {
        await handleCheckV3Confirmation(actionButton);
        return;
      }
      if (action === "check-pending-actions") {
        setBusy(actionButton, true, "Checking state…");
        const remaining = await reconcilePendingActions({ poll: true });
        setBusy(actionButton, false);
        if (remaining.length) showToast("Still confirming your transaction. No retry was submitted.");
        return;
      }
      if (action === "discard-draft") {
        discardDraftForSurface(actionButton);
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
      if (action === "contribute") await handleContribution(actionButton);
      if (action === "accept-supplier-request") await handleSimpleAction(actionButton, "accept_supplier_request", { purchase_id: String(actionButton.dataset.purchaseId) }, "Supplier agreement recorded. Contributions are now open.");
      if (action === "decline-supplier-request") await handleSimpleAction(actionButton, "decline_supplier_request", { purchase_id: String(actionButton.dataset.purchaseId) }, "The supplier declined this request.");
      if (action === "vote") await handleVote(actionButton);
      if (action === "finalize") await handleSimpleAction(actionButton, "finalize_purchase", { purchase_id: String(actionButton.dataset.purchaseId) }, "Purchase finalized on-chain.");
      if (action === "cancel-commitment") await handleSimpleAction(actionButton, "cancel_commitment", { purchase_id: String(actionButton.dataset.purchaseId) }, "Commitment cancelled on-chain. The refund is now claimable.");
      if (action === "claim-refund") await handleSimpleAction(actionButton, "claim_refund", { purchase_id: String(actionButton.dataset.purchaseId) }, "Refund claim submitted on-chain. Wait for the contract callback to mark it refunded.");
      if (action === "expire-unfulfilled") await handleSimpleAction(actionButton, "expire_unfulfilled_purchase", { purchase_id: String(actionButton.dataset.purchaseId) }, "Purchase marked failed on-chain. Refunds are now claimable.");
      if (action === "release-payment") await handleSimpleAction(actionButton, "release_payment", { purchase_id: String(actionButton.dataset.purchaseId) }, "Payment release confirmed on-chain. The contract callback will finalize the state.");
      if (action === "decision-vote") await handleV3Action(actionButton, "vote_on_decision", { decision_id: String(actionButton.dataset.decisionId), option: Number(actionButton.dataset.option) }, "Your vote has been recorded.");
      if (action === "resolve-issue") await handleV3Action(actionButton, "resolve_issue", { issue_id: String(actionButton.dataset.issueId) }, "Issue marked resolved.");
      if (action === "agree-decision") await handleV3Action(actionButton, "agree_to_decision", { decision_id: String(actionButton.dataset.decisionId) }, "Supplier agreement recorded on-chain.");
      if (action === "decline-decision") await handleV3Action(actionButton, "decline_decision", { decision_id: String(actionButton.dataset.decisionId) }, "The proposal was declined and the issue is open again.");
      if (action === "expire-decision") await handleV3Action(actionButton, "expire_decision", { decision_id: String(actionButton.dataset.decisionId) }, "Expired decision closed. The issue is open for another proposal.");
    });
    document.addEventListener("input", (event) => {
      if (event.target.id === "contribution-quantity") updateContributionTotal();
      if (event.target.id === "price-per-unit") updateCreatePricePreview();
      saveDraft(event.target);
    });
    document.addEventListener("change", (event) => {
      handleDraftContextChange(event.target);
      if (event.target.id === "agreement-acceptance") updateAgreementAcceptance();
      if (event.target.id === "sale-unit") updateSaleUnitFields();
      if (event.target.name === "vote_type") updateDecisionFormType(event.target.form);
      saveDraft(event.target);
    });
    document.addEventListener("submit", (event) => { if (event.target.matches("[data-evidence-form]")) { event.preventDefault(); handleEvidence(event.target); } });
    document.addEventListener("submit", (event) => { if (event.target.matches("[data-issue-form]")) { event.preventDefault(); handleRaiseIssue(event.target); } });
    document.addEventListener("submit", (event) => { if (event.target.matches("[data-decision-form]")) { event.preventDefault(); handleRequestDecision(event.target); } });
  }

  async function init() {
    bindGlobalEvents();
    setCreateDefaults();
    updateSaleUnitFields();
    updateCreatePricePreview();
    try {
      await setupNear();
      await Promise.allSettled([loadBaseData(), loadNearPrice()]);
      if (["details", "agreement", "issue_form", "supplier_invitation"].includes(appConfig.page)) {
        const id = $("[data-purchase-id]")?.dataset.purchaseId;
        if (id) await loadPurchase(id);
      }
      updateWalletUi();
      await reconcilePendingActions();
    } catch (_error) {
      if (appConfig.page !== "home" && appConfig.page !== "explore") showToast("Live Testnet data is unavailable right now. Refresh to try again.", "error");
    }
    renderCurrentPage();
    window.setInterval(loadNearPrice, 60_000);
    window.setInterval(() => {
      if (state.accountId && pendingActionStore.list(state.accountId).length) reconcilePendingActions({ poll: true });
    }, 12_000);
    if (["details", "agreement", "issue_form", "supplier_invitation"].includes(appConfig.page)) {
      if (state.currentPurchase) {
        if (appConfig.page === "details") { renderDetailsPage(); decorateDetailsActions(); }
        else if (appConfig.page === "agreement") renderAgreementPage();
        else if (appConfig.page === "issue_form") renderIssueFormPage();
        else renderSupplierInvitationPage();
        decorateMoneyText();
      } else {
        const target = $("#details-content") || $("#agreement-content") || $("#supplier-invitation-content");
        showError(target, "Live purchase data is unavailable", "This page only acts on the contract returned by NEAR testnet. No mock purchase, membership, vote, or payment is shown as successful.", '<a class="button button-outline" href="/purchases">Back to Explore</a>');
      }
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
