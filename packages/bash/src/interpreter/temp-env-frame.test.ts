import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

/**
 * `VAR=x cmd` creates a TEMPORARY binding — a "temp frame" pushed onto the
 * variable-scope stack for exactly the duration of `cmd`. It is distinct from
 * both the global environment and a function's `local` scope.
 *
 * Every expectation below is copied from an Oils spec fixture under
 * `src/spec-tests/bash/cases/`, using the variant the harness accepts for bash
 * (the default `## STDOUT:` block, or a `## BUG bash` / `## OK bash` block).
 * The case names are quoted so the source of each rule stays traceable.
 *
 * The four interacting behaviours:
 *   (a) the binding must NOT persist after the command — except for POSIX
 *       special builtins in `set -o posix` mode;
 *   (b) frames STACK: several at once, and across nested function contexts;
 *   (c) `unset` of a temp-bound name REVEALS the shadowed value rather than
 *       deleting it;
 *   (d) `local v` with no value INHERITS a temp binding;
 *   (e) marking the name `export` or `readonly` PROMOTES the temp binding to a
 *       permanent one instead of discarding it.
 *
 * (e) was missing from the first version of this file, and its absence let a
 * regression ship in which an explicit `export X=new` inside a temp frame was
 * silently thrown away by the frame unwind. Every gate passed — unit, the
 * 530/530 bash-comparison canary, and the Oils ratchet with zero new failures —
 * because nothing anywhere invoked `export` or `readonly` on a temp-bound name.
 * The expectations in (e) are taken from `/bin/bash` 3.2.57 directly rather than
 * from a spec fixture, since no Oils case covers it either.
 */
describe("temp-env frame: (a) prefix assignments do not persist", () => {
  it("drops the binding after a builtin command", async () => {
    // assign.test.sh :: "Env value doesn't persist"
    const bash = new Bash();
    const result = await bash.exec(`FOO=foo echo "[$FOO]"
echo -$FOO-`);
    expect(result.stdout).toBe("[foo]\n--\n");
  });

  it("drops the binding after `true`, and after `true` is redefined", async () => {
    // builtin-special.test.sh :: "true is not special; prefix assignments
    // don't persist, it can be redefined"  ->  "foo=\ntrue func\nfoo="
    const bash = new Bash();
    const result = await bash.exec(`foo=bar true
echo foo=$foo

true() {
  echo true func
}
foo=bar true
echo foo=$foo`);
    expect(result.stdout).toBe("foo=\ntrue func\nfoo=\n");
  });

  it("drops the binding after `eval`", async () => {
    // strict-options.test.sh :: "shopt -s strict_binding: Persistent prefix
    // bindings not allowed on special builtins"  ->  BUG bash "FOO=bar\nFOO="
    const bash = new Bash();
    const result = await bash.exec(`FOO=bar eval 'echo FOO=$FOO'
echo FOO=$FOO`);
    expect(result.stdout).toBe("FOO=bar\nFOO=\n");
  });

  it("restores the previous value rather than deleting the name", async () => {
    const bash = new Bash();
    const result = await bash.exec(`FOO=outer
FOO=inner echo "[$FOO]"
echo -$FOO-`);
    expect(result.stdout).toBe("[inner]\n-outer-\n");
  });

  it("keeps the binding for a POSIX special builtin under `set -o posix`", async () => {
    // builtin-special.test.sh :: "Prefix assignments persist after special
    // builtins, like : (set -o posix)"  ->  "foo=bar\nz="
    const bash = new Bash();
    const result = await bash.exec(`set -o posix
foo=bar :
echo foo=$foo
z=Z builtin :
echo z=$Z`);
    expect(result.stdout).toBe("foo=bar\nz=\n");
  });
});

