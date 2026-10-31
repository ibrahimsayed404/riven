import { CanActivate, ExecutionContext, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

/**
 * Detailed health endpoints expose internal counts, so they need the shared
 * monitor token (`x-health-token`). With HEALTH_CHECK_TOKEN unset they are off
 * (404). Comparison is timing-safe with a length check first (CLAUDE.md).
 */
@Injectable()
export class HealthTokenGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.configService.get<string>('HEALTH_CHECK_TOKEN');
    if (!expected) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found.' });
    }
    const header = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>().headers['x-health-token'];
    const provided = Buffer.from(typeof header === 'string' ? header : '');
    const wanted = Buffer.from(expected);
    if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
      throw new UnauthorizedException({ code: 'HEALTH_TOKEN_INVALID', message: 'Invalid health token.' });
    }
    return true;
  }
}
