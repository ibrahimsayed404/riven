// specs/commerce/01 §7.3 – §7.9 (TD-06), 21 §8.5 (TD-23). Proposed starting values.

export const OUTBOX_QUEUE = 'outbox';
export const OUTBOX_DRAIN_JOB = 'drain-outbox';
export const OUTBOX_SCHEDULER_ID = 'outbox-drain-scheduler';
/** Independent of the 10-minute reservation interval. */
export const OUTBOX_DRAIN_PATTERN = '*/5 * * * *';
export const OUTBOX_DRAIN_COMMAND = 'OUTBOX_DRAIN';

/** Lease is always longer than the consumer timeout (01 §7.4). */
export const OUTBOX_LEASE_MS = 60_000;
export const OUTBOX_CONSUMER_TIMEOUT_MS = 30_000;
export const OUTBOX_MAX_ATTEMPTS = 10;
/** Retry schedule after attempt n (1-based): 1 s, 5 s, 30 s, 2 min, 10 min, then every 10 min. */
export const OUTBOX_BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 600_000];

/** One drain: at most this many deliveries or this long (boot sweep, schedule, admin). */
export const OUTBOX_DRAIN_MAX = 500;
export const OUTBOX_DRAIN_BUDGET_MS = 20_000;
export const OUTBOX_CLAIM_BATCH = 50;

export const OUTBOX_JOB_TEMPLATE_OPTIONS = {
  attempts: 1,
  removeOnComplete: { count: 100, age: 86_400 },
  removeOnFail: { count: 1_000, age: 604_800 },
};

/** Handlers registered by consumer modules (multi-provider token). */
export const OUTBOX_HANDLERS = Symbol('OUTBOX_HANDLERS');

export function outboxBackoffMs(attempts: number): number {
  return OUTBOX_BACKOFF_MS[Math.min(attempts, OUTBOX_BACKOFF_MS.length) - 1] ?? OUTBOX_BACKOFF_MS[OUTBOX_BACKOFF_MS.length - 1];
}
