import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';

import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { BarcodesService } from './barcodes.service';
import { ListOwnBarcodesQueryDto, ProposeBarcodeDto } from './dto/barcode.dto';

// Vendors propose barcodes for their own variants; nothing becomes active
// until an admin approves it (riven-barcode-inventory-plan §3.7, §K.1).
@Controller('vendors/me/barcodes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.VENDOR)
export class VendorBarcodesController {
  constructor(private readonly barcodesService: BarcodesService) {}

  @Post()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async propose(@CurrentUser() user: AuthenticatedUser, @Body() dto: ProposeBarcodeDto) {
    const barcode = await this.barcodesService.propose(user.id, dto);
    return { id: barcode.id, value: barcode.value, status: barcode.status, packagingType: barcode.packagingType, unitsPerPackage: barcode.unitsPerPackage };
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListOwnBarcodesQueryDto) {
    return this.barcodesService.listOwn(user.id, { status: query.status, page: query.page ?? 1, limit: query.limit ?? DEFAULT_PAGE_SIZE });
  }

  /** Withdraw an own pending proposal (kept in history as REJECTED / withdrawn). */
  @Delete(':id')
  withdraw(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.barcodesService.withdraw(user.id, id);
  }
}
