import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import { ControlPlaneError } from "./errors.mjs";

const JAVASCRIPT_EXTENSIONS = Object.freeze(new Set([".cjs", ".js", ".mjs"]));
const LOCAL_IMPORT_SUFFIXES = Object.freeze(["", ".mjs", ".js", ".cjs", ".json"]);
const STATIC_FILE_READERS = Object.freeze(new Set([
  "createReadStream",
  "open",
  "openSync",
  "readFile",
  "readFileSync",
]));
const REGEX_PREFIX_IDENTIFIERS = Object.freeze(new Set([
  "await", "case", "delete", "do", "else", "in", "instanceof", "of", "return",
  "throw", "typeof", "void", "yield",
]));
const REGEX_PREFIX_PUNCTUATORS = Object.freeze(new Set([
  "(", "{", "[", "=", ",", ":", ";", "!", "&", "|", "?", "+", "-", "*",
  "%", "^", "~", "<", ">",
]));

export class M6GroundedRunTcbClosureError extends ControlPlaneError {
  constructor(code, message, details = {}) {
    super(code, message, { status: 409, details: { ...details, notSent: true } });
    this.name = "M6GroundedRunTcbClosureError";
    this.details = Object.freeze(this.details);
  }
}

function fail(code, message, details = {}) {
  throw new M6GroundedRunTcbClosureError(code, message, details);
}

