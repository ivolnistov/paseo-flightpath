// Shared ESLint preset for the checked-in HTML previews: HTML parse errors, duplicate ids and inline scripts.
// Dependencies are passed in so each plugin resolves them from its own node_modules.

const CLASSIC_TYPES = new Set(["", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript"]);

function scriptKind(element) {
  const attrs = new Map(element.attrs.map((attr) => [attr.name, attr.value]));
  if (attrs.has("src")) return null;
  const type = (attrs.get("type") ?? "").trim().toLowerCase();
  if (type === "module") return "mjs";
  return CLASSIC_TYPES.has(type) ? "js" : null;
}

function collectScripts(node, found) {
  if (node.nodeName === "script") found.push(node);
  for (const child of node.childNodes ?? []) collectScripts(child, found);
  if (node.content) collectScripts(node.content, found);
  return found;
}

function markupProblem(ruleId, message, location) {
  return {
    ruleId,
    severity: 2,
    message,
    line: location.startLine,
    column: location.startCol,
    endLine: location.endLine,
    endColumn: location.endCol,
  };
}

const UNKNOWN_LOCATION = { startLine: 1, startCol: 1, endLine: 1, endCol: 1 };

// The parser can merge attributes into an implied element that has no source location.
function idLocation(node) {
  return node.sourceCodeLocation?.attrs?.id ?? node.sourceCodeLocation ?? null;
}

// Template contents are separate documents, so each one has its own id scope.
function collectDuplicateIds(node, seen, problems) {
  const id = node.attrs?.find((attr) => attr.name === "id");
  if (id !== undefined && id.value !== "") {
    const location = idLocation(node);
    if (seen.has(id.value)) {
      const firstLine = seen.get(id.value);
      const first = firstLine === null ? "first used on an element without a source location" : `first used on line ${firstLine}`;
      const here = location === null ? " This element has no source location." : "";
      problems.push(markupProblem("html/duplicate-id", `Duplicate id "${id.value}", ${first}.${here}`, location ?? UNKNOWN_LOCATION));
    } else {
      seen.set(id.value, location?.startLine ?? null);
    }
  }
  for (const child of node.childNodes ?? []) collectDuplicateIds(child, seen, problems);
  if (node.content) collectDuplicateIds(node.content, new Map(), problems);
}

// Each script block is padded with newlines and spaces so reported lines and columns match the HTML file.
function createHtmlProcessor(parse) {
  const markupProblems = new Map();
  return {
    meta: { name: "flightpath-html" },
    supportsAutofix: false,
    preprocess(text, filename) {
      const problems = [];
      const document = parse(text, {
        sourceCodeLocationInfo: true,
        onParseError: (error) => problems.push(markupProblem(`html/${error.code}`, `HTML parse error: ${error.code}.`, error)),
      });
      collectDuplicateIds(document, new Map(), problems);
      markupProblems.set(filename, problems);
      return collectScripts(document, []).flatMap((element, index) => {
        const kind = scriptKind(element);
        const body = element.childNodes[0];
        if (kind === null || body === undefined) return [];
        const { startLine, startCol, startOffset, endOffset } = body.sourceCodeLocation;
        const padding = "\n".repeat(startLine - 1) + " ".repeat(startCol - 1);
        return [{ text: padding + text.slice(startOffset, endOffset), filename: `${index}.${kind}` }];
      });
    },
    postprocess(messages, filename) {
      const markup = markupProblems.get(filename) ?? [];
      markupProblems.delete(filename);
      return [...markup, ...messages.flat()].sort((a, b) => a.line - b.line || a.column - b.column);
    },
  };
}

export function htmlPreviewConfig({ js, globals, parse, ignores = [] }) {
  const correctness = {
    ...js.configs.recommended.rules,
    "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", caughtErrors: "none" }],
    "array-callback-return": "error",
    "no-constructor-return": "error",
    "no-promise-executor-return": "error",
    "no-self-compare": "error",
    "no-template-curly-in-string": "error",
    "no-unmodified-loop-condition": "error",
    "no-unreachable-loop": "error",
  };
  return [
    { ignores: ["node_modules/**", ...ignores] },
    { linterOptions: { reportUnusedDisableDirectives: "error" } },
    { files: ["**/*.html"], processor: createHtmlProcessor(parse) },
    {
      files: ["**/*.html/*.js"],
      languageOptions: { ecmaVersion: "latest", sourceType: "script", globals: globals.browser },
      rules: correctness,
    },
    {
      files: ["**/*.html/*.mjs"],
      languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.browser },
      rules: correctness,
    },
    {
      files: ["eslint.config.js"],
      languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.node },
      rules: correctness,
    },
  ];
}
