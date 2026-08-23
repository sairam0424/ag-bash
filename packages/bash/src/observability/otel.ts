import type { OtelConfig, OtelSpan, OtelTracer } from "./otel-types.js";

const NOOP_SPAN: OtelSpan = {
  setAttribute() {},
  setStatus() {},
  recordException() {},
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
  private initPromise?: Promise<void>;

  constructor(config?: OtelConfig) {
    this.config = config ?? (Object.create(null) as OtelConfig);
  }

  /**
   * Attempt to initialize OTel. Safe to call any number of times, from any
   * number of callers: the first call starts the dynamic import and every
   * later call returns the SAME promise.
   *
   * Callers that create spans MUST await this first. The dynamic import can
   * never settle inside the synchronous turn that constructs the tracer, so a
   * fire-and-forget `void initialize()` leaves `this.tracer` on NOOP_TRACER
   * for the first spans of the process — they are silently dropped. Memoizing
   * the promise (rather than an `initialized` boolean, which resolved a second
   * concurrent call *before* the import had landed) makes awaiting it mean
   * "the tracer is resolved", not merely "initialization has started".
   */
  initialize(): Promise<void> {
    this.initPromise ??= this.loadTracer();
    return this.initPromise;
  }

  private async loadTracer(): Promise<void> {
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
        ...(this.config.attributes ?? null),
      },
    });
    return span;
  }

  /**
   * Create a span for a tool call.
   *
   * NOT yet called from inside the engine: the agentic toolbox dispatch
   * boundary (`src/agentic/toolbox/`) is where this belongs, and wiring it
   * there is tracked separately. It is reachable public API today —
   * `AgBashTracer` is exported from the package root — so embedders driving
   * their own tool loop can use it. Do not delete it as dead code.
   */
  startToolSpan(toolName: string, args: Record<string, unknown>): OtelSpan {
    const span = this.tracer.startSpan(`ag-bash.tool.${toolName}`, {
      attributes: {
        "ag-bash.tool.name": toolName,
        "ag-bash.tool.args": JSON.stringify(args).slice(0, 500),
        ...(this.config.attributes ?? null),
      },
    });
    return span;
  }

  /** Create a span for a statement (only if statementLevel is enabled) */
  startStatementSpan(type: string, line?: number): OtelSpan {
    if (!this.config.statementLevel) return NOOP_SPAN;
    const attrs: Record<string, string | number> = Object.create(null);
    attrs["ag-bash.statement.type"] = type;
    if (this.config.attributes) {
      for (const [key, value] of Object.entries(this.config.attributes)) {
        attrs[key] = value;
      }
    }
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
