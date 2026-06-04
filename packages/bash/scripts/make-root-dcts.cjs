#!/usr/bin/env node
/**
 * Emit a genuinely CJS-correct root declaration file: `dist/index.d.cts`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `dist/index.d.ts` is the ESM barrel produced by `tsc` (isolatedDeclarations).
 * Every line is a re-export with an ESM-style `.js` specifier, e.g.:
 *     export { Bash } from "./Bash.js";
 *     export type { BashOptions } from "./Bash.js";
 *
 * The root `@ag-bash/bash` "." export declares `require.types -> index.d.cts`.
 * Historically that file was a byte-copy of `index.d.ts`. Under
 * `moduleResolution: Node16/NodeNext` a `.d.cts` is parsed in CJS mode, so each
 * `.js` re-export must resolve to a CJS module. The targets are ESM (`type:
 * module`), so a CJS/Node16 consumer doing `import { Bash } from "@ag-bash/bash"`
 * (or `require`) fails `tsc` with TS1479 ("...referenced file is an ECMAScript
 * module and cannot be imported with 'require'").
 *
 * THE FIX (least blast radius)
 * ----------------------------
 * Rather than emit a `.d.cts` companion for every file in the dist tree (huge,
 * recursive blast radius), rewrite the SINGLE root barrel into a self-contained
 * CJS declaration that pulls each symbol via an inline import type carrying an
 * explicit `resolution-mode: "import"` attribute. That attribute makes TS
 * resolve each target in ESM mode for TYPE purposes while the `.d.cts` itself
 * stays CJS — so no TS1479. The runtime `require('@ag-bash/bash')` is unaffected:
 * it loads `dist/bundle/index.cjs` (a self-contained esbuild CJS bundle); this
 * file only describes its TYPES.
 *
 * Each barrel export is classified (via the TypeScript checker) into one of:
 *   - type-only  -> per-module namespace alias:
 *       import type * as __m0 from "./Bash.js" with { "resolution-mode": "import" };
 *       export type BashOptions = __m0.BashOptions;
 *   - value-only (functions/consts) -> typeof inline import:
 *       export declare const parse:
 *         typeof import("./parser/parser.js", { with: { "resolution-mode": "import" } }).parse;
 *   - both (classes/enums)          -> DUAL emit (a type alias AND a const) so
 *       `new Bash()` and `const x: Bash` both keep working, matching the ESM barrel.
 *
 * Why the checker (not a regex guess): nested re-export barrels (e.g.
 * `sandbox/index.d.ts` re-exports `Command` from `./Sandbox.js`) make a single-
 * file static scan unreliable. `typescript` is already a devDependency, so this
 * adds no new dependency.
 *
 * Usage: node scripts/make-root-dcts.cjs [<src .d.ts>] [<out .d.cts>]
 * Defaults: dist/index.d.ts -> dist/index.d.cts
 */

const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const srcPath = path.resolve(process.argv[2] || path.join("dist", "index.d.ts"));
const outPath = path.resolve(process.argv[3] || path.join("dist", "index.d.cts"));

const RESOLUTION_ATTR = '{ "resolution-mode": "import" }';

/**
 * Split a brace body like `A, type B, C as D, type E as F` into entries,
 * tolerating trailing commas and arbitrary whitespace/newlines.
 * @param {string} body
 * @returns {{ syntacticType: boolean, source: string, alias: string }[]}
 */
function parseSpecifiers(body) {
  return body
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      let syntacticType = false;
      let rest = entry;
      const typeMatch = /^type\s+(.+)$/.exec(rest);
      if (typeMatch) {
        syntacticType = true;
        rest = typeMatch[1].trim();
      }
      const asMatch = /^(\S+)\s+as\s+(\S+)$/.exec(rest);
      if (asMatch) {
        return { syntacticType, source: asMatch[1], alias: asMatch[2] };
      }
      return { syntacticType, source: rest, alias: rest };
    });
}

/**
 * Parse the barrel into export records.
 * @param {string} input
 * @returns {{ syntacticType: boolean, source: string, alias: string, module: string }[]}
 */
function parseBarrel(input) {
  const statements = input
    .replace(/\r\n/g, "\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  const exportRe = /^export\s+(type\s+)?\{([\s\S]*?)\}\s+from\s+["']([^"']+)["']$/;
  /** @type {{ syntacticType: boolean, source: string, alias: string, module: string }[]} */
  const records = [];

  for (const stmt of statements) {
    const m = exportRe.exec(stmt);
    if (!m) {
      throw new Error(
        `make-root-dcts: unsupported statement (only \`export [type] { ... } from "..."\` is supported):\n${stmt};`,
      );
    }
    const stmtIsType = Boolean(m[1]);
    const moduleSpecifier = m[3];
    for (const spec of parseSpecifiers(m[2])) {
      records.push({
        syntacticType: stmtIsType || spec.syntacticType,
        source: spec.source,
        alias: spec.alias,
        module: moduleSpecifier,
      });
    }
  }
  return records;
}

/**
 * @typedef {Object} ExportInfo
 * @property {boolean} isValue   symbol has a value meaning (function/const/class)
 * @property {boolean} isType    symbol has a type meaning (class/interface/type/enum)
 * @property {string[]} typeParams  full type-parameter declarations (e.g. `T extends X = Y`)
 * @property {string[]} typeArgs    bare type-parameter references (e.g. `T`)
 */

