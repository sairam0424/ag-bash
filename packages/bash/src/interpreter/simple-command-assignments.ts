/**
 * Simple Command Assignment Handling
 *
 * Handles variable assignments in simple commands:
 * - Array assignments: VAR=(a b c)
 * - Subscript assignments: VAR[idx]=value
 * - Scalar assignments with nameref resolution
 */

import type { SimpleCommandNode, WordNode } from "../ast/types.js";
import { parseArithmeticExpression } from "../parser/arithmetic-parser.js";
import { Parser } from "../parser/parser.js";
import type { ExecResult } from "../types.js";
import { evaluateArithmetic } from "./arithmetic.js";
import {
  applyCaseTransform,
  getLocalVarDepth,
  isInteger,
} from "./builtins/index.js";
import { ArithmeticError, ExitError } from "./errors.js";
import {
  expandWord,
  expandWordWithGlob,
  getArrayElements,
} from "./expansion.js";
import {
  parseKeyedElementFromWord,
  wordToLiteralString,
} from "./helpers/array.js";
import {
  getNamerefTarget,
  isNameref,
  resolveNameref,
  resolveNamerefForAssignment,
} from "./helpers/nameref.js";
import { checkReadonlyError, isReadonly } from "./helpers/readonly.js";
import { result } from "./helpers/result.js";
import { POSIX_SPECIAL_BUILTINS } from "./helpers/shell-constants.js";
import { expandTildesInValue } from "./helpers/tilde.js";
import { traceAssignment } from "./helpers/xtrace.js";
import type { InterpreterContext } from "./types.js";

/**
 * Result of processing assignments in a simple command
 */
export interface AssignmentResult {
  /** Whether to continue to the next statement (skip command execution) */
  continueToNext: boolean;
  /** Accumulated xtrace output for assignments */
  xtraceOutput: string;
  /** Temporary assignments for prefix bindings (FOO=bar cmd) */
  tempAssignments: Map<string, string | undefined>;
  /** Error result if assignment failed */
  error?: ExecResult;
}

/**
 * Process all assignments in a simple command.
 * Returns assignment results including temp bindings and any errors.
 */
export async function processAssignments(
  ctx: InterpreterContext,
  node: SimpleCommandNode,
): Promise<AssignmentResult> {
  const tempAssignments = new Map<string, string | undefined>();
  let xtraceOutput = "";

  for (const assignment of node.assignments) {
    const name = assignment.name;

    // Handle array assignment: VAR=(a b c) or VAR+=(a b c)
    if (assignment.array) {
      const arrayResult = await processArrayAssignment(
        ctx,
        node,
        name,
        assignment.array,
        assignment.append,
        tempAssignments,
      );
      if (arrayResult.error) {
        return {
          continueToNext: false,
          xtraceOutput,
          tempAssignments,
          error: arrayResult.error,
        };
      }
      xtraceOutput += arrayResult.xtraceOutput;
      if (arrayResult.continueToNext) {
        continue;
      }
    }

    const value = assignment.value
      ? await expandWord(ctx, assignment.value)
      : "";

    // Check for empty subscript assignment: a[]=value is invalid
    const emptySubscriptMatch = name.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[\]$/);
    if (emptySubscriptMatch) {
      return {
        continueToNext: false,
        xtraceOutput,
        tempAssignments,
        error: result("", `bash: ${name}: bad array subscript\n`, 1),
      };
    }

    // Check for array subscript assignment: a[subscript]=value
    const subscriptMatch = name.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
    if (subscriptMatch) {
      const subscriptResult = await processSubscriptAssignment(
        ctx,
        node,
        subscriptMatch[1],
        subscriptMatch[2],
        value,
        assignment.append,
        tempAssignments,
      );
      if (subscriptResult.error) {
        return {
          continueToNext: false,
          xtraceOutput,
          tempAssignments,
          error: subscriptResult.error,
        };
      }
      if (subscriptResult.continueToNext) {
        continue;
      }
    }

    // Handle scalar assignment
    const scalarResult = await processScalarAssignment(
      ctx,
      node,
      name,
      value,
      assignment.append,
      tempAssignments,
    );
    if (scalarResult.error) {
      return {
        continueToNext: false,
        xtraceOutput,
        tempAssignments,
        error: scalarResult.error,
      };
    }
    xtraceOutput += scalarResult.xtraceOutput;
    if (scalarResult.continueToNext) {
    }
  }

  return {
    continueToNext: false,
    xtraceOutput,
    tempAssignments,
  };
}