function sorted(values) {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function canonicalRepoPath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && !value.includes("\\")
    && !value.startsWith("/")
    && !/^[a-zA-Z]:/u.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function within(root, target) {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function toRepoPath(root, target) {
  const rel = relative(root, target).split(sep).join("/");
  if (!canonicalRepoPath(rel)) {
    fail("M6_TCB_CLOSURE_PATH_ESCAPE", "TCB dependency escaped the repository root", {
      root,
      target,
    });
  }
  return rel;
}

function assertPlainFile(root, absolutePath, relativePath, kind) {
  if (!within(root, absolutePath)) {
    fail("M6_TCB_CLOSURE_PATH_ESCAPE", `${kind} escaped the repository root`, {
      path: relativePath,
    });
  }
  let stat;
  let real;
  try {
    stat = lstatSync(absolutePath);
    real = realpathSync(absolutePath);
  } catch (cause) {
    fail("M6_TCB_CLOSURE_DEPENDENCY_MISSING", `${kind} is missing`, {
      path: relativePath,
      cause: cause?.message ?? String(cause),
    });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("M6_TCB_CLOSURE_DEPENDENCY_INVALID", `${kind} must be one plain file`, {
      path: relativePath,
    });
  }
  if (!within(root, real)) {
    fail("M6_TCB_CLOSURE_PATH_ESCAPE", `${kind} resolved outside the repository root`, {
      path: relativePath,
      realPath: real,
    });
  }
  return absolutePath;
}

function decodeStringEscape(source, index) {
  const marker = source[index];
  const simple = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", 0: "\0" };
  if (Object.hasOwn(simple, marker)) return { value: simple[marker], next: index + 1 };
  if (marker === "\n") return { value: "", next: index + 1 };
  if (marker === "\r") return { value: "", next: source[index + 1] === "\n" ? index + 2 : index + 1 };
  if (marker === "x") {
    const hex = source.slice(index + 1, index + 3);
    if (/^[0-9a-fA-F]{2}$/u.test(hex)) return { value: String.fromCodePoint(Number.parseInt(hex, 16)), next: index + 3 };
  }
  if (marker === "u") {
    if (source[index + 1] === "{") {
      const end = source.indexOf("}", index + 2);
      const hex = end >= 0 ? source.slice(index + 2, end) : "";
      const codePoint = /^[0-9a-fA-F]{1,6}$/u.test(hex) ? Number.parseInt(hex, 16) : -1;
      if (codePoint >= 0 && codePoint <= 0x10ffff) return { value: String.fromCodePoint(codePoint), next: end + 1 };
    }
    const hex = source.slice(index + 1, index + 5);
    if (/^[0-9a-fA-F]{4}$/u.test(hex)) return { value: String.fromCodePoint(Number.parseInt(hex, 16)), next: index + 5 };
  }
  return { value: marker, next: index + 1 };
}

function tokenizeJavaScript(source, sourcePath) {
  const tokens = [];
  let index = 0;
  let line = 1;

  const push = (type, value, start, tokenLine) => tokens.push(Object.freeze({ type, value, index: start, line: tokenLine }));
  const previousToken = () => tokens.at(-1) ?? null;

  function skipLineComment() {
    index += 2;
    while (index < source.length && source[index] !== "\n") index += 1;
  }

  function skipBlockComment() {
    const start = index;
    index += 2;
    while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
      if (source[index] === "\n") line += 1;
      index += 1;
    }
    if (index >= source.length) {
      fail("M6_TCB_CLOSURE_SOURCE_INVALID", "unterminated block comment while scanning TCB authority", {
        sourcePath,
        index: start,
      });
    }
    index += 2;
  }

  function scanQuotedString(quote) {
    const start = index;
    const tokenLine = line;
    let value = "";
    index += 1;
    while (index < source.length) {
      const char = source[index];
      if (char === quote) {
        index += 1;
        push("string", value, start, tokenLine);
        return;
      }
      if (char === "\\") {
        const decoded = decodeStringEscape(source, index + 1);
        value += decoded.value;
        index = decoded.next;
        continue;
      }
      if (char === "\n" || char === "\r") {
        fail("M6_TCB_CLOSURE_SOURCE_INVALID", "unterminated string while scanning TCB authority", {
          sourcePath,
          line: tokenLine,
        });
      }
      value += char;
      index += 1;
    }
    fail("M6_TCB_CLOSURE_SOURCE_INVALID", "unterminated string while scanning TCB authority", {
      sourcePath,
      line: tokenLine,
    });
  }

  function slashStartsRegex() {
    const previous = previousToken();
    return previous === null
      || (previous.type === "identifier" && REGEX_PREFIX_IDENTIFIERS.has(previous.value))
      || (previous.type === "punctuator" && REGEX_PREFIX_PUNCTUATORS.has(previous.value));
  }

  function skipRegex() {
    const start = index;
    const tokenLine = line;
    let inClass = false;
    index += 1;
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "/" && !inClass) {
        index += 1;
        while (/[a-z]/iu.test(source[index] ?? "")) index += 1;
        push("regex", null, start, tokenLine);
        return;
      } else if (char === "\n" || char === "\r") {
        break;
      }
      index += 1;
    }
    fail("M6_TCB_CLOSURE_SOURCE_INVALID", "unterminated regular expression while scanning TCB authority", {
      sourcePath,
      line: tokenLine,
    });
  }

  function scanTemplate() {
    const start = index;
    const tokenLine = line;
    push("template", null, start, tokenLine);
    index += 1;
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "\n") line += 1;
      if (char === "`") {
        index += 1;
        return;
      }
      if (char === "$" && source[index + 1] === "{") {
        index += 2;
        scanSegment(true);
        continue;
      }
      index += 1;
    }
    fail("M6_TCB_CLOSURE_SOURCE_INVALID", "unterminated template literal while scanning TCB authority", {
      sourcePath,
      line: tokenLine,
    });
  }

  function scanSegment(stopAtTemplateBrace = false) {
    let braceDepth = 0;
    while (index < source.length) {
      const char = source[index];
      if (/\s/u.test(char)) {
        if (char === "\n") line += 1;
        index += 1;
        continue;
      }
      if (char === "/" && source[index + 1] === "/") {
        skipLineComment();
        continue;
      }
      if (char === "/" && source[index + 1] === "*") {
        skipBlockComment();
        continue;
      }
      if (char === "'" || char === "\"") {
        scanQuotedString(char);
        continue;
      }
      if (char === "`") {
        scanTemplate();
        continue;
      }
      if (char === "/" && slashStartsRegex()) {
        skipRegex();
        continue;
      }
      if (/[A-Za-z_$]/u.test(char)) {
        const start = index;
        const tokenLine = line;
        index += 1;
        while (/[A-Za-z0-9_$]/u.test(source[index] ?? "")) index += 1;
        push("identifier", source.slice(start, index), start, tokenLine);
        continue;
      }
      if (stopAtTemplateBrace && char === "}" && braceDepth === 0) {
        index += 1;
        return;
      }
      if (stopAtTemplateBrace && char === "{") braceDepth += 1;
      if (stopAtTemplateBrace && char === "}") braceDepth -= 1;
      push("punctuator", char, index, line);
      index += 1;
    }
    if (stopAtTemplateBrace) {
      fail("M6_TCB_CLOSURE_SOURCE_INVALID", "unterminated template expression while scanning TCB authority", {
        sourcePath,
      });
    }
  }

  scanSegment(false);
  return tokens;
}

