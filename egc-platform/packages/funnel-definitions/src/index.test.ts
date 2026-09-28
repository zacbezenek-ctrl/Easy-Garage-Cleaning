import { describe, expect, it } from "vitest";
import { hubDefinitionsHash, hubDefinitionsVersion, canonicalJson, definitions, definitionsHash, definitionsVerified, ghlTagKey, hashDefinitions, sameDefinitions } from "./index.js";

describe("@egc/funnel-definitions", () => {
  it("hashes the copied JSON to exactly the value the Hub computed when it generated this package", () => {
    expect(definitionsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(definitionsHash).toBe(hubDefinitionsHash);
    expect(definitions.definitionsVersion).toBe(hubDefinitionsVersion);
    expect(definitionsVerified).toBe(true);
    expect(sameDefinitions(hubDefinitionsHash)).toBe(true);
    expect(sameDefinitions(hubDefinitionsHash.replace(/^./, c => (c === "0" ? "1" : "0")))).toBe(false);
    expect(sameDefinitions(undefined)).toBe(false);
  });

  it("canonical hashing ignores key order and whitespace but not values", () => {
    expect(canonicalJson({ b: [2, { d: 1, c: "x" }], a: null })).toBe('{"a":null,"b":[2,{"c":"x","d":1}]}');
    const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)])) : value;
    const reordered = reverse(definitions);
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(definitions));
    expect(hashDefinitions(reordered)).toBe(definitionsHash);
    expect(hashDefinitions({ ...definitions, definitionsVersion: "1999-01-01.1" })).not.toBe(definitionsHash);
    // Code-unit ordering, never locale ordering: "Z" (0x5A) sorts before "a" (0x61).
    expect(canonicalJson({ a: 1, Z: 2 })).toBe('{"Z":2,"a":1}');
  });

  it("exposes the shared lists deep-frozen so no consumer can drift from the Hub", () => {
    expect(Object.isFrozen(definitions)).toBe(true);
    expect(Object.isFrozen(definitions.eligibility.ghl.exclusionTags)).toBe(true);
    expect(() => { (definitions.vocabularies.serviceLines as string[]).push("x"); }).toThrow();
    expect(definitions.timeZone).toBe("America/Denver");
    expect(definitions.eligibility.ghl.exclusionTags["egc-test"]).toBe("test");
    expect(definitions.reasonCodes.walkthroughOutcome).toContain("quote_to_follow");
    expect(definitions.cycles.repeatWindowDays).toBe(30);
    expect(definitions.eventTypes["deal.sold"]?.required).toContain("amountCents");
  });

  it("folds GHL tags the way the Hub does, so the shared exclusion lists match every spelling", () => {
    expect(definitions.eligibility.ghl.tagFolding).toBe("lowercase_fold_separators_to_hyphen");
    for (const [raw, folded] of [[" EGC Test ", "egc-test"], ["egc_test", "egc-test"], ["Do  Not_Contact", "do-not-contact"], ["-vendor-", "vendor"], [7, ""]] as const) expect(ghlTagKey(raw)).toBe(folded);
    for (const tag of Object.keys(definitions.eligibility.ghl.exclusionTags)) expect(ghlTagKey(tag)).toBe(tag);
    for (const tag of ["egc test", "test lead", "egc internal", "egc vendor", "supplier", "do not contact"]) expect(definitions.eligibility.ghl.exclusionTags[ghlTagKey(tag)]).toBeDefined();
    expect(definitions.eligibility.ghl.exclusionFlags["dnd"]).toBe("do_not_contact");
  });
});
