export type CurrentUserVideoIntentState = "none" | "confirmation_required" | "explicit";

export interface CurrentUserVideoIntent {
  state: CurrentUserVideoIntentState;
}

function inputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap(part => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const item = part as Record<string, unknown>;
      return (item.type === "input_text" || item.type === "text") && typeof item.text === "string"
        ? [item.text]
        : [];
    })
    .join("\n");
}

/** Return only text authored by the current user at the tail of this request. */
export function currentUserAuthoredText(rawBody: unknown): string | undefined {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) return undefined;
  const input = (rawBody as { input?: unknown }).input;
  if (typeof input === "string") return input.trim() || undefined;
  if (!Array.isArray(input) || input.length === 0) return undefined;

  for (let index = input.length - 1; index >= 0; index -= 1) {
    const value = input[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as Record<string, unknown>;
    if (item.type === "additional_tools") continue;
    // Match the Responses parser: message items may omit `type` when a role is present.
    const effectiveType = item.type ?? ("role" in item ? "message" : undefined);
    if (effectiveType !== "message" || item.role !== "user") return undefined;
    const text = inputText(item.content).trim();
    return text || undefined;
  }
  return undefined;
}

function hasImageToVideoIntent(text: string): boolean {
  return /\b(?:animate|turn|convert)\b[\s\S]{0,80}\b(?:image|photo|picture|frame)\b/i.test(text)
    || /\b(?:image|photo|picture|frame)\s*[- ]to[- ]video\b/i.test(text)
    || /\bvideo\b[\s\S]{0,50}\b(?:from|using|based\s+on)\b[\s\S]{0,50}\b(?:image|photo|picture|frame)\b/i.test(text);
}

function maskCharacters(text: string): string {
  return text.replace(/[^\r\n]/g, " ");
}

interface NormalizedIntentText {
  text: string;
  supported: boolean;
}

const CONTROL_PICTOGRAPH = /[⛔🚫🛑✋🖐🙅🆘🆖❌❎🚷🚯🚳🚱🔞📵❓❔❕❗]/u;
const EMOJI_SEQUENCE = /(\p{Extended_Pictographic})(?:[\ufe0e\ufe0f])?(?:\p{Emoji_Modifier})?(?:\u200d\p{Extended_Pictographic}(?:[\ufe0e\ufe0f])?(?:\p{Emoji_Modifier})?)*/gu;

/** Canonicalize known prose boundaries and reject remaining invisible controls. */
function normalizeIntentText(text: string): NormalizedIntentText {
  // Collapse one bounded RGI-like pictograph sequence before the general mark/default-ignorable
  // rejection. Invalid marks/joiners remain visible and fail closed; any cancellation pictograph
  // anywhere in a joined sequence remains visible for the description audit.
  const normalized = text.normalize("NFKC")
    .replace(EMOJI_SEQUENCE, (sequence, first: string) =>
      CONTROL_PICTOGRAPH.test(sequence) ? sequence : first)
    .replace(/\r\n?|\u000b|\u000c|\u0085|\u2028|\u2029/g, "\n")
    .replace(/[。．｡۔।…]/g, ".")
    .replace(/！/g, "!")
    .replace(/[\uff1f\u061f]/g, "?")
    .replace(/[‘’\u02bc\uff07]/g, "'");
  const unsupportedCodePoint = [...normalized].some(char => {
    const codePoint = char.codePointAt(0)!;
    return (char.length === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff)
      || (codePoint >= 0xfdd0 && codePoint <= 0xfdef)
      || (codePoint & 0xffff) >= 0xfffe
      // Paid execution grammar is deliberately ASCII English. Any other letter can conceal a
      // visually confusable control word, so require confirmation instead of guessing semantics.
      || (/\p{L}/u.test(char) && !/[A-Za-z]/.test(char));
  });
  return {
    text: normalized,
    supported: !unsupportedCodePoint
      && !/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Default_Ignorable_Code_Point}\p{M}]/u.test(normalized),
  };
}

interface MaskedText {
  text: string;
  balanced: boolean;
  maskedSpan: boolean;
}