/**
 * Push a "temp frame" for the prefix assignments of `VAR=x cmd`.
 *
 * `processAssignments()` has already written the new values into `ctx.state.env`
 * and recorded the SHADOWED (outer) value for each name in `tempAssignments`.
 * Publishing that same map on `ctx.state.tempEnvBindings` is what makes the
 * frame observable to the rest of the interpreter while `cmd` runs:
 *   - `unset` reveals the shadowed value instead of deleting the variable
 *     (`handleTempEnvUnset` in builtins/unset.ts);
 *   - a bare `local v` INHERITS the temp value (builtins/local.ts);
 *   - reads/writes of the name are recorded in `accessedTempEnvVars` /
 *     `mutatedTempEnvVars`, which decide whether a later local-unset is a
 *     value-unset or reveals the shadowed value.
 *
 * The map is shared, NOT copied, on purpose: when `unset` reveals a shadowed
 * value it deletes that entry, and the delete must also cancel the restore in
 * `popTempEnvFrame()`. Otherwise `f() { unset x; x=new; }; x=temp f` would
 * clobber the fresh `x=new` with the stale shadowed value on the way out.
 */
export function pushTempEnvFrame(
  ctx: InterpreterContext,
  tempAssignments: Map<string, string | undefined>,
): void {
  const stack = ctx.state.tempEnvBindings ?? [];
  stack.push(tempAssignments);
  ctx.state.tempEnvBindings = stack;
}

/**
 * Whether the temp frame is unwound when its command finishes.
 *
 * bash restores prefix assignments after EVERY command by default — that is why
 * `foo=bar true; echo $foo` prints nothing and why `true` being redefinable as a
 * function changes nothing (builtin-special.test.sh :: "true is not special").
 * The POSIX rule that assignments preceding a SPECIAL builtin persist is only
 * honoured under `set -o posix` (builtin-special.test.sh :: "Prefix assignments
 * persist after special builtins, like : (set -o posix)"), and bash does not
 * extend it to `unset`/`eval`, whose whole job may be to touch the same name.
 */
function shouldRestoreTempEnv(
  ctx: InterpreterContext,
  commandName: string,
): boolean {
  if (!ctx.state.options.posix || !POSIX_SPECIAL_BUILTINS.has(commandName)) {
    return true;
  }
  return commandName === "unset" || commandName === "eval";
}

/**
 * Pop the temp frame pushed by `pushTempEnvFrame()` and unwind its effects.
 *
 * `boundNames` is the frame's ORIGINAL key set, captured before the command ran:
 * `frame` itself may have shrunk (see `pushTempEnvFrame`), but the export and
 * access bookkeeping still has to be cleared for every name that was bound.
 * Each name is only cleared when no OUTER frame still binds it, so
 * `X=1 f` -> `X=2 g` does not lose X's outer binding when g returns.
 */
export function popTempEnvFrame(
  ctx: InterpreterContext,
  frame: Map<string, string | undefined>,
  boundNames: readonly string[],
  commandName: string,
): void {
  const stack = ctx.state.tempEnvBindings;
  if (stack) {
    const index = stack.lastIndexOf(frame);
    if (index !== -1) {
      stack.splice(index, 1);
    }
  }

  for (const name of boundNames) {
    if (ctx.state.tempEnvBindings?.some((outer) => outer.has(name))) {
      continue;
    }
    if (ctx.state.tempExportedVars?.delete(name)) {
      ctx.state.exportedEnvDirty = true;
    }
    // These two only mean "…since the frame that bound this name was pushed",
    // so they MUST NOT outlive the frame: a stale entry would turn the next
    // command's local-unset of the same name into a reveal.
    ctx.state.accessedTempEnvVars?.delete(name);
    ctx.state.mutatedTempEnvVars?.delete(name);
  }

  if (!shouldRestoreTempEnv(ctx, commandName)) {
    return;
  }

  for (const [name, shadowed] of frame) {
    // A local cell that was unset all the way down suppresses the restore:
    // bash leaves the name unset rather than resurrecting the temp value.
    if (ctx.state.fullyUnsetLocals?.has(name)) {
      continue;
    }
    if (shadowed === undefined) {
      ctx.state.env.delete(name);
    } else {
      ctx.state.env.set(name, shadowed);
    }
  }
}

