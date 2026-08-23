/**
 * Exec-level OTel span wiring (U103).
 *
 * `@opentelemetry/api` is an optional peer that is NOT installed in this repo
 * (see knip.json ignoreDependencies), so `AgBashTracer` is permanently a no-op
 * here and a real span can never be observed. To test the wiring we mock the
 * module so the dynamic `import("@opentelemetry/api")` inside
 * `AgBashTracer.initialize()` resolves to a recording tracer, then reload the
 * `Bash` module graph. The final test deliberately runs UNMOCKED to assert the
 * zero-overhead no-op fallback is preserved.
 */
import { describe, expect, it, vi } from "vitest";
import type { OtelSpan, OtelTracer } from "./otel-types.js";

type BashCtor = typeof import("../Bash.js")["Bash"];

interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  statuses: Array<{ code: number; message?: string }>;
  exceptions: unknown[];
  ended: boolean;
}

function createRecordingTracer(): {
  spans: RecordedSpan[];
  tracer: OtelTracer;
} {
  const spans: RecordedSpan[] = [];
  const tracer: OtelTracer = {
    startSpan(name, options): OtelSpan {
      const attributes: Record<string, string | number | boolean> =
        Object.create(null);
      for (const [key, value] of Object.entries(options?.attributes ?? {})) {
        attributes[key] = value;
      }
      const recorded: RecordedSpan = {
        name,
        attributes,
        statuses: [],
        exceptions: [],
        ended: false,
      };
      spans.push(recorded);
      return {
        setAttribute(key, value): void {
          recorded.attributes[key] = value;
        },
        setStatus(status): void {
          recorded.statuses.push(status);
        },
        recordException(error): void {
          recorded.exceptions.push(error);
        },
        end(): void {
          recorded.ended = true;
        },
      };
    },
  };
  return { spans, tracer };
}

/** Reload Bash with a mocked (present) @opentelemetry/api. */
async function loadBashWithOtel(tracer: OtelTracer): Promise<BashCtor> {
  vi.resetModules();
  vi.doMock("@opentelemetry/api", () => ({
    trace: { getTracer: () => tracer },
  }));
  const mod = await import("../Bash.js");
  return mod.Bash;
}

/** Reload Bash with @opentelemetry/api genuinely absent (no mock). */
async function loadBashWithoutOtel(): Promise<BashCtor> {
  vi.resetModules();
  vi.doUnmock("@opentelemetry/api");
  const mod = await import("../Bash.js");
  return mod.Bash;
}

describe("Bash.exec() OTel exec span", () => {
  it("emits one exec span with exit code and duration for a default exec", async () => {
    const { spans, tracer } = createRecordingTracer();
    const Bash = await loadBashWithOtel(tracer);
    const bash = new Bash({ otel: { serviceName: "exec-span-test" } });

    const result = await bash.exec("echo hello");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span?.name).toBe("ag-bash.exec");
    expect(span?.attributes["ag-bash.script"]).toBe("echo hello");
    expect(span?.attributes["ag-bash.exitCode"]).toBe(0);
    expect(typeof span?.attributes["ag-bash.durationMs"]).toBe("number");
    expect(span?.ended).toBe(true);
    expect(span?.exceptions).toHaveLength(0);
  });

  it("emits an exec span for the legacy execMode:'monolith' alias", async () => {
    const { spans, tracer } = createRecordingTracer();
    const Bash = await loadBashWithOtel(tracer);
    const bash = new Bash({ otel: { serviceName: "exec-span-test" } });

    // v6.0.0 removed the monolith engine: "monolith" transparently falls
    // through to the ExecutionPipeline, so it must not gate tracing.
    const result = await bash.exec("echo hi", { execMode: "monolith" });

    expect(result.exitCode).toBe(0);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes["ag-bash.exitCode"]).toBe(0);
    expect(spans[0]?.ended).toBe(true);
  });

  it("records the exception and an error status when exec throws", async () => {
    const { spans, tracer } = createRecordingTracer();
    const Bash = await loadBashWithOtel(tracer);
    const bash = new Bash({ otel: { serviceName: "exec-span-test" } });
    const boom = new Error("transform exploded");
    bash.registerTransformPlugin({
      name: "exploding-plugin",
      transform() {
        throw boom;
      },
    });

    await expect(bash.exec("echo hello")).rejects.toThrow("transform exploded");

    expect(spans).toHaveLength(1);
    expect(spans[0]?.exceptions).toEqual([boom]);
    expect(spans[0]?.statuses).toEqual([{ code: 2, message: "exec failed" }]);
    expect(typeof spans[0]?.attributes["ag-bash.durationMs"]).toBe("number");
    expect(spans[0]?.ended).toBe(true);
  });

  it("emits no spans at all when the otel option is omitted", async () => {
    const { spans, tracer } = createRecordingTracer();
    const Bash = await loadBashWithOtel(tracer);
    const bash = new Bash();

    const result = await bash.exec("echo quiet");

    expect(result.exitCode).toBe(0);
    expect(spans).toHaveLength(0);
  });

  it("stays a throw-free no-op when @opentelemetry/api is absent", async () => {
    const Bash = await loadBashWithoutOtel();
    const { AgBashTracer } = await import("./otel.js");

    const standalone = new AgBashTracer({ serviceName: "absent" });
    await standalone.initialize();
    expect(standalone.isActive).toBe(false);

    const bash = new Bash({ otel: { serviceName: "absent" } });
    const result = await bash.exec("echo still-works");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("still-works\n");
  });
});
