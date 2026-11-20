import { describe, expect, it } from "vitest";
import {
  addDaysToIsoDate,
  formatMinutesAsTime,
  getZonedDateParts,
  isoWeekday,
  normalizeIsoDate,
  parseTimeToMinutes,
  zonedWallTimeToInstant,
} from "./appointment-availability.time.js";

/**
 * Unit tests for the Intl-based timezone primitives. No database or server
 * timezone is involved, so these assertions are stable on any host.
 */

describe("appointment availability time helpers", () => {
  it("validates ISO dates and computes ISO weekdays without the server zone", () => {
    expect(normalizeIsoDate("2026-12-07", "Date")).toBe("2026-12-07");
    expect(() => normalizeIsoDate("2026-02-30", "Date")).toThrow(/valid calendar date/);
    expect(() => normalizeIsoDate("07/12/2026", "Date")).toThrow(/ISO date/);

    expect(isoWeekday("2026-11-16")).toBe(1); // Monday
    expect(isoWeekday("2026-11-22")).toBe(7); // Sunday
    expect(isoWeekday("2026-03-29")).toBe(7); // DST spring-forward Sunday
  });

  it("adds calendar days across month, year and leap boundaries", () => {
    expect(addDaysToIsoDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToIsoDate("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysToIsoDate("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("parses and formats wall-clock times", () => {
    expect(parseTimeToMinutes("09:00:00")).toBe(540);
    expect(parseTimeToMinutes("23:45")).toBe(1425);
    expect(formatMinutesAsTime(540)).toBe("09:00");
    expect(formatMinutesAsTime(1425)).toBe("23:45");
  });

  it("converts branch-local times using the IANA zone, not the server zone", () => {
    const winter = zonedWallTimeToInstant("2026-12-07", 9 * 60, "Europe/London");
    expect(winter.instant?.toISOString()).toBe("2026-12-07T09:00:00.000Z");
    expect(winter.ambiguous).toBe(false);

    const summer = zonedWallTimeToInstant("2026-07-06", 9 * 60, "Europe/London");
    expect(summer.instant?.toISOString()).toBe("2026-07-06T08:00:00.000Z");

    const newYork = zonedWallTimeToInstant("2026-12-07", 9 * 60, "America/New_York");
    expect(newYork.instant?.toISOString()).toBe("2026-12-07T14:00:00.000Z");
  });

  it("rejects non-existent spring-forward local times", () => {
    // Europe/London jumps 01:00 GMT -> 02:00 BST on 2026-03-29.
    expect(zonedWallTimeToInstant("2026-03-29", 60, "Europe/London").instant).toBeNull();
    expect(zonedWallTimeToInstant("2026-03-29", 90, "Europe/London").instant).toBeNull();

    const firstValid = zonedWallTimeToInstant("2026-03-29", 120, "Europe/London");
    expect(firstValid.instant?.toISOString()).toBe("2026-03-29T01:00:00.000Z");
  });

  it("resolves ambiguous fall-back local times to the first occurrence", () => {
    // Europe/London repeats 01:00-02:00 local on 2026-10-25.
    const ambiguous = zonedWallTimeToInstant("2026-10-25", 90, "Europe/London");
    expect(ambiguous.ambiguous).toBe(true);
    expect(ambiguous.instant?.toISOString()).toBe("2026-10-25T00:30:00.000Z");

    expect(
      zonedWallTimeToInstant("2026-10-25", 60, "Europe/London").instant?.toISOString(),
    ).toBe("2026-10-25T00:00:00.000Z");
  });

  it("reads back the local date and minutes from an instant", () => {
    const parts = getZonedDateParts(
      new Date("2026-12-07T09:00:00.000Z"),
      "Europe/London",
    );
    expect(parts).toMatchObject({ date: "2026-12-07", minutes: 540 });

    const tokyo = getZonedDateParts(
      new Date("2026-12-07T20:30:00.000Z"),
      "Asia/Tokyo",
    );
    expect(tokyo).toMatchObject({ date: "2026-12-08", minutes: 330 });
  });
});
