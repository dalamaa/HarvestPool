(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HarvestPoolDealTime = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_BUSINESS_TIME_ZONE = "America/Chicago";
  const PARTS_FORMATTERS = new Map();

  function browserTimeZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }

  function assertTimeZone(timeZone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format();
      return timeZone;
    } catch (_error) {
      throw new Error("Choose a valid business timezone.");
    }
  }

  function partsFormatter(timeZone) {
    assertTimeZone(timeZone);
    if (!PARTS_FORMATTERS.has(timeZone)) {
      PARTS_FORMATTERS.set(timeZone, new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }));
    }
    return PARTS_FORMATTERS.get(timeZone);
  }

  function zonedParts(date, timeZone) {
    const values = {};
    partsFormatter(timeZone).formatToParts(date).forEach((part) => {
      if (part.type !== "literal") values[part.type] = Number(part.value);
    });
    return values;
  }

  function offsetMinutesAt(date, timeZone) {
    const parts = zonedParts(date, timeZone);
    const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return Math.round((representedAsUtc - date.getTime()) / 60000);
  }

  function offsetLabel(date, timeZone) {
    const minutes = offsetMinutesAt(date, timeZone);
    const sign = minutes >= 0 ? "+" : "-";
    const absolute = Math.abs(minutes);
    const hours = Math.floor(absolute / 60);
    const remainder = absolute % 60;
    return `GMT${sign}${hours}${remainder ? `:${String(remainder).padStart(2, "0")}` : ""}`;
  }

  function zoneName(date, timeZone) {
    for (const style of ["longGeneric", "long"]) {
      try {
        const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: style })
          .formatToParts(date)
          .find((item) => item.type === "timeZoneName");
        if (part?.value && !part.value.startsWith("GMT")) return part.value;
      } catch (_error) {
        // Older browsers may not support longGeneric.
      }
    }
    return timeZone.replaceAll("_", " ");
  }

  function formatZoned(dateValue, timeZone) {
    const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
    if (Number.isNaN(date.getTime())) return "Not set";
    const dateAndTime = new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
    return `${dateAndTime} (${offsetLabel(date, timeZone)}, ${zoneName(date, timeZone)})`;
  }

  function dateFromNanoseconds(value) {
    return new Date(Number(BigInt(String(value)) / 1000000n));
  }

  function formatInstant(value, businessTimeZone = DEFAULT_BUSINESS_TIME_ZONE, localTimeZone = browserTimeZone()) {
    if (!value) return "Not set";
    try {
      const date = value instanceof Date ? value : dateFromNanoseconds(value);
      if (Number.isNaN(date.getTime())) return "Not set";
      const business = formatZoned(date, businessTimeZone);
      if (!localTimeZone || localTimeZone === businessTimeZone) return business;
      return `${business} · Your time: ${formatZoned(date, localTimeZone)}`;
    } catch (_error) {
      return "Not set";
    }
  }

  function durationLabel(milliseconds) {
    const totalMinutes = Math.max(0, Math.round(Number(milliseconds) / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const parts = [];
    if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
    if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
    if (minutes || !parts.length) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
    return parts.slice(0, 2).join(" ");
  }

  function deadlineSummary(value, nowMs = Date.now()) {
    if (!value) return "Deadline not set.";
    try {
      const date = value instanceof Date ? value : dateFromNanoseconds(value);
      const difference = date.getTime() - Number(nowMs);
      if (!Number.isFinite(difference)) return "Deadline not set.";
      if (Math.abs(difference) < 60000) return "Deadline is now.";
      return difference > 0
        ? `Closes in ${durationLabel(difference)}.`
        : `Closed ${durationLabel(Math.abs(difference))} ago.`;
    } catch (_error) {
      return "Deadline not set.";
    }
  }

  function fulfillmentWindow(joinValue, fulfillmentValue, shortWindowHours = 24) {
    try {
      const join = joinValue instanceof Date ? joinValue : dateFromNanoseconds(joinValue);
      const fulfillment = fulfillmentValue instanceof Date ? fulfillmentValue : dateFromNanoseconds(fulfillmentValue);
      const milliseconds = fulfillment.getTime() - join.getTime();
      if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
        return { valid: false, short: false, milliseconds, summary: "Fulfillment must be after joining closes." };
      }
      return {
        valid: true,
        short: milliseconds < Number(shortWindowHours) * 3600000,
        milliseconds,
        summary: `The supplier has ${durationLabel(milliseconds)} after joining closes.`,
      };
    } catch (_error) {
      return { valid: false, short: false, milliseconds: NaN, summary: "Choose both deadlines to review the fulfillment window." };
    }
  }

  function parseWallTime(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    if (!match) throw new Error("Enter a valid date and time.");
    const parts = match.slice(1).map(Number);
    const [year, month, day, hour, minute] = parts;
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
      throw new Error("Enter a valid date and time.");
    }
    return { year, month, day, hour, minute };
  }

  function sameWallTime(parts, expected) {
    return ["year", "month", "day", "hour", "minute"].every((key) => parts[key] === expected[key]);
  }

  function instantFromWallTime(value, timeZone) {
    assertTimeZone(timeZone);
    const expected = parseWallTime(value);
    const wallUtc = Date.UTC(expected.year, expected.month - 1, expected.day, expected.hour, expected.minute);
    const possibleOffsets = new Set();
    for (let hours = -48; hours <= 48; hours += 6) {
      possibleOffsets.add(offsetMinutesAt(new Date(wallUtc + hours * 3600000), timeZone));
    }
    const matches = [...possibleOffsets]
      .map((offset) => new Date(wallUtc - offset * 60000))
      .filter((candidate) => sameWallTime(zonedParts(candidate, timeZone), expected));
    if (!matches.length) {
      throw new Error("That local time does not exist because the clocks change then. Choose another time.");
    }
    if (matches.length > 1) {
      throw new Error("That local time occurs twice because the clocks change then. Choose a different time.");
    }
    return matches[0];
  }

  function toNanoseconds(value, timeZone) {
    return (BigInt(instantFromWallTime(value, timeZone).getTime()) * 1000000n).toString();
  }

  function wallTimeValue(dateValue, timeZone) {
    const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
    const parts = zonedParts(date, timeZone);
    const pad = (number) => String(number).padStart(2, "0");
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
  }

  function zoneOptionLabel(label, timeZone, now = new Date()) {
    return `${label} (${offsetLabel(now, timeZone)})`;
  }

  return {
    DEFAULT_BUSINESS_TIME_ZONE,
    assertTimeZone,
    browserTimeZone,
    deadlineSummary,
    durationLabel,
    fulfillmentWindow,
    formatInstant,
    formatZoned,
    instantFromWallTime,
    offsetLabel,
    offsetMinutesAt,
    toNanoseconds,
    wallTimeValue,
    zoneName,
    zoneOptionLabel,
  };
});
