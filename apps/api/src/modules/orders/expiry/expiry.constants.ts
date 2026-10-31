// Reservation maintenance tuning (specs/commerce/21 §8, 23 R0.5). Unmeasured
// starting values — confirmed or revised by the load tests (MNT-18).

export const EXPIRE_OVERDUE_COMMAND = 'EXPIRE_OVERDUE';

/** Groups read per batch; a run loops over batches until none remain or its budget is spent. */
export const EXPIRY_BATCH_SIZE = 500;

/** Scheduled runs: well below the scheduler interval, so runs do not normally overlap. */
export const SCHEDULED_RUN_BUDGET_MS = 4 * 60_000;

/** Manual runs answer an HTTP request; the operator repeats the command if a backlog remains (23 §11.9). */
export const MANUAL_RUN_BUDGET_MS = 25_000;

/** A RUNNING row older than this is a run whose process died (23 §11.7): longest run + worst group + margin. */
export const STALE_RUN_AFTER_MS = 15 * 60_000;