function tokenIs(token, type, value = undefined) {
  return token?.type === type && (value === undefined || token.value === value);
}

function matchingParenIndex(tokens, openIndex) {
  let depth = 0;
  for (let cursor = openIndex; cursor < tokens.length; cursor += 1) {
    if (tokenIs(tokens[cursor], "punctuator", "(")) depth += 1;
    else if (tokenIs(tokens[cursor], "punctuator", ")")) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

function staticSpecifier(value) {
  return typeof value === "string" && value.length > 0;
}

function analyzeJavaScript(source, sourcePath) {
  const tokens = tokenizeJavaScript(source, sourcePath);
  const imports = [];
  const staticData = [];

  for (let cursor = 0; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    const previous = tokens[cursor - 1];
    const next = tokens[cursor + 1];

    if (tokenIs(token, "identifier", "import") && !tokenIs(previous, "punctuator", ".")) {
      if (tokenIs(next, "punctuator", ".")) continue;
      if (tokenIs(next, "punctuator", "(")) {
        const argument = tokens[cursor + 2];
        if (!tokenIs(argument, "string") || !staticSpecifier(argument.value)) {
          fail("M6_TCB_NON_LITERAL_DYNAMIC_IMPORT", "TCB authority contains a non-literal dynamic import", {
            sourcePath,
            line: token.line,
          });
        }
        imports.push(Object.freeze({ kind: "dynamic-import", specifier: argument.value, line: token.line }));
        continue;
      }
      if (tokenIs(next, "string")) {
        if (!staticSpecifier(next.value)) {
          fail("M6_TCB_CLOSURE_IMPORT_INVALID", "TCB authority contains an empty import specifier", {
            sourcePath,
            line: token.line,
          });
        }
        imports.push(Object.freeze({ kind: "static-import", specifier: next.value, line: token.line }));
        continue;
      }
      let from = cursor + 1;
      while (from < tokens.length && !tokenIs(tokens[from], "punctuator", ";")) {
        if (tokenIs(tokens[from], "identifier", "from")) break;
        from += 1;
      }
      if (!tokenIs(tokens[from], "identifier", "from") || !tokenIs(tokens[from + 1], "string")
        || !staticSpecifier(tokens[from + 1].value)) {
        fail("M6_TCB_CLOSURE_SOURCE_INVALID", "TCB authority contains an unparseable import declaration", {
          sourcePath,
          line: token.line,
        });
      }
      imports.push(Object.freeze({ kind: "static-import", specifier: tokens[from + 1].value, line: token.line }));
      continue;
    }

    if (tokenIs(token, "identifier", "export") && !tokenIs(previous, "punctuator", ".")) {
      let from = cursor + 1;
      while (from < tokens.length && !tokenIs(tokens[from], "punctuator", ";")) {
        if (tokenIs(tokens[from], "identifier", "from")) break;
        from += 1;
      }
      if (tokenIs(tokens[from], "identifier", "from") && tokenIs(tokens[from + 1], "string")
        && staticSpecifier(tokens[from + 1].value)) {
        imports.push(Object.freeze({ kind: "static-export", specifier: tokens[from + 1].value, line: token.line }));
      } else if (tokenIs(tokens[from], "identifier", "from") && tokenIs(tokens[from + 1], "string")) {
        fail("M6_TCB_CLOSURE_IMPORT_INVALID", "TCB authority contains an empty export specifier", {
          sourcePath,
          line: token.line,
        });
      }
      continue;
    }

    if (tokenIs(token, "identifier", "require")
      && !tokenIs(previous, "punctuator", ".")
      && !tokenIs(previous, "identifier", "function")
      && tokenIs(next, "punctuator", "(")) {
      const closing = matchingParenIndex(tokens, cursor + 1);
      const looksLikeMethod = closing === cursor + 3 && tokenIs(tokens[closing + 1], "punctuator", "{");
      if (looksLikeMethod) continue;
      const argument = tokens[cursor + 2];
      if (!tokenIs(argument, "string") || !staticSpecifier(argument.value)) {
        fail("M6_TCB_NON_LITERAL_REQUIRE", "TCB authority contains a non-literal require", {
          sourcePath,
          line: token.line,
        });
      }
      imports.push(Object.freeze({ kind: "require", specifier: argument.value, line: token.line }));
      continue;
    }

    if (tokenIs(token, "identifier", "new")
      && tokenIs(tokens[cursor + 1], "identifier", "URL")
      && tokenIs(tokens[cursor + 2], "punctuator", "(")
      && tokenIs(tokens[cursor + 3], "string")
      && tokenIs(tokens[cursor + 4], "punctuator", ",")
      && tokenIs(tokens[cursor + 5], "identifier", "import")
      && tokenIs(tokens[cursor + 6], "punctuator", ".")
      && tokenIs(tokens[cursor + 7], "identifier", "meta")
      && tokenIs(tokens[cursor + 8], "punctuator", ".")
      && tokenIs(tokens[cursor + 9], "identifier", "url")) {
      staticData.push(Object.freeze({ kind: "module-url", specifier: tokens[cursor + 3].value, line: token.line }));
      continue;
    }

    if (token.type === "identifier" && STATIC_FILE_READERS.has(token.value)
      && tokenIs(next, "punctuator", "(") && tokenIs(tokens[cursor + 2], "string")) {
      staticData.push(Object.freeze({ kind: "literal-read", specifier: tokens[cursor + 2].value, line: token.line }));
    }
  }
  return Object.freeze({ imports: Object.freeze(imports), staticData: Object.freeze(staticData) });
}

function localSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../")
    || specifier.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(specifier) || specifier.startsWith("file:");
}

function resolveLocalImport({ root, importerPath, specifier, kind, line }) {
  if (specifier.includes("\\")) {
    fail("M6_TCB_CLOSURE_IMPORT_INVALID", "TCB import specifiers may not contain backslashes", {
      importerPath,
      specifier,
      kind,
      line,
    });
  }
  if (!localSpecifier(specifier)) return null;
  if (specifier.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(specifier) || specifier.startsWith("file:")) {
    fail("M6_TCB_CLOSURE_PATH_ESCAPE", "TCB local import must be repository-relative", {
      importerPath,
      specifier,
      kind,
      line,
    });
  }
  if (specifier.includes("?") || specifier.includes("#") || specifier.includes("%")) {
    fail("M6_TCB_CLOSURE_IMPORT_INVALID", "TCB local import may not contain a query, fragment, or percent escape", {
      importerPath,
      specifier,
      kind,
      line,
    });
  }
  const importerAbsolute = resolve(root, ...importerPath.split("/"));
  const base = resolve(dirname(importerAbsolute), specifier);
  if (!within(root, base)) {
    fail("M6_TCB_CLOSURE_PATH_ESCAPE", "TCB local import escaped the repository root", {
      importerPath,
      specifier,
      kind,
      line,
    });
  }
  const candidates = [];
  for (const suffix of LOCAL_IMPORT_SUFFIXES) candidates.push(`${base}${suffix}`);
  for (const suffix of ["index.mjs", "index.js", "index.cjs", "index.json"]) candidates.push(resolve(base, suffix));
  for (const candidate of candidates) {
    try {
      if (lstatSync(candidate).isFile()) {
        const relativePath = toRepoPath(root, candidate);
        return { absolutePath: assertPlainFile(root, candidate, relativePath, "TCB local import"), relativePath };
      }
    } catch (cause) {
      if (cause instanceof M6GroundedRunTcbClosureError) throw cause;
    }
  }
  fail("M6_TCB_CLOSURE_DEPENDENCY_MISSING", "TCB local import target is missing", {
    importerPath,
    specifier,
    kind,
    line,
  });
}

function resolveStaticData({ root, sourcePath, entry }) {
  const { specifier, kind, line } = entry;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(specifier) && !specifier.startsWith("file:")) return null;
  if (specifier.endsWith("/") || specifier.endsWith("\\")) return null;
  let target;
  if (specifier.startsWith("file:") || specifier.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(specifier)) {
    fail("M6_TCB_STATIC_DATA_PATH_ESCAPE", "static TCB data read must be repository-relative", {
      sourcePath,
      specifier,
      kind,
      line,
    });
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    target = resolve(dirname(resolve(root, ...sourcePath.split("/"))), specifier);
  } else if (specifier.includes("/")) {
    target = resolve(root, ...specifier.split("/"));
  } else {
    target = resolve(dirname(resolve(root, ...sourcePath.split("/"))), specifier);
  }
  if (!within(root, target)) {
    fail("M6_TCB_STATIC_DATA_PATH_ESCAPE", "static TCB data read escaped the repository root", {
      sourcePath,
      specifier,
      kind,
      line,
    });
  }
  try {
    if (lstatSync(target).isDirectory()) return null;
  } catch {
    // A missing static data read is still undeclared and is diagnosed below.
  }
  return toRepoPath(root, target);
}

