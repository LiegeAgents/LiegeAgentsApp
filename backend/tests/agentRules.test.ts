import { describe, expect, test } from "bun:test";
import { isTimeZone, localClock, ownerRuleReasons, type OwnerRules } from "../src/agentActions.js";

const rules = (overrides: Partial<OwnerRules> = {}): OwnerRules => ({
  require_human_above: null,
  active_hours_start: null,
  active_hours_end: null,
  active_days: [],
  active_timezone: "UTC",
  ...overrides,
});
// Wednesday 2026-10-07 at 14:30 UTC.
const wednesdayAfternoon = new Date("2026-10-07T14:30:00Z");

describe("owner policy rules", () => {
  test("an empty rulebook adds no reasons", () => {
    expect(ownerRuleReasons(rules(), 1_000_000, wednesdayAfternoon)).toEqual({
      denied: [],
      review: [],
    });
  });

  test("routes amounts above the threshold to the owner without denying them", () => {
    const threshold = rules({ require_human_above: "250" });
    expect(ownerRuleReasons(threshold, 250, wednesdayAfternoon).review).toEqual([]);
    expect(ownerRuleReasons(threshold, 250.01, wednesdayAfternoon)).toEqual({
      denied: [],
      review: ["human_approval_required"],
    });
    expect(ownerRuleReasons(threshold, null, wednesdayAfternoon).review).toEqual([]);
  });

  test("denies actions outside a same-day window", () => {
    const office = rules({ active_hours_start: 9, active_hours_end: 17 });
    expect(ownerRuleReasons(office, 1, wednesdayAfternoon).denied).toEqual([]);
    expect(ownerRuleReasons(office, 1, new Date("2026-10-07T17:00:00Z")).denied).toEqual([
      "outside_active_hours",
    ]);
    expect(ownerRuleReasons(office, 1, new Date("2026-10-07T08:59:00Z")).denied).toEqual([
      "outside_active_hours",
    ]);
  });

  test("supports overnight windows", () => {
    const night = rules({ active_hours_start: 22, active_hours_end: 6 });
    expect(ownerRuleReasons(night, 1, new Date("2026-10-07T23:00:00Z")).denied).toEqual([]);
    expect(ownerRuleReasons(night, 1, new Date("2026-10-07T05:59:00Z")).denied).toEqual([]);
    expect(ownerRuleReasons(night, 1, wednesdayAfternoon).denied).toEqual(["outside_active_hours"]);
  });

  test("applies active days and hours in the owner's time zone", () => {
    const lagosWeekdays = rules({
      active_hours_start: 9,
      active_hours_end: 17,
      active_days: [1, 2, 3, 4, 5],
      active_timezone: "Africa/Lagos",
    });
    // 14:30 UTC is 15:30 in Lagos on a Wednesday.
    expect(ownerRuleReasons(lagosWeekdays, 1, wednesdayAfternoon).denied).toEqual([]);
    // 16:30 UTC is 17:30 in Lagos, after hours.
    expect(ownerRuleReasons(lagosWeekdays, 1, new Date("2026-10-07T16:30:00Z")).denied).toEqual([
      "outside_active_hours",
    ]);
    // Saturday.
    expect(ownerRuleReasons(lagosWeekdays, 1, new Date("2026-10-10T12:00:00Z")).denied).toEqual([
      "outside_active_hours",
    ]);
  });

  test("reads local clocks and validates time zones", () => {
    expect(localClock("Asia/Tokyo", wednesdayAfternoon)).toEqual({ hour: 23, day: 3 });
    expect(localClock("UTC", new Date("2026-10-07T00:15:00Z"))).toEqual({ hour: 0, day: 3 });
    expect(isTimeZone("Europe/London")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
  });
});
