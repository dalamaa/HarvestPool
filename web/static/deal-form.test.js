const test = require("node:test");
const assert = require("node:assert/strict");
const form = require("./deal-form.js");

test("representative products produce natural labels and exact V5 price terms", () => {
  const usdc = require("./usdc-payments.js");
  const cases = [
    { product: "Tomatoes", unit: "basket", price: "50.00", label: "Price per basket ($)", cents: "5000", units: "50000000" },
    { product: "Beef", unit: "lb", price: "8.75", label: "Price per lb ($)", cents: "875", units: "8750000" },
    { product: "Rice", unit: "kg", price: "3.25", label: "Price per kg ($)", cents: "325", units: "3250000" },
    { product: "Eggs", unit: "dozen", price: "6.00", label: "Price per dozen ($)", cents: "600", units: "6000000" },
    { product: "CSA share", unit: "custom", custom: "half-share", price: "12.50", label: "Price per half-share ($)", cents: "1250", units: "12500000" },
  ];
  cases.forEach((example) => {
    assert.equal(form.labels(example.unit, example.custom).price, example.label, example.product);
    assert.deepEqual(usdc.usdPrice(example.price, 6), { cents: example.cents, tokenUnits: example.units }, example.product);
  });
  assert.equal(form.labels("basket").minimum, "Minimum baskets needed");
  assert.equal(form.labels("lb").maximum, "Total lb available");
  assert.equal(form.labels("kg").perBuyer, "Maximum kg per buyer");
  assert.equal(form.labels("custom", "half-share").maximum, "Total half-shares available");
});

test("package contents appear only for packaged or custom units", () => {
  assert.equal(form.supportsPackageContents("basket"), true);
  assert.equal(form.supportsPackageContents("box"), true);
  assert.equal(form.supportsPackageContents("lb"), false);
  assert.equal(form.supportsPackageContents("kg"), false);
  assert.equal(form.supportsPackageContents("dozen"), false);
  assert.equal(form.supportsPackageContents("custom"), true);
});
