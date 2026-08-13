import { describe, expect, test } from "bun:test";
import {
  deriveRosterReachability,
  type RosterProjectionExclusion,
  type RosterProjections,
} from "../gui/src/pages/subagent-roster-reachability";

function projections(v1: unknown, v2: unknown): RosterProjections {
  return { v1, v2 };
}

function projection(excluded: unknown): unknown {
  return { excluded };
}

function exclusion(configured: string, reason?: string): RosterProjectionExclusion {
  return reason === undefined ? { configured } : { configured, reason };
}

function entries(map: ReadonlyMap<string, string>): [string, string][] {
  return [...map.entries()];
}

describe("deriveRosterReachability", () => {
  test("valid empty exclusions on both surfaces -> every chosen selector is both", () => {
    const map = deriveRosterReachability(
      ["a", "b", "c"],
      projections(projection([]), projection([])),
    );
    expect(entries(map)).toEqual([
      ["a", "both"],
      ["b", "both"],
      ["c", "both"],
    ]);
  });

  test("v2 exclusion only -> v1", () => {
    const map = deriveRosterReachability(
      ["foo", "bar"],
      projections(projection([]), projection([exclusion("foo")])),
    );
    expect(map.get("foo")).toBe("v1");
    expect(map.get("bar")).toBe("both");
  });

  test("v1 exclusion only -> v2", () => {
    const map = deriveRosterReachability(
      ["foo", "bar"],
      projections(projection([exclusion("foo")]), projection([])),
    );
    expect(map.get("foo")).toBe("v2");
    expect(map.get("bar")).toBe("both");
  });

  test("same selector excluded by both -> neither", () => {
    const map = deriveRosterReachability(
      ["foo"],
      projections(projection([exclusion("foo")]), projection([exclusion("foo")])),
    );
    expect(map.get("foo")).toBe("neither");
  });

  test("reason is ignored: every reason string excludes identically", () => {
    const reasons = [
      "missing_catalog_entry",
      "outside_display_limit",
      "surface_incompatible",
      "picker_hidden",
    ];
    for (const reason of reasons) {
      const map = deriveRosterReachability(
        ["foo", "bar"],
        projections(
          projection([exclusion("foo", reason)]),
          projection([exclusion("bar", reason)]),
        ),
      );
      expect(entries(map), `reason=${reason}`).toEqual([
        ["foo", "v2"],
        ["bar", "v1"],
      ]);
    }
  });

  test("multiple mixed selectors -> exact both/v1/v2/neither map", () => {
    const map = deriveRosterReachability(
      ["both-model", "v1-only", "v2-only", "neither-model", "untouched"],
      projections(
        projection([exclusion("v2-only"), exclusion("neither-model")]),
        projection([exclusion("v1-only"), exclusion("neither-model")]),
      ),
    );
    expect(entries(map)).toEqual([
      ["both-model", "both"],
      ["v1-only", "v1"],
      ["v2-only", "v2"],
      ["neither-model", "neither"],
      ["untouched", "both"],
    ]);
  });

  test("exclusion matches the exact configured selector, not prefixes or suffixes", () => {
    const map = deriveRosterReachability(
      ["foo", "provider/foo", "foo/bar"],
      projections(projection([exclusion("foo")]), projection([exclusion("provider/foo")])),
    );
    // "foo" is excluded only on v1; "provider/foo" only on v2; "foo/bar" never.
    expect(entries(map)).toEqual([
      ["foo", "v2"],
      ["provider/foo", "v1"],
      ["foo/bar", "both"],
    ]);
  });

  test("catalogModel on the entry does not affect matching; configured wins", () => {
    const map = deriveRosterReachability(
      ["alias-target"],
      projections(
        projection([{ configured: "alias-target", catalogModel: "completely/different" }]),
        projection([]),
      ),
    );
    expect(entries(map)).toEqual([["alias-target", "v2"]]);
  });

  test("duplicate selector in chosen -> one stable map entry", () => {
    const map = deriveRosterReachability(
      ["dup", "dup", "dup"],
      projections(projection([]), projection([exclusion("dup")])),
    );
    expect(entries(map)).toEqual([["dup", "v1"]]);
    expect(map.size).toBe(1);
  });

  test("no projections argument -> empty map", () => {
    expect(entries(deriveRosterReachability(["foo"]))).toEqual([]);
  });

  test("only v1 present -> empty map", () => {
    const map = deriveRosterReachability(["foo"], projections(projection([]), undefined));
    expect(entries(map)).toEqual([]);
  });

  test("only v2 present -> empty map", () => {
    const map = deriveRosterReachability(["foo"], projections(undefined, projection([])));
    expect(entries(map)).toEqual([]);
  });

  test("v1 as null, primitive, or string -> empty map", () => {
    const validV2 = projection([]);
    for (const v1 of [null, 42, true, "excluded"]) {
      expect(
        entries(deriveRosterReachability(["foo"], projections(v1, validV2))),
        `v1=${String(v1)}`,
      ).toEqual([]);
    }
  });

  test("projection missing excluded -> empty map", () => {
    for (const v1 of [{}, { excluded: undefined }, { reasons: [] }]) {
      expect(
        entries(deriveRosterReachability(["foo"], projections(v1, projection([])))),
        JSON.stringify(v1),
      ).toEqual([]);
    }
  });

  test("excluded not an array -> empty map", () => {
    for (const excluded of ["string", 42, null, { configured: "foo" }]) {
      expect(
        entries(deriveRosterReachability(["foo"], projections(projection(excluded), projection([])))),
        `excluded=${String(excluded)}`,
      ).toEqual([]);
    }
  });

  test("malformed exclusion entries fail closed with no partial results", () => {
    const malformed: unknown[] = [
      null,
      42,
      "string",
      {},
      { reason: "missing_catalog_entry" },
      { configured: "" },
      { configured: 7 },
    ];
    for (const entry of malformed) {
      const bad = projection([{ configured: "foo" }, entry]);
      expect(
        entries(deriveRosterReachability(["foo"], projections(bad, projection([])))),
        `entry=${JSON.stringify(entry)}`,
      ).toEqual([]);
    }
  });

  test("unknown reason and extra fields with a valid configured are accepted", () => {
    const map = deriveRosterReachability(
      ["foo", "bar"],
      projections(
        projection([{ configured: "foo", reason: "brand_new_reason", extra: { anything: true } }]),
        projection([{ configured: "bar", reason: 123, extra: ["x"] }]),
      ),
    );
    expect(entries(map)).toEqual([
      ["foo", "v2"],
      ["bar", "v1"],
    ]);
  });

  test("empty chosen with valid projections -> empty map", () => {
    const map = deriveRosterReachability(
      [],
      projections(projection([exclusion("foo")]), projection([exclusion("foo")])),
    );
    expect(entries(map)).toEqual([]);
    expect(map.size).toBe(0);
  });
});
