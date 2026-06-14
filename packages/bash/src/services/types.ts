import type { SharedStateBus } from "./SharedStateBus.js";

export interface Disposable {
  dispose(): Promise<void> | void;
}

export interface BusAware {
  setBus(bus: SharedStateBus): void;
}
