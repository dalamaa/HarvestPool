(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HarvestPoolRpcReads = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_RETRY_DELAY_MS = 1_000;
  const DEFAULT_429_COOLDOWN_MS = 5_000;
  const MAX_BACKOFF_MS = 30_000;
  const MAX_SHARED_COOLDOWN_MS = 60_000;
  const COOLDOWN_STORAGE_PREFIX = "harvestpool:rpc-cooldown:v1:";
  const inFlight = new Map();
  const localCooldowns = new Map();

  function transientStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  function transientRpcPayload(payload) {
    const code = Number(payload?.error?.code);
    const message = String(payload?.error?.message || "");
    return [-32000, -32001, -32002, -32603].includes(code) || /timeout|temporar|unavailable|overloaded/i.test(message);
  }

  function safeStorage(storage) {
    if (storage !== undefined) return storage;
    try { return globalThis.localStorage; } catch (_error) { return null; }
  }

  function endpointKey(url) {
    try { return new URL(url).origin; }
    catch (_error) { return String(url); }
  }

  function cooldownStorageKey(url) {
    return `${COOLDOWN_STORAGE_PREFIX}${endpointKey(url)}`;
  }

  function readCooldown(url, storage, now = Date.now()) {
    const key = endpointKey(url);
    let until = Number(localCooldowns.get(key) || 0);
    try {
      const stored = JSON.parse(storage?.getItem(cooldownStorageKey(url)) || "null");
      until = Math.max(until, Number(stored?.until || 0));
    } catch (_error) {
      // A blocked or malformed browser storage entry cannot make the read unsafe.
    }
    return until > now ? until : 0;
  }

  function publishCooldown(url, milliseconds, storage, now = Date.now()) {
    const duration = Math.min(MAX_SHARED_COOLDOWN_MS, Math.max(0, Number(milliseconds) || 0));
    const until = now + duration;
    const key = endpointKey(url);
    const current = Number(localCooldowns.get(key) || 0);
    if (until <= current) return current;
    localCooldowns.set(key, until);
    try {
      const storageKey = cooldownStorageKey(url);
      const stored = JSON.parse(storage?.getItem(storageKey) || "null");
      const sharedUntil = Math.max(until, Number(stored?.until || 0));
      storage?.setItem(storageKey, JSON.stringify({ until: sharedUntil, updatedAt: now }));
      return sharedUntil;
    } catch (_error) {
      return until;
    }
  }

  function responseHeader(response, name) {
    if (typeof response?.headers?.get === "function") return response.headers.get(name);
    const headers = response?.headers || {};
    return headers[name] ?? headers[name.toLowerCase()] ?? null;
  }

  function retryAfterMs(response, now = Date.now()) {
    const value = String(responseHeader(response, "Retry-After") || "").trim();
    if (!value) return 0;
    if (/^\d+(?:\.\d+)?$/.test(value)) return Math.max(0, Math.ceil(Number(value) * 1_000));
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
  }

  function requestKey(url, options = {}) {
    return `${url}|${String(options.method || "GET").toUpperCase()}|${String(options.body || "")}`;
  }

  function recordAttempt(url, metricLabel = null) {
    try {
      const metrics = globalThis.__harvestPoolRpcMetrics || { totalAttempts: 0, byEndpoint: {}, byPage: {}, last: null };
      metrics.byEndpoint ||= {};
      metrics.byPage ||= {};
      metrics.totalAttempts += 1;
      const key = endpointKey(url);
      metrics.byEndpoint[key] = Number(metrics.byEndpoint[key] || 0) + 1;
      if (metricLabel) metrics.byPage[metricLabel] = Number(metrics.byPage[metricLabel] || 0) + 1;
      metrics.last = { endpoint: key, page: metricLabel || null, at: Date.now() };
      globalThis.__harvestPoolRpcMetrics = metrics;
    } catch (_error) {
      // Diagnostics must never affect a read.
    }
  }

  async function fetchJsonWithRetry(fetchImpl, url, options, {
    attempts = 2,
    delayMs = DEFAULT_RETRY_DELAY_MS,
    retry429 = false,
    retryPayload = null,
    metricLabel = null,
    storage,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    const key = requestKey(url, options);
    if (inFlight.has(key)) return inFlight.get(key);
    const run = (async () => {
      let lastError;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const cooldown = readCooldown(url, safeStorage(storage));
          if (cooldown) await sleep(cooldown - Date.now());
          recordAttempt(url, metricLabel);
          const response = await fetchImpl(url, options);
          if (!response.ok) {
            const error = new Error(`The testnet read returned HTTP ${response.status}.`);
            error.status = response.status;
            error.retryAfterMs = retryAfterMs(response);
            if (Number(response.status) === 429) {
              publishCooldown(url, error.retryAfterMs || DEFAULT_429_COOLDOWN_MS, safeStorage(storage));
            }
            throw error;
          }
          const payload = await response.json();
          if (retryPayload?.(payload)) {
            const error = new Error(payload.error?.message || "The testnet read failed temporarily.");
            error.code = "RPC_TRANSIENT";
            throw error;
          }
          return payload;
        } catch (error) {
          lastError = error;
          // Browser CORS failures surface as TypeError with no HTTP status. They
          // are not safe to retry because a retry storm can hide the real cause.
          const corsOrNetworkFailure = error?.name === "TypeError" && !error?.status;
          const retryable = !corsOrNetworkFailure && (!error?.status || transientStatus(Number(error.status)));
          const isRateLimited = Number(error?.status) === 429;
          if (!retryable || isRateLimited && !retry429 || attempt === attempts - 1) throw error;
          const backoff = Math.min(MAX_BACKOFF_MS, Math.max(
            Number(error?.retryAfterMs || 0),
            Number(delayMs) * (2 ** attempt),
          ));
          if (isRateLimited) publishCooldown(url, backoff, safeStorage(storage));
          await sleep(backoff);
        }
      }
      throw lastError;
    })();
    inFlight.set(key, run);
    try { return await run; }
    finally {
      if (inFlight.get(key) === run) inFlight.delete(key);
    }
  }

  return {
    fetchJsonWithRetry,
    retryAfterMs,
    transientRpcPayload,
    transientStatus,
  };
}));
