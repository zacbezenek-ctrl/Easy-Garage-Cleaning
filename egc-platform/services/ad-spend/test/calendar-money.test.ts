import { describe, expect, it } from "vitest";
import { addDays, alignedWithDenver, dateRange, dayStart, denverDateOf, denverDateReceivesDay, parseInstant, validDate, validTimeZone, zonedDate } from "../src/dates.js";
import { countValue, decimalCents, microsCents, parseMicros } from "../src/money.js";

describe("Denver calendar helpers", () => {
  it("validates real calendar dates only", () => {
    for (const date of ["2026-09-28", "2028-02-29", "2026-12-31"]) expect(validDate(date)).toBe(true);
    for (const date of ["2026-02-29", "2026-13-01", "2026-9-28", "20260928", "", null, 20260928]) expect(validDate(date)).toBe(false);
    expect(validTimeZone("America/Denver")).toBe(true);
    for (const zone of ["Mars/Base", "", "x".repeat(101), 7]) expect(validTimeZone(zone)).toBe(false);
  });
  it("finds local midnight across both 2026 Denver DST changes", () => {
    expect(new Date(dayStart("2026-03-08", "America/Denver")).toISOString()).toBe("2026-03-08T07:00:00.000Z");
    expect(new Date(dayStart("2026-03-09", "America/Denver")).toISOString()).toBe("2026-03-09T06:00:00.000Z");
    expect(new Date(dayStart("2026-11-01", "America/Denver")).toISOString()).toBe("2026-11-01T06:00:00.000Z");
    expect(new Date(dayStart("2026-11-02", "America/Denver")).toISOString()).toBe("2026-11-02T07:00:00.000Z");
    expect(new Date(dayStart("2026-09-20", "Asia/Tokyo")).toISOString()).toBe("2026-09-19T15:00:00.000Z");
  });
  it("uses explicit zones, never the host clock zone", () => {
    const instant = Date.parse("2026-09-21T05:30:00Z");
    expect(zonedDate(instant, "America/Denver")).toBe("2026-09-20");
    expect(zonedDate(instant, "UTC")).toBe("2026-09-21");
    expect(zonedDate(instant, "Asia/Tokyo")).toBe("2026-09-21");
    expect(addDays("2026-03-07", 2)).toBe("2026-03-09");
    expect(dateRange("2026-02-27", "2026-03-02")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    expect(dateRange("2026-03-02", "2026-02-27")).toEqual([]);
  });
  it("knows which provider zones share Denver's calendar day", () => {
    for (const date of ["2026-01-15", "2026-03-08", "2026-07-15", "2026-11-01"]) {
      expect(alignedWithDenver(date, "America/Denver")).toBe(true);
      expect(alignedWithDenver(date, "America/Boise")).toBe(true);
      expect(alignedWithDenver(date, "America/Los_Angeles")).toBe(false);
    }
    // Phoenix keeps MST all year: the same day as Denver in winter only.
    expect(alignedWithDenver("2026-01-15", "America/Phoenix")).toBe(true);
    expect(alignedWithDenver("2026-07-15", "America/Phoenix")).toBe(false);
  });
  it("reports an unaligned provider day under the Denver date of its midpoint", () => {
    expect(denverDateOf("2026-09-20", "America/Denver")).toBe("2026-09-20");
    expect(denverDateOf("2026-09-20", "America/Los_Angeles")).toBe("2026-09-20");
    expect(denverDateOf("2026-09-20", "Asia/Tokyo")).toBe("2026-09-19");
  });
  it("knows the Denver dates a zone about 12 hours away skips or doubles at a Denver DST change", () => {
    // Dhaka (UTC+6) days are reported one Denver day early on MST and on the same day on MDT.
    expect(["2026-03-07", "2026-03-08", "2026-03-09"].map(date => denverDateOf(date, "Asia/Dhaka"))).toEqual(["2026-03-06", "2026-03-07", "2026-03-09"]);
    expect(["2026-03-07", "2026-03-08", "2026-03-09"].map(date => denverDateReceivesDay(date, "Asia/Dhaka"))).toEqual([true, false, true]);
    expect(["2026-11-01", "2026-11-02"].map(date => denverDateOf(date, "Asia/Dhaka"))).toEqual(["2026-11-01", "2026-11-01"]);
    for (const zone of ["America/Denver", "America/Los_Angeles", "Asia/Tokyo"]) expect(dateRange("2026-03-01", "2026-03-15").every(date => denverDateReceivesDay(date, zone)), zone).toBe(true);
  });
  it("parses provider instants strictly", () => {
    expect(parseInstant("2026-09-20T05:59:00+0000")).toBe(Date.parse("2026-09-20T05:59:00Z"));
    expect(parseInstant("2026-09-20T05:59:00-06:00")).toBe(Date.parse("2026-09-20T11:59:00Z"));
    expect(parseInstant("2026-09-20T05:59:00.123Z")).toBe(Date.parse("2026-09-20T05:59:00.123Z"));
    for (const value of ["2026-09-20T05:59:00", "2026-02-30T00:00:00Z", "yesterday", 1790000000, null]) expect(parseInstant(value)).toBeNull();
  });
});

describe("integer cents and counts", () => {
  it("converts Meta decimal spend exactly, half up, and refuses anything else", () => {
    expect(decimalCents("12.34")).toBe(1234);
    expect(decimalCents("12")).toBe(1200);
    expect(decimalCents("0.005")).toBe(1);
    expect(decimalCents("0.0049")).toBe(0);
    expect(decimalCents("1.999")).toBe(200);
    expect(decimalCents(12.34)).toBe(1234);
    expect(decimalCents("21474836.47")).toBe(2_147_483_647);
    for (const value of ["-1", "1e3", "abc", "", "21474836.48", null, undefined, Number.NaN, -3]) expect(decimalCents(value)).toBeNull();
  });
  it("converts Google micros exactly, half up", () => {
    expect(microsCents(parseMicros("1234567")!)).toBe(123);
    expect(microsCents(parseMicros("1235000")!)).toBe(124);
    expect(microsCents(parseMicros("0")!)).toBe(0);
    expect(microsCents(parseMicros(20_000_000)!)).toBe(2000);
    for (const value of ["-5", "1.5", "abc", 1.5, -1]) expect(parseMicros(value)).toBeNull();
    expect(microsCents(-1n)).toBeNull();
    expect(microsCents(21_474_836_480_000n)).toBeNull();
  });
  it("keeps counts as non-negative integers or unknown", () => {
    expect(countValue("3021")).toBe(3021);
    expect(countValue(0)).toBe(0);
    for (const value of ["-1", "1.5", "99999999999", "x", null, 2 ** 31]) expect(countValue(value)).toBeNull();
  });
});