describe("temp-env frame: (b) frames stack", () => {
  it("pops each nested frame when its own command returns", async () => {
    // assign.test.sh :: "Multiple temporary envs on the stack" — same shape as
    // the fixture (F=f f -> G1/G2 g -> P=p cmd), asserted through the shell
    // instead of printenv.py so the test needs no spec helper.
    const bash = new Bash();
    const result = await bash.exec(`g() {
  echo "g: F=$F G1=$G1 G2=$G2 P=$P"
  P=p echo "g+P: F=$F G1=$G1 G2=$G2 P=$P"
  echo "g after P: P=$P"
}
f() {
  G1=[g1] G2=[g2] g
  echo "f: F=$F G1=$G1 G2=$G2 P=$P"
}
F=f f
echo "top: F=$F G1=$G1 G2=$G2 P=$P"`);
    expect(result.stdout).toBe(
      [
        "g: F=f G1=[g1] G2=[g2] P=",
        "g+P: F=f G1=[g1] G2=[g2] P=p",
        "g after P: P=",
        "f: F=f G1= G2= P=",
        "top: F= G1= G2= P=",
        "",
      ].join("\n"),
    );
  });

  it("removes a temp-only name from the environment after the command", async () => {
    // The name had no prior value, so unwinding the frame must DELETE it, not
    // leave an empty cell behind. `env` here reports the shell's variables.
    const bash = new Bash();
    const result = await bash.exec(`show() { env | grep '^FOO=' || echo no; }
FOO=bar show
show`);
    expect(result.stdout).toBe("FOO=bar\nno\n");
  });

  it("leaves a permanently exported name exported after a temp shadow", async () => {
    // Unwinding the frame clears the name from the TEMP export set only; the
    // `export` attribute lives in a different set and must survive.
    const bash = new Bash();
    const result = await bash.exec(`export FOO=perm
FOO=temp printenv FOO
printenv FOO
echo after=$FOO`);
    expect(result.stdout).toBe("temp\nperm\nafter=perm\n");
  });
});

describe("temp-env frame: (c) unset reveals the shadowed value", () => {
  it("reveals the global when unsetting a temp binding in a function", async () => {
    // assign.test.sh :: "Test above without 'local' (which is not POSIX)"
    //   x=temp-binding / x=mutated-temp / x=global / x=global
    const bash = new Bash();
    const result = await bash.exec(`f() {
  echo "x=$x"
  x=mutated-temp
  echo "x=$x"
  unset x
  echo "x=$x"
}
x=global
x=temp-binding f
echo "x=$x"`);
    expect(result.stdout).toBe(
      "x=temp-binding\nx=mutated-temp\nx=global\nx=global\n",
    );
  });

  it("reveals the global for both local-unset and dynamic-unset of a tempenv", async () => {
    // ble-features.test.sh :: "[bash_unset] local-unset / dynamic-unset for
    // tempenv"  ->  both lines "v: global"
    const bash = new Bash();
    const result = await bash.exec(`unlocal() { unset -v "$1"; }

f1() {
  unset v
  echo "[$1,(unset)] v: \${v-(unset)}"
}
v=global
v=tempenv f1 'global,tempenv'

f1() {
  unlocal v
  echo "[$1,(unlocal)] v: \${v-(unset)}"
}
v=global
v=tempenv f1 'global,tempenv'`);
    expect(result.stdout).toBe(
      "[global,tempenv,(unset)] v: global\n[global,tempenv,(unlocal)] v: global\n",
    );
  });

  it("leaves an unrelated temp binding alone while unsetting a global", async () => {
    // temp-binding.test.sh :: "Temp bindings with unset" (first two blocks)
    const bash = new Bash();
    const result = await bash.exec(`x=42
unset x
echo x=$x
echo ---
x=42
tmp= unset x
echo x=$x
x=42
tmp= eval 'unset x'
echo x=$x`);
    expect(result.stdout).toBe("x=\n---\nx=\nx=\n");
  });

  it("reveals the shadowed global when the temp binding IS the unset name", async () => {
    // temp-binding.test.sh :: "Temp bindings with unset" (shadow() block)
    const bash = new Bash();
    const result = await bash.exec(`shadow() {
  x=42
  x=tmp unset x
  echo x=$x

  x=42
  x=tmp eval 'unset x'
  echo x=$x
}
shadow`);
    expect(result.stdout).toBe("x=42\nx=42\n");
  });
});

