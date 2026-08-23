/**
 * Temp-env frame helpers shared by the attribute builtins.
 *
 * Lives here rather than next to `pushTempEnvFrame`/`popTempEnvFrame` in
 * `simple-command-assignments.ts` purely to avoid an import cycle: that module
 * already imports `helpers/readonly.js`, which is the main caller of this one.
 * This module deliberately depends on nothing but the context type.
 */

import type { InterpreterContext } from "../types.js";

/**
 * Cancel the temp-env restore for `name`, because the command has PROMOTED the
 * temporary binding to a permanent one.
 *
 * bash keeps a prefix assignment when the command marks the name `export` or
 * `readonly`:
 *
 *     X=g; f() { export X=new; }; X=t f;  echo "$X"   # -> new
 *     V=g; fb() { export V; };   V=t fb;  echo "$V"   # -> t
 *
 * Without this, `popTempEnvFrame()` writes the shadowed value straight back over
 * the promoted one, so an explicit `export X=new` is silently discarded.
 *
 * This reuses the mechanism `handleTempEnvUnset()` already relies on: the frame
 * Map is shared by reference, so DELETING an entry is what cancels its restore.
 * Promotion is the same shape of operation as a revealing unset, which is why it
 * gets the same treatment rather than a parallel "was promoted" flag that the
 * unwind would have to consult.
 *
 * EVERY frame is cleared, not just the innermost. With nested frames both would
 * otherwise restore in turn and the outer one would clobber the promotion:
 *
 *     H=g; i() { export H; }; o() { H=t2 i; }; H=t1 o;  echo "$H"   # -> t2
 *
 * The attribute is now permanent, so no frame at any depth should restore over
 * it.
 *
 * @returns true if any frame was carrying a binding for `name`.
 */
export function promoteTempEnvBinding(
  ctx: InterpreterContext,
  name: string,
): boolean {
  const frames = ctx.state.tempEnvBindings;
  if (!frames || frames.length === 0) {
    return false;
  }

  let promoted = false;
  for (const frame of frames) {
    if (frame.delete(name)) {
      promoted = true;
    }
  }
  return promoted;
}
