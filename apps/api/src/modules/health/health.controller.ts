import { Controller, Get, ServiceUnavailableException, UseGuards } from '@nestjs/common';

import { HealthTokenGuard } from './health-token.guard';
import { HealthService } from './health.service';

/**
 * Monitor endpoints (specs/commerce/22 §4.3: M4 dependencies, M5 maintenance).
 * 200 when healthy; 503 with a coded body (`details` = the full result) when a
 * P1 / P2 condition is open, so an external monitor can alert on the status code
 * alone — even when PostgreSQL is down. The plain `/health` stays public and static.
 */
@Controller('health')
@UseGuards(HealthTokenGuard)
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('dependencies')
  async dependencies() {
    const result = await this.healthService.dependencies();
    if (result.status !== 'ok') {
      throw new ServiceUnavailableException({ code: 'DEPENDENCY_DOWN', message: 'A dependency is unavailable.', details: result });
    }
    return result;
  }

  @Get('maintenance')
  async maintenance() {
    const result = await this.healthService.maintenance();
    if (result.status !== 'ok') {
      throw new ServiceUnavailableException({
        code: 'MAINTENANCE_ALERT',
        message: result.conditions.map((c) => `${c.code} (${c.severity})`).join(', '),
        details: result,
      });
    }
    return result;
  }
}
