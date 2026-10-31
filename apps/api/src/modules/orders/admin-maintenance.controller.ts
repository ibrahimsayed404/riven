import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { ExpireOverdueDto } from './dto/expire-overdue.dto';
import { ReservationExpiryService } from './expiry/reservation-expiry.service';

// specs/commerce/23 R0.8: the Redis-independent fallback for scheduled
// reservation maintenance. Same run method as the scheduled job; a short budget
// because it answers an HTTP request — repeat it while a backlog remains.
@Controller('admin/maintenance')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminMaintenanceController {
  constructor(private readonly expiryService: ReservationExpiryService) {}

  @Post('expire-overdue')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  expireOverdue(@CurrentUser() admin: AuthenticatedUser, @Body() dto: ExpireOverdueDto) {
    return this.expiryService.runManual(admin.id, dto.reason);
  }
}
