import { Prisma } from '@prisma/client';

// Transient database failures that are safe to retry because the whole
// transaction rolled back: serialization failures and deadlocks (Prisma maps
// both to P2034 inside interactive transactions; raw queries surface the
// SQLSTATE in P2010), plus dropped connections and P2028 (the interactive
// transaction could not start within maxWait, or ran past its timeout — Prisma
// rolled it back). A lock timeout (55P03) is NOT retried here — the caller
// decides (expiry counts the group as failed and the next run tries again).
const RETRYABLE_PRISMA_CODES = new Set(['P2034', 'P2028', 'P1001', 'P1017']);
const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);

/**
 * Explicit interactive-transaction limits for cancel/expiry and payment
 * (checkout has its own, shorter CHECKOUT_TX_LIMITS plus a deadline). Prisma's defaults (maxWait 2 s, timeout
 * 5 s) would cut a transaction off before its own `lock_timeout` (5 s) and
 * `statement_timeout` (15 s) could answer (commerce/25 §11).
 */
export const MONEY_TX_LIMITS = { maxWait: 10_000, timeout: 20_000 } as const;

export function isRetryableTxError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (RETRYABLE_PRISMA_CODES.has(error.code)) return true;
    const sqlState = (error.meta as { code?: unknown } | undefined)?.code;
    return typeof sqlState === 'string' && RETRYABLE_SQLSTATES.has(sqlState);
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return /could not serialize access|deadlock detected/i.test(error.message);
  }
  return false;
}

/** A row lock not granted within `lock_timeout`, or a statement cut off by `statement_timeout`. */
const BUSY_SQLSTATES = new Set(['55P03', '57014']);

/**
 * Contention, not a bug: a retryable failure that outlived its retries, a row
 * lock not granted within `lock_timeout` (55P03), or a statement cut off by
 * `statement_timeout` (57014). Callers and the global filter answer these with
 * a coded 503 the client may retry, never 500.
 */
export function isContentionError(error: unknown): boolean {
  if (isRetryableTxError(error)) return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const sqlState = (error.meta as { code?: unknown } | undefined)?.code;
    return typeof sqlState === 'string' && BUSY_SQLSTATES.has(sqlState);
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return /lock timeout|statement timeout|code: "55P03"|code: "57014"/i.test(error.message);
  }
  return false;
}

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Base backoff; each retry waits base × 2^n plus jitter. */
  baseDelayMs?: number;
  /** Epoch ms after which no new attempt starts (bounds the caller's total time). */
  deadline?: number;
}

/**
 * Runs `work` (normally one `prisma.$transaction(...)`) and retries it a bounded
 * number of times when it fails with a transient error. `work` must be safe to
 * re-run from the start: every write inside it is guarded, and a failed attempt
 * left nothing behind because its transaction rolled back.
 */
export async function withRetryableTx<T>(work: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 25;

  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= attempts || !isRetryableTxError(error)) throw error;
      if (options.deadline !== undefined && Date.now() >= options.deadline) throw error;
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * baseDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
