import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

/**
 * `$_` — the last-argument special parameter.
 *
 * bash(1): "At shell startup, set to the pathname used to invoke the shell...
 * Subsequently, expands to the last argument to the previous simple command
 * executed in the foreground, after expansion."
 *
 * Every expectation below was captured from real bash (3.2.57, arm64-darwin)
 * or from the Oils spec cases in `src/spec-tests/bash/cases/vars-special.test.sh`,
 * which are the authoritative specification for the cases on the ratchet baseline.
 */
describe("$_ (last-argument special parameter)", () => {
  it("is the last argument of the previous simple command, after expansion", async () => {
    const env = new Bash();
    const result = await env.exec(`name=world
echo "hi $name"
echo "$_"`);
    expect(result.stdout).toBe("hi world\nhi world\n");
    expect(result.exitCode).toBe(0);
  });

  it("is the command name itself when the command has no arguments", async () => {
    const env = new Bash();
    // Real bash: `echo hi; echo; echo "[$_]"` -> "hi\n\n[echo]"
    const result = await env.exec(`echo hi
echo
echo "[$_]"`);
    expect(result.stdout).toBe("hi\n\n[echo]\n");
  });

  it("is the command name for a no-arg builtin", async () => {
    const env = new Bash();
    const result = await env.exec(`true
echo "[$_]"`);
    expect(result.stdout).toBe("[true]\n");
  });

  it("uses the last field after word splitting, not the unsplit word", async () => {
    const env = new Bash();
    const result = await env.exec(`x='with spaces'
: $x
echo $_`);
    expect(result.stdout).toBe("spaces\n");
  });

  it("uses the concatenated word after quote removal", async () => {
    const env = new Bash();
    const result = await env.exec(`: 'foo'"bar"
echo "[$_]"`);
    expect(result.stdout).toBe("[foobar]\n");
  });

  it("distinguishes $_ from $_var and supports ${_}", async () => {
    const env = new Bash();
    const result = await env.exec(`_var=value

: 42
echo $_ $_var \${_}var`);
    expect(result.stdout).toBe("42 value 42var\n");
  });

  it("is cleared by a bare scalar assignment", async () => {
    const env = new Bash();
    const result = await env.exec(`: foo
echo "colon [$_]"
s=bar
echo "bare assign [$_]"`);
    expect(result.stdout).toBe("colon [foo]\nbare assign []\n");
  });

  it("is cleared by a bare array assignment", async () => {
    const env = new Bash();
    // The `before` line is load-bearing: without it this case would pass
    // vacuously against an implementation where $_ is ALWAYS empty.
    const result = await env.exec(`: foo
echo "before [$_]"
a=(1 2)
echo "array [$_]"`);
    expect(result.stdout).toBe("before [foo]\narray []\n");
  });

  it("is the whole word for a scalar assignment argument to declare", async () => {
    const env = new Bash();
    const result = await env.exec(`declare s=bar
echo "declare [$_]"`);
    expect(result.stdout).toBe("declare [s=bar]\n");
  });

  it("is the bare LHS name for a compound array assignment to declare", async () => {
    const env = new Bash();
    // Real bash quirk: `declare a=(1 2)` sets $_ to "a", not "a=(1 2)".
    const result = await env.exec(`declare a=(1 2)
echo "declare array [$_]"`);
    expect(result.stdout).toBe("declare array [a]\n");
  });

  it("is the bare LHS name for a compound array assignment with a flag", async () => {
    const env = new Bash();
    const result = await env.exec(`declare -g d=(1 2)
echo "declare flag [$_]"`);
    expect(result.stdout).toBe("declare flag [d]\n");
  });

  it("is NOT reset by (( )) or [[ ]]", async () => {
    const env = new Bash();
    const result = await env.exec(`echo simple
(( a = 2 + 3 ))
echo "(( $_"

[[ a == *.py ]]
echo "[[ $_"`);
    expect(result.stdout).toBe("simple\n(( simple\n[[ (( simple\n");
  });

  it("carries across && and short-circuited ||", async () => {
    const env = new Bash();
    const result = await env.exec(`echo hi && echo last=$_
echo and=$_

echo hi || echo last=$_
echo or=$_`);
    expect(result.stdout).toBe("hi\nlast=hi\nand=last=hi\nhi\nor=hi\n");
  });

  it("is not set by a for loop's word list and carries into the body", async () => {
    const env = new Bash();
    const result = await env.exec(`echo init
echo begin=$_
for x in 1 2 3; do
  echo prev=$_
done`);
    expect(result.stdout).toBe(
      [
        "init",
        "begin=init",
        "prev=begin=init",
        "prev=prev=begin=init",
        "prev=prev=prev=begin=init",
        "",
      ].join("\n"),
    );
  });

  it("is reset per pipeline component, and with lastpipe the last one sticks", async () => {
    const env = new Bash();
    const result = await env.exec(`shopt -s lastpipe

seq 3 | echo last=$_

echo pipeline=$_

( echo subshell=$_ )
echo done=$_`);
    expect(result.stdout).toBe(
      [
        "last=",
        "pipeline=last=",
        "subshell=pipeline=last=",
        "done=pipeline=last=",
        "",
      ].join("\n"),
    );
  });

  it("is not modified in the parent by a subshell", async () => {
    const env = new Bash();
    const result = await env.exec(`echo AA
( echo "sub=[$_]" )
echo "done=[$_]"`);
    expect(result.stdout).toBe("AA\nsub=[AA]\ndone=[AA]\n");
  });

  it("is bound after the command runs, so a function call's last arg wins", async () => {
    const env = new Bash();
    // Real bash: the inner `echo inner` binds $_ during the body, but the
    // outer `f aa bb` binds its own lastarg afterwards -> "bb".
    const result = await env.exec(`f() { echo inner; }
f aa bb
echo "[$_]"`);
    expect(result.stdout).toBe("inner\n[bb]\n");
  });

  it("is set even when the command fails", async () => {
    const env = new Bash();
    const result = await env.exec(`command-that-does-not-exist zzz 2>/dev/null
echo "[$_]"`);
    expect(result.stdout).toBe("[zzz]\n");
  });
});
