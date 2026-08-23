import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

/**
 * Out-of-bounds NEGATIVE array subscripts must be diagnosed, not silent.
 *
 * bash resolves `a[-n]` to `a[maxIndex + 1 - n]`, where maxIndex is the highest
 * SET index (so it counts back from the last element, not from the element
 * count — that distinction matters for sparse arrays). When the resolved index
 * lands below 0 the subscript is invalid, and bash writes
 *
 *   bash: line <N>: <name>: bad array subscript
 *
 * to the SHELL's stderr while still yielding the empty string (or 0 in an
 * arithmetic context) and status 0.
 *
 * Oracles: `src/spec-tests/bash/cases/array.test.sh` and
 * `src/spec-tests/bash/cases/array-sparse.test.sh` (`## OK bash STDERR:`
 * variants). Local bash here is 3.2, which predates negative subscripts
 * entirely, so the spec fixtures — recorded against bash 4/5 — are the oracle.
 */
describe("out-of-bounds negative array subscript", () => {
  it("diagnoses ${a[-2]} on a one-element array", async () => {
    const env = new Bash();
    const result = await env.exec(`a=(x)
echo "[\${a[-2]}]"`);
    expect(result.stdout).toBe("[]\n");
    expect(result.stderr).toBe("bash: line 2: a: bad array subscript\n");
    expect(result.exitCode).toBe(0);
  });

  it("diagnoses $((a[-2])) on a one-element array", async () => {
    const env = new Bash();
    const result = await env.exec(`a=(x)
echo "[$((a[-2]))]"`);
    expect(result.stdout).toBe("[0]\n");
    expect(result.stderr).toBe("bash: line 2: a: bad array subscript\n");
    expect(result.exitCode).toBe(0);
  });

  it("reports the line number of the offending command", async () => {
    const env = new Bash();
    const result = await env.exec(`a=(x)
echo one
echo two
echo "[\${a[-5]}]"`);
    expect(result.stdout).toBe("one\ntwo\n[]\n");
    expect(result.stderr).toBe("bash: line 4: a: bad array subscript\n");
  });

  it("diagnoses a negative subscript on an empty array", async () => {
    const env = new Bash();
    const result = await env.exec(`a=()
echo "[\${a[-1]}]"`);
    expect(result.stdout).toBe("[]\n");
    expect(result.stderr).toBe("bash: line 2: a: bad array subscript\n");
  });

  it("counts back from the highest SET index in a sparse array", async () => {
    const env = new Bash();
    // sp holds indices 0,1,4,5,6,8 -> maxIndex 8, so sp[-9] is sp[0] and
    // sp[-10] resolves to -1, which is out of bounds.
    const result = await env.exec(`sp=({1..9})
unset -v 'sp[2]'
unset -v 'sp[3]'
unset -v 'sp[7]'
echo "sp[-9]: '\${sp[-9]}'."
echo "sp[-10]: '\${sp[-10]}'."`);
    expect(result.stdout).toBe("sp[-9]: '1'.\nsp[-10]: ''.\n");
    expect(result.stderr).toBe("bash: line 6: sp: bad array subscript\n");
  });

  it("diagnoses every out-of-bounds subscript in a sparse array", async () => {
    const env = new Bash();
    const result = await env.exec(`sp=({1..9})
unset -v 'sp[2]'
unset -v 'sp[3]'
unset -v 'sp[7]'
echo "sp[-10]: '\${sp[-10]}'."
echo "sp[-11]: '\${sp[-11]}'."
echo "sp[-19]: '\${sp[-19]}'."`);
    expect(result.stdout).toBe("sp[-10]: ''.\nsp[-11]: ''.\nsp[-19]: ''.\n");
    expect(result.stderr).toBe(
      "bash: line 5: sp: bad array subscript\n" +
        "bash: line 6: sp: bad array subscript\n" +
        "bash: line 7: sp: bad array subscript\n",
    );
  });

  it("diagnoses an out-of-bounds subscript in arithmetic on a sparse array", async () => {
    const env = new Bash();
    const result = await env.exec(`a=({1..9})
unset -v 'a[2]' 'a[3]' 'a[7]'
echo $((a[-10]))
echo st=$?`);
    expect(result.stdout).toBe("0\nst=0\n");
    expect(result.stderr).toBe("bash: line 3: a: bad array subscript\n");
  });

  it("stays silent for an in-bounds negative subscript", async () => {
    const env = new Bash();
    const result = await env.exec(`a=(p q r)
echo "\${a[-1]} \${a[-3]} $((a[-1] + 0))"`);
    expect(result.stdout).toBe("r p 0\n");
    expect(result.stderr).toBe("");
  });

  it("keeps the diagnostic on the shell's stderr, not in a redirected file", async () => {
    const env = new Bash();
    const result = await env.exec(`a=(x)
echo "[\${a[-2]}]" > /tmp/neg-idx-out
echo "file=[$(cat /tmp/neg-idx-out)]"`);
    expect(result.stdout).toBe("file=[[]]\n");
    expect(result.stderr).toBe("bash: line 2: a: bad array subscript\n");
  });
});
