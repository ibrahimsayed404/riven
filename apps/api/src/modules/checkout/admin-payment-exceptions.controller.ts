import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { AdminListPaymentExceptionsQueryDto, ResolvePaymentExceptionDto } from './dto/payment-exceptions.dto';
import { PaymentExceptionsService } from './payment-exceptions.service';

// specs/commerce/25 S1: double / late / wrong-amount / wrong-currency charges.
// ADMIN until staff permissions exist (SD-01 → FINANCE). No refund route: a
// refund is done outside the API and recorded here in the resolution note.
@Controller('admin/payment-exceptions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminPaymentExceptionsController {
  constructor(private readonly paymentExceptionsService: PaymentExceptionsService) {}

  @Get()
  list(@Query() query: AdminListPaymentExceptionsQueryDto) {
    return this.paymentExceptionsService.listForAdmin({
      status: query.status,
      type: query.type,
      orderGroupId: query.orderGroupId,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    });
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.paymentExceptionsService.getForAdmin(id);
  }

  @Patch(':id/resolve')
  resolve(@CurrentUser() admin: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolvePaymentExceptionDto) {
    return this.paymentExceptionsService.resolveForAdmin(admin.id, id, dto.note);
  }
}
