const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const time = require("./deal-time.js");

test("converts Deal #0's Chicago wall time to its verified immutable timestamp", () => {
  const value = time.toNanoseconds("2026-11-10T14:00", "America/Chicago");
  assert.equal(value, "1794340800000000000");
  assert.equal(
    time.formatInstant(value, "America/Chicago", "America/Chicago"),
    "Nov 10, 2026, 2:00 PM (GMT-6, Central Time)",
  );
});

test("uses the offset at the deal date, including daylight saving time", () => {
  assert.equal(time.offsetLabel(new Date("2026-01-15T18:00:00Z"), "America/Chicago"), "GMT-6");
  assert.equal(time.offsetLabel(new Date("2026-07-15T18:00:00Z"), "America/Chicago"), "GMT-5");
  assert.match(time.formatZoned(new Date("2026-07-15T18:00:00Z"), "America/Chicago"), /GMT-5, Central Time/);
});

test("shows an equivalent local time when the viewer uses another zone", () => {
  const display = time.formatInstant("1794340800000000000", "America/Chicago", "America/New_York");
  assert.match(display, /2:00 PM \(GMT-6, Central Time\)/);
  assert.match(display, /Your time: Nov 10, 2026, 3:00 PM \(GMT-5, Eastern Time\)/);
});

test("rejects nonexistent and ambiguous daylight-saving wall times", () => {
  assert.throws(() => time.instantFromWallTime("2026-03-08T02:30", "America/Chicago"), /does not exist/);
  assert.throws(() => time.instantFromWallTime("2026-11-01T01:30", "America/Chicago"), /occurs twice/);
});

test("business timezone option shows its current offset", () => {
  assert.equal(
    time.zoneOptionLabel("Central Time", "America/Chicago", new Date("2026-11-10T12:00:00Z")),
    "Central Time (GMT-6)",
  );
});

test("create form and app use an IANA business timezone for immutable deal timestamps", () => {
  const root = path.join(__dirname, "..");
  const template = fs.readFileSync(path.join(root, "templates", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  assert.match(template, /id="business-timezone"/);
  assert.match(template, /value="America\/Chicago"/);
  assert.match(template, /deal-time\.js/);
  assert.match(app, /toNanoseconds\(deadline, businessZone\)/);
  assert.match(app, /formatInstant\(ns, businessTimeZone\(\), dealTimeTools\.browserTimeZone\(\)\)/);
});
