import {
  DELEGATION_BEGIN_MARKER,
  DELEGATION_END_MARKER,
  type CodexDelegationMode,
} from "./delegation-templates";

export type DelegationAgentsInspection =
  | { kind: "absent" }
  | {
    kind: "managed";
    start: number;
    end: number;
    content: string;
    mode: CodexDelegationMode | null;
    version: number | null;
  }
  | { kind: "conflict"; reason: "orphan_begin" | "orphan_end" | "duplicate" | "reversed" | "malformed_marker" };

interface PhysicalLine {
  start: number;
  end: number;
  normalized: string;
}

function physicalLines(content: string): PhysicalLine[] {
  const lines: PhysicalLine[] = [];
  let start = 0;

  for (let index = 0; index <= content.length; index += 1) {
    if (index !== content.length && content[index] !== "\n") continue;
    const end = index;
    const raw = content.slice(start, end);
    lines.push({
      start,
      end: raw.endsWith("\r") ? end - 1 : end,
      normalized: raw.endsWith("\r") ? raw.slice(0, -1) : raw,
    });
    start = index + 1;
  }

  return lines;
}

function markerConflict(content: string, lines: PhysicalLine[]): DelegationAgentsInspection | null {
  for (const line of lines) {
    if (
      (line.normalized.includes(DELEGATION_BEGIN_MARKER) && line.normalized !== DELEGATION_BEGIN_MARKER)
      || (line.normalized.includes(DELEGATION_END_MARKER) && line.normalized !== DELEGATION_END_MARKER)
    ) {
      return { kind: "conflict", reason: "malformed_marker" };
    }
  }

  return null;
}

function detectEol(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeBlockEol(block: string, eol: "\n" | "\r\n"): string {
  return block.replace(/\r?\n/g, eol).replace(/(?:\r?\n)+$/, "");
}

function readMode(content: string): CodexDelegationMode | null {
  const match = /^Mode: (balanced|orchestrator)\r?$/m.exec(content);
  return match?.[1] as CodexDelegationMode | undefined ?? null;
}

function readVersion(content: string): number | null {
  const match = /^<!-- CodexCommander delegation schema: (\d+) -->\r?$/m.exec(content);
  return match === null ? null : Number(match[1]);
}

export function inspectDelegationAgentsBlock(content: string): DelegationAgentsInspection {
  const lines = physicalLines(content);
  const malformed = markerConflict(content, lines);
  if (malformed !== null) return malformed;

  const begins = lines.filter((line) => line.normalized === DELEGATION_BEGIN_MARKER);
  const ends = lines.filter((line) => line.normalized === DELEGATION_END_MARKER);
  if (begins.length === 0 && ends.length === 0) return { kind: "absent" };
  if (begins.length === 0) return { kind: "conflict", reason: "orphan_end" };
  if (ends.length === 0) return { kind: "conflict", reason: "orphan_begin" };
  if (begins.length !== 1 || ends.length !== 1) return { kind: "conflict", reason: "duplicate" };

  const begin = begins[0];
  const end = ends[0];
  if (end.start < begin.start) return { kind: "conflict", reason: "reversed" };

  const managedContent = content.slice(begin.start, end.end);
  return {
    kind: "managed",
    start: begin.start,
    end: end.end,
    content: managedContent,
    mode: readMode(managedContent),
    version: readVersion(managedContent),
  };
}

export function upsertDelegationAgentsBlock(content: string, block: string): { content: string; changed: boolean } {
  const inspection = inspectDelegationAgentsBlock(content);
  if (inspection.kind === "conflict") return { content, changed: false };

  const normalizedBlock = normalizeBlockEol(block, detectEol(content));
  if (inspection.kind === "managed") {
    if (inspection.content === normalizedBlock) return { content, changed: false };
    return {
      content: `${content.slice(0, inspection.start)}${normalizedBlock}${content.slice(inspection.end)}`,
      changed: true,
    };
  }

  if (content.length === 0) return { content: normalizedBlock, changed: true };
  const separator = content.endsWith("\n") ? "" : detectEol(content);
  return { content: `${content}${separator}${normalizedBlock}`, changed: true };
}

export function removeDelegationAgentsBlock(content: string): { content: string; changed: boolean } {
  const inspection = inspectDelegationAgentsBlock(content);
  if (inspection.kind !== "managed") return { content, changed: false };

  const suffix = content.slice(inspection.end);
  const separator = suffix.startsWith("\r\n") ? 2 : suffix.startsWith("\n") ? 1 : 0;
  return {
    content: `${content.slice(0, inspection.start)}${suffix.slice(separator)}`,
    changed: true,
  };
}
