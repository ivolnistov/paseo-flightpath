/** What a highlighted span of YAML source is. */
export type YamlTokenKind = "comment" | "key" | "value" | "literal" | "punctuation" | "anchor";

/** A half-open span of UTF-16 offsets into the YAML text. Gaps between tokens are plain text. */
export interface YamlToken {
  readonly start: number;
  readonly end: number;
  readonly kind: YamlTokenKind;
}

const LITERAL = /^(?:true|false|True|False|TRUE|FALSE|null|Null|NULL|~|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

function isBreak(char: string | undefined): boolean {
  return char === undefined || char === "\n" || char === "\r";
}

function isFlowIndicator(char: string | undefined): boolean {
  return char === "," || char === "[" || char === "]" || char === "{" || char === "}";
}

/**
 * Splits YAML source into highlightable tokens. It is a lexical approximation for display:
 * keys, scalar values, literals, comments and indicators, including quoted strings that span
 * lines and block scalar bodies. Invalid input still yields ordered, non-overlapping tokens.
 */
export function tokenizeYaml(text: string): YamlToken[] {
  const tokens: YamlToken[] = [];
  const push = (start: number, end: number, kind: YamlTokenKind) => {
    if (end > start) tokens.push({ start, end, kind });
  };
  let i = 0;
  let lineStart = 0;
  let flowDepth = 0;
  // A block scalar's body is every following line indented past this column, and blank lines.
  let blockParent: number | null = null;
  // Column of the last key or sequence entry on the current line, which a block scalar belongs to.
  let nodeColumn = 0;

  const atLineStart = () => {
    lineStart = i;
    nodeColumn = 0;
    if (blockParent === null) return;
    let p = i;
    while (text[p] === " ") p += 1;
    const blank = isBreak(text[p]);
    if (blank || p - i > blockParent) {
      let end = p;
      while (!isBreak(text[end])) end += 1;
      push(p, end, "value");
      i = end;
    } else {
      blockParent = null;
    }
  };

  while (i < text.length) {
    const char = text[i];
    if (char === "\n") {
      i += 1;
      atLineStart();
      continue;
    }
    if (char === "\r" || isSpace(char)) {
      i += 1;
      continue;
    }
    const previous = i === 0 ? undefined : text[i - 1];
    if (char === "#" && (i === lineStart || isSpace(previous) || isBreak(previous))) {
      let end = i;
      while (!isBreak(text[end])) end += 1;
      push(i, end, "comment");
      i = end;
      continue;
    }
    if (
      i === lineStart &&
      (text.startsWith("---", i) || text.startsWith("...", i)) &&
      (isSpace(text[i + 3]) || isBreak(text[i + 3]))
    ) {
      push(i, i + 3, "punctuation");
      i += 3;
      continue;
    }
    if ((char === "-" || char === "?" || char === ":") && (isSpace(text[i + 1]) || isBreak(text[i + 1]))) {
      if (char !== ":") nodeColumn = i - lineStart;
      push(i, i + 1, "punctuation");
      i += 1;
      continue;
    }
    if (isFlowIndicator(char)) {
      if (char === "[" || char === "{") flowDepth += 1;
      else if (char === "]" || char === "}") flowDepth = Math.max(0, flowDepth - 1);
      push(i, i + 1, "punctuation");
      i += 1;
      continue;
    }
    if ((char === "|" || char === ">") && flowDepth === 0) {
      let end = i + 1;
      while (end < text.length && /[0-9+-]/.test(text[end] ?? "")) end += 1;
      push(i, end, "punctuation");
      blockParent = nodeColumn;
      i = end;
      continue;
    }
    if (char === "&" || char === "*" || char === "!") {
      let end = i + 1;
      while (end < text.length && !isSpace(text[end]) && !isBreak(text[end]) && !isFlowIndicator(text[end])) {
        end += 1;
      }
      push(i, end, "anchor");
      i = end;
      continue;
    }

    const start = i;
    let end: number;
    let quoted = false;
    if (char === '"' || char === "'") {
      quoted = true;
      end = i + 1;
      while (end < text.length) {
        const c = text[end];
        if (char === '"' && c === "\\") {
          end += 2;
          continue;
        }
        if (c === char) {
          if (char === "'" && text[end + 1] === "'") {
            end += 2;
            continue;
          }
          end += 1;
          break;
        }
        end += 1;
      }
      end = Math.min(end, text.length);
    } else {
      end = i;
      while (end < text.length && !isBreak(text[end])) {
        const c = text[end];
        if (c === ":" && (isSpace(text[end + 1]) || isBreak(text[end + 1]) || (flowDepth > 0 && isFlowIndicator(text[end + 1])))) {
          break;
        }
        if (c === "#" && isSpace(text[end - 1])) break;
        if (flowDepth > 0 && isFlowIndicator(c)) break;
        end += 1;
      }
      while (end > start && isSpace(text[end - 1])) end -= 1;
    }
    let after = end;
    while (isSpace(text[after])) after += 1;
    const isKey =
      text[after] === ":" &&
      (isSpace(text[after + 1]) || isBreak(text[after + 1]) || (flowDepth > 0 && (quoted || isFlowIndicator(text[after + 1]))));
    if (isKey) {
      nodeColumn = start - lineStart;
      push(start, end, "key");
    } else if (!quoted && LITERAL.test(text.slice(start, end))) {
      push(start, end, "literal");
    } else {
      push(start, end, "value");
    }
    i = Math.max(end, start + 1);
    // A quoted scalar that spans lines has moved past their line starts.
    const lastBreak = text.lastIndexOf("\n", i - 1);
    if (lastBreak >= start) lineStart = lastBreak + 1;
  }
  return tokens;
}

/** A half-open range of UTF-16 code unit offsets into the YAML text. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

export interface Locatable {
  readonly range: TextRange | null;
  readonly line: number;
}

function clampOffset(text: string, value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), text.length);
}

function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The line containing `offset`, without its line break. */
export function lineAt(text: string, offset: number): TextRange {
  const at = clampOffset(text, offset);
  const start = at === 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1;
  const newline = text.indexOf("\n", at);
  let end = newline === -1 ? text.length : newline;
  if (end > start && text[end - 1] === "\r") end -= 1;
  return { start, end };
}

/** The 1-based `line`, clamped to the lines the text has. */
export function lineRange(text: string, line: number): TextRange {
  let offset = 0;
  for (let current = 1; current < Math.trunc(line); current += 1) {
    const newline = text.indexOf("\n", offset);
    if (newline === -1) break;
    offset = newline + 1;
  }
  return lineAt(text, offset);
}

/**
 * Where a diagnostic is marked in `text`: its exact range, else the whole line it names.
 * The result is empty only for an empty line.
 */
export function markRange(text: string, located: Locatable): TextRange | null {
  if (located.range) {
    let start = clampOffset(text, located.range.start);
    let end = Math.max(clampOffset(text, located.range.end), start);
    while (end > start && (text[end - 1] === "\n" || text[end - 1] === "\r")) end -= 1;
    if (start > 0 && isLowSurrogate(text, start)) start -= 1;
    if (end < text.length && isLowSurrogate(text, end)) end += 1;
    if (end > start) return { start, end };
    // Parsers report unterminated input at the end; the last written line is where it shows.
    return start === text.length && start > 0 ? lineAt(text, start - 1) : lineAt(text, start);
  }
  if (Number.isFinite(located.line) && located.line > 0) return lineRange(text, located.line);
  return null;
}

/** Indices of located diagnostics to mark: the first `max`, plus the active one wherever it is. */
export function markedIndices(located: readonly boolean[], active: number | null, max: number): number[] {
  const indices: number[] = [];
  located.forEach((isLocated, index) => {
    if (isLocated && (indices.length < max || index === active)) indices.push(index);
  });
  return indices;
}

/** The zero-based line number of `offset`. */
export function lineIndexOf(text: string, offset: number): number {
  const at = clampOffset(text, offset);
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1 && index < at; index = text.indexOf("\n", index + 1)) count += 1;
  return count;
}

