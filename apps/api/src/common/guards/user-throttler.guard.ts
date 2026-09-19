import { ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';

type RequestLike = { ip?: string; ips?: string[]; user?: { id?: string } };

/**
 * Global rate-limit guard. Keys by the authenticated user when there is one,
 * otherwise by client IP — so a per-user rule like "one location update a
 * minute" holds across devices, and unauthenticated abuse is still throttled
 * per source. Storage is in-memory (per process); swap in a Redis storage
 * before running more than one instance.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: RequestLike): Promise<string> {
    if (req.user?.id) return `user:${req.user.id}`;
    const ip = req.ips?.length ? req.ips[0] : req.ip;
    return `ip:${ip ?? 'unknown'}`;
  }

  /** A 429 the client can branch on; the guard has already set Retry-After. */
  protected async throwThrottlingException(
    _context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    // timeToBlockExpire is already in seconds; the guard has set Retry-After from it.
    const retryAfterSeconds = Math.max(1, Math.ceil(detail.timeToBlockExpire));
    throw new HttpException(
      {
        code: 'RATE_LIMITED',
        message: `Too many requests. Retry after ${retryAfterSeconds}s.`,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
