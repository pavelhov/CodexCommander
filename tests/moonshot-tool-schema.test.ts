import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import type { CodexCommanderParsedRequest, CodexCommanderProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));

function provider(overrides: Partial<CodexCommanderProviderConfig> = {}): CodexCommanderProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKey: "sk-test",
    authMode: "key",
    ...overrides,
  };
}

function parsedWithParameters(parameters: Record<string, unknown>): CodexCommanderParsedRequest {
  return {
    modelId: "kimi-k3",
    context: {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
      tools: [{ name: "create_thread", description: "make a thread", parameters }],
    },
    stream: false,
    options: {},
  };
}

function emittedParameters(req: CodexCommanderParsedRequest, prov = provider()): Record<string, unknown> {
  const built = createOpenAIChatAdapter(prov).buildRequest(req) as { body: string };
  const body = JSON.parse(built.body) as { tools: { function: { parameters: Record<string, unknown> } }[] };
  return body.tools[0]!.function.parameters;
}

/** Collect every node in the schema tree that carries a `$ref` key. */
function refNodes(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const entry of value) refNodes(entry, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  const obj = value as Record<string, unknown>;
  if (typeof obj.$ref === "string") found.push(obj);
  for (const child of Object.values(obj)) refNodes(child, found);
  return found;
}

describe("moonshot tool schema sanitization", () => {
  // Reproduces the exact 400 shape seen from api.moonshot.ai:
  //   At path '$defs.__schema20': when using $ref, type should be defined
  //   in the referenced schema instead of the parent schema
  const REPORTED_SHAPE = {
    type: "object",
    properties: {
      brief: { $ref: "#/$defs/__schema10", description: "what to do" },
    },
    $defs: {
      __schema10: { type: "object", properties: { title: { type: "string" } } },
      __schema20: { $ref: "#/$defs/__schema10", type: "object" },
    },
  };

  test("no emitted $ref node carries sibling keys (the reported $defs.__schema20 case)", () => {
    const parameters = emittedParameters(parsedWithParameters(REPORTED_SHAPE));
    for (const node of refNodes(parameters)) {
      expect(Object.keys(node)).toEqual(["$ref"]);
    }
  });

  test("a $defs entry that is $ref + type is inlined from its target", () => {
    const parameters = emittedParameters(parsedWithParameters(REPORTED_SHAPE));
    const defs = parameters.$defs as Record<string, Record<string, unknown>>;
    expect(defs.__schema20).toMatchObject({
      type: "object",
      properties: { title: { type: "string" } },
    });
  });

  test("a property-level $ref with a description sibling is resolved", () => {
    const parameters = emittedParameters(parsedWithParameters(REPORTED_SHAPE));
    const props = parameters.properties as Record<string, Record<string, unknown>>;
    expect(props.brief).toMatchObject({
      type: "object",
      description: "what to do",
      properties: { title: { type: "string" } },
    });
  });

  test.each(["https://api.moonshot.ai/v1", "https://api.moonshot.cn/v1", "https://api.kimi.com/coding/v1"])(
    "applies to %s",
    baseUrl => {
      const parameters = emittedParameters(parsedWithParameters(REPORTED_SHAPE), provider({ baseUrl }));
      for (const node of refNodes(parameters)) {
        expect(Object.keys(node)).toEqual(["$ref"]);
      }
    },
  );

  test("recursive schemas stay referenced and terminate", () => {
    const parameters = emittedParameters(parsedWithParameters({
      type: "object",
      properties: { root: { $ref: "#/$defs/node", type: "object" } },
      $defs: {
        node: {
          type: "object",
          properties: {
            children: { type: "array", items: { $ref: "#/$defs/node" } },
          },
        },
      },
    }));
    const props = parameters.properties as Record<string, Record<string, unknown>>;
    // The sibling-carrying root ref is inlined once; the inner bare $ref keeps the recursion intact.
    expect(props.root).toMatchObject({ type: "object" });
    const node = (parameters.$defs as Record<string, Record<string, unknown>>).node;
    const items = (node.properties as Record<string, Record<string, unknown>>).children
      .items as Record<string, unknown>;
    expect(items).toEqual({ $ref: "#/$defs/node" });
  });

  test("unresolvable or external refs keep the $ref and drop siblings", () => {
    const parameters = emittedParameters(parsedWithParameters({
      type: "object",
      properties: {
        external: { $ref: "https://example.com/schema.json", type: "object" },
        missing: { $ref: "#/$defs/nope", description: "gone" },
      },
    }));
    const props = parameters.properties as Record<string, Record<string, unknown>>;
    expect(props.external).toEqual({ $ref: "https://example.com/schema.json" });
    expect(props.missing).toEqual({ $ref: "#/$defs/nope" });
  });

  test("non-moonshot providers pass the shape through untouched", () => {
    const parameters = emittedParameters(
      parsedWithParameters(REPORTED_SHAPE),
      provider({ baseUrl: "https://api.deepseek.com/v1" }),
    );
    const defs = parameters.$defs as Record<string, Record<string, unknown>>;
    expect(defs.__schema20).toEqual({ $ref: "#/$defs/__schema10", type: "object" });
  });

  test("root still gains type: object when missing", () => {
    const parameters = emittedParameters(parsedWithParameters({
      properties: { title: { type: "string" } },
    }));
    expect(parameters.type).toBe("object");
  });
});
