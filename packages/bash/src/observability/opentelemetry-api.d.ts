/**
 * Ambient module declaration for @opentelemetry/api.
 * This allows TypeScript to type-check the dynamic import without
 * requiring the package to be installed as a dependency.
 */
declare module "@opentelemetry/api" {
  interface Span {
    setAttribute(key: string, value: string | number | boolean): void;
    setStatus(status: { code: number; message?: string }): void;
    recordException(exception: unknown, time?: unknown): void;
    end(): void;
  }

  interface Tracer {
    startSpan(
      name: string,
      options?: { attributes?: Record<string, string | number | boolean> },
    ): Span;
  }

  interface TracerProvider {
    getTracer(name: string, version?: string): Tracer;
  }

  const trace: {
    getTracer(name: string, version?: string): Tracer;
  };
}
