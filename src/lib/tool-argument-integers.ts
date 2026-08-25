type SchemaNode = Record<string, unknown>;

interface CoerceResult {
  value: unknown;
  changed: boolean;
}

type PathPart = string | number;
type NumericTokens = Map<string, string>;

const U64_NUMBER_FIELDS = new Set(["timeout_ms"]);
const MAX_SCHEMA_DEPTH = 64;

function asSchema(value: unknown): SchemaNode | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as SchemaNode
    : undefined;
}

function schemaTypeIncludes(schema: SchemaNode, type: string): boolean {
  const declared = schema.type;
  return declared === type || (Array.isArray(declared) && declared.includes(type));
}

function declaresInteger(schema: SchemaNode): boolean {
  return schemaTypeIncludes(schema, "integer");
}

function declaresNumeric(schema: SchemaNode): boolean {
  return schemaTypeIncludes(schema, "number") || declaresInteger(schema);
}

function resolveRef(schema: SchemaNode, root: SchemaNode, seen: Set<string>): SchemaNode | undefined {
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  if (!ref.startsWith("#/") || seen.has(ref)) return undefined;

  let current: unknown = root;
  for (const encodedPart of ref.slice(2).split("/")) {
    const part = encodedPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  const target = asSchema(current);
  return target ? resolveRef(target, root, new Set([...seen, ref])) : undefined;
}

function compositionBranches(schema: SchemaNode): SchemaNode[] {
  const branches: SchemaNode[] = [];
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    const value = schema[keyword];
    if (!Array.isArray(value)) continue;
    for (const branch of value) {
      const branchSchema = asSchema(branch);
      if (branchSchema) branches.push(branchSchema);
    }
  }
  return branches;
}

function safelyIntegral(value: number): boolean {
  return Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function pathKey(path: PathPart[]): string {
  return JSON.stringify(path);
}

function decodeJsonString(raw: string): string {
  let result = "";
  for (let index = 1; index < raw.length - 1; index++) {
    const char = raw[index];
    if (char !== "\\") {
      result += char;
      continue;
    }
    const escape = raw[++index];
    if (escape === "u") {
      const code = Number.parseInt(raw.slice(index + 1, index + 5), 16);
      result += String.fromCharCode(code);
      index += 4;
    } else {
      result += ({ '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[escape] ?? escape;
    }
  }
  return result;
}

/**
 * Collect raw number tokens so canonical integer spelling can be distinguished from whitespace
 * changes. A value beyond the schema walker's bound rejects the whole token set conservatively:
 * no repair is safer than recursing through an adversarial provider argument tree.
 */
function collectNumericTokens(text: string): NumericTokens {
  const tokens: NumericTokens = new Map();
  let index = 0;
  let exceededDepth = false;
  const skipWhitespace = () => {
    while (/\s/.test(text[index] ?? "")) index++;
  };
  const parseString = (): string => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index++] === '"') break;
    }
    return decodeJsonString(text.slice(start, index));
  };
  const parseValue = (path: PathPart[], depth: number): void => {
    if (depth > MAX_SCHEMA_DEPTH) {
      exceededDepth = true;
      return;
    }
    skipWhitespace();
    const char = text[index];
    if (char === "{") {
      index++;
      skipWhitespace();
      if (text[index] === "}") { index++; return; }
      while (index < text.length) {
        skipWhitespace();
        const key = parseString();
        skipWhitespace();
        index++;
        parseValue([...path, key], depth + 1);
        if (exceededDepth) return;
        skipWhitespace();
        if (text[index] === "}") { index++; return; }
        index++;
      }
      return;
    }
    if (char === "[") {
      index++;
      skipWhitespace();
      let item = 0;
      if (text[index] === "]") { index++; return; }
      while (index < text.length) {
        parseValue([...path, item++], depth + 1);
        if (exceededDepth) return;
        skipWhitespace();
        if (text[index] === "]") { index++; return; }
        index++;
      }
      return;
    }
    if (char === '"') { parseString(); return; }
    if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) {
      const start = index;
      while (index < text.length && /[-+0-9.eE]/.test(text[index] ?? "")) index++;
      tokens.set(pathKey(path), text.slice(start, index));
      return;
    }
    while (index < text.length && /[A-Za-z]/.test(text[index] ?? "")) index++;
  };
  parseValue([], 0);
  return exceededDepth ? new Map() : tokens;
}

function coerceValue(
  value: unknown,
  schema: SchemaNode | undefined,
  root: SchemaNode,
  depth: number,
  propertyName?: string,
  path: PathPart[] = [],
  numericTokens: NumericTokens = new Map(),
): CoerceResult {
  if (depth > MAX_SCHEMA_DEPTH || !schema) return { value, changed: false };
  const resolved = resolveRef(schema, root, new Set());
  if (!resolved) return { value, changed: false };

  let current = value;
  let changed = false;
  const hasComposition = ["anyOf", "oneOf", "allOf"].some((keyword) => Array.isArray(resolved[keyword]));
  for (const branch of compositionBranches(resolved)) {
    const branchResult = coerceValue(current, branch, root, depth + 1, propertyName, path, numericTokens);
    if (branchResult.changed) {
      current = branchResult.value;
      changed = true;
    }
  }

  if (typeof current === "number" && safelyIntegral(current)) {
    const integerIntent = !hasComposition && declaresInteger(resolved);
    const timeoutIntent = !hasComposition && propertyName !== undefined && U64_NUMBER_FIELDS.has(propertyName) && declaresNumeric(resolved);
    const raw = numericTokens.get(pathKey(path));
    if ((integerIntent || timeoutIntent) && raw !== undefined && /[.eE]/.test(raw)) {
      return { value: current, changed: true };
    }
    return { value: current, changed };
  }

  if (Array.isArray(current)) {
    let output: unknown[] | undefined;
    const items = resolved.items;
    for (let index = 0; index < current.length; index++) {
      const itemSchema = Array.isArray(items) ? asSchema(items[index]) : asSchema(items);
      const result = coerceValue(current[index], itemSchema, root, depth + 1, undefined, [...path, index], numericTokens);
      if (result.changed) {
        output ??= [...current];
        output[index] = result.value;
        changed = true;
      }
    }
    return { value: output ?? current, changed };
  }

  if (current !== null && typeof current === "object") {
    const properties = asSchema(resolved.properties);
    const additional = resolved.additionalProperties;
    let output: Record<string, unknown> | undefined;
    for (const [key, childValue] of Object.entries(current as Record<string, unknown>)) {
      const childSchema = asSchema(properties?.[key]) ?? asSchema(additional);
      const result = coerceValue(childValue, childSchema, root, depth + 1, key, [...path, key], numericTokens);
      if (result.changed) {
        output ??= { ...(current as Record<string, unknown>) };
        output[key] = result.value;
        changed = true;
      }
    }
    return { value: output ?? current, changed };
  }

  return { value: current, changed };
}

export function coerceIntegerToolArguments(args: string, parameters: Record<string, unknown> | undefined): string {
  if (!parameters || !/[.eE]/.test(args)) return args;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args) as unknown;
  } catch {
    return args;
  }
  const root = asSchema(parameters);
  if (!root) return args;
  const result = coerceValue(parsed, root, root, 0, undefined, [], collectNumericTokens(args));
  if (!result.changed) return args;
  return JSON.stringify(result.value);
}
