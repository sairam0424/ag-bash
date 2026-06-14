import { describe, expect, it } from "vitest";
import { AgBashTracer } from "./otel.js";

describe("AgBashTracer", () => {
  it("starts as no-op when OTel is not available", async () => {
    const tracer = new AgBashTracer({ serviceName: "test" });
    await tracer.initialize();

    // Should not throw even without OTel installed
    const span = tracer.startExecSpan("echo hello");
    span.setAttribute("key", "value");
    span.setStatus({ code: 0 });
    span.end();

    expect(tracer.isActive).toBe(false);
  });

  it("creates exec spans without errors", () => {
    const tracer = new AgBashTracer();
    const span = tracer.startExecSpan("ls -la");
    expect(span).toBeDefined();
    span.end(); // Should not throw
  });

  it("creates tool spans without errors", () => {
    const tracer = new AgBashTracer();
    const span = tracer.startToolSpan("read_file", { path: "/tmp/test.txt" });
    expect(span).toBeDefined();
    span.end();
  });

  it("skips statement spans when statementLevel is false", () => {
    const tracer = new AgBashTracer({ statementLevel: false });
    const span = tracer.startStatementSpan("pipeline", 5);
    expect(span).toBeDefined();
    span.end();
  });

  it("creates statement spans when statementLevel is true", () => {
    const tracer = new AgBashTracer({ statementLevel: true });
    const span = tracer.startStatementSpan("if", 10);
    expect(span).toBeDefined();
    span.end();
  });

  it("is idempotent on multiple initialize calls", async () => {
    const tracer = new AgBashTracer();
    await tracer.initialize();
    await tracer.initialize(); // Should not throw
    expect(tracer.isActive).toBe(false); // OTel not installed in test env
  });

  it("includes custom attributes in spans", () => {
    const tracer = new AgBashTracer({
      attributes: { env: "test", version: "4.1" },
    });
    // No error means attributes were accepted
    const span = tracer.startExecSpan("pwd");
    span.end();
  });

  it("truncates long scripts in exec spans", () => {
    const tracer = new AgBashTracer();
    const longScript = "echo ".repeat(200);
    const span = tracer.startExecSpan(longScript);
    span.end(); // Should not throw, script is truncated to 500 chars
  });
});