/** Mask fenced and indented Markdown code while preserving clause boundaries. */
function maskMarkdownCode(text: string): MaskedText {
  let fence: { marker: "`" | "~"; length: number } | undefined;
  const masked: string[] = [];
  let maskedSpan = false;

  for (let lineStart = 0; lineStart < text.length;) {
    const newlineIndex = text.indexOf("\n", lineStart);
    const lineEnd = newlineIndex < 0 ? text.length : newlineIndex + 1;
    const rawLine = text.slice(lineStart, lineEnd);
    lineStart = lineEnd;
    const line = rawLine.endsWith("\n") ? rawLine.slice(0, -1) : rawLine;
    if (fence) {
      const closesFence = new RegExp(
        "^ {0,3}" + fence.marker + "{" + fence.length + ",}\\s*$",
      ).test(line);
      masked.push(maskCharacters(rawLine));
      if (closesFence) fence = undefined;
      continue;
    }

    const openingFence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (openingFence) {
      const run = openingFence[1]!;
      fence = { marker: run[0] as "`" | "~", length: run.length };
      maskedSpan = true;
      masked.push(maskCharacters(rawLine));
      continue;
    }

    // A nested Markdown list is prose, not indented code. Keep it visible so its
    // description or control content is audited by the whole-message grammar.
    if (/^(?: {4,}| {0,3}\t)/.test(line) && !MARKDOWN_LIST_ITEM.test(line)) {
      maskedSpan = true;
      masked.push(maskCharacters(rawLine));
      continue;
    }
    masked.push(rawLine);
  }

  return { text: masked.join(""), balanced: fence === undefined, maskedSpan };
}

function wordCharacter(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

function backtickRunLength(text: string, index: number): number {
  let length = 0;
  while (text[index + length] === "`") length += 1;
  return length;
}

function matchingBacktickRun(text: string, from: number, length: number): number {
  for (let index = from; index < text.length;) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    const candidateLength = backtickRunLength(text, index);
    if (candidateLength === length) return index;
    index += candidateLength;
  }
  return -1;
}

type ClosingQuote = "\"" | "'" | "”" | "’";

function closingQuoteFor(char: string, previous: string | undefined): ClosingQuote | undefined {
  if (char === "\"" || char === "'") {
    return char === "'" && wordCharacter(previous) ? undefined : char;
  }
  if (char === "“") return "”";
  if (char === "‘") return "’";
  return undefined;
}

/** Mask prose quotations and inline code so examples cannot grant execution authority. */
function maskQuotedText(text: string): MaskedText {
  const markdownMasked = maskMarkdownCode(text);
  const masked: string[] = [];
  let balanced = markdownMasked.balanced;
  let maskedSpan = markdownMasked.maskedSpan;

  for (let index = 0; index < markdownMasked.text.length;) {
    const char = markdownMasked.text[index]!;
    if (char === "`") {
      maskedSpan = true;
      const runLength = backtickRunLength(markdownMasked.text, index);
      const closingIndex = matchingBacktickRun(markdownMasked.text, index + runLength, runLength);
      if (closingIndex < 0) balanced = false;
      const end = closingIndex < 0 ? markdownMasked.text.length : closingIndex + runLength;
      masked.push(maskCharacters(markdownMasked.text.slice(index, end)));
      index = end;
      continue;
    }

    const previous = index > 0 ? markdownMasked.text[index - 1] : undefined;
    const closingQuote = closingQuoteFor(char, previous);
    if (!closingQuote) {
      masked.push(char);
      index += 1;
      continue;
    }

    maskedSpan = true;
    let closingIndex = -1;
    for (let cursor = index + 1; cursor < markdownMasked.text.length; cursor += 1) {
      if (markdownMasked.text[cursor] === "\\" && (closingQuote === "\"" || closingQuote === "'")) {
        cursor += 1;
        continue;
      }
      if (markdownMasked.text[cursor] !== closingQuote) continue;
      if ((closingQuote === "'" || closingQuote === "’") && wordCharacter(markdownMasked.text[cursor + 1])) {
        continue;
      }
      closingIndex = cursor;
      break;
    }
    if (closingIndex < 0) balanced = false;
    const end = closingIndex < 0 ? markdownMasked.text.length : closingIndex + 1;
    masked.push(maskCharacters(markdownMasked.text.slice(index, end)));
    index = end;
  }

  return { text: masked.join(""), balanced, maskedSpan };
}

