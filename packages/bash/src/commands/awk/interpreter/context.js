/**
 * AWK Runtime Context
 *
 * Holds all state for AWK program execution.
 */
import { ConstantRegex } from "../../../regex/index.js";

const DEFAULT_MAX_ITERATIONS = 10000;
// Keep low to prevent JS stack overflow (each AWK call uses ~10-20 JS stack frames)
const DEFAULT_MAX_RECURSION_DEPTH = 100;
// Default field separator for AWK (whitespace)
const DEFAULT_FIELD_SEP = new ConstantRegex(/\s+/);
export function createRuntimeContext(options = {}) {
  const {
    fieldSep = DEFAULT_FIELD_SEP,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    maxRecursionDepth = DEFAULT_MAX_RECURSION_DEPTH,
    maxOutputSize = 0,
    fs,
    cwd,
    exec,
    coverage,
    requireDefenseContext,
  } = options;
  return {
    FS: " ",
    OFS: " ",
    ORS: "\n",
    OFMT: "%.6g",
    NR: 0,
    NF: 0,
    FNR: 0,
    FILENAME: "",
    RSTART: 0,
    RLENGTH: -1,
    SUBSEP: "\x1c",
    fields: [],
    line: "",
    // Use null-prototype objects to prevent prototype pollution
    // when user-controlled keys like "__proto__" or "constructor" are used
    vars: Object.create(null),
    arrays: Object.create(null),
    arrayAliases: new Map(),
    ARGC: 0,
    ARGV: Object.create(null),
    ENVIRON: Object.create(null),
    functions: new Map(),
    fieldSep,
    maxIterations,
    maxRecursionDepth,
    maxOutputSize,
    currentRecursionDepth: 0,
    exitCode: 0,
    shouldExit: false,
    shouldNext: false,
    shouldNextFile: false,
    loopBreak: false,
    loopContinue: false,
    hasReturn: false,
    inEndBlock: false,
    output: "",
    openedFiles: new Set(),
    fs,
    cwd,
    exec,
    coverage,
    requireDefenseContext,
  };
}
