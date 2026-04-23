import { describe, expect, it } from "vitest";
import { parse } from "../parser/parser.js";
import { SemanticEngine, SymbolType } from "./semantic-engine.js";

describe("SemanticEngine (Phase 6)", () => {
  it("should track symbol occurrences (definitions and references)", () => {
    const code = `
      MY_VAR="hello"
      func() {
        echo $MY_VAR
      }
      func
    `;
    const ast = parse(code);
    const engine = new SemanticEngine(ast);

    const varOccurrences = engine.getOccurrences("MY_VAR");
    expect(varOccurrences).toHaveLength(2);
    expect(varOccurrences.find((o) => o.isDefinition)).toBeDefined();
    expect(varOccurrences.find((o) => !o.isDefinition)).toBeDefined();

    const funcOccurrences = engine.getOccurrences("func");
    expect(funcOccurrences).toHaveLength(2);
    expect(funcOccurrences.find((o) => o.isDefinition)).toBeDefined();
    expect(funcOccurrences.find((o) => !o.isDefinition)).toBeDefined();
  });

  it("should find definitions across scopes", () => {
    const code = `
      VAR="global"
      func() {
        VAR="local"
        echo $VAR
      }
    `;
    const ast = parse(code);
    const engine = new SemanticEngine(ast);

    const globalDef = engine.findDefinition("VAR", "global");
    expect(globalDef?.line).toBe(2);

    const localDef = engine.findDefinition("VAR", "func");
    expect(localDef?.line).toBe(4);
  });
});