const VIDEO_NOUN = /\b(?:video|videos|clip|clips|animation|animations|movie|movies)\b/i;
const GENERATION_IMPERATIVE = /^(?:create|generate|make|produce|render|synthesize)\b/i;
const MARKDOWN_LIST_ITEM = /^[ \t]*(?:[-*+•]\s+|\d+[.)]\s+)(.*)$/;
const UNSUPPORTED_MARKDOWN_LINE = /^ {0,3}(?:>\s?|#{1,6}\s+|\|)/;
const DIRECT_OBJECT_PREFIX = /^\s+(?:(?:me|us)\s+)?(?:(?:a|an|the)\s+)?(?:(?:[\p{L}\p{N}'’-]+|\p{N}+(?:\.\p{N}+)+(?:[-–‑][\p{L}\p{N}'’]+)*)\s+){0,8}$/u;
const INDIRECT_OBJECT_PREFIX = /\b(?:about|of|for|on|regarding|toward|to|whether|how|why)\b/i;
const NON_GENERATION_OBJECT_PREFIX = /\b(?:analysis|caption|concept|critique|description|guide|idea|instructions?|outline|plan|prompt|report|request|review|script|storyboard|summary|title|transcript|tutorial|wording)\b/i;
const CONTENT_INTRODUCER = /^(?:of|about|showing|depicting|featuring|with|where|that|which|in|on|for|from|using|based\s+on|set\s+in)\b/i;
const DEFERRED_CONSENT = /\b(?:(?:only\s+)?(?:after|before|once|when|until|unless|upon|pending|with|without)\b[^.!?\n]{0,80}\b(?:approv(?:e|ed|al)|allow(?:ed|ance)?|okay(?:ed)?|confirm(?:ed|ation)?|authoriz(?:e|ed|ation)|permit(?:ted|ssion)?|consent|go[-\s]ahead|green\s+light|clear(?:ed|ance)|sign[-\s]?off)\b|(?:subject\s+to|contingent\s+on|conditioned\s+on)\b[^.!?\n]{0,40}\b(?:approval|allowance|okay|confirmation|authorization|permission|consent|go[-\s]ahead|green\s+light|clearance|sign[-\s]?off)\b)/i;
const NON_EXECUTION_FRAMING = /(?:^|\n)\s{0,3}(?:for\s+example|example|sample|checklist|quote\s+(?:this\s+sentence|these|the\s+following|sentence)|review\s+(?:this|these|the\s+following)|analy[sz]e\s+(?:this|these|the\s+following))\s*:|\bnot\s+(?:an?\s+)?(?:request|instruction|command)\b/im;
const WITHHELD_EXECUTION = /\bwithout\s+(?:(?:actually|ever)\s+)?(?:creating|generating|making|producing|rendering|synthesizing|executing|performing|following|running|submitting|starting|launching|doing)\b/i;
const WITHHELD_GENERATION = /\b(?:no|without)\s+(?:(?:actual|further|paid)\s+)?(?:(?:video|media)\s+)?generation\b/i;
const RELEVANT_NEGATION = /\b(?:(?:do\s+not|don't|never)\s+(?:(?:actually|ever)\s+)?(?:(?:create|generate|make|produce|render|synthesize|execute|perform|follow|run|submit|start|launch)\b|(?:do|proceed|continue)(?:\s+with)?\s+(?:it|that|this)\b)|not\s+(?:(?:actually|ever)\s+)?(?:create|generate|make|produce|render|synthesize|execute|perform|submit|start|launch)\b)/i;
const RELEVANT_CANCELLATION = /\bnever\s+mind\b|\bcall\s+(?:it|that|this)\s+off\b|\bcancel\b|\b(?:withdraw|revoke|retract|rescind|stop|abort|forget|disregard|ignore|scratch|decline|refuse)\s+(?:it|that|this|(?:the|my)\s+(?:request|instruction|generation|video(?:\s+generation)?))\b/i;
const CONSENT_REVOCATION = /\b(?:i|we)\s+(?:hereby\s+)?(?:withdraw|revoke|retract|rescind|decline|refuse)\b(?:\s+(?:(?:my|our)\s+)?(?:consent|approval|authorization|permission|request))?/i;
const ALTERNATIVE_MEDIA_CONFLICT = /(?:\b(?:create|generate|make|produce|render)\b[^.!?\n]{0,60}\b(?:image|photo|picture|audio|text)\b[^.!?\n]{0,20}\binstead\b|\binstead\b[^.!?\n]{0,20}\b(?:create|generate|make|produce|render)\b[^.!?\n]{0,60}\b(?:image|photo|picture|audio|text)\b)/i;
const DESCRIPTION_CONTROL_CLAUSE = /(?:^|[,;:/|\\]\s*|(?:\(|\)|\[|\]|\{|\})\s*|[–—]\s*|\s+-\s+|\b(?:and(?:\s+then)?|but|then)\s+)(?:(?:\*\*|__|~~|\[(?: |x|X)\])\s*)*(?:(?:please|kindly|now|then|next|finally),?\s+)*(?:(?:cancel|withdraw|revoke|retract|rescind|decline|refuse|stop|abort|forget|disregard|ignore|scratch|wait|hold|pause|postpone|defer|delay)\b|(?:(?:do\s+not|don't|never|not\s+(?:actually\s+)?)|no\s+(?:actual\s+)?generation\b)|(?:create|generate|make|produce|render|synthesize)\b|(?:i|we)\s+(?:hereby\s+)?(?:withdraw|revoke|retract|rescind|decline|refuse)\b)/i;
const DESCRIPTION_APPROVAL_CLAUSE = /(?:^|[,;:/|\\]\s*|(?:\(|\)|\[|\]|\{|\})\s*|[–—]\s*|\s+-\s+|\b(?:and(?:\s+then)?|but|then)\s+)(?:(?:\*\*|__|~~|\[(?: |x|X)\])\s*)*(?:(?:please|kindly|now|then|next|finally),?\s+)*(?:(?:await|seek|request|obtain)\b[^.!?\n]{0,40}\b(?:approval|confirmation|authorization|consent|go[-\s]ahead)\b|(?:provided|providing)(?:\s+that)?\b[^.!?\n]{0,40}\b(?:approv(?:e|al)|confirm(?:ation)?|authoriz(?:e|ation)|consent|go[-\s]ahead)\b)/i;
const SECONDARY_CLAUSE_MARKER = /\b(?:but|then|although|though|however|whereas|yet|despite)\b|\bsubject\s+to\b|\bor\s+(?:not|don't|do\s+not)\b/i;
const SECONDARY_GATING_CONTEXT = /\b(?:(?:after|before|once|when|while|until|unless|upon|pending|provided|providing)\b[^.!?\n]{0,50}\b(?:i|we|you|my|our|your|permission|signal|cue|decision|approv(?:ed|al)?|allow(?:ed|ance)?|okay(?:ed)?|confirm(?:ed|ation)?|authoriz(?:ed|ation)?|permit(?:ted|ssion)?|consent|refusal|say\s+yes|green\s+light|clear(?:ed|ance)|sign[-\s]?off)\b|(?:with|without|on|at)\s+(?:my|our|your)\s+(?:permission|signal|cue|approval|confirmation|consent|authorization|refusal)\b|against\s+(?:my|our|your)\s+wishes\b)/i;
const SECONDARY_CONTROL_CONTEXT = /\b(?:cancel|withdraw|revoke|retract|rescind|decline|refuse|abandon|abort|skip|omit|defer|delay|postpone|disable(?:d)?|forbid(?:den)?|consent|permission|approval|confirmation|authorization|refusal|nix|instead)\b|\b(?:please|kindly)\s+stop\b|\b(?:scrap|discard)\s+(?:it|that|this|the\s+request)\b|\bgeneration\b[^.!?\n]{0,30}\b(?:off|inactive|suspended|halted|prohibited|disallowed|paused|blocked|deactivated|disabled|forbidden|unavailable|not\s+enabled)\b|(?:^|,\s*)(?:no|nope)$|\bno\s+(?:longer|need)\b|\brefrain\s+from\b|\bask\s+(?:me|us)\s+first\b|\bchange(?:d)?\s+(?:my|our)\s+mind\b/i;

const NON_EXECUTABLE_CONTEXTS = [
  DEFERRED_CONSENT,
  NON_EXECUTION_FRAMING,
  WITHHELD_EXECUTION,
  WITHHELD_GENERATION,
  RELEVANT_NEGATION,
  RELEVANT_CANCELLATION,
  CONSENT_REVOCATION,
  ALTERNATIVE_MEDIA_CONFLICT,
] as const;

// These phrases explicitly discuss media generation without asking the proxy to buy one. Keep
// approval-gated wording separate: it is not executable now, but remains ambiguous rather than
// being silently treated as ordinary chat.
const CLEARLY_NON_EXECUTABLE_CONTEXTS = [
  NON_EXECUTION_FRAMING,
  WITHHELD_EXECUTION,
  WITHHELD_GENERATION,
  RELEVANT_NEGATION,
  RELEVANT_CANCELLATION,
  CONSENT_REVOCATION,
  ALTERNATIVE_MEDIA_CONFLICT,
] as const;
const HYPOTHETICAL_VIDEO_DISCUSSION = /^\s*(?:if|suppose|might|may|what|why|how)\b|^\s*(?:could|would)\b[^.!?\n]{0,120}\bif\b/i;
const INFORMATIONAL_VIDEO_DISCUSSION = /^\s*(?:analy[sz]e|clarif(?:y|ication)|compare|describe|discuss|explain|list|review|summari[sz]e|tell\s+(?:me|us)\s+(?:how|what|which|whether))\b/i;
const NON_EXECUTABLE_VIDEO_COMPOUND = /\b(?:non[- ]video|video[- ]free)\b|\b(?:video|videos|clip|clips|animation|animations|movie|movies)\s+(?:call|game|guide|list|review|script|tutorial)\b/i;
const NEGATED_VIDEO_OBJECT = /\bnot\s+(?:an?\s+)?(?:video|videos|clip|clips|animation|animations|movie|movies)\b/i;
const MULTIPLE_VIDEO_OUTPUTS = /\b(?:videos|clips|animations|movies)\b|\b(?:\d+|two|three|four|five|six|seven|eight|nine|ten|multiple|several|many|a\s+(?:couple|pair)|(?:a\s+)?(?:couple|pair)\s+of)\s+(?:separate\s+)?(?:video|clip|animation|movie)s?\b/i;

function hasNonExecutableContext(text: string): boolean {
  return NON_EXECUTABLE_CONTEXTS.some(pattern => pattern.test(text));
}

function hasPositiveVideoDirective(text: string): boolean {
  for (const clause of auditedClauses(text)) {
    if (clause.context === "top_level" && !clause.question && classifyVideoDirective(clause.text).state === "positive") {
      return true;
    }
  }
  return false;
}

/** V1 can fulfill exactly one text-to-video output, never a plural or counted batch. */
function requestsUnsupportedMultipleVideoOutputs(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized.supported) return false;
  const masked = maskQuotedText(normalized.text);
  if (!masked.balanced || masked.maskedSpan || hasNonExecutableContext(masked.text)) return false;
  for (const clause of auditedClauses(masked.text)) {
    if (
      clause.context === "top_level"
      && !clause.question
      && classifyVideoDirective(clause.text).state === "positive"
      && MULTIPLE_VIDEO_OUTPUTS.test(clause.text)
    ) return true;
  }
  return false;
}

/**
 * Recognize discussion that cannot authorise a paid submission. Unsupported text and mixed
 * discussion/directives deliberately return false so the caller keeps the confirmation gate.
 */
function hasClearlyNonExecutableVideoDiscussion(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized.supported) return false;
  const masked = maskQuotedText(normalized.text);
  if (!masked.balanced) return false;

  if (CLEARLY_NON_EXECUTABLE_CONTEXTS.some(pattern => pattern.test(normalized.text))) return true;
  if (masked.maskedSpan && !VIDEO_NOUN.test(masked.text)) return true;
  if (hasPositiveVideoDirective(masked.text)) return false;
  return HYPOTHETICAL_VIDEO_DISCUSSION.test(masked.text)
    || INFORMATIONAL_VIDEO_DISCUSSION.test(masked.text)
    || NON_EXECUTABLE_VIDEO_COMPOUND.test(masked.text)
    || NEGATED_VIDEO_OBJECT.test(masked.text);
}

type DescriptionFragmentClassification = "description" | "control" | "empty";

/**
 * A paid directive may carry one simple descriptive phrase, not a second punctuation-delimited
 * clause. Keep only commas, numeric ratios, and ordinary intra-word apostrophes/hyphens; every
 * other Unicode punctuation is an unsupported boundary and therefore needs confirmation. This makes
 * cancellation/approval wording fail closed without trying to enumerate every synonym or glyph.
 */
function hasSecondaryDescriptionBoundary(fragment: string): boolean {
  const terminalTrimmed = fragment.trim().replace(/[.!?]+$/, "");
  if (terminalTrimmed.split(",").slice(1).some(segment => {
    const value = segment.trim();
    return /\p{S}/u.test(value) && !/[\p{L}\p{N}]/u.test(value);
  })) return true;
  const chars = [...terminalTrimmed];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if (char === "<" || char === ">") return true;
    if (/\p{S}/u.test(char)) {
      if (
        !/\p{Extended_Pictographic}/u.test(char)
        || CONTROL_PICTOGRAPH.test(char)
        || wordCharacter(chars[index - 1])
        || wordCharacter(chars[index + 1])
      ) return true;
      continue;
    }
    if (!/[\p{P}]/u.test(char)) continue;
    if (char === ",") continue;
    if ((char === "'" || char === "’" || char === "-" || char === "‐" || char === "‑")
      && wordCharacter(chars[index - 1]) && wordCharacter(chars[index + 1])) continue;
    if (char === ":" && /\d/.test(chars[index - 1] ?? "") && /\d/.test(chars[index + 1] ?? "")) continue;
    if (char === "." && /\d/.test(chars[index - 1] ?? "") && /\d/.test(chars[index + 1] ?? "")) continue;
    if (char === "." && isInitialismPeriod(chars.join(""), chars.slice(0, index).join("").length)) continue;
    if (char === "." && isTitleAbbreviationPeriod(chars.join(""), chars.slice(0, index).join("").length)) continue;
    return true;
  }
  return false;
}

function classifyDescriptionFragment(fragment: string): DescriptionFragmentClassification {
  const trimmed = fragment.trim();
  if (!trimmed) return "empty";
  if (
    hasSecondaryDescriptionBoundary(trimmed)
    ||
    SECONDARY_CLAUSE_MARKER.test(trimmed)
    || SECONDARY_GATING_CONTEXT.test(trimmed)
    || SECONDARY_CONTROL_CONTEXT.test(trimmed)
    ||
    DESCRIPTION_CONTROL_CLAUSE.test(trimmed)
    || DESCRIPTION_APPROVAL_CLAUSE.test(trimmed)
    || hasNonExecutableContext(trimmed)
  ) {
    return "control";
  }
  return "description";
}

type ClauseContext = "top_level" | "list_description" | "unsupported_markdown";

interface AuditedClause {
  text: string;
  question: boolean;
  context: ClauseContext;
}

function stripListDescriptionMarkup(text: string): string {
  let stripped = text.trim().replace(/^\[(?: |x|X)\]\s*/, "");
  // Strip only balanced whole-fragment wrappers. Unmatched emphasis remains
  // visible and therefore cannot hide a leading control verb.
  for (let depth = 0; depth < 2; depth += 1) {
    const wrapper = /^(?:\*\*([\s\S]*)\*\*|__([\s\S]*)__|~~([\s\S]*)~~)$/.exec(stripped);
    if (!wrapper) break;
    stripped = (wrapper[1] ?? wrapper[2] ?? wrapper[3] ?? "").trim();
  }
  return stripped;
}

function isInitialismPeriod(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const after = text.slice(index + 1);
  const initialPrefix = /(?:^|[^A-Za-z])(?:[A-Z]\.)*[A-Z]$/;
  if (initialPrefix.test(before) && /^[A-Z](?:\.|$)/.test(after)) return true;
  return /(?:^|[^A-Za-z])(?:[A-Z]\.)+[A-Z]$/.test(before) && /^\s+[a-z]/.test(after);
}

function isTitleAbbreviationPeriod(text: string, index: number): boolean {
  return /(?:^|\s)(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr)$/.test(text.slice(0, index))
    && /^\s+[A-Z]/.test(text.slice(index + 1));
}

function* auditedClauses(text: string): Generator<AuditedClause> {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const listItem = MARKDOWN_LIST_ITEM.exec(line);
    const context: ClauseContext = listItem
      ? "list_description"
      : UNSUPPORTED_MARKDOWN_LINE.test(line)
        ? "unsupported_markdown"
        : "top_level";
    const clauseText = listItem ? stripListDescriptionMarkup(listItem[1] ?? "") : line;
    let sentenceStart = 0;
    for (let index = 0; index < clauseText.length; index += 1) {
      const char = clauseText[index]!;
      if (char !== "." && char !== "!" && char !== "?") continue;
      if (char === "." && /\d/.test(clauseText[index - 1] ?? "") && /\d/.test(clauseText[index + 1] ?? "")) {
        continue;
      }
      if (char === "." && isInitialismPeriod(clauseText, index)) continue;
      if (char === "." && isTitleAbbreviationPeriod(clauseText, index)) continue;
      const trimmed = clauseText.slice(sentenceStart, index + 1).trim();
      if (trimmed) yield { text: trimmed, question: char === "?", context };
      sentenceStart = index + 1;
    }
    const trailing = clauseText.slice(sentenceStart).trim();
    if (trailing) yield { text: trailing, question: false, context };
  }
}

type VideoDirectiveClassification =
  | { state: "unsupported" | "ambiguous" }
  | { state: "positive"; opensDescriptionList: boolean };

function classifyVideoObjectSuffix(suffix: string): VideoDirectiveClassification {
  const trimmed = suffix.trim();
  if (!trimmed || /^,?\s*(?:please)?$/i.test(trimmed)) {
    return { state: "positive", opensDescriptionList: false };
  }
  if (trimmed === ":") return { state: "positive", opensDescriptionList: true };

  const colonDescription = /^:\s+([\s\S]+)$/.exec(trimmed);
  if (colonDescription) {
    return classifyDescriptionFragment(colonDescription[1]!) === "description"
      ? { state: "positive", opensDescriptionList: false }
      : { state: "ambiguous" };
  }

  const introducer = CONTENT_INTRODUCER.exec(trimmed);
  if (!introducer) return { state: "ambiguous" };
  return classifyDescriptionFragment(trimmed.slice(introducer[0].length)) === "description"
    ? { state: "positive", opensDescriptionList: false }
    : { state: "ambiguous" };
}

function classifyVideoDirective(clauseText: string): VideoDirectiveClassification {
  const clause = clauseText
    .replace(/[.!]+$/, "")
    .trim()
    .replace(/^(?:(?:please|kindly|now|then|next|finally),?\s+)+/i, "");
  const imperative = GENERATION_IMPERATIVE.exec(clause);
  if (!imperative) return { state: "unsupported" };

  const remainder = clause.slice(imperative[0].length);
  const videoNoun = VIDEO_NOUN.exec(remainder);
  if (!videoNoun) return { state: "unsupported" };
  if (videoNoun.index > 100) return { state: "ambiguous" };

  const directObjectPrefix = remainder.slice(0, videoNoun.index);
  const suffix = remainder.slice(videoNoun.index + videoNoun[0].length);
  if (!DIRECT_OBJECT_PREFIX.test(directObjectPrefix)) return { state: "ambiguous" };
  if (INDIRECT_OBJECT_PREFIX.test(directObjectPrefix)) return { state: "ambiguous" };
  if (NON_GENERATION_OBJECT_PREFIX.test(directObjectPrefix)) return { state: "ambiguous" };
  if (/\b(?:not|never|no|without|except|rather\s+than|instead\s+of)\b/i.test(directObjectPrefix)) {
    return { state: "ambiguous" };
  }
  if (/\bnon[-\s]*$/i.test(directObjectPrefix) || /^\s*-\s*free\b/i.test(suffix)) {
    return { state: "ambiguous" };
  }
  if (/\b(?:if|unless|would|could|might|may|hypothetically)\b/i.test(clause)) {
    return { state: "ambiguous" };
  }
  if (
    SECONDARY_CLAUSE_MARKER.test(directObjectPrefix)
    || SECONDARY_GATING_CONTEXT.test(directObjectPrefix)
    || SECONDARY_CONTROL_CONTEXT.test(directObjectPrefix)
  ) {
    return { state: "ambiguous" };
  }
  return classifyVideoObjectSuffix(suffix);
}

/**
 * Paid generation requires a direct command, not a keyword match embedded in prose.
 * Sentence/line starts are the executable boundary; quoted spans and clauses with
 * negative, conditional, or indirect-object wording fail closed to confirmation.
 */
function hasExplicitVideoGenerationImperative(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized.supported) return false;
  const masked = maskQuotedText(normalized.text);
  // Quotation/code is useful context, but not execution authority for a paid action. Requiring a
  // plain unquoted directive also fails closed on nested or ambiguously paired delimiters.
  if (!masked.balanced || masked.maskedSpan) return false;
  const unquoted = masked.text;
  if (hasNonExecutableContext(unquoted)) return false;

  let positiveDirectives = 0;
  let descriptionListOpen = false;
  for (const clause of auditedClauses(unquoted)) {
    if (clause.context === "unsupported_markdown") return false;
    if (clause.context === "list_description") {
      if (
        !descriptionListOpen
        || clause.question
        || classifyDescriptionFragment(clause.text) !== "description"
      ) {
        return false;
      }
      continue;
    }

    const classification = classifyVideoDirective(clause.text);
    // Every visible top-level clause must belong to the consent-bearing grammar.
    // Ignoring an unsupported clause would let surrounding framing, cancellation,
    // or approval language borrow authority from a separate positive directive.
    if (classification.state !== "positive" || clause.question) return false;
    positiveDirectives += 1;
    descriptionListOpen = classification.opensDescriptionList;
  }
  return positiveDirectives === 1;
}

/** Conservative, wording-only admission signal for v1 text-to-video. */
export function deriveCurrentUserVideoIntent(rawBody: unknown): CurrentUserVideoIntent {
  const currentUserText = currentUserAuthoredText(rawBody);
  if (!currentUserText) return { state: "none" };

  // Policy vocabulary and grammar share one canonical view so compatibility glyphs cannot make
  // image-to-video or media mentions disagree with the consent classifier.
  const policyText = normalizeIntentText(currentUserText).text;
  const mentionsVideo = /\b(?:video|videos|clip|clips|animation|animations|movie|movies|text\s*[- ]to[- ]video)\b/i.test(policyText);
  if (!mentionsVideo) return { state: "none" };
  if (hasImageToVideoIntent(policyText)) {
    return { state: "confirmation_required" };
  }
  if (hasClearlyNonExecutableVideoDiscussion(policyText)) {
    return { state: "none" };
  }
  if (requestsUnsupportedMultipleVideoOutputs(policyText)) {
    return { state: "confirmation_required" };
  }

  const explicitGeneration = hasExplicitVideoGenerationImperative(policyText);
  return { state: explicitGeneration ? "explicit" : "confirmation_required" };
}