interface SingleAssignmentResult {
  continueToNext: boolean;
  xtraceOutput: string;
  error?: ExecResult;
}

/**
 * Process an array assignment: VAR=(a b c) or VAR+=(a b c)
 */
async function processArrayAssignment(
  ctx: InterpreterContext,
  node: SimpleCommandNode,
  name: string,
  array: WordNode[],
  append: boolean,
  tempAssignments: Map<string, string | undefined>,
): Promise<SingleAssignmentResult> {
  let xtraceOutput = "";

  // Check if trying to assign array to subscripted element: a[0]=(1 2) is invalid
  if (/\[.+\]$/.test(name)) {
    return {
      continueToNext: false,
      xtraceOutput: "",
      error: result(
        "",
        `bash: ${name}: cannot assign list to array member\n`,
        1,
      ),
    };
  }

  // Check if name is a nameref - assigning an array to a nameref is complex
  if (isNameref(ctx, name)) {
    const target = getNamerefTarget(ctx, name);
    if (target === undefined || target === "") {
      throw new ExitError(1, "", "");
    }
    const resolved = resolveNameref(ctx, name);
    if (resolved && /^[a-zA-Z_][a-zA-Z0-9_]*\[@\]$/.test(resolved)) {
      return {
        continueToNext: false,
        xtraceOutput: "",
        error: result(
          "",
          `bash: ${name}: cannot assign list to array member\n`,
          1,
        ),
      };
    }
  }

  // Check if array variable is readonly
  if (isReadonly(ctx, name)) {
    if (node.name) {
      xtraceOutput += `bash: ${name}: readonly variable\n`;
      return { continueToNext: true, xtraceOutput };
    }
    const readonlyError = checkReadonlyError(ctx, name);
    if (readonlyError) {
      return { continueToNext: false, xtraceOutput: "", error: readonlyError };
    }
  }

  // Check if this is an associative array
  const isAssoc = ctx.state.associativeArrays?.has(name);

  // Check if elements use [key]=value or [key]+=value syntax
  const hasKeyedElements = checkHasKeyedElements(array);

  // Helper to clear existing array elements
  const clearExistingElements = () => {
    const prefix = `${name}_`;
    for (const key of ctx.state.env.keys()) {
      if (key.startsWith(prefix) && !key.includes("__")) {
        ctx.state.env.delete(key);
      }
    }
    ctx.state.env.delete(name);
  };

  if (isAssoc && hasKeyedElements) {
    await processAssociativeArrayAssignment(
      ctx,
      node,
      name,
      array,
      append,
      clearExistingElements,
      (msg) => {
        xtraceOutput += msg;
      },
    );
  } else if (hasKeyedElements) {
    await processIndexedArrayWithKeysAssignment(
      ctx,
      name,
      array,
      append,
      clearExistingElements,
    );
  } else {
    await processSimpleArrayAssignment(
      ctx,
      name,
      array,
      append,
      clearExistingElements,
    );
  }

  // For prefix assignments with a command, bash stringifies the array syntax
  if (node.name) {
    tempAssignments.set(name, ctx.state.env.get(name));
    const elements = array.map((el) => wordToLiteralString(el));
    const stringified = `(${elements.join(" ")})`;
    ctx.state.env.set(name, stringified);
  }

  return { continueToNext: true, xtraceOutput };
}

/**
 * Check if array elements use [key]=value syntax
 */
function checkHasKeyedElements(array: WordNode[]): boolean {
  return array.some((element) => {
    if (element.parts.length >= 2) {
      const first = element.parts[0];
      const second = element.parts[1];
      if (first.type !== "Glob" || !first.pattern.startsWith("[")) {
        return false;
      }
      if (
        first.pattern === "[" &&
        (second.type === "DoubleQuoted" || second.type === "SingleQuoted")
      ) {
        if (element.parts.length < 3) return false;
        const third = element.parts[2];
        if (third.type !== "Literal") return false;
        return third.value.startsWith("]=") || third.value.startsWith("]+=");
      }
      if (second.type !== "Literal") {
        return false;
      }
      if (second.value.startsWith("]")) {
        return second.value.startsWith("]=") || second.value.startsWith("]+=");
      }
      if (first.pattern.endsWith("]")) {
        return second.value.startsWith("=") || second.value.startsWith("+=");
      }
      return false;
    }
    return false;
  });
}

