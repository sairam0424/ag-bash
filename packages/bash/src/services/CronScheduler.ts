/**
 * CronScheduler - Sandbox-safe cron job scheduling service.
 *
 * Provides a pure-JS cron expression parser and timer-free scheduling.
 * The host drives execution by calling tick(now) periodically;
 * the scheduler matches jobs against the current time and fires them.
 *
 * No setInterval, setTimeout, or other Node.js timers are used,
 * making this safe to run inside sandboxed environments.
 */

import type { SharedStateBus } from "./SharedStateBus.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  createdAt: number;
  expiresAt: number;
  lastFiredAt?: number;
  fireCount: number;
}

/* ------------------------------------------------------------------ */
/*  Cron expression parser & matcher                                   */
/* ------------------------------------------------------------------ */

/** 7 days in milliseconds — default TTL for recurring jobs. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Parse a single cron field into the set of matching integer values.
 *
 * Supports:
 *   *        — all values in [min, max]
 *   N        — literal value
 *   N-M      — inclusive range
 *   * /step   — every `step` starting from `min`  (written without the space)
 *   N-M/step — every `step` within the range
 *   N,M,O    — comma-separated list (each element may be a range or step)
 */
function parseField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();

  for (const part of field.split(",")) {
    const trimmed = part.trim();

    if (trimmed === "*") {
      for (let i = min; i <= max; i++) result.add(i);
      continue;
    }

    // Step: */N  or  range/N
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx !== -1) {
      const base = trimmed.slice(0, slashIdx);
      const step = Number.parseInt(trimmed.slice(slashIdx + 1), 10);
      if (Number.isNaN(step) || step <= 0) continue;

      let rangeMin = min;
      let rangeMax = max;

      if (base !== "*") {
        const dashIdx = base.indexOf("-");
        if (dashIdx !== -1) {
          rangeMin = Number.parseInt(base.slice(0, dashIdx), 10);
          rangeMax = Number.parseInt(base.slice(dashIdx + 1), 10);
        } else {
          rangeMin = Number.parseInt(base, 10);
          rangeMax = max;
        }
      }

      for (let i = rangeMin; i <= rangeMax; i += step) {
        result.add(i);
      }
      continue;
    }

    // Range: N-M
    const dashIdx = trimmed.indexOf("-");
    if (dashIdx !== -1) {
      const lo = Number.parseInt(trimmed.slice(0, dashIdx), 10);
      const hi = Number.parseInt(trimmed.slice(dashIdx + 1), 10);
      if (!Number.isNaN(lo) && !Number.isNaN(hi)) {
        for (let i = lo; i <= hi; i++) result.add(i);
      }
      continue;
    }

    // Literal
    const val = Number.parseInt(trimmed, 10);
    if (!Number.isNaN(val)) {
      result.add(val);
    }
  }

  return result;
}

/**
 * Check whether a Date matches a standard 5-field cron expression.
 *
 * Fields: minute  hour  day-of-month  month  day-of-week
 *
 * Day-of-week uses 0 = Sunday .. 6 = Saturday (7 is also Sunday for
 * compatibility with some cron implementations).
 */
export function matchesCron(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1; // JS months are 0-based
  const dow = date.getDay(); // 0 = Sunday

  const minuteSet = parseField(fields[0], 0, 59);
  const hourSet = parseField(fields[1], 0, 23);
  const domSet = parseField(fields[2], 1, 31);
  const monthSet = parseField(fields[3], 1, 12);
  const dowSet = parseField(fields[4], 0, 6);

  // Treat 7 as Sunday (alias for 0) if present in the dow field
  if (dowSet.has(7)) {
    dowSet.add(0);
  }

  return (
    minuteSet.has(minute) &&
    hourSet.has(hour) &&
    domSet.has(dom) &&
    monthSet.has(month) &&
    dowSet.has(dow)
  );
}

/**
 * Basic structural validation for a 5-field cron expression.
 * Returns an error message string if invalid, or undefined if valid.
 */
