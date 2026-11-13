const test = require("node:test");
const assert = require("node:assert/strict");

const { failureMessage, recoverStalledUi, withTimeout } = require("./wallet-initialization.js");

test("wallet initialization resolves normally before its deadline", async () => {
  assert.equal(await withTimeout(Promise.resolve("ready"), 50), "ready");
});

test("a stalled wallet initialization becomes a retryable timeout", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 5),
    (error) => error.code === "WALLET_INITIALIZATION_TIMEOUT",
  );
});

test("wallet initialization failures give a recovery action", () => {
  const timeout = new Error("late");
  timeout.code = "WALLET_INITIALIZATION_TIMEOUT";
  assert.match(failureMessage(timeout), /timed out/i);
  assert.match(failureMessage(timeout), /retry/i);
  assert.match(failureMessage(new Error("blocked")), /permissions/i);
  assert.match(failureMessage(new Error("blocked")), /retry/i);
});

test("a startup exception cannot leave the navbar loading indefinitely", () => {
  let reloaded = false;
  let clickHandler;
  const fields = {
    "#wallet-account": { textContent: "Not connected" },
    "#wallet-panel-copy": { textContent: "Connect Meteor Wallet." },
  };
  const button = {
    dataset: {},
    disabled: true,
    textContent: "Loading wallet…",
    attributes: new Map([["aria-busy", "true"]]),
    getAttribute(name) { return this.attributes.get(name) || null; },
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
    addEventListener(_name, handler) { clickHandler = handler; },
  };
  const documentRef = {
    querySelector(selector) { return selector === "#wallet-button" ? button : fields[selector]; },
  };

  assert.equal(recoverStalledUi(documentRef, () => { reloaded = true; }), true);
  assert.equal(button.textContent, "Retry wallet");
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute("aria-busy"), null);
  assert.equal(fields["#wallet-account"].textContent, "Wallet unavailable");
  const event = { preventDefault() {}, stopImmediatePropagation() {} };
  clickHandler(event);
  assert.equal(reloaded, true);
});

test("the watchdog leaves a completed wallet state unchanged", () => {
  const button = {
    textContent: "Connect wallet",
    getAttribute() { return null; },
  };
  const documentRef = { querySelector() { return button; } };
  assert.equal(recoverStalledUi(documentRef), false);
  assert.equal(button.textContent, "Connect wallet");
});
