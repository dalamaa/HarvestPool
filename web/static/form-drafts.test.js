const test = require("node:test");
const assert = require("node:assert/strict");

const { clear, draftKey, restore, save } = require("./form-drafts.js");

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) || null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

function surface(fields) {
  return { querySelectorAll: () => fields };
}

test("drafts are scoped by wallet, purchase, and issue", () => {
  const a = draftKey("raise-issue", { walletId: "member-a.testnet", purchaseId: "0" });
  const b = draftKey("raise-issue", { walletId: "member-b.testnet", purchaseId: "0" });
  const c = draftKey("raise-issue", { walletId: "member-a.testnet", purchaseId: "1" });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test("drafts restore text and checkbox values without persisting secrets", () => {
  const storage = new MemoryStorage();
  const fields = [
    { name: "subject", id: "subject", type: "text", value: "Pickup changed", checked: false },
    { name: "acceptance", id: "acceptance", type: "checkbox", value: "on", checked: true },
    { name: "private_key", id: "private-key", type: "text", value: "must-not-persist", checked: false },
  ];
  const form = surface(fields);
  const context = { walletId: "member-a.testnet", purchaseId: "0" };
  assert.equal(save(form, "issue", context, storage), true);
  const stored = JSON.stringify([...storage.values.values()]);
  assert.equal(stored.includes("must-not-persist"), false);

  fields[0].value = "";
  fields[1].checked = false;
  assert.equal(restore(form, "issue", context, storage), true);
  assert.equal(fields[0].value, "Pickup changed");
  assert.equal(fields[1].checked, true);
  assert.equal(clear("issue", context, storage), true);
  assert.equal(restore(form, "issue", context, storage), false);
});
