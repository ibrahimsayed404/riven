import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';

import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { DrainOutboxDto, ListOutboxQueryDto, RequeueDeliveryDto } from './dto/outbox-admin.dto';
import { OutboxService } from './outbox.service';

// specs/commerce/01 §7.9. ADMIN until staff permissions exist (SD-01 → PLATFORM_OPERATOR).
// No endpoint deletes events or deliveries or edits payloads.
@Controller('admin/outbox')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminOutboxController {
  constructor(private readonly outboxService: OutboxService) {}

  @Get()
  list(@Query() query: ListOutboxQueryDto) {
    return this.outboxService.listForAdmin({
      status: query.status,
      consumer: query.consumer,
      type: query.type,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    });
  }

  @Get('metrics')
  metrics() {
    return this.outboxService.metrics();
  }

  @Get('deliveries/:id')
  get(@Param('id') id: string) {
    return this.outboxService.getForAdmin(id);
  }

  @Post('drain')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  drain(@CurrentUser() admin: AuthenticatedUser, @Body() dto: DrainOutboxDto) {
    return this.outboxService.drainForAdmin(admin.id, dto.max);
  }

  @Patch('deliveries/:id/requeue')
  requeue(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string, @Body() dto: RequeueDeliveryDto) {
    return this.outboxService.requeueForAdmin(admin.id, id, dto.reason);
  }
}