/**
 * Process associative array assignment with [key]=value syntax
 */
async function processAssociativeArrayAssignment(
  ctx: InterpreterContext,
  node: SimpleCommandNode,
  name: string,
  array: WordNode[],
  append: boolean,
  clearExistingElements: () => void,
  addXtraceOutput: (msg: string) => void,
): Promise<void> {
  interface PendingAssocElement {
    type: "keyed";
    key: string;
    value: string;
    append: boolean;
  }
  interface PendingAssocInvalid {
    type: "invalid";
    expandedValue: string;
  }
  const pendingElements: (PendingAssocElement | PendingAssocInvalid)[] = [];

  // First pass: Expand all values BEFORE clearing the array
  for (const element of array) {
    const parsed = parseKeyedElementFromWord(element);
    if (parsed) {
      const { key, valueParts, append: elementAppend } = parsed;
      let value: string;
      if (valueParts.length > 0) {
        const valueWord: WordNode = { type: "Word", parts: valueParts };
        value = await expandWord(ctx, valueWord);
      } else {
        value = "";
      }
      value = expandTildesInValue(ctx, value);
      pendingElements.push({
        type: "keyed",
        key,
        value,
        append: elementAppend,
      });
    } else {
      const expandedValue = await expandWord(ctx, element);
      pendingElements.push({ type: "invalid", expandedValue });
    }
  }

  // Clear existing elements AFTER all expansion
  if (!append) {
    clearExistingElements();
  }

  // Second pass: Perform all assignments
  for (const pending of pendingElements) {
    if (pending.type === "keyed") {
      if (pending.append) {
        const existing = ctx.state.env.get(`${name}_${pending.key}`) ?? "";
        ctx.state.env.set(`${name}_${pending.key}`, existing + pending.value);
      } else {
        ctx.state.env.set(`${name}_${pending.key}`, pending.value);
      }
    } else {
      const lineNum = node.line ?? ctx.state.currentLine ?? 1;
      addXtraceOutput(
        `bash: line ${lineNum}: ${name}: ${pending.expandedValue}: must use subscript when assigning associative array\n`,
      );
    }
  }
}

/**
 * Process indexed array assignment with [index]=value syntax (sparse array)
 */
async function processIndexedArrayWithKeysAssignment(
  ctx: InterpreterContext,
  name: string,
  array: WordNode[],
  append: boolean,
  clearExistingElements: () => void,
): Promise<void> {
  interface PendingElement {
    type: "keyed";
    indexExpr: string;
    value: string;
    append: boolean;
  }
  interface PendingNonKeyed {
    type: "non-keyed";
    values: string[];
  }
  const pendingElements: (PendingElement | PendingNonKeyed)[] = [];

  // First pass: Expand all RHS values
  for (const element of array) {
    const parsed = parseKeyedElementFromWord(element);
    if (parsed) {
      const { key: indexExpr, valueParts, append: elementAppend } = parsed;
      let value: string;
      if (valueParts.length > 0) {
        const valueWord: WordNode = { type: "Word", parts: valueParts };
        value = await expandWord(ctx, valueWord);
      } else {
        value = "";
      }
      value = expandTildesInValue(ctx, value);
      pendingElements.push({
        type: "keyed",
        indexExpr,
        value,
        append: elementAppend,
      });
    } else {
      const expanded = await expandWordWithGlob(ctx, element);
      pendingElements.push({ type: "non-keyed", values: expanded.values });
    }
  }

  // Clear existing elements AFTER all RHS expansion
  if (!append) {
    clearExistingElements();
  }

  // Second pass: Evaluate all indices and perform assignments
  let currentIndex = 0;
  for (const pending of pendingElements) {
    if (pending.type === "keyed") {
      let index: number;
      try {
        const parser = new Parser();
        const arithAst = parseArithmeticExpression(parser, pending.indexExpr);
        index = await evaluateArithmetic(ctx, arithAst.expression, false);
      } catch {
        if (/^-?\d+$/.test(pending.indexExpr)) {
          index = Number.parseInt(pending.indexExpr, 10);
        } else {
          const varValue = ctx.state.env.get(pending.indexExpr);
          index = varValue ? Number.parseInt(varValue, 10) : 0;
          if (Number.isNaN(index)) index = 0;
        }
      }
      if (pending.append) {
        const existing = ctx.state.env.get(`${name}_${index}`) ?? "";
        ctx.state.env.set(`${name}_${index}`, existing + pending.value);
      } else {
        ctx.state.env.set(`${name}_${index}`, pending.value);
      }
      currentIndex = index + 1;
    } else {
      for (const val of pending.values) {
        ctx.state.env.set(`${name}_${currentIndex++}`, val);
      }
    }
  }
}

