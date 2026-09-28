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

const BEARER = 'Bearer ';

/**
 * Global rate-limit guard. Keys by the authenticated user when there is one,
 * otherwise by client IP — so a per-user rule like "one location update a
 * minute" holds across devices, and unauthenticated abuse is still throttled
 * per source. Storage is in-memory (per process); swap in a Redis storage
 * before running more than one instance.
 *
 * The user is resolved from the bearer token *here* rather than from
 * `req.user`: this guard is an APP_GUARD, and Nest runs guards in the order
 * [global, controller, handler], so JwtAuthGuard has not populated `req.user`
 * yet. Reading `req.user` alone silently degraded every limit to per-IP.
 *
 * The signature is verified, never merely decoded — an unverified `sub` would
 * let a caller mint a fresh bucket per request with a forged token and bypass
 * the limit entirely. A missing, malformed or expired token is not an error
 * here; it just means "not identifiable as a user", and we fall back to IP.
 * Authentication itself remains JwtAuthGuard's job.
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
    const userId = req.user?.id ?? (await this.userIdFromBearerToken(req));
    if (userId) return `user:${userId}`;

    const ip = req.ips?.length ? req.ips[0] : req.ip;
    return `ip:${ip ?? 'unknown'}`;
  }

  /** The `sub` of a valid, unexpired access token, or null for anything else. */
  private async userIdFromBearerToken(req: RequestLike): Promise<string | null> {
    const raw = req.headers?.authorization;
    const header = Array.isArray(raw) ? raw[0] : raw;

    if (typeof header !== 'string' || !header.startsWith(BEARER)) {
      return null;
    }

    try {
      const payload = await this.jwtService.verifyAsync<{ sub?: unknown }>(
        header.slice(BEARER.length),
      );

      return typeof payload.sub === 'string' && payload.sub.length > 0
        ? payload.sub
        : null;
    } catch {
      return null;
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