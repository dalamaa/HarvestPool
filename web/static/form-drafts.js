/* Small, local-only draft store for user-entered form data. Never persist wallet secrets. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.HarvestPoolDrafts = factory();
  }
}(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const PREFIX = "harvestpool:draft:v1";
  const SECRET_NAME = /(private|secret|seed|mnemonic|recovery|passphrase|password|key)/i;

  function storageFor(storage) {
    if (storage) return storage;
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch (_error) {
      return null;
    }
  }

  function safePart(value) {
    return encodeURIComponent(String(value || "").slice(0, 160) || "none");
  }

  function draftKey(formId, context = {}) {
    return [
      PREFIX,
      safePart(formId),
      safePart(context.walletId || "unconnected"),
      safePart(context.purchaseId || "global"),
      safePart(context.issueId || "global"),
    ].join(":");
  }

  function fields(surface) {
    if (!surface || typeof surface.querySelectorAll !== "function") return [];
    return Array.from(surface.querySelectorAll("input, textarea, select"))
      .filter((field) => field.name && field.type !== "button" && field.type !== "submit")
      .filter((field) => !SECRET_NAME.test(field.name) && !SECRET_NAME.test(field.id || ""));
  }

  function collect(surface) {
    const values = {};
    fields(surface).forEach((field) => {
      values[field.name] = field.type === "checkbox" || field.type === "radio"
        ? { checked: Boolean(field.checked) }
        : { value: String(field.value ?? "") };
    });
    return values;
  }

  function save(surface, formId, context, storage) {
    const target = storageFor(storage);
    if (!target || !surface || !formId) return false;
    try {
      target.setItem(draftKey(formId, context), JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        values: collect(surface),
      }));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function read(formId, context, storage) {
    const target = storageFor(storage);
    if (!target || !formId) return null;
    try {
      const raw = target.getItem(draftKey(formId, context));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && parsed.version === 1 && parsed.values ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  function restore(surface, formId, context, storage) {
    const draft = read(formId, context, storage);
    if (!draft) return false;
    const saved = draft.values;
    fields(surface).forEach((field) => {
      const value = saved[field.name];
      if (!value) return;
      if (field.type === "checkbox" || field.type === "radio") field.checked = Boolean(value.checked);
      else if (typeof value.value === "string") field.value = value.value;
    });
    return true;
  }

  function clear(formId, context, storage) {
    const target = storageFor(storage);
    if (!target || !formId) return false;
    try {
      target.removeItem(draftKey(formId, context));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function copy(formId, fromContext, toContext, storage) {
    const target = storageFor(storage);
    if (!target || !formId) return false;
    try {
      const source = target.getItem(draftKey(formId, fromContext));
      if (!source) return false;
      target.setItem(draftKey(formId, toContext), source);
      return true;
    } catch (_error) {
      return false;
    }
  }

  return { clear, collect, copy, draftKey, fields, read, restore, save };
}));
