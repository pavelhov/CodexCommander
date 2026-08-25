import { describe, expect, test } from "bun:test";
import { coerceIntegerToolArguments } from "../src/lib/tool-argument-integers";

const objectSchema = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
});

describe("coerceIntegerToolArguments", () => {
  test("repairs integral floats only when integer intent is declared", () => {
    expect(coerceIntegerToolArguments(
      '{"count":50.0}',
      objectSchema({ count: { type: "integer" } }),
    )).toBe('{"count":50}');
    expect(coerceIntegerToolArguments(
      '{"count":1.2e5}',
      objectSchema({ count: { type: "integer" } }),
    )).toBe('{"count":120000}');
    expect(coerceIntegerToolArguments(
      '{"count":120000e0}',
      objectSchema({ count: { type: "integer" } }),
    )).toBe('{"count":120000}');
  });

  test("repairs Codex timeout_ms under its advertised numeric schema", () => {
    expect(coerceIntegerToolArguments(
      '{"timeout_ms":300000.0}',
      objectSchema({ timeout_ms: { type: "number" } }),
    )).toBe('{"timeout_ms":300000}');
  });

  test.each([
    ['{"timeout_ms":300000.5}', objectSchema({ timeout_ms: { type: "number" } })],
    ['{"temperature":1.0}', objectSchema({ temperature: { type: "number" } })],
    ['{"count":1.0}', undefined],
    ['{"count":9007199254740993.0}', objectSchema({ count: { type: "integer" } })],
    ['{"count":1.0', objectSchema({ count: { type: "integer" } })],
  ])("leaves unauthorized or unsafe input unchanged", (args, schema) => {
    expect(coerceIntegerToolArguments(args, schema)).toBe(args);
  });

  test("walks nested objects and arrays without inheriting property names", () => {
    const schema = objectSchema({
      nested: {
        type: "object",
        properties: { count: { type: "integer" } },
      },
      values: {
        type: "array",
        items: { type: "integer" },
      },
      timeout_ms: {
        type: "array",
        items: { type: "number" },
      },
    });
    expect(coerceIntegerToolArguments(
      '{"nested":{"count":2.0},"values":[1.0,2e0],"timeout_ms":[3.0]}',
      schema,
    )).toBe('{"nested":{"count":2},"values":[1,2],"timeout_ms":[3]}');
    expect(coerceIntegerToolArguments(
      '{"timeout_ms":[3.0]}',
      schema,
    )).toBe('{"timeout_ms":[3.0]}');
  });

  test("applies additionalProperties schemas", () => {
    expect(coerceIntegerToolArguments(
      '{"extra":4.0}',
      { type: "object", additionalProperties: { type: "integer" } },
    )).toBe('{"extra":4}');
    expect(coerceIntegerToolArguments(
      '{"extra":4.0}',
      { type: "object", additionalProperties: false },
    )).toBe('{"extra":4.0}');
  });

  test("resolves local JSON Pointer refs with unescaped segments", () => {
    expect(coerceIntegerToolArguments(
      '{"a~b/c":7.0}',
      {
        type: "object",
        properties: { "a~b/c": { $ref: "#/$defs/a~0b~1c" } },
        $defs: { "a~b/c": { type: "integer" } },
      },
    )).toBe('{"a~b/c":7}');
  });

  test("requires composition branches to declare numeric intent", () => {
    expect(coerceIntegerToolArguments(
      '{"count":1.0}',
      objectSchema({ count: { anyOf: [{ type: "string" }, { type: "integer" }] } }),
    )).toBe('{"count":1}');
    expect(coerceIntegerToolArguments(
      '{"count":1.0}',
      objectSchema({ count: { oneOf: [{ type: "string" }, {}] } }),
    )).toBe('{"count":1.0}');
    expect(coerceIntegerToolArguments(
      '{"count":1.0}',
      objectSchema({ count: { allOf: [{ type: "integer" }, { minimum: 0 }] } }),
    )).toBe('{"count":1}');
    expect(coerceIntegerToolArguments(
      '{"count":1.0}',
      objectSchema({ count: { type: "integer", oneOf: [{}] } }),
    )).toBe('{"count":1.0}');
  });

  test("stops cyclic refs and traversal deeper than the recursion bound", () => {
    const cyclic: Record<string, unknown> = {
      type: "object",
      properties: { child: { $ref: "#/$defs/node" } },
      $defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } },
    };
    expect(coerceIntegerToolArguments('{"child":{"child":1.0}}', cyclic)).toBe('{"child":{"child":1.0}}');

    let schema: Record<string, unknown> = { type: "integer" };
    for (let i = 0; i < 70; i++) schema = { type: "object", properties: { child: schema } };
    let value: Record<string, unknown> = { value: 1.0 };
    for (let i = 0; i < 70; i++) value = { child: value };
    expect(coerceIntegerToolArguments(JSON.stringify(value), schema)).toBe(JSON.stringify(value));
  });
});
