/**
 * Quote an argument so it is interpreted as a single literal shell word.
 */
function shellQuoteArg(arg) {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
/**
 * Join argv-style tokens into a shell-safe command string.
 */
export function shellJoinArgs(args) {
  return args.map(shellQuoteArg).join(" ");
}
