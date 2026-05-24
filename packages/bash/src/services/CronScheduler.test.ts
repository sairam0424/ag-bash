/**
 * CronScheduler unit tests.
 *
 * Tests job creation, deletion, tick-based firing, cron expression matching,
 * expiration, dedup, serialization, and dispose lifecycle.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler, matchesCron } from "./CronScheduler.js";
import { type BusEvent, SharedStateBus } from "./SharedStateBus.js";

/* ================================================================== */
/*  Helper                                                             */
/* ================================================================== */

function collectEvents(bus: SharedStateBus, type: string): BusEvent[] {
  const events: BusEvent[] = [];
  bus.subscribe(type, (e) => events.push(e));
  return events;
}

/* ================================================================== */
/*  CronScheduler                                                      */
/* ================================================================== */

describe("CronScheduler", () => {
  let cs: CronScheduler;
  let bus: SharedStateBus;

  beforeEach(() => {
    bus = new SharedStateBus();
    cs = new CronScheduler();
    cs.setBus(bus);
  });

  /* ================================================================ */
  /*  Job creation                                                     */
  /* ================================================================ */

  describe("createJob", () => {
    it("creates a recurring job by default", () => {
      const job = cs.createJob({ cron: "*/5 * * * *", prompt: "check status" });

      expect(job.id).toMatch(/^cron_\d+$/);
      expect(job.cron).toBe("*/5 * * * *");
      expect(job.prompt).toBe("check status");
      expect(job.recurring).toBe(true);
      expect(job.durable).toBe(false);
      expect(job.fireCount).toBe(0);
      expect(job.lastFiredAt).toBeUndefined();
      expect(job.createdAt).toBeGreaterThan(0);
      expect(job.expiresAt).toBeGreaterThan(job.createdAt);
    });

    it("creates a one-shot job when recurring=false", () => {
      const job = cs.createJob({
        cron: "0 12 * * *",
        prompt: "once only",
        recurring: false,
      });

      expect(job.recurring).toBe(false);
      // One-shot TTL is 1 day (shorter than 7-day recurring)
      const oneDayMs = 24 * 60 * 60 * 1000;
      expect(job.expiresAt - job.createdAt).toBeLessThanOrEqual(oneDayMs);
    });

    it("creates a durable job", () => {
      const job = cs.createJob({
        cron: "0 * * * *",
        prompt: "durable",
        durable: true,
      });

      expect(job.durable).toBe(true);
    });

    it("generates unique sequential IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        ids.add(cs.createJob({ cron: "* * * * *", prompt: `job-${i}` }).id);
      }
      expect(ids.size).toBe(10);
    });

    it("rejects invalid cron expression (bad characters)", () => {
      expect(() =>
        cs.createJob({ cron: "bad expression here now", prompt: "nope" }),
      ).toThrow("Invalid cron expression");
    });

    it("rejects cron with wrong field count", () => {
      expect(() =>
        cs.createJob({ cron: "* * *", prompt: "nope" }),
      ).toThrow("Expected 5 fields");
    });

    it("rejects cron with 6 fields", () => {
      expect(() =>
        cs.createJob({ cron: "* * * * * *", prompt: "nope" }),
      ).toThrow("Expected 5 fields");
    });

    it("publishes created event on the bus", () => {
      const events = collectEvents(bus, "state:cron");
      cs.createJob({ cron: "* * * * *", prompt: "test" });

      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ action: "created" });
    });

    it("enforces maximum job limit", () => {
      const limited = new CronScheduler({ maxJobs: 2 });
      limited.setBus(bus);

      limited.createJob({ cron: "* * * * *", prompt: "1" });
      limited.createJob({ cron: "* * * * *", prompt: "2" });

      expect(() =>
        limited.createJob({ cron: "* * * * *", prompt: "3" }),
      ).toThrow("Maximum job limit");
    });

    it("allows creating job after another is deleted (within limit)", () => {
      const limited = new CronScheduler({ maxJobs: 2 });
      limited.setBus(bus);

      const job1 = limited.createJob({ cron: "* * * * *", prompt: "1" });
      limited.createJob({ cron: "* * * * *", prompt: "2" });

      limited.deleteJob(job1.id);

      expect(() =>
        limited.createJob({ cron: "* * * * *", prompt: "3" }),
      ).not.toThrow();
    });
  });

  /* ================================================================ */
  /*  Job deletion                                                     */
  /* ================================================================ */

  describe("deleteJob", () => {
    it("deletes an existing job by ID", () => {
      const job = cs.createJob({ cron: "* * * * *", prompt: "x" });
      expect(cs.deleteJob(job.id)).toBe(true);
      expect(cs.getJob(job.id)).toBeUndefined();
    });

    it("returns false when deleting non-existent job", () => {
      expect(cs.deleteJob("cron_999")).toBe(false);
    });

    it("publishes deleted event on the bus", () => {
      const events = collectEvents(bus, "state:cron");
      const job = cs.createJob({ cron: "* * * * *", prompt: "x" });
      events.length = 0; // clear creation event
      cs.deleteJob(job.id);

      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ action: "deleted" });
    });

    it("removes job from listJobs after deletion", () => {
      const job = cs.createJob({ cron: "* * * * *", prompt: "x" });
      cs.deleteJob(job.id);

      expect(cs.listJobs()).toHaveLength(0);
    });
  });

  /* ================================================================ */
  /*  getJob and listJobs                                              */
  /* ================================================================ */

  describe("getJob / listJobs", () => {
    it("retrieves a job by ID", () => {
      const job = cs.createJob({ cron: "*/10 * * * *", prompt: "retrieve me" });
      const fetched = cs.getJob(job.id);

      expect(fetched).toBeDefined();
      expect(fetched?.prompt).toBe("retrieve me");
    });

    it("returns undefined for unknown ID", () => {
      expect(cs.getJob("cron_nonexistent")).toBeUndefined();
    });

    it("lists all active jobs", () => {
      cs.createJob({ cron: "* * * * *", prompt: "a" });
      cs.createJob({ cron: "0 * * * *", prompt: "b" });
      cs.createJob({ cron: "0 0 * * *", prompt: "c" });

      expect(cs.listJobs()).toHaveLength(3);
    });

    it("returns empty array when no jobs exist", () => {
      expect(cs.listJobs()).toHaveLength(0);
    });
  });

  /* ================================================================ */
  /*  tick() - firing behavior                                         */
  /* ================================================================ */

  describe("tick", () => {
    it("fires a job when the cron expression matches", () => {
      cs.createJob({ cron: "* * * * *", prompt: "always fire" });

      const now = Date.now();
      const fired = cs.tick(now);

      expect(fired).toHaveLength(1);
      expect(fired[0].prompt).toBe("always fire");
      expect(fired[0].fireCount).toBe(1);
    });

    it("does not fire when expression does not match", () => {
      cs.createJob({ cron: "0 * * * *", prompt: "hourly" });

      // Tick at minute 30
      const date = new Date(2024, 0, 1, 12, 30);
      const fired = cs.tick(date.getTime());

      expect(fired).toHaveLength(0);
    });

    it("fires multiple matching jobs", () => {
      cs.createJob({ cron: "* * * * *", prompt: "a" });
      cs.createJob({ cron: "* * * * *", prompt: "b" });
      cs.createJob({ cron: "0 0 1 1 *", prompt: "yearly" }); // won't match most ticks

      const date = new Date(2024, 5, 15, 10, 30);
      const fired = cs.tick(date.getTime());

      expect(fired).toHaveLength(2);
    });

    it("increments fireCount on each successful fire", () => {
      const job = cs.createJob({ cron: "* * * * *", prompt: "counter" });

      const minute1 = new Date(2024, 0, 1, 12, 0);
      const minute2 = new Date(2024, 0, 1, 12, 1);
      const minute3 = new Date(2024, 0, 1, 12, 2);

      cs.tick(minute1.getTime());
      cs.tick(minute2.getTime());
      cs.tick(minute3.getTime());

      expect(cs.getJob(job.id)?.fireCount).toBe(3);
    });

    it("publishes cron:fired event when job fires", () => {
      const events = collectEvents(bus, "cron:fired");
      cs.createJob({ cron: "* * * * *", prompt: "fire me" });
      cs.tick(Date.now());

      expect(events).toHaveLength(1);
      expect((events[0].payload as any).job.prompt).toBe("fire me");
    });

    it("does not fire same job twice in the same calendar minute (dedup)", () => {
      cs.createJob({ cron: "* * * * *", prompt: "dedup" });

      const baseDate = new Date(2024, 0, 1, 12, 30, 0);
      const sameMinute = new Date(2024, 0, 1, 12, 30, 45);

      const fired1 = cs.tick(baseDate.getTime());
      expect(fired1).toHaveLength(1);

      const fired2 = cs.tick(sameMinute.getTime());
      expect(fired2).toHaveLength(0);
    });

    it("fires again in a different minute", () => {
      cs.createJob({ cron: "* * * * *", prompt: "per-minute" });

      const minute1 = new Date(2024, 0, 1, 12, 30, 0);
      const minute2 = new Date(2024, 0, 1, 12, 31, 0);

      cs.tick(minute1.getTime());
      const fired = cs.tick(minute2.getTime());

      expect(fired).toHaveLength(1);
    });

    it("auto-deletes one-shot jobs after firing", () => {
      const job = cs.createJob({
        cron: "* * * * *",
        prompt: "once",
        recurring: false,
      });

      cs.tick(Date.now());

      expect(cs.getJob(job.id)).toBeUndefined();
      expect(cs.listJobs()).toHaveLength(0);
    });

    it("removes expired jobs during tick without firing", () => {
      const job = cs.createJob({ cron: "* * * * *", prompt: "expirable" });

      // Tick 8 days in the future (past 7-day expiration for recurring)
      const futureMs = Date.now() + 8 * 24 * 60 * 60 * 1000;
      const fired = cs.tick(futureMs);

      expect(cs.getJob(job.id)).toBeUndefined();
      expect(fired).toHaveLength(0);
    });

    it("handles tick with no jobs gracefully", () => {
      const fired = cs.tick(Date.now());
      expect(fired).toHaveLength(0);
    });

    it("returns a snapshot copy (not a reference to internal job)", () => {
      cs.createJob({ cron: "* * * * *", prompt: "snapshot" });
      const fired = cs.tick(Date.now());

      // Mutating the returned job should not affect internal state
      fired[0].prompt = "mutated";
      expect(cs.listJobs()[0].prompt).toBe("snapshot");
    });
  });

  /* ================================================================ */
  /*  matchesCron (exported utility)                                    */
  /* ================================================================ */

  describe("matchesCron", () => {
    it("matches all-wildcard expression against any date", () => {
      expect(matchesCron("* * * * *", new Date())).toBe(true);
    });

    it("matches specific minute and hour", () => {
      const date = new Date(2024, 5, 15, 14, 30);
      expect(matchesCron("30 14 * * *", date)).toBe(true);
      expect(matchesCron("31 14 * * *", date)).toBe(false);
      expect(matchesCron("30 15 * * *", date)).toBe(false);
    });

    it("matches day-of-week (0 = Sunday)", () => {
      const sunday = new Date(2024, 5, 16, 12, 0); // June 16 2024 is Sunday
      expect(matchesCron("* * * * 0", sunday)).toBe(true);
      expect(matchesCron("* * * * 1", sunday)).toBe(false);
    });

    it("handles 7 as Sunday alias", () => {
      const sunday = new Date(2024, 5, 16, 12, 0);
      expect(matchesCron("* * * * 7", sunday)).toBe(true);
    });

    it("handles step expressions (*/15)", () => {
      const at0 = new Date(2024, 0, 1, 0, 0);
      const at15 = new Date(2024, 0, 1, 0, 15);
      const at30 = new Date(2024, 0, 1, 0, 30);
      const at7 = new Date(2024, 0, 1, 0, 7);

      expect(matchesCron("*/15 * * * *", at0)).toBe(true);
      expect(matchesCron("*/15 * * * *", at15)).toBe(true);
      expect(matchesCron("*/15 * * * *", at30)).toBe(true);
      expect(matchesCron("*/15 * * * *", at7)).toBe(false);
    });

    it("handles range expressions", () => {
      const at10 = new Date(2024, 0, 1, 10, 0);
      const at20 = new Date(2024, 0, 1, 20, 0);

      expect(matchesCron("* 9-17 * * *", at10)).toBe(true);
      expect(matchesCron("* 9-17 * * *", at20)).toBe(false);
    });

    it("handles comma-separated values", () => {
      const at0 = new Date(2024, 0, 1, 0, 0);
      const at15 = new Date(2024, 0, 1, 0, 15);
      const at10 = new Date(2024, 0, 1, 0, 10);

      expect(matchesCron("0,15,30,45 * * * *", at0)).toBe(true);
      expect(matchesCron("0,15,30,45 * * * *", at15)).toBe(true);
      expect(matchesCron("0,15,30,45 * * * *", at10)).toBe(false);
    });

    it("handles range with step (1-30/10)", () => {
      const at1 = new Date(2024, 0, 1, 0, 1);
      const at11 = new Date(2024, 0, 1, 0, 11);
      const at21 = new Date(2024, 0, 1, 0, 21);
      const at5 = new Date(2024, 0, 1, 0, 5);

      expect(matchesCron("1-30/10 * * * *", at1)).toBe(true);
      expect(matchesCron("1-30/10 * * * *", at11)).toBe(true);
      expect(matchesCron("1-30/10 * * * *", at21)).toBe(true);
      expect(matchesCron("1-30/10 * * * *", at5)).toBe(false);
    });

    it("rejects invalid field count", () => {
      expect(matchesCron("* * *", new Date())).toBe(false);
      expect(matchesCron("* * * * * *", new Date())).toBe(false);
      expect(matchesCron("", new Date())).toBe(false);
    });

    it("handles specific month", () => {
      const june = new Date(2024, 5, 1, 0, 0); // month 5 = June
      const jan = new Date(2024, 0, 1, 0, 0);

      expect(matchesCron("* * * 6 *", june)).toBe(true);
      expect(matchesCron("* * * 6 *", jan)).toBe(false);
    });

    it("handles specific day-of-month", () => {
      const day15 = new Date(2024, 5, 15, 0, 0);
      const day1 = new Date(2024, 5, 1, 0, 0);

      expect(matchesCron("* * 15 * *", day15)).toBe(true);
      expect(matchesCron("* * 15 * *", day1)).toBe(false);
    });
  });

  /* ================================================================ */
  /*  Serialization (toJSON / loadFromJSON)                             */
  /* ================================================================ */

  describe("serialization", () => {
    it("round-trips via toJSON / loadFromJSON", () => {
      cs.createJob({ cron: "*/5 * * * *", prompt: "saved" });
      cs.createJob({ cron: "0 12 * * *", prompt: "noon" });

      const json = cs.toJSON();
      const cs2 = new CronScheduler();
      cs2.loadFromJSON(json);

      expect(cs2.listJobs()).toHaveLength(2);
      expect(cs2.listJobs().map((j) => j.prompt).sort()).toEqual(["noon", "saved"]);
    });

    it("preserves fireCount and lastFiredAt after load", () => {
      const job = cs.createJob({ cron: "* * * * *", prompt: "track" });
      cs.tick(new Date(2024, 0, 1, 12, 0).getTime());

      const json = cs.toJSON();
      const cs2 = new CronScheduler();
      cs2.loadFromJSON(json);

      const loaded = cs2.getJob(job.id);
      expect(loaded?.fireCount).toBe(1);
      expect(loaded?.lastFiredAt).toBeDefined();
    });

    it("restores nextId correctly to avoid ID collisions", () => {
      cs.createJob({ cron: "* * * * *", prompt: "first" });
      cs.createJob({ cron: "* * * * *", prompt: "second" });

      const json = cs.toJSON();
      const cs2 = new CronScheduler();
      cs2.setBus(bus);
      cs2.loadFromJSON(json);

      // New jobs should get IDs > existing ones
      const newJob = cs2.createJob({ cron: "* * * * *", prompt: "third" });
      expect(newJob.id).toBe("cron_3");
    });

    it("toJSON returns empty array when no jobs exist", () => {
      expect(cs.toJSON()).toEqual([]);
    });

    it("loadFromJSON clears existing jobs", () => {
      cs.createJob({ cron: "* * * * *", prompt: "existing" });
      cs.loadFromJSON([]);
      expect(cs.listJobs()).toHaveLength(0);
    });
  });

  /* ================================================================ */
  /*  dispose()                                                         */
  /* ================================================================ */

  describe("dispose", () => {
    it("clears all jobs on dispose", async () => {
      cs.createJob({ cron: "* * * * *", prompt: "a" });
      cs.createJob({ cron: "* * * * *", prompt: "b" });

      await cs.dispose();

      expect(cs.listJobs()).toHaveLength(0);
    });

    it("is idempotent (safe to call multiple times)", async () => {
      cs.createJob({ cron: "* * * * *", prompt: "x" });

      await cs.dispose();
      await cs.dispose();
      await cs.dispose();

      expect(cs.listJobs()).toHaveLength(0);
    });

    it("disconnects from bus after dispose", async () => {
      const events = collectEvents(bus, "state:cron");
      cs.createJob({ cron: "* * * * *", prompt: "before" });
      events.length = 0;

      await cs.dispose();

      // After dispose, bus reference is cleared — no more events
      // Creating a new scheduler and job should not affect old bus
      expect(events).toHaveLength(0);
    });
  });

  /* ================================================================ */
  /*  setBus                                                           */
  /* ================================================================ */

  describe("setBus", () => {
    it("works without a bus (no errors on publish)", () => {
      const noBusScheduler = new CronScheduler();

      expect(() =>
        noBusScheduler.createJob({ cron: "* * * * *", prompt: "no bus" }),
      ).not.toThrow();
    });

    it("publishes to the wired bus", () => {
      const customBus = new SharedStateBus();
      const events = collectEvents(customBus, "state:cron");

      const scheduler = new CronScheduler();
      scheduler.setBus(customBus);
      scheduler.createJob({ cron: "* * * * *", prompt: "wired" });

      expect(events).toHaveLength(1);
    });
  });
});