function assertDeclaredStaticData({ root, sourcePath, staticData, declaredData }) {
  for (const entry of staticData) {
    const resolvedPath = resolveStaticData({ root, sourcePath, entry });
    if (resolvedPath !== null && !declaredData.has(resolvedPath)) {
      fail("M6_TCB_UNDECLARED_STATIC_DATA", "TCB authority reads repository data that is absent from the explicit data dependency set", {
        sourcePath,
        dataPath: resolvedPath,
        kind: entry.kind,
        line: entry.line,
      });
    }
  }
}

function normalizeDeclaredPaths(root, values, kind) {
  if (!Array.isArray(values) || values.length === 0) {
    fail("M6_TCB_CLOSURE_DECLARATION_INVALID", `${kind} must be a non-empty array`);
  }
  const unique = new Set();
  for (const value of values) {
    if (!canonicalRepoPath(value) || unique.has(value)) {
      fail("M6_TCB_CLOSURE_DECLARATION_INVALID", `${kind} must contain unique canonical repository paths`, {
        path: value,
      });
    }
    const absolutePath = resolve(root, ...value.split("/"));
    assertPlainFile(root, absolutePath, value, kind);
    unique.add(value);
  }
  return unique;
}

/**
 * Reproduce the effect-bearing code closure from a small reviewed authority-root
 * set, then add the separately reviewed static data set. Bare package and
 * node: imports remain outside this repository closure; every repository-local
 * edge must resolve to one plain file below rootDir.
 */
