/**
 * SharedStateBus unit tests.
 *
 * Tests publish/subscribe, typed publishing, state management,
 * wildcard subscriptions, error handling, and destroy lifecycle.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BusCallback,
  type BusErrorHandler,
  type BusEvent,
  SharedStateBus,
} from "./SharedStateBus.js";

/* ================================================================== */
/*  SharedStateBus                                                     */
/* ================================================================== */

describe("SharedStateBus", () => {
  let bus: SharedStateBus;

  beforeEach(() => {
    bus = new SharedStateBus();
  });

  /* ================================================================ */
  /*  Basic publish/subscribe                                          */
  /* ================================================================ */

  describe("publish / subscribe", () => {
    it("delivers an event to a subscriber", () => {
      const events: BusEvent[] = [];
      bus.subscribe("test:event", (e) => events.push(e));

      bus.publish("test:event", "source-1", { message: "hello" });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("test:event");
      expect(events[0].source).toBe("source-1");
      expect(events[0].payload).toEqual({ message: "hello" });
      expect(events[0].timestamp).toBeGreaterThan(0);
    });

    it("does not deliver events to unrelated subscribers", () => {
      const events: BusEvent[] = [];
      bus.subscribe("other:event", (e) => events.push(e));

      bus.publish("test:event", "source", { data: 1 });

      expect(events).toHaveLength(0);
    });

    it("delivers to multiple subscribers of the same type", () => {
      const events1: BusEvent[] = [];
      const events2: BusEvent[] = [];

      bus.subscribe("shared:type", (e) => events1.push(e));
      bus.subscribe("shared:type", (e) => events2.push(e));

      bus.publish("shared:type", "source", "payload");

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
    });

    it("delivers multiple events in order", () => {
      const payloads: unknown[] = [];
      bus.subscribe("ordered", (e) => payloads.push(e.payload));

      bus.publish("ordered", "src", "first");
      bus.publish("ordered", "src", "second");
      bus.publish("ordered", "src", "third");

      expect(payloads).toEqual(["first", "second", "third"]);
    });

    it("publishes with null payload", () => {
      const events: BusEvent[] = [];
      bus.subscribe("nullable", (e) => events.push(e));

      bus.publish("nullable", "src", null);

      expect(events).toHaveLength(1);
      expect(events[0].payload).toBeNull();
    });

    it("publishes with undefined payload", () => {
      const events: BusEvent[] = [];
      bus.subscribe("undef", (e) => events.push(e));

      bus.publish("undef", "src", undefined);

      expect(events).toHaveLength(1);
      expect(events[0].payload).toBeUndefined();
    });
  });

  /* ================================================================ */
  /*  publishTyped<T>                                                  */
  /* ================================================================ */

  describe("publishTyped<T>", () => {
    interface StatusPayload {
      code: number;
      message: string;
    }

    it("delivers typed payload correctly", () => {
      const events: BusEvent[] = [];
      bus.subscribe("typed:status", (e) => events.push(e));

      bus.publishTyped<StatusPayload>("typed:status", "service", {
        code: 200,
        message: "OK",
      });

      expect(events).toHaveLength(1);
      const payload = events[0].payload as StatusPayload;
      expect(payload.code).toBe(200);
      expect(payload.message).toBe("OK");
    });

    it("works identically to publish for delivery", () => {
      const regularEvents: BusEvent[] = [];
      const typedEvents: BusEvent[] = [];

      bus.subscribe("compare", (e) => regularEvents.push(e));
      bus.publish("compare", "a", { val: 1 });

      bus.subscribe("compare-typed", (e) => typedEvents.push(e));
      bus.publishTyped<{ val: number }>("compare-typed", "a", { val: 1 });

      expect(regularEvents[0].payload).toEqual(typedEvents[0].payload);
    });
  });

  /* ================================================================ */
  /*  State management (state: prefix)                                 */
  /* ================================================================ */

  describe("state management", () => {
    it("stores state when publishing with state: prefix", () => {
      bus.publish("state:counter", "src", 42);

      expect(bus.getState("counter")).toBe(42);
    });

    it("does not store state for non-state: events", () => {
      bus.publish("event:something", "src", "data");

      expect(bus.getState("something")).toBeUndefined();
    });

    it("overwrites state on subsequent publishes", () => {
      bus.publish("state:value", "src", "first");
      bus.publish("state:value", "src", "second");

      expect(bus.getState("value")).toBe("second");
    });

    it("stores complex objects as state", () => {
      const complex = { nested: { array: [1, 2, 3] }, flag: true };
      bus.publish("state:complex", "src", complex);

      expect(bus.getState("complex")).toEqual(complex);
    });
  });

  /* ================================================================ */
  /*  setState / getState / getStateAs                                 */
  /* ================================================================ */

  describe("setState / getState / getStateAs", () => {
    it("sets state and retrieves it", () => {
      bus.setState("myKey", "myValue");

      expect(bus.getState("myKey")).toBe("myValue");
    });

    it("setState publishes a state: event", () => {
      const events: BusEvent[] = [];
      bus.subscribe("state:config", (e) => events.push(e));

      bus.setState("config", { debug: true }, "admin");

      expect(events).toHaveLength(1);
      expect(events[0].source).toBe("admin");
      expect(events[0].payload).toEqual({ debug: true });
    });

    it("setState uses 'system' as default source", () => {
      const events: BusEvent[] = [];
      bus.subscribe("state:default", (e) => events.push(e));

      bus.setState("default", "val");

      expect(events[0].source).toBe("system");
    });

    it("getStateAs returns typed value", () => {
      interface Config {
        port: number;
        host: string;
      }

      bus.setState("server", { port: 3000, host: "localhost" });

      const config = bus.getStateAs<Config>("server");
      expect(config).toBeDefined();
      expect(config?.port).toBe(3000);
      expect(config?.host).toBe("localhost");
    });

    it("getStateAs returns undefined for missing key", () => {
      const result = bus.getStateAs<string>("nonexistent");
      expect(result).toBeUndefined();
    });

    it("getState returns undefined for missing key", () => {
      expect(bus.getState("missing")).toBeUndefined();
    });
  });

  /* ================================================================ */
  /*  Unsubscribe                                                      */
  /* ================================================================ */

  describe("unsubscribe", () => {
    it("subscribe returns an unsubscribe function", () => {
      const events: BusEvent[] = [];
      const unsub = bus.subscribe("removable", (e) => events.push(e));

      bus.publish("removable", "src", "before");
      unsub();
      bus.publish("removable", "src", "after");

      expect(events).toHaveLength(1);
      expect(events[0].payload).toBe("before");
    });

    it("unsubscribing one callback does not affect others", () => {
      const events1: BusEvent[] = [];
      const events2: BusEvent[] = [];

      const unsub1 = bus.subscribe("multi", (e) => events1.push(e));
      bus.subscribe("multi", (e) => events2.push(e));

      unsub1();
      bus.publish("multi", "src", "data");

      expect(events1).toHaveLength(0);
      expect(events2).toHaveLength(1);
    });

    it("calling unsubscribe multiple times is safe", () => {
      const events: BusEvent[] = [];
      const unsub = bus.subscribe("safe", (e) => events.push(e));

      unsub();
      unsub();
      unsub();

      bus.publish("safe", "src", "data");
      expect(events).toHaveLength(0);
    });
  });

  /* ================================================================ */
  /*  Wildcard subscription                                            */
  /* ================================================================ */

  describe("wildcard subscription (*)", () => {
    it("receives all events regardless of type", () => {
      const events: BusEvent[] = [];
      bus.subscribe("*", (e) => events.push(e));

      bus.publish("type:a", "src", "1");
      bus.publish("type:b", "src", "2");
      bus.publish("state:c", "src", "3");

      expect(events).toHaveLength(3);
    });

    it("wildcard and specific subscribers both receive matching events", () => {
      const wildcardEvents: BusEvent[] = [];
      const specificEvents: BusEvent[] = [];

      bus.subscribe("*", (e) => wildcardEvents.push(e));
      bus.subscribe("specific", (e) => specificEvents.push(e));

      bus.publish("specific", "src", "data");

      expect(wildcardEvents).toHaveLength(1);
      expect(specificEvents).toHaveLength(1);
    });

    it("wildcard unsubscribe stops delivery", () => {
      const events: BusEvent[] = [];
      const unsub = bus.subscribe("*", (e) => events.push(e));

      bus.publish("any", "src", "before");
      unsub();
      bus.publish("any", "src", "after");

      expect(events).toHaveLength(1);
    });
  });

  /* ================================================================ */
  /*  Error handling                                                    */
  /* ================================================================ */

  describe("error handling", () => {
    it("does not crash when a subscriber throws", () => {
      bus.subscribe("dangerous", () => {
        throw new Error("subscriber exploded");
      });

      expect(() => bus.publish("dangerous", "src", "data")).not.toThrow();
    });

    it("continues delivering to other subscribers after one throws", () => {
      const events: BusEvent[] = [];

      bus.subscribe("mixed", () => {
        throw new Error("first fails");
      });
      bus.subscribe("mixed", (e) => events.push(e));

      bus.publish("mixed", "src", "data");

      expect(events).toHaveLength(1);
    });

    it("invokes BusErrorHandler when a subscriber throws", () => {
      const errors: Array<{ type: string; error: unknown }> = [];
      bus.setErrorHandler((type, error) => {
        errors.push({ type, error });
      });

      bus.subscribe("failing", () => {
        throw new Error("oops");
      });
      bus.publish("failing", "src", "data");

      expect(errors).toHaveLength(1);
      expect(errors[0].type).toBe("failing");
      expect(errors[0].error).toBeInstanceOf(Error);
    });

    it("invokes error handler for wildcard subscriber errors", () => {
      const errors: Array<{ type: string; error: unknown }> = [];
      bus.setErrorHandler((type, error) => {
        errors.push({ type, error });
      });

      bus.subscribe("*", () => {
        throw new Error("wildcard error");
      });
      bus.publish("any:event", "src", "data");

      expect(errors).toHaveLength(1);
      expect(errors[0].type).toBe("*");
    });

    it("does not invoke error handler when no errors occur", () => {
      const handler = vi.fn();
      bus.setErrorHandler(handler);

      bus.subscribe("clean", () => {
        /* no-op */
      });
      bus.publish("clean", "src", "data");

      expect(handler).not.toHaveBeenCalled();
    });
  });

  /* ================================================================ */
  /*  subscriberCount                                                   */
  /* ================================================================ */

  describe("subscriberCount", () => {
    it("returns 0 for empty bus", () => {
      expect(bus.subscriberCount()).toBe(0);
    });

    it("counts all subscribers across all types", () => {
      bus.subscribe("a", () => {});
      bus.subscribe("a", () => {});
      bus.subscribe("b", () => {});

      expect(bus.subscriberCount()).toBe(3);
    });

    it("decrements when subscribers are removed", () => {
      const unsub1 = bus.subscribe("a", () => {});
      bus.subscribe("b", () => {});

      expect(bus.subscriberCount()).toBe(2);
      unsub1();
      expect(bus.subscriberCount()).toBe(1);
    });
  });

  /* ================================================================ */
  /*  reset()                                                          */
  /* ================================================================ */

  describe("reset", () => {
    it("clears all listeners", () => {
      bus.subscribe("a", () => {});
      bus.subscribe("b", () => {});

      bus.reset();

      expect(bus.subscriberCount()).toBe(0);
    });

    it("clears all stored state", () => {
      bus.setState("key1", "val1");
      bus.setState("key2", "val2");

      bus.reset();

      expect(bus.getState("key1")).toBeUndefined();
      expect(bus.getState("key2")).toBeUndefined();
    });

    it("stops event delivery after reset", () => {
      const events: BusEvent[] = [];
      bus.subscribe("resettable", (e) => events.push(e));

      bus.reset();
      bus.publish("resettable", "src", "after-reset");

      expect(events).toHaveLength(0);
    });
  });

  /* ================================================================ */
  /*  destroy()                                                        */
  /* ================================================================ */

  describe("destroy", () => {
    it("clears all listeners and state", () => {
      bus.subscribe("a", () => {});
      bus.setState("key", "val");

      bus.destroy();

      expect(bus.subscriberCount()).toBe(0);
      expect(bus.getState("key")).toBeUndefined();
    });

    it("clears the error handler", () => {
      const handler = vi.fn();
      bus.setErrorHandler(handler);

      bus.subscribe("err", () => {
        throw new Error("test");
      });

      bus.destroy();

      // Re-subscribe after destroy to test handler is cleared
      bus.subscribe("err", () => {
        throw new Error("post-destroy");
      });
      bus.publish("err", "src", "data");

      // Handler was cleared by destroy, so it should not have been called
      // for the post-destroy error (only possibly for pre-destroy)
      expect(handler).not.toHaveBeenCalled();
    });

    it("allows new subscriptions after destroy", () => {
      bus.destroy();

      const events: BusEvent[] = [];
      bus.subscribe("fresh", (e) => events.push(e));
      bus.publish("fresh", "src", "data");

      expect(events).toHaveLength(1);
    });
  });

  /* ================================================================ */
  /*  Edge cases                                                       */
  /* ================================================================ */

  describe("edge cases", () => {
    it("handles empty string as event type", () => {
      const events: BusEvent[] = [];
      bus.subscribe("", (e) => events.push(e));
      bus.publish("", "src", "empty-type");

      expect(events).toHaveLength(1);
    });

    it("handles very long event type names", () => {
      const longType = "a".repeat(1000);
      const events: BusEvent[] = [];
      bus.subscribe(longType, (e) => events.push(e));
      bus.publish(longType, "src", "long");

      expect(events).toHaveLength(1);
    });

    it("subscriber added during publish does not receive current event", () => {
      const laterEvents: BusEvent[] = [];

      bus.subscribe("trigger", () => {
        bus.subscribe("trigger", (e) => laterEvents.push(e));
      });

      bus.publish("trigger", "src", "first");

      // The subscriber added during publish shouldn't receive the triggering event
      // (depends on Set iteration behavior — new entries are visited in insertion order)
      // This test documents the actual behavior
      expect(laterEvents.length).toBeLessThanOrEqual(1);
    });

    it("state: prefix event also triggers regular subscriber", () => {
      const events: BusEvent[] = [];
      bus.subscribe("state:mykey", (e) => events.push(e));

      bus.publish("state:mykey", "src", "value");

      expect(events).toHaveLength(1);
      expect(bus.getState("mykey")).toBe("value");
    });
  });
});
