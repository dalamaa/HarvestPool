/* Durable Community Fund request directory. Financial actions remain in app.js for the verified DAO only. */
(function () {
  "use strict";

  const configNode = document.getElementById("app-config");
  if (!configNode) return;
  const config = JSON.parse(configNode.textContent);
  const directoryTools = window.HarvestPoolCommunityDirectory;
  if (!directoryTools) throw new Error("HarvestPool Community Directory helpers did not load.");
  const ownerKey = "harvestpool:community-fund-owner:v1";
  const verifiedCacheKey = "harvestpool:community-directory-verified:v1";
  const verifiedCacheMaxAgeMs = 15 * 60 * 1000;
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);

  function ownerToken() {
    let token = window.localStorage.getItem(ownerKey);
    if (!token) {
      token = window.crypto?.randomUUID?.().replaceAll("-", "") || Array.from(window.crypto.getRandomValues(new Uint8Array(24)), (value) => value.toString(16).padStart(2, "0")).join("");
      window.localStorage.setItem(ownerKey, token);
    }
    return token;
  }

  function money(value) {
    if (value === null || value === undefined || value === "") return "Verification unavailable";
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "—";
  }

  function readableDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return String(value || "Not set");
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
  }

  function statusClass(status) {
    if (status === "Completed") return "status-funded";
    if (status === "Goal reached" || status === "Fully Funded") return "status-funded";
    if (["Open for contributions", "Open for Contributions"].includes(status)) return "status-open";
    return "status-pending";
  }

  function displayStatus(status) {
    if (status === "Fully Funded") return "Goal reached";
    if (status === "Open for Contributions") return "Open for contributions";
    return status;
  }

  function fundCard(fund) {
    const progress = fund.isVerifiedFund ? directoryTools.progressPercent(fund.raisedUnits, fund.targetUnits) : null;
    const progressLabel = fund.isVerifiedFund ? directoryTools.progressLabel(progress) : "Awaiting fund setup";
    const verificationCopy = !fund.isVerifiedFund
      ? "No treasury or verified contribution history"
      : fund.verificationState === "current"
      ? "Confirmed finalized receipts"
      : fund.verificationState === "last-verified"
        ? "Last verified finalized activity · refreshing"
        : fund.verificationState === "partial"
          ? "Confirmed receipts · broader discovery may be incomplete"
        : fund.verificationState === "error"
          ? "Verification is temporarily unavailable"
          : "Checking finalized activity…";
    const raisedCopy = !fund.isVerifiedFund
      ? "Contributions unavailable"
      : fund.raisedAmount === null || fund.raisedAmount === undefined
      ? "Raised amount pending verification"
      : `${money(fund.raisedAmount)} confirmed`;
    const contributorCopy = !fund.isVerifiedFund
      ? "Contributions unavailable"
      : fund.contributorsCount === null || fund.contributorsCount === undefined
      ? "Contributor count unavailable"
      : `${fund.contributorsCount} contributor${fund.contributorsCount === 1 ? "" : "s"}`;
    const image = fund.cover_image_url ? `<div class="community-card-media"><img class="community-card-image" src="${escapeHtml(fund.cover_image_url)}" alt="" loading="lazy"><div class="community-image-placeholder" role="img" aria-label="Cover image unavailable"><span aria-hidden="true">◇</span><strong>Image unavailable</strong></div></div>` : "";
    const progressAttributes = progress === null
      ? 'aria-label="Funding progress is being verified" aria-busy="true"'
      : `role="progressbar" aria-label="Amount raised toward goal" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"`;
    return `<article class="community-directory-card">${image}<div class="community-card-body"><div class="community-card-top"><span class="status ${statusClass(fund.status)}"><span></span>${escapeHtml(displayStatus(fund.status))}</span>${fund.isVerifiedFund ? '<span class="verified-label">Verified Testnet fund</span>' : ""}</div><h3>${escapeHtml(fund.title)}</h3><p class="community-card-location">${escapeHtml(fund.location)}</p><p class="community-card-description">${escapeHtml(fund.description)}</p><div class="community-card-progress"><div class="goal-progress" ${progressAttributes}><span style="width:${progress ?? 0}%"></span></div><div><strong>${escapeHtml(progressLabel)}</strong><span>${escapeHtml(raisedCopy)} · ${money(fund.targetAmount)} goal</span><small class="community-verification-copy">${escapeHtml(verificationCopy)}</small></div></div><dl class="community-card-meta"><div><dt>Contributors</dt><dd>${escapeHtml(contributorCopy)}</dd></div><div><dt>Deadline</dt><dd>${escapeHtml(readableDate(fund.contribution_deadline))}</dd></div></dl><a class="button button-outline" href="${escapeHtml(fund.detailUrl)}">View fund</a></div></article>`;
  }

  function applyVerifiedActivity(fund, activity, verificationState = null) {
    if (!fund?.isVerifiedFund || (!activity?.contributionHistoryComplete && !(activity?.contributions || []).length)) return false;
    const contributions = activity.contributions || [];
    const total = contributions.reduce((sum, item) => sum + BigInt(String(item.amount || "0")), 0n);
    const scale = 10n ** BigInt(Number(fund.decimals ?? 6));
    const whole = total / scale;
    const fraction = (total % scale).toString().padStart(Number(fund.decimals ?? 6), "0").slice(0, 2).padEnd(2, "0");
    const complete = activity.contributionHistoryComplete === true;
    fund.raisedAmount = `${whole}.${fraction}`;
    fund.raisedUnits = total.toString();
    fund.verifiedSubtotalAmount = `${whole}.${fraction}`;
    fund.verifiedSubtotalUnits = total.toString();
    fund.verifiedContributorIds = directoryTools.verifiedContributors(contributions);
    fund.contributorsCount = fund.verifiedContributorIds.length;
    fund.status = directoryTools.fundraisingStatus(total.toString(), fund.targetUnits);
    fund.verificationState = verificationState
      || (complete ? "current" : "partial");
    return true;
  }

  function readVerifiedCache() {
    try {
      const cache = JSON.parse(window.sessionStorage.getItem(verifiedCacheKey) || "{}");
      return cache && typeof cache === "object" ? cache : {};
    } catch (_error) {
      return {};
    }
  }

  function writeVerifiedCache(slug, activity) {
    if (!activity?.contributionHistoryComplete && !(activity?.contributions || []).length) return;
    try {
      const cache = readVerifiedCache();
      cache[slug] = { savedAt: Date.now(), activity };
      window.sessionStorage.setItem(verifiedCacheKey, JSON.stringify(cache));
    } catch (_error) {
      // Directory verification still works when browser storage is unavailable.
    }
  }

  function applyCachedActivity(fund) {
    const cached = readVerifiedCache()[fund.slug];
    if (!cached || Date.now() - Number(cached.savedAt || 0) > verifiedCacheMaxAgeMs) return false;
    return applyVerifiedActivity(
      fund,
      cached.activity,
      cached.activity?.contributionHistoryComplete ? "last-verified" : "partial",
    );
  }

  async function hydrateVerifiedFund(fund, render, { force = false, onVerified = null } = {}) {
    if (fund.verificationPromise) return fund.verificationPromise;
    fund.verificationPromise = (async () => {
      try {
        const separator = fund.activityUrl.includes("?") ? "&" : "?";
        const url = force ? `${fund.activityUrl}${separator}refresh=1` : fund.activityUrl;
        const response = await fetch(url, { headers: { Accept: "application/json" } });
        const activity = await response.json();
        if (!response.ok) throw new Error(activity.error || "Verified activity is unavailable.");
        if (!applyVerifiedActivity(fund, activity)) throw new Error("Verified activity was incomplete.");
        writeVerifiedCache(fund.slug, activity);
        if (typeof onVerified === "function") onVerified(fund);
        render();
        return true;
      } catch (error) {
        fund.verificationError = String(error?.message || error);
        if (fund.raisedAmount === null || fund.raisedAmount === undefined) fund.verificationState = "error";
        render();
        return false;
      } finally {
        fund.verificationPromise = null;
      }
    })();
    return fund.verificationPromise;
  }

  async function hydrateVerifiedFunds(funds, render, options = {}) {
    let verified = 0;
    let failures = 0;
    for (const fund of funds.filter((item) => item.isVerifiedFund && item.activityUrl)) {
      const succeeded = await hydrateVerifiedFund(fund, render, { force: true, onVerified: options.onVerified }).catch(() => false);
      if (succeeded) verified += 1;
      else failures += 1;
    }
    return { verified, failures };
  }

  function bindImageFallbacks(root) {
    root.querySelectorAll(".community-card-image").forEach((image) => {
      const fallback = () => image.closest(".community-card-media")?.classList.add("image-unavailable");
      image.addEventListener("error", fallback, { once: true });
      if (image.complete && image.naturalWidth === 0) fallback();
    });
  }

  async function initDirectory() {
    const root = document.getElementById("community-directory-root");
    if (!root) return;
    let funds = [];
    let active = "all";
    let accountId = "";
    let phase = "loading";
    let refreshError = false;
    let lastVerifiedAt = 0;
    let refreshPromise = null;
    const relativeRefreshTime = (timestamp) => {
      const ageSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
      if (ageSeconds < 5) return "just now";
      if (ageSeconds < 60) return `${ageSeconds} seconds ago`;
      const minutes = Math.floor(ageSeconds / 60);
      return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    };
    const emptyCopy = () => {
      const verificationPending = funds.some((fund) => fund.isVerifiedFund && ["pending", undefined].includes(fund.verificationState));
      if (verificationPending) return ["Checking verified fund activity", "This view will update as finalized contribution evidence arrives."];
      if (active === "vote") return accountId
        ? ["No verified votes need your action", `No pending fund decision is verified for ${accountId}.`]
        : ["Connect a wallet to check votes", "Vote eligibility comes from each configured fund’s verified governance policy."];
      if (active === "mine") return accountId
        ? ["No verified funds are associated with this wallet", "A verified contribution or supported fund membership will appear here."]
        : ["Connect a wallet to find your funds", "Saved requests from this browser still appear here without a wallet."];
      if (active === "completed") return ["No completed fundraisers", "A fund appears here once verified lifetime contributions reach its goal."];
      if (active === "open") return ["No funds are open for contributions", "Try All Funds to see requests and goal-reached funds."];
      return ["No Community Funds are available", "Start a fund request for your community."];
    };
    const statusMarkup = () => {
      if (phase === "loading") {
        return `<div class="community-directory-status wallet-empty-state data-loading-state" role="status" aria-live="polite"><span class="loading-label"><span class="loading-spinner" aria-hidden="true"></span><strong>Loading community funds…</strong></span><span>Checking verified contribution history.</span><span class="loading-bar short" aria-hidden="true"></span></div>`;
      }
      if (phase === "error") {
        return `<div class="community-directory-status error-card" role="status"><h2>Community funds are unavailable</h2><p>We could not load the fund directory. Try again when the network is ready.</p><button class="button button-outline" type="button" data-community-directory-refresh>Retry</button></div>`;
      }
      if (refreshError) {
        return `<div class="community-directory-status live-read-warning" role="status" aria-live="polite"><strong>Community funds need a retry.</strong><span>Showing the last verified fund records while the latest activity is unavailable.</span><button class="button button-outline button-small" type="button" data-community-directory-refresh>Retry</button></div>`;
      }
      if (lastVerifiedAt) {
        return `<div class="community-directory-status live-refresh-status" role="status" aria-live="polite"><span>Updated ${escapeHtml(relativeRefreshTime(lastVerifiedAt))}${phase === "refreshing" ? " · Checking for updates…" : ""}</span><button class="button button-outline button-small" type="button" data-community-directory-refresh ${phase === "refreshing" ? "disabled" : ""}>${phase === "refreshing" ? "Checking…" : "Refresh"}</button></div>`;
      }
      return `<div class="community-directory-status live-refresh-status" role="status" aria-live="polite"><span>Community funds loaded</span><button class="button button-outline button-small" type="button" data-community-directory-refresh ${phase === "refreshing" ? "disabled" : ""}>${phase === "refreshing" ? "Checking…" : "Refresh"}</button></div>`;
    };
    const render = () => {
      const visible = funds.filter((fund) => directoryTools.matchesFilter(fund, active, { accountId }));
      const [emptyTitle, emptyMessage] = emptyCopy();
      const content = visible.length
        ? visible.map(fundCard).join("")
        : `<div class="empty-state community-empty"><h2>${escapeHtml(emptyTitle)}</h2><p>${escapeHtml(emptyMessage)}</p>${active === "all" ? '<a class="button button-outline" href="/community-funds/start">Start a Community Fund</a>' : ""}</div>`;
      root.innerHTML = `${statusMarkup()}${content}`;
      bindImageFallbacks(root);
    };
    root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-community-directory-refresh]");
      if (!button || refreshPromise) return;
      loadDirectory({ force: true }).catch(() => null);
    });
    window.addEventListener("harvestpool:wallet-account", (event) => {
      accountId = String(event.detail?.accountId || "");
      render();
    });
    document.querySelectorAll("[data-community-filter]").forEach((button) => button.addEventListener("click", () => {
      active = button.dataset.communityFilter;
      document.querySelectorAll("[data-community-filter]").forEach((item) => {
        const selected = item === button;
        item.classList.toggle("active", selected);
        item.setAttribute("aria-pressed", String(selected));
      });
      render();
    }));
    async function loadDirectory({ force = false, initial = false } = {}) {
      if (refreshPromise) return refreshPromise;
      phase = initial ? "loading" : "refreshing";
      refreshError = false;
      render();
      refreshPromise = (async () => {
        try {
          const response = await fetch("/api/community-funds", { headers: { Accept: "application/json", "X-HarvestPool-Owner-Token": ownerToken() } });
          const payload = await response.json();
          if (!response.ok) throw new Error("Community funds could not be loaded.");
          funds = payload.funds || [];
          funds.filter((fund) => fund.isVerifiedFund && ["pending", undefined].includes(fund.verificationState)).forEach((fund) => {
            if (applyCachedActivity(fund)) {
              const savedAt = Number(readVerifiedCache()[fund.slug]?.savedAt || 0);
              if (savedAt > lastVerifiedAt) lastVerifiedAt = savedAt;
            }
          });
          phase = lastVerifiedAt ? "refreshing" : "loading";
          render();
          const result = await hydrateVerifiedFunds(funds, render, {
            force,
            onVerified: () => { lastVerifiedAt = Date.now(); },
          });
          phase = "ready";
          refreshError = result.failures > 0;
          render();
        } catch (_error) {
          phase = funds.length ? "ready" : "error";
          refreshError = Boolean(funds.length);
          render();
        } finally {
          refreshPromise = null;
        }
      })();
      return refreshPromise;
    }
    loadDirectory({ initial: true }).catch(() => null);
  }

  function clearFieldErrors(form) {
    form.querySelectorAll(".field-error").forEach((error) => error.remove());
    form.querySelectorAll("[aria-invalid]").forEach((field) => {
      field.removeAttribute("aria-invalid");
      const described = (field.getAttribute("aria-describedby") || "").split(" ").filter((id) => !id.endsWith("-error"));
      if (described.length) field.setAttribute("aria-describedby", described.join(" "));
      else field.removeAttribute("aria-describedby");
    });
  }

  function showFieldError(form, name, message) {
    const field = form.elements.namedItem(name);
    if (!field || field instanceof RadioNodeList) return;
    field.setAttribute("aria-invalid", "true");
    const id = `${field.id || name}-error`;
    field.setAttribute("aria-describedby", `${field.getAttribute("aria-describedby") || ""} ${id}`.trim());
    const error = document.createElement("p");
    error.className = "field-error";
    error.id = id;
    error.textContent = message;
    field.closest(".field")?.append(error);
  }

  function formPayload(form) {
    const data = Object.fromEntries(new FormData(form).entries());
    data.share_contact = form.elements.share_contact.checked;
    data.terms_acknowledged = form.elements.terms_acknowledged.checked;
    data.owner_token = ownerToken();
    return data;
  }

  function clientErrors(form, data) {
    const errors = {};
    Array.from(form.elements).forEach((field) => {
      if (field.closest("#community-request-fields") && field.name && !field.checkValidity()) {
        errors[field.name] = field.validationMessage;
      }
    });
    const today = new Date().toISOString().slice(0, 10);
    if (data.contribution_deadline && data.contribution_deadline < today) errors.contribution_deadline = "The contribution deadline cannot be in the past.";
    if (data.completion_date && data.contribution_deadline && data.completion_date < data.contribution_deadline) errors.completion_date = "The completion date must be on or after the contribution deadline.";
    if (!data.terms_acknowledged) errors.terms_acknowledged = "Confirm the setup limitation before continuing.";
    return errors;
  }

  function showErrors(form, errors) {
    clearFieldErrors(form);
    Object.entries(errors).forEach(([name, message]) => showFieldError(form, name, message));
    const summary = document.getElementById("community-request-errors");
    summary.innerHTML = `<strong>Review ${Object.keys(errors).length} field${Object.keys(errors).length === 1 ? "" : "s"} before continuing.</strong><ul>${Object.entries(errors).map(([name, message]) => `<li><a href="#${escapeHtml(form.elements.namedItem(name)?.id || "community-request-form")}">${escapeHtml(message)}</a></li>`).join("")}</ul>`;
    summary.hidden = false;
    summary.focus();
  }

  function reviewMarkup(data) {
    const rows = [
      ["Fund", `${data.title} · ${data.category} · ${data.city}, ${data.state.toUpperCase()}`],
      ["Purpose", data.intended_purpose], ["Organizer", `${data.organizer_name} · ${data.organizer_role}`],
      ["Goal", `${money(data.target_amount)} by ${readableDate(data.contribution_deadline)}`],
      ["Beneficiary", data.beneficiary], ["Budget", data.budget],
      ["If target is reached", data.reached_terms], ["If target is missed", data.not_reached_terms],
      ["Payment requests", data.payment_requesters], ["Approvals", data.payment_approvers],
      ["Payment and refunds", data.payment_refund_rules], ["Unused money", data.unused_money_terms],
    ];
    return `<dl class="community-review-list">${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl><p class="terms-boundary"><strong>No deposit address will be created by this submission.</strong> The public page will show Awaiting Fund Setup until supported accounting and governance are configured.</p>`;
  }

  function initCreate() {
    const form = document.getElementById("community-request-form");
    if (!form) return;
    const fields = document.getElementById("community-request-fields");
    const review = document.getElementById("community-request-review");
    const summary = document.getElementById("community-request-errors");
    const reviewButton = form.querySelector("[data-community-review]");
    form.elements.contribution_deadline.min = new Date().toISOString().slice(0, 10);
    form.elements.completion_date.min = new Date().toISOString().slice(0, 10);
    reviewButton.addEventListener("click", () => {
      const data = formPayload(form);
      const errors = clientErrors(form, data);
      if (Object.keys(errors).length) return showErrors(form, errors);
      clearFieldErrors(form);
      summary.hidden = true;
      document.getElementById("community-review-content").innerHTML = reviewMarkup(data);
      fields.hidden = true;
      review.hidden = false;
      review.focus();
    });
    form.querySelector("[data-community-edit]").addEventListener("click", () => {
      review.hidden = true;
      fields.hidden = false;
      reviewButton.focus();
    });
    form.addEventListener("focusout", (event) => {
      const field = event.target;
      if (!field.name || field.checkValidity()) return;
      form.querySelector(`#${CSS.escape(`${field.id}-error`)}`)?.remove();
      showFieldError(form, field.name, field.validationMessage);
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      submit.textContent = "Saving…";
      try {
        const response = await fetch("/api/community-funds", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(formPayload(form)) });
        const payload = await response.json();
        if (!response.ok) {
          if (payload.fields) {
            review.hidden = true;
            fields.hidden = false;
            showErrors(form, payload.fields);
          }
          throw new Error(payload.error || "The fund request could not be saved.");
        }
        window.location.assign(`${payload.url}?created=1`);
      } catch (error) {
        if (review.hidden) return;
        summary.textContent = error.message;
        summary.hidden = false;
        summary.focus();
      } finally {
        submit.disabled = false;
        submit.textContent = "Save Fund Request";
      }
    });
  }

  function detailTabs(fund) {
    const organizerContact = fund.shareContact && fund.contact_method ? `<p><strong>Public contact:</strong> ${escapeHtml(fund.contact_method)}</p>` : "";
    const privateContact = fund.isMine && fund.contact_email ? `<p class="private-contact"><strong>Private organizer email:</strong> ${escapeHtml(fund.contact_email)} <span>Only visible in this organizer browser.</span></p>` : "";
    const empty = (heading, copy) => `<div class="dashboard-empty compact"><h3>${heading}</h3><p>${copy}</p></div>`;
    const activity = fund.events.map((event) => `<li><strong>${escapeHtml(event.event_type)}</strong><span>${escapeHtml(event.summary)}</span><time datetime="${escapeHtml(event.created_at)}">${escapeHtml(new Date(event.created_at).toLocaleString())}</time></li>`).join("");
    const tabs = [["overview", "Overview"], ["contributions", "Contributions"], ["payments", "Payment Requests"], ["votes", "Votes"], ["activity", "Activity"]];
    const tabMarkup = tabs.map(([id, label], index) => `<button class="fund-tab" id="request-tab-${id}" type="button" role="tab" aria-selected="${index === 0}" aria-controls="request-panel-${id}" tabindex="${index === 0 ? "0" : "-1"}" data-request-tab="${id}">${label}</button>`).join("");
    return `<div class="fund-tabs" role="tablist" aria-label="Fund details">${tabMarkup}</div><div class="request-tab-panel" id="request-panel-overview" role="tabpanel" aria-labelledby="request-tab-overview" data-request-panel="overview"><div class="request-overview-grid"><section><h2>Overview</h2><p>${escapeHtml(fund.description)}</p><h3>Intended purpose</h3><p>${escapeHtml(fund.intended_purpose)}</p><h3>Budget</h3><p>${escapeHtml(fund.budget)}</p></section><aside><h2>Organizer</h2><p><strong>${escapeHtml(fund.organizer_name)}</strong><br>${escapeHtml(fund.organizer_role)}</p>${organizerContact}${privateContact}<h2>Dates</h2><p>Contributions requested by ${escapeHtml(readableDate(fund.contribution_deadline))}. Intended completion ${escapeHtml(readableDate(fund.completion_date))}.</p><h2>Beneficiary</h2><p>${escapeHtml(fund.beneficiary)}</p></aside></div><section class="request-terms"><h2>Proposed fund terms</h2><dl><div><dt>If the target is reached</dt><dd>${escapeHtml(fund.reached_terms)}</dd></div><div><dt>If the target is missed</dt><dd>${escapeHtml(fund.not_reached_terms)}</dd></div><div><dt>Who may request payments</dt><dd>${escapeHtml(fund.payment_requesters)}</dd></div><div><dt>Who should approve</dt><dd>${escapeHtml(fund.payment_approvers)}</dd></div><div><dt>Payment and refund rules</dt><dd>${escapeHtml(fund.payment_refund_rules)}</dd></div><div><dt>Unused money</dt><dd>${escapeHtml(fund.unused_money_terms)}</dd></div></dl></section></div><div class="request-tab-panel" id="request-panel-contributions" role="tabpanel" aria-labelledby="request-tab-contributions" data-request-panel="contributions" hidden>${empty("Contributions are not open", "This request has no isolated treasury. No deposit action or contribution is available.")}</div><div class="request-tab-panel" id="request-panel-payments" role="tabpanel" aria-labelledby="request-tab-payments" data-request-panel="payments" hidden>${empty("No payment requests", "Payment requests remain unavailable until the fund has reviewed on-chain rules and money to administer.")}</div><div class="request-tab-panel" id="request-panel-votes" role="tabpanel" aria-labelledby="request-tab-votes" data-request-panel="votes" hidden>${empty("No eligible voters yet", "The proposed approvers above are not active voters. Eligibility must come from the policy of a configured fund treasury.")}</div><div class="request-tab-panel" id="request-panel-activity" role="tabpanel" aria-labelledby="request-tab-activity" data-request-panel="activity" hidden><ol class="request-activity">${activity}</ol></div>`;
  }

  async function initDetail() {
    const root = document.getElementById("community-request-root");
    if (!root) return;
    try {
      const response = await fetch(`/api/community-funds/${encodeURIComponent(root.dataset.fundSlug)}`, { headers: { Accept: "application/json", "X-HarvestPool-Owner-Token": ownerToken() } });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "This fund could not be loaded.");
      const fund = payload.fund;
      const savedNotice = new URL(window.location.href).searchParams.get("created") === "1"
        ? '<div class="fund-safety-ready community-saved-notice" role="status"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 7v5c0 4.5 3.4 7.9 8 9 4.6-1.1 8-4.5 8-9V7l-8-4Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></svg><div><strong>Fund request saved</strong><span>This public URL is ready to share. Contributions remain disabled while setup is pending.</span></div></div>'
        : "";
      root.innerHTML = `${savedNotice}<nav class="detail-breadcrumb" aria-label="Breadcrumb"><a href="/community-funds">Community Funds</a><span aria-hidden="true">/</span><span>${escapeHtml(fund.title)}</span></nav><header class="request-detail-header"><div><span class="status ${statusClass(fund.status)}"><span></span>${escapeHtml(displayStatus(fund.status))}</span><h1>${escapeHtml(fund.title)}</h1><p>${escapeHtml(fund.location)} · ${escapeHtml(fund.category)}</p></div><div class="request-goal"><span>Goal</span><strong>${money(fund.targetAmount)}</strong><small>${money(fund.raisedAmount)} raised · ${fund.contributorsCount} contributors</small></div></header><div class="terms-boundary request-setup-boundary"><strong>This is a saved fund request, not an active treasury.</strong><p>Contributions, payment requests, and votes are disabled until isolated accounting and approval rules are configured. Individual fund treasuries and broader member governance are planned for a future release.</p></div>${detailTabs(fund)}`;
      const tabs = Array.from(root.querySelectorAll("[data-request-tab]"));
      const activate = (button, focus = false) => {
        tabs.forEach((tab) => {
          const selected = tab === button;
          tab.setAttribute("aria-selected", String(selected));
          tab.tabIndex = selected ? 0 : -1;
        });
        root.querySelectorAll("[data-request-panel]").forEach((panel) => { panel.hidden = panel.dataset.requestPanel !== button.dataset.requestTab; });
        if (focus) button.focus();
      };
      tabs.forEach((button, index) => {
        button.addEventListener("click", () => activate(button));
        button.addEventListener("keydown", (event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
          activate(tabs[next], true);
        });
      });
    } catch (error) {
      root.innerHTML = `<div class="error-card"><h1>Fund details are unavailable</h1><p>${escapeHtml(error.message)}</p><a class="button button-outline" href="/community-funds">Back to Community Funds</a></div>`;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (config.page === "community_directory") initDirectory();
    if (config.page === "community_create") initCreate();
    if (config.page === "community_request") initDetail();
  });
})();
