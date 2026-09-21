import { ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  ThrottlerLimitDetail,
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';

type RequestLike = {
  ip?: string;
  ips?: string[];
  user?: { id?: string };
  headers?: Record<string, string | string[] | undefined>;
};

/**
 * Global rate-limit guard. Keys by the authenticated user when there is one,
 * otherwise by client IP — so a per-user rule like "one location update a
 * minute" holds across devices, and unauthenticated abuse is still throttled
 * per source. Storage is in-memory (per process); swap in a Redis storage
 * before running more than one instance.
 *
 * Being an APP_GUARD it runs *before* the controller-level JwtAuthGuard, so
 * `req.user` is never set yet. The guard therefore verifies the bearer token
 * itself; a missing or invalid token simply falls back to the IP key (and the
 * request then fails auth downstream as usual).
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwtService: JwtService,
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: RequestLike): Promise<string> {
    const userId = req.user?.id ?? (await this.userIdFromBearer(req));
    if (userId) return `user:${userId}`;
    const ip = req.ips?.length ? req.ips[0] : req.ip;
    return `ip:${ip ?? 'unknown'}`;
  }

  private async userIdFromBearer(req: RequestLike): Promise<string | undefined> {
    const raw = req.headers?.authorization;
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header?.startsWith('Bearer ')) return undefined;
    try {
      const payload = await this.jwtService.verifyAsync<{ sub?: string }>(header.slice('Bearer '.length));
      return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : undefined;
    } catch {
      return undefined;
    }
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