/**
 * Process simple array assignment without keyed elements
 */
async function processSimpleArrayAssignment(
  ctx: InterpreterContext,
  name: string,
  array: WordNode[],
  append: boolean,
  clearExistingElements: () => void,
): Promise<void> {
  const allElements: string[] = [];
  for (const element of array) {
    const expanded = await expandWordWithGlob(ctx, element);
    allElements.push(...expanded.values);
  }

  let startIndex = 0;
  if (append) {
    const elements = getArrayElements(ctx, name);
    if (elements.length > 0) {
      const maxIndex = Math.max(
        ...elements.map(([idx]) => (typeof idx === "number" ? idx : 0)),
      );
      startIndex = maxIndex + 1;
    } else {
      const scalarValue = ctx.state.env.get(name);
      if (scalarValue !== undefined) {
        ctx.state.env.set(`${name}_0`, scalarValue);
        ctx.state.env.delete(name);
        startIndex = 1;
      }
    }
  } else {
    clearExistingElements();
  }

  for (let i = 0; i < allElements.length; i++) {
    ctx.state.env.set(`${name}_${startIndex + i}`, allElements[i]);
  }
  if (!append) {
    ctx.state.env.set(`${name}__length`, String(allElements.length));
  }
}

/**
 * Process a subscript assignment: VAR[idx]=value
 */
async function processSubscriptAssignment(
  ctx: InterpreterContext,
  node: SimpleCommandNode,
  arrayName: string,
  subscriptExpr: string,
  value: string,
  append: boolean,
  tempAssignments: Map<string, string | undefined>,
): Promise<SingleAssignmentResult> {
  let resolvedArrayName = arrayName;

  // Check if arrayName is a nameref
  if (isNameref(ctx, arrayName)) {
    const resolved = resolveNameref(ctx, arrayName);
    if (resolved && resolved !== arrayName) {
      if (resolved.includes("[")) {
        return {
          continueToNext: false,
          xtraceOutput: "",
          error: result(
            "",
            `bash: \`${resolved}': not a valid identifier\n`,
            1,
          ),
        };
      }
      resolvedArrayName = resolved;
    }
  }

  // Check if array variable is readonly
  if (isReadonly(ctx, resolvedArrayName)) {
    if (node.name) {
      return { continueToNext: true, xtraceOutput: "" };
    }
    const readonlyError = checkReadonlyError(ctx, resolvedArrayName);
    if (readonlyError) {
      return { continueToNext: false, xtraceOutput: "", error: readonlyError };
    }
  }

  const isAssoc = ctx.state.associativeArrays?.has(resolvedArrayName);
  let envKey: string;

  if (isAssoc) {
    envKey = await computeAssocArrayEnvKey(
      ctx,
      resolvedArrayName,
      subscriptExpr,
    );
  } else {
    const indexResult = await computeIndexedArrayIndex(
      ctx,
      resolvedArrayName,
      subscriptExpr,
    );
    if (indexResult.error) {
      return {
        continueToNext: false,
        xtraceOutput: "",
        error: indexResult.error,
      };
    }
    envKey = `${resolvedArrayName}_${indexResult.index}`;
  }

  const finalValue = append ? (ctx.state.env.get(envKey) || "") + value : value;

  if (node.name) {
    tempAssignments.set(envKey, ctx.state.env.get(envKey));
    ctx.state.env.set(envKey, finalValue);
  } else {
    const localDepth = getLocalVarDepth(ctx, resolvedArrayName);
    if (
      localDepth !== undefined &&
      localDepth === ctx.state.callDepth &&
      ctx.state.localScopes.length > 0
    ) {
      const currentScope =
        ctx.state.localScopes[ctx.state.localScopes.length - 1];
      if (!currentScope.has(envKey)) {
        currentScope.set(envKey, ctx.state.env.get(envKey));
      }
    }
    ctx.state.env.set(envKey, finalValue);
  }

  return { continueToNext: true, xtraceOutput: "" };
}

