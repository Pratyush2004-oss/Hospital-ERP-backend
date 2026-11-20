import { describe, expect, it } from "vitest";
import { slugify, TENANT_SLUG_PATTERN } from "../../lib/slug.js";

describe("tenant slug generation", () => {
  it.each([
    ["St. Mary's General Hospital", "st-marys-general-hospital"],
    ["  Northside   Medical Center  ", "northside-medical-center"],
    ["Hôpital Général de Montréal", "hopital-general-de-montreal"],
    ["Clinic #1 / West Wing", "clinic-1-west-wing"],
    ["A_B.C", "a-b-c"],
  ])("slugifies %j", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it("always produces a value accepted by the public slug schema", () => {
    const slug = slugify("St. Mary's General Hospital");

    expect(slug).toMatch(TENANT_SLUG_PATTERN);
    expect(slug).not.toMatch(/^-|-$/);
  });

  it("returns an empty string when no slug characters remain", () => {
    expect(slugify("---")).toBe("");
  });
});