export function computeM6GroundedRunStaticClosure({
  rootDir,
  authorityRoots,
  explicitDataDependencies,
} = {}) {
  if (typeof rootDir !== "string" || rootDir.length === 0) {
    fail("M6_TCB_CLOSURE_DECLARATION_INVALID", "rootDir is required");
  }
  const root = realpathSync(resolve(rootDir));
  const roots = normalizeDeclaredPaths(root, authorityRoots, "TCB authority roots");
  const declaredData = normalizeDeclaredPaths(root, explicitDataDependencies, "TCB explicit data dependencies");
  const closure = new Set(declaredData);
  const pending = [...roots];

  while (pending.length > 0) {
    const sourcePath = pending.pop();
    if (closure.has(sourcePath)) continue;
    const absolutePath = assertPlainFile(
      root,
      resolve(root, ...sourcePath.split("/")),
      sourcePath,
      "TCB authority source",
    );
    closure.add(sourcePath);
    if (!JAVASCRIPT_EXTENSIONS.has(extname(sourcePath))) continue;
    const analysis = analyzeJavaScript(readFileSync(absolutePath, "utf8"), sourcePath);
    assertDeclaredStaticData({ root, sourcePath, staticData: analysis.staticData, declaredData });
    for (const entry of analysis.imports) {
      const resolvedImport = resolveLocalImport({ root, importerPath: sourcePath, ...entry });
      if (resolvedImport !== null && !closure.has(resolvedImport.relativePath)) pending.push(resolvedImport.relativePath);
    }
  }
  return Object.freeze(sorted(closure));
}

export function assertExactM6GroundedRunStaticClosure({ declaredPaths, expectedPaths } = {}) {
  if (!Array.isArray(declaredPaths) || !Array.isArray(expectedPaths)
    || declaredPaths.length !== expectedPaths.length
    || declaredPaths.some((value, index) => value !== expectedPaths[index])) {
    const declared = Array.isArray(declaredPaths) ? declaredPaths : [];
    const expected = Array.isArray(expectedPaths) ? expectedPaths : [];
    const declaredSet = new Set(declared);
    const expectedSet = new Set(expected);
    fail("M6_GROUNDED_RUN_TCB_PATHS_MISMATCH", "grounded-run TCB manifest paths differ from the reproduced static closure", {
      missingFromManifest: expected.filter((path) => !declaredSet.has(path)),
      unexpectedInManifest: declared.filter((path) => !expectedSet.has(path)),
      orderMismatch: declared.length === expected.length
        && declared.every((path) => expectedSet.has(path))
        && expected.every((path) => declaredSet.has(path)),
    });
  }
  return true;
}
