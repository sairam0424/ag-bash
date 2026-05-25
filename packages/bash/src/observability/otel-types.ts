/**
 * Minimal OTel-compatible type definitions.
 * These mirror @opentelemetry/api without requiring it as a dependency.
 */

export interface OtelSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  end(): void;
}

export interface OtelTracer {
  startSpan(
    name: string,
    options?: { attributes?: Record<string, string | number | boolean> },
  ): OtelSpan;
}

export interface OtelConfig {
  /** Service name for spans. Default: "ag-bash" */
  serviceName?: string;
  /** Whether to create spans for individual statements. Default: false */
  statementLevel?: boolean;
  /** Custom attributes to add to all spans */
  attributes?: Record<string, string>;
}