function validateCron(expression: string): string | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return `Expected 5 fields (minute hour dom month dow), got ${fields.length}`;
  }
  // Verify each field contains only valid characters
  const fieldPattern = /^[\d,\-*/]+$/;
  const names = ["minute", "hour", "day-of-month", "month", "day-of-week"];
  for (let i = 0; i < 5; i++) {
    if (!fieldPattern.test(fields[i])) {
      return `Invalid characters in ${names[i]} field: ${fields[i]}`;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  ID generator                                                       */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  CronScheduler service                                              */
/* ------------------------------------------------------------------ */

/** One day in milliseconds — TTL for one-shot jobs. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export class CronScheduler {
  private jobs: Map<string, CronJob> = new Map();
  private bus: SharedStateBus | undefined;
  private maxJobs: number;
  private nextId = 1;

  constructor(options?: { maxJobs?: number }) {
    this.maxJobs = options?.maxJobs ?? 20;
  }

  private generateId(): string {
    return `cron_${this.nextId++}`;
  }

  /** Wire up the SharedStateBus for event publishing. */
  setBus(bus: SharedStateBus): void {
    this.bus = bus;
  }

  /**
   * Create a new cron job.
   *
   * @throws if the expression is invalid or the job limit is reached.
   */
  createJob(opts: {
    cron: string;
    prompt: string;
    recurring?: boolean;
    durable?: boolean;
  }): CronJob {
    const validationError = validateCron(opts.cron);
    if (validationError) {
      throw new Error(`Invalid cron expression: ${validationError}`);
    }

    if (this.jobs.size >= this.maxJobs) {
      throw new Error(`Maximum job limit reached (${this.maxJobs})`);
    }

    const now = Date.now();
    const recurring = opts.recurring ?? true;

    const job: CronJob = {
      id: this.generateId(),
      cron: opts.cron,
      prompt: opts.prompt,
      recurring,
      durable: opts.durable ?? false,
      createdAt: now,
      expiresAt: recurring ? now + SEVEN_DAYS_MS : now + ONE_DAY_MS,
      fireCount: 0,
    };

    this.jobs.set(job.id, job);
    this.publishChange(job, "created");
    return job;
  }

  /** Delete a job by ID. Returns true if it existed. */
  deleteJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;

    this.jobs.delete(id);
    this.publishChange(job, "deleted");
    return true;
  }

  /** List all active jobs. */
  listJobs(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  /** Get a single job by ID. */
  getJob(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * Tick the scheduler forward to `now` (epoch ms).
   *
   * Checks every registered job against the provided timestamp.
   * Returns the list of jobs that fired during this tick.
   *
   * - One-shot jobs are auto-deleted after firing.
   * - Expired recurring jobs are auto-deleted.
   * - A job will not fire more than once per calendar minute
   *   (guards against rapid successive ticks).
   */
  tick(now: number): CronJob[] {
    const date = new Date(now);
    const fired: CronJob[] = [];
    const toDelete: string[] = [];

    for (const job of this.jobs.values()) {
      // Auto-expire
      if (now >= job.expiresAt) {
        toDelete.push(job.id);
        continue;
      }

      // Guard: skip if already fired this calendar minute
      if (job.lastFiredAt !== undefined) {
        const lastDate = new Date(job.lastFiredAt);
        if (
          lastDate.getFullYear() === date.getFullYear() &&
          lastDate.getMonth() === date.getMonth() &&
          lastDate.getDate() === date.getDate() &&
          lastDate.getHours() === date.getHours() &&
          lastDate.getMinutes() === date.getMinutes()
        ) {
          continue;
        }
      }

      if (matchesCron(job.cron, date)) {
        job.lastFiredAt = now;
        job.fireCount++;
        fired.push({ ...job });

        this.publishFired(job);

        if (!job.recurring) {
          toDelete.push(job.id);
        }
      }
    }

    // Cleanup expired and one-shot jobs
    for (const id of toDelete) {
      const job = this.jobs.get(id);
      this.jobs.delete(id);
      if (job) {
        this.publishChange(job, "deleted");
      }
    }

    return fired;
  }

  /** Serialize all jobs for persistence. */
  toJSON(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  /** Restore jobs from a persisted snapshot. */
  loadFromJSON(jobs: CronJob[]): void {
    this.jobs.clear();
    let maxNum = 0;
    for (const job of jobs) {
      this.jobs.set(job.id, job);
      const num = Number.parseInt(job.id.replace("cron_", ""), 10);
      if (!Number.isNaN(num) && num > maxNum) maxNum = num;
    }
    this.nextId = maxNum + 1;
  }

  /* ---------------------------------------------------------------- */
  /*  Private helpers                                                   */
  /* ---------------------------------------------------------------- */

  private publishChange(job: CronJob, action: "created" | "deleted"): void {
    this.bus?.publish("state:cron", "cronScheduler", {
      action,
      job: { ...job },
    });
  }

  /** Release all resources and clear internal state. */
  async dispose(): Promise<void> {
    this.jobs.clear();
    this.bus = undefined;
  }

  private publishFired(job: CronJob): void {
    this.bus?.publish("cron:fired", "cronScheduler", {
      job: { ...job },
    });
  }
}
