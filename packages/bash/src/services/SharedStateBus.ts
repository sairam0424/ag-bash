/**
 * SharedStateBus provides a centralized bus for inter-runtime communication.
 * Allows Bash, Python, and JavaScript runtimes to publish and subscribe to state changes.
 */

const MAX_SUBSCRIPTIONS = 1000;
const MAX_STATE_ENTRIES = 10_000;
const MAX_PAYLOAD_BYTES = 1_048_576; // 1MB

export type BusEvent = {
  type: string;
  source: string;
  payload: unknown;
  timestamp: number;
};

export type BusCallback = (event: BusEvent) => void;

export type BusErrorHandler = (type: string, error: unknown) => void;

export class SharedStateBus {
  private listeners: Map<string, Set<BusCallback>> = new Map();
  private state: Map<string, unknown> = new Map();
  private onError: BusErrorHandler | undefined;

  setErrorHandler(handler: BusErrorHandler): void {
    this.onError = handler;
  }

  publish(type: string, source: string, payload: unknown): void {
    // Enforce payload size limit for object/array payloads
    if (payload !== null && typeof payload === "object") {
      const serialized = JSON.stringify(payload);
      if (serialized.length > MAX_PAYLOAD_BYTES) {
        throw new Error(
          "SharedStateBus: payload exceeds maximum size limit",
        );
      }
    }

    const event: BusEvent = {
      type,
      source,
      payload,
      timestamp: Date.now(),
    };

    if (type.startsWith("state:")) {
      const key = type.slice(6);
      this.state.set(key, payload);
    }

    const callbacks = this.listeners.get(type);
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(event);
        } catch (e: unknown) {
          this.onError?.(type, e);
        }
      }
    }

    const wildcardCallbacks = this.listeners.get("*");
    if (wildcardCallbacks) {
      for (const cb of wildcardCallbacks) {
        try {
          cb(event);
        } catch (e: unknown) {
          this.onError?.("*", e);
        }
      }
    }
  }

  publishTyped<T>(type: string, source: string, payload: T): void {
    this.publish(type, source, payload);
  }

  subscribe(type: string, callback: BusCallback): () => void {
    // Enforce maximum subscription count
    if (this.subscriberCount() >= MAX_SUBSCRIPTIONS) {
      throw new Error("SharedStateBus: maximum subscriptions exceeded");
    }

    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)?.add(callback);

    return () => {
      const callbacks = this.listeners.get(type);
      if (callbacks) {
        callbacks.delete(callback);
      }
    };
  }

  setState(key: string, value: unknown, source: string = "system"): void {
    // Enforce maximum state entries for new keys
    if (!this.state.has(key) && this.state.size >= MAX_STATE_ENTRIES) {
      throw new Error("SharedStateBus: maximum state entries exceeded");
    }
    this.state.set(key, value);
    this.publish(`state:${key}`, source, value);
  }

  getState(key: string): unknown {
    return this.state.get(key);
  }

  getStateAs<T>(key: string): T | undefined {
    const value = this.state.get(key);
    if (value === undefined) {
      return undefined;
    }
    return value as T;
  }

  reset(): void {
    this.listeners.clear();
    this.state.clear();
  }

  destroy(): void {
    this.listeners.clear();
    this.state.clear();
    this.onError = undefined;
  }

  subscriberCount(): number {
    let count = 0;
    for (const callbacks of this.listeners.values()) {
      count += callbacks.size;
    }
    return count;
  }
}
