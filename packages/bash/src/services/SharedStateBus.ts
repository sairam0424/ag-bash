/**
 * SharedStateBus provides a centralized bus for inter-runtime communication.
 * Allows Bash, Python, and JavaScript runtimes to publish and subscribe to state changes.
 */

export type BusEvent = {
  type: string;
  source: string;
  payload: any;
  timestamp: number;
};

export type BusCallback = (event: BusEvent) => void;

export class SharedStateBus {
  private static instance: SharedStateBus;
  private listeners: Map<string, Set<BusCallback>> = new Map();
  private state: Map<string, any> = new Map();

  private constructor() {}

  static getInstance(): SharedStateBus {
    if (!SharedStateBus.instance) {
      SharedStateBus.instance = new SharedStateBus();
    }
    return SharedStateBus.instance;
  }

  /**
   * Publish an event to the bus.
   */
  publish(type: string, source: string, payload: any): void {
    const event: BusEvent = {
      type,
      source,
      payload,
      timestamp: Date.now(),
    };

    // Update internal state if the event type corresponds to a state key
    if (type.startsWith("state:")) {
      const key = type.slice(6);
      this.state.set(key, payload);
    }

    const callbacks = this.listeners.get(type);
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(event);
        } catch (e) {
          console.error(`[SharedStateBus] Error in listener for ${type}:`, e);
        }
      }
    }

    // Also notify wildcard listeners
    const wildcardCallbacks = this.listeners.get("*");
    if (wildcardCallbacks) {
      for (const cb of wildcardCallbacks) {
        try {
          cb(event);
        } catch (e) {
          console.error(`[SharedStateBus] Error in wildcard listener:`, e);
        }
      }
    }
  }

  /**
   * Subscribe to events of a specific type.
   */
  subscribe(type: string, callback: BusCallback): () => void {
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

  /**
   * Set a shared state value.
   */
  setState(key: string, value: any, source: string = "system"): void {
    this.state.set(key, value);
    this.publish(`state:${key}`, source, value);
  }

  /**
   * Get a shared state value.
   */
  getState(key: string): any {
    return this.state.get(key);
  }

  /**
   * Clear all state and listeners (useful for resets).
   */
  reset(): void {
    this.listeners.clear();
    this.state.clear();
  }
}
