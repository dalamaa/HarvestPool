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

test("Deal #2 deadlines render with exact Central time and a useful window summary", () => {
  const join = "1794986100000000000";
  const fulfillment = "1795591800000000000";
  assert.equal(
    time.formatInstant(join, "America/Chicago", "America/Chicago"),
    "Nov 18, 2026, 1:15 AM (GMT-6, Central Time)",
  );
  assert.equal(
    time.formatInstant(fulfillment, "America/Chicago", "America/Chicago"),
    "Nov 25, 2026, 1:30 AM (GMT-6, Central Time)",
  );
  assert.deepEqual(time.fulfillmentWindow(join, fulfillment), {
    valid: true,
    short: false,
    milliseconds: 605700000,
    summary: "The supplier has 7 days 15 minutes after joining closes.",
  });
});

test("short fulfillment windows produce a warning state without changing validation", () => {
  const result = time.fulfillmentWindow(
    new Date("2026-11-18T07:15:00Z"),
    new Date("2026-11-18T19:15:00Z"),
  );
  assert.equal(result.valid, true);
  assert.equal(result.short, true);
  assert.match(result.summary, /12 hours/);
});

test("deadline summaries distinguish future, passed, and current cutoffs", () => {
  const deadline = "1794986100000000000";
  assert.equal(time.deadlineSummary(deadline, Date.parse("2026-11-17T07:15:00Z")), "Closes in 1 day.");
  assert.equal(time.deadlineSummary(deadline, Date.parse("2026-11-19T07:15:00Z")), "Closed 1 day ago.");
  assert.equal(time.deadlineSummary(deadline, Date.parse("2026-11-18T07:15:00Z")), "Deadline is now.");
});

test("create form and app use an IANA business timezone for immutable deal timestamps", () => {
  const root = path.join(__dirname, "..");
  const template = fs.readFileSync(path.join(root, "templates", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  assert.match(template, /id="business-timezone"/);
  assert.match(template, /value="America\/Chicago"/);
  assert.match(template, /aria-describedby="fulfillment-deadline-tooltip"/);
  assert.match(template, /id="fulfillment-window-warning" role="alert"/);
  assert.match(template, /The supplier needs time after joining closes/);
  assert.match(template, /deal-time\.js/);
  assert.match(app, /toNanoseconds\(deadline, businessZone\)/);
  assert.match(app, /formatInstant\(ns, businessTimeZone\(\), dealTimeTools\.browserTimeZone\(\)\)/);
});
