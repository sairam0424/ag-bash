import type { OtelConfig, OtelSpan, OtelTracer } from "./otel-types.js";

const NOOP_SPAN: OtelSpan = {
  setAttribute() {},
  setStatus() {},
  end() {},
};

const NOOP_TRACER: OtelTracer = {
  startSpan() {
    return NOOP_SPAN;
  },
};

/**
 * AgBashTracer provides optional OpenTelemetry integration.
 * If @opentelemetry/api is not installed, all operations are no-ops (zero overhead).
 */
export class AgBashTracer {
  private tracer: OtelTracer = NOOP_TRACER;
  private readonly config: OtelConfig;
  private initialized = false;

  constructor(config?: OtelConfig) {
    this.config = config ?? {};
  }

  /** Attempt to initialize OTel. Call once at startup. Safe to call multiple times. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      // Dynamic import - only loads if @opentelemetry/api is installed
      const otel = await import("@opentelemetry/api");
      const tracerName = this.config.serviceName ?? "ag-bash";
      this.tracer = otel.trace.getTracer(tracerName);
    } catch {
      // @opentelemetry/api not installed - keep no-op tracer
    }
  }

  /** Create a span for a bash execution call */
  startExecSpan(script: string): OtelSpan {
    const span = this.tracer.startSpan("ag-bash.exec", {
      attributes: {
        "ag-bash.script": script.slice(0, 500),
        ...(this.config.attributes ?? {}),
      },
    });
    return span;
  }

  /** Create a span for a tool call */
  startToolSpan(toolName: string, args: Record<string, unknown>): OtelSpan {
    const span = this.tracer.startSpan(`ag-bash.tool.${toolName}`, {
      attributes: {
        "ag-bash.tool.name": toolName,
        "ag-bash.tool.args": JSON.stringify(args).slice(0, 500),
        ...(this.config.attributes ?? {}),
      },
    });
    return span;
  }

  /** Create a span for a statement (only if statementLevel is enabled) */
  startStatementSpan(type: string, line?: number): OtelSpan {
    if (!this.config.statementLevel) return NOOP_SPAN;
    const attrs: Record<string, string | number> = {
      "ag-bash.statement.type": type,
      ...(this.config.attributes ?? {}),
    };
    if (line !== undefined) attrs["ag-bash.statement.line"] = line;
    return this.tracer.startSpan(`ag-bash.statement.${type}`, {
      attributes: attrs,
    });
  }

  /** Check if the tracer is active (OTel was loaded successfully) */
  get isActive(): boolean {
    return this.tracer !== NOOP_TRACER;
  }
}