describe("temp-env frame: (d) local inherits a temp binding", () => {
  it("inherits the tempenv value for a bare `local v`", async () => {
    // ble-features.test.sh :: "[bash_unset] localvar-inherit from tempenv"
    const bash = new Bash();
    const result = await bash.exec(`f1() {
  local v
  echo "[$1,(local)] v: \${v-(unset)}"
}
f2() {
  f1 "$1,(func)"
}
v=global

f1 'global'
v=tempenv f1 'global,tempenv'
f2 'global'
v=tempenv f2 'global,tempenv'`);
    expect(result.stdout).toBe(
      [
        "[global,(local)] v: (unset)",
        "[global,tempenv,(local)] v: tempenv",
        "[global,(func),(local)] v: (unset)",
        "[global,tempenv,(func),(local)] v: tempenv",
        "",
      ].join("\n"),
    );
  });

  it("value-unsets a local that shadows an untouched tempenv", async () => {
    // ble-features.test.sh :: "[bash_unset] local-unset / dynamic-unset for
    // localvar (mutated from tempenv)"
    //   local-unset   -> (unset)
    //   dynamic-unset -> global
    const bash = new Bash();
    const result = await bash.exec(`unlocal() { unset -v "$1"; }

f1() {
  local v=local
  unset v
  echo "[$1,local,(unset)] v: \${v-(unset)}"
}
v=global
v=tempenv f1 'global,tempenv'

f1() {
  local v=local
  unlocal v
  echo "[$1,local,(unlocal)] v: \${v-(unset)}"
}
v=global
v=tempenv f1 'global,tempenv'`);
    expect(result.stdout).toBe(
      "[global,tempenv,local,(unset)] v: (unset)\n[global,tempenv,local,(unlocal)] v: global\n",
    );
  });
});

describe("temp-env frame: (e) export/readonly promotes the binding", () => {
  it("keeps the value when the command exports the name with a new value", async () => {
    // /bin/bash 3.2.57: X=[new]. The most severe form — an EXPLICIT assignment
    // is what the unwind used to discard.
    const bash = new Bash();
    const result = await bash.exec(`X=g
f() { export X=new; }
X=t f
echo "X=[$X]"`);
    expect(result.stdout).toBe("X=[new]\n");
  });

  it("promotes on a bare `export` of a name that was ALREADY exported", async () => {
    // /bin/bash 3.2.57: V=[t]. Pins that promotion is NOT conditional on the
    // export attribute changing — gating it on "wasExported" would fail here.
    const bash = new Bash();
    const result = await bash.exec(`V=g
export V
fa() { export V; }
V=t fa
echo "V=[$V]"`);
    expect(result.stdout).toBe("V=[t]\n");
  });

  it("promotes on a bare `export` of a name that was not exported", async () => {
    // /bin/bash 3.2.57: W=[t]
    const bash = new Bash();
    const result = await bash.exec(`W=g
fb() { export W; }
W=t fb
echo "W=[$W]"`);
    expect(result.stdout).toBe("W=[t]\n");
  });

  it("promotes when `export` IS the prefixed command", async () => {
    // /bin/bash 3.2.57: D=[t]
    const bash = new Bash();
    const result = await bash.exec(`D=g
D=t export D
echo "D=[$D]"`);
    expect(result.stdout).toBe("D=[t]\n");
  });

  it("promotes on `readonly`, not just `export`", async () => {
    // /bin/bash 3.2.57: R=[t]
    const bash = new Bash();
    const result = await bash.exec(`R=g
fr() { readonly R; }
R=t fr
echo "R=[$R]"`);
    expect(result.stdout).toBe("R=[t]\n");
  });

  it("survives the unwind of EVERY enclosing frame, not just the innermost", async () => {
    // /bin/bash 3.2.57: H=[t2]. Two frames bind H (t1 outer, t2 inner). Clearing
    // only the innermost would let the OUTER unwind restore `g` over the
    // promoted `t2`, so this pins that promotion clears all depths.
    const bash = new Bash();
    const result = await bash.exec(`H=g
i() { export H; }
o() { H=t2 i; }
H=t1 o
echo "H=[$H]"`);
    expect(result.stdout).toBe("H=[t2]\n");
  });

  it("still reverts when the command assigns WITHOUT exporting", async () => {
    // /bin/bash 3.2.57: Z=[g]. The anti-over-fix guard: a plain assignment is
    // NOT a promotion, so `mutatedTempEnvVars` would be the wrong
    // discriminator. The export/readonly attribute is.
    const bash = new Bash();
    const result = await bash.exec(`Z=g
fz() { Z=plain; }
Z=t fz
echo "Z=[$Z]"`);
    expect(result.stdout).toBe("Z=[g]\n");
  });

  it("still reverts when the command touches nothing", async () => {
    // /bin/bash 3.2.57: Q=[g]
    const bash = new Bash();
    const result = await bash.exec(`Q=g
fq() { :; }
Q=t fq
echo "Q=[$Q]"`);
    expect(result.stdout).toBe("Q=[g]\n");
  });
});