/**
 * Compute the env key for an associative array subscript
 */
async function computeAssocArrayEnvKey(
  ctx: InterpreterContext,
  arrayName: string,
  subscriptExpr: string,
): Promise<string> {
  let key: string;
  if (subscriptExpr.startsWith("'") && subscriptExpr.endsWith("'")) {
    key = subscriptExpr.slice(1, -1);
  } else if (subscriptExpr.startsWith('"') && subscriptExpr.endsWith('"')) {
    const inner = subscriptExpr.slice(1, -1);
    const parser = new Parser();
    const wordNode = parser.parseWordFromString(inner, true, false);
    key = await expandWord(ctx, wordNode);
  } else if (subscriptExpr.includes("$")) {
    const parser = new Parser();
    const wordNode = parser.parseWordFromString(subscriptExpr, false, false);
    key = await expandWord(ctx, wordNode);
  } else {
    key = subscriptExpr;
  }
  return `${arrayName}_${key}`;
}

/**
 * Compute the index for an indexed array subscript
 */
async function computeIndexedArrayIndex(
  ctx: InterpreterContext,
  arrayName: string,
  subscriptExpr: string,
): Promise<{ index: number; error?: ExecResult }> {
  let evalExpr = subscriptExpr;
  if (
    subscriptExpr.startsWith('"') &&
    subscriptExpr.endsWith('"') &&
    subscriptExpr.length >= 2
  ) {
    evalExpr = subscriptExpr.slice(1, -1);
  }

  let index: number;
  if (/^-?\d+$/.test(evalExpr)) {
    index = Number.parseInt(evalExpr, 10);
  } else {
    try {
      const parser = new Parser();
      const arithAst = parseArithmeticExpression(parser, evalExpr);
      index = await evaluateArithmetic(ctx, arithAst.expression, false);
    } catch (e) {
      if (e instanceof ArithmeticError) {
        const lineNum = ctx.state.currentLine;
        const errorMsg = `bash: line ${lineNum}: ${subscriptExpr}: ${e.message}\n`;
        if (e.fatal) {
          throw new ExitError(1, "", errorMsg);
        }
        return { index: 0, error: result("", errorMsg, 1) };
      }
      const varValue = ctx.state.env.get(subscriptExpr);
      index = varValue ? Number.parseInt(varValue, 10) : 0;
    }
    if (Number.isNaN(index)) index = 0;
  }

  // Handle negative indices
  if (index < 0) {
    const elements = getArrayElements(ctx, arrayName);
    if (elements.length === 0) {
      const lineNum = ctx.state.currentLine;
      return {
        index: 0,
        error: result(
          "",
          `bash: line ${lineNum}: ${arrayName}[${subscriptExpr}]: bad array subscript\n`,
          1,
        ),
      };
    }
    const maxIndex = Math.max(
      ...elements.map(([idx]) => (typeof idx === "number" ? idx : 0)),
    );
    index = maxIndex + 1 + index;
    if (index < 0) {
      const lineNum = ctx.state.currentLine;
      return {
        index: 0,
        error: result(
          "",
          `bash: line ${lineNum}: ${arrayName}[${subscriptExpr}]: bad array subscript\n`,
          1,
        ),
      };
    }
  }

  return { index };
}

/**
 * Process a scalar assignment
 */