export type Span = { start: number; end: number; kind: YamlTokenKind | "plain"; marked: boolean; active: boolean };

/**
 * Cuts the text into spans covering every character exactly once: syntax tokens and the plain
 * text between them, split further where diagnostic marks begin and end.
 */
export function highlightSpans(text: string, tokens: readonly YamlToken[], marks: ReadonlyArray<{ start: number; end: number; active: boolean }>): Span[] {
  const cuts = new Set<number>([0, text.length]);
  for (const token of tokens) {
    cuts.add(token.start);
    cuts.add(token.end);
  }
  for (const mark of marks) {
    cuts.add(clampOffset(text, mark.start));
    cuts.add(clampOffset(text, mark.end));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const spans: Span[] = [];
  let tokenIndex = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const start = points[i] ?? 0;
    const end = points[i + 1] ?? start;
    if (end <= start) continue;
    while (tokenIndex < tokens.length && (tokens[tokenIndex]?.end ?? 0) <= start) tokenIndex += 1;
    const token = tokens[tokenIndex];
    const kind = token && token.start <= start && token.end >= end ? token.kind : "plain";
    const covering = marks.filter((mark) => mark.start <= start && mark.end >= end);
    spans.push({ start, end, kind, marked: covering.length > 0, active: covering.some((mark) => mark.active) });
  }
  return spans;
}