/**
 * Build a name -> ExportInfo map for the barrel's own exports using the
 * TypeScript checker (resolving aliases through nested re-export barrels, and
 * capturing generic type-parameter lists so re-exported generics keep their
 * arity, constraints, and defaults).
 * @param {string} entry absolute path to index.d.ts
 * @returns {Map<string, ExportInfo>}
 */
function classifyExports(entry) {
  const program = ts.createProgram([entry], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    declaration: true,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(entry);
  if (!sourceFile) {
    throw new Error(`make-root-dcts: could not load source file ${entry}`);
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    throw new Error(`make-root-dcts: ${entry} is not a module`);
  }

  const TYPE_FLAGS =
    ts.SymbolFlags.Type |
    ts.SymbolFlags.Interface |
    ts.SymbolFlags.Class |
    ts.SymbolFlags.TypeAlias |
    ts.SymbolFlags.Enum |
    ts.SymbolFlags.TypeParameter;

  /**
   * Extract a generic symbol's type-parameter declarations and reference names
   * from its first parameterised declaration.
   * @param {ts.Symbol} target
   * @returns {{ typeParams: string[], typeArgs: string[] }}
   */
  const extractTypeParams = (target) => {
    for (const decl of target.getDeclarations() || []) {
      const params = /** @type {any} */ (decl).typeParameters;
      if (params && params.length) {
        const declFile = decl.getSourceFile();
        return {
          typeParams: params.map((tp) => tp.getText(declFile)),
          typeArgs: params.map((tp) => tp.name.getText(declFile)),
        };
      }
    }
    return { typeParams: [], typeArgs: [] };
  };

  /** @type {Map<string, ExportInfo>} */
  const classification = new Map();
  for (const exp of checker.getExportsOfModule(moduleSymbol)) {
    let target = exp;
    if (exp.getFlags() & ts.SymbolFlags.Alias) {
      target = checker.getAliasedSymbol(exp);
    }
    const flags = target.getFlags();
    const { typeParams, typeArgs } = extractTypeParams(target);
    classification.set(exp.getName(), {
      isValue: Boolean(flags & ts.SymbolFlags.Value),
      isType: Boolean(flags & TYPE_FLAGS),
      typeParams,
      typeArgs,
    });
  }
  return classification;
}

/**
 * @param {{ syntacticType: boolean, source: string, alias: string, module: string }[]} records
 * @param {Map<string, ExportInfo>} classification
 * @returns {string}
 */
function render(records, classification) {
  /** @type {Map<string, string>} */
  const moduleAlias = new Map();
  const aliasFor = (moduleSpecifier) => {
    if (!moduleAlias.has(moduleSpecifier)) {
      moduleAlias.set(moduleSpecifier, `__m${moduleAlias.size}`);
    }
    return moduleAlias.get(moduleSpecifier);
  };

  /** @type {string[]} */ const typeLines = [];
  /** @type {string[]} */ const valueLines = [];

  for (const rec of records) {
    const info = classification.get(rec.alias) || {
      isValue: false,
      isType: false,
      typeParams: [],
      typeArgs: [],
    };
    // A `type`-marked specifier is always type-only regardless of the symbol's
    // value meaning. Otherwise trust the checker.
    const emitType = rec.syntacticType || info.isType || !info.isValue;
    const emitValue = !rec.syntacticType && info.isValue;

    if (emitType) {
      const ns = aliasFor(rec.module);
      // Preserve generic type parameters (with constraints/defaults) and the
      // matching argument list so re-exported generics keep their arity.
      const params = info.typeParams.length
        ? `<${info.typeParams.join(", ")}>`
        : "";
      const args = info.typeArgs.length
        ? `<${info.typeArgs.join(", ")}>`
        : "";
      typeLines.push(
        `export type ${rec.alias}${params} = ${ns}.${rec.source}${args};`,
      );
    }
    if (emitValue) {
      valueLines.push(
        `export declare const ${rec.alias}: typeof import("${rec.module}", { with: ${RESOLUTION_ATTR} }).${rec.source};`,
      );
    }
  }

  const importLines = [...moduleAlias.entries()].map(
    ([moduleSpecifier, alias]) =>
      `import type * as ${alias} from "${moduleSpecifier}" with { "resolution-mode": "import" };`,
  );

  const header = [
    "// AUTO-GENERATED by scripts/make-root-dcts.cjs — DO NOT EDIT BY HAND.",
    "// CJS-correct mirror of index.d.ts for the `require` types condition (TS1479 fix).",
  ];

  const blocks = [header.join("\n"), importLines.join("\n")];
  if (typeLines.length) blocks.push(typeLines.join("\n"));
  if (valueLines.length) blocks.push(valueLines.join("\n"));
  return `${blocks.join("\n\n")}\n`;
}

function main() {
  if (!fs.existsSync(srcPath)) {
    console.error(`make-root-dcts: source not found: ${srcPath}`);
    process.exit(1);
  }
  const records = parseBarrel(fs.readFileSync(srcPath, "utf8"));
  const classification = classifyExports(srcPath);
  const output = render(records, classification);
  fs.writeFileSync(outPath, output);
  console.error(
    `make-root-dcts: wrote ${path.relative(process.cwd(), outPath)} (${records.length} exports, ${output.length} bytes)`,
  );
}

main();