async function processScalarAssignment(
  ctx: InterpreterContext,
  node: SimpleCommandNode,
  name: string,
  value: string,
  append: boolean,
  tempAssignments: Map<string, string | undefined>,
): Promise<SingleAssignmentResult> {
  let xtraceOutput = "";

  // Resolve nameref
  let targetName = name;
  let namerefArrayRef: { arrayName: string; subscriptExpr: string } | null =
    null;

  if (isNameref(ctx, name)) {
    const resolved = resolveNamerefForAssignment(ctx, name, value);
    if (resolved === undefined) {
      return {
        continueToNext: false,
        xtraceOutput: "",
        error: result("", `bash: ${name}: circular name reference\n`, 1),
      };
    }
    if (resolved === null) {
      return { continueToNext: true, xtraceOutput: "" };
    }
    targetName = resolved;

    const arrayRefMatch = targetName.match(
      /^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/,
    );
    if (arrayRefMatch) {
      namerefArrayRef = {
        arrayName: arrayRefMatch[1],
        subscriptExpr: arrayRefMatch[2],
      };
      targetName = arrayRefMatch[1];
    }
  }

  // Check if variable is readonly
  if (isReadonly(ctx, targetName)) {
    if (node.name) {
      xtraceOutput += `bash: ${targetName}: readonly variable\n`;
      return { continueToNext: true, xtraceOutput };
    }
    const readonlyError = checkReadonlyError(ctx, targetName);
    if (readonlyError) {
      return { continueToNext: false, xtraceOutput: "", error: readonlyError };
    }
  }

  // Handle append mode and integer attribute
  let finalValue: string;
  if (isInteger(ctx, targetName)) {
    try {
      const parser = new Parser();
      if (append) {
        const currentVal = ctx.state.env.get(targetName) || "0";
        const expr = `(${currentVal}) + (${value})`;
        const arithAst = parseArithmeticExpression(parser, expr);
        finalValue = String(await evaluateArithmetic(ctx, arithAst.expression));
      } else {
        const arithAst = parseArithmeticExpression(parser, value);
        finalValue = String(await evaluateArithmetic(ctx, arithAst.expression));
      }
    } catch {
      finalValue = "0";
    }
  } else {
    const { isArray } = await import("./expansion.js");
    const appendKey = isArray(ctx, targetName) ? `${targetName}_0` : targetName;
    finalValue = append ? (ctx.state.env.get(appendKey) || "") + value : value;
  }

  finalValue = applyCaseTransform(ctx, targetName, finalValue);

  xtraceOutput += await traceAssignment(ctx, targetName, finalValue);

  // Compute actual env key
  let actualEnvKey = targetName;
  if (namerefArrayRef) {
    actualEnvKey = await computeNamerefArrayEnvKey(ctx, namerefArrayRef);
  } else {
    const { isArray } = await import("./expansion.js");
    if (isArray(ctx, targetName)) {
      actualEnvKey = `${targetName}_0`;
    }
  }

  if (node.name) {
    tempAssignments.set(actualEnvKey, ctx.state.env.get(actualEnvKey));
    ctx.state.env.set(actualEnvKey, finalValue);
  } else {
    ctx.state.env.set(actualEnvKey, finalValue);
    if (ctx.state.options.allexport) {
      ctx.state.exportedVars = ctx.state.exportedVars || new Set();
      ctx.state.exportedVars.add(targetName);
      ctx.state.exportedEnvDirty = true;
    }
    if (ctx.state.tempEnvBindings?.some((b) => b.has(targetName))) {
      ctx.state.mutatedTempEnvVars = ctx.state.mutatedTempEnvVars || new Set();
      ctx.state.mutatedTempEnvVars.add(targetName);
    }
  }

  return { continueToNext: false, xtraceOutput };
}

/**
 * Compute the env key for a nameref pointing to an array element
 */
async function computeNamerefArrayEnvKey(
  ctx: InterpreterContext,
  namerefArrayRef: { arrayName: string; subscriptExpr: string },
): Promise<string> {
  const { arrayName, subscriptExpr } = namerefArrayRef;
  const isAssoc = ctx.state.associativeArrays?.has(arrayName);

  if (isAssoc) {
    return computeAssocArrayEnvKey(ctx, arrayName, subscriptExpr);
  }

  let index: number;
  if (/^-?\d+$/.test(subscriptExpr)) {
    index = Number.parseInt(subscriptExpr, 10);
  } else {
    try {
      const parser = new Parser();
      const arithAst = parseArithmeticExpression(parser, subscriptExpr);
      index = await evaluateArithmetic(ctx, arithAst.expression, false);
    } catch {
      const varValue = ctx.state.env.get(subscriptExpr);
      index = varValue ? Number.parseInt(varValue, 10) : 0;
    }
    if (Number.isNaN(index)) index = 0;
  }

  if (index < 0) {
    const elements = getArrayElements(ctx, arrayName);
    if (elements.length > 0) {
      const maxIdx = Math.max(...elements.map((e) => e[0] as number));
      index = maxIdx + 1 + index;
    }
  }

  return `${arrayName}_${index}`;
}
