import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';

import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { BarcodesService } from './barcodes.service';
import {
  AdminListBarcodesQueryDto,
  BarcodeReasonDto,
  ChangeConversionDto,
  CreateInternalBarcodeDto,
  LookupBarcodeDto,
  RegisterVendorBarcodeDto,
} from './dto/barcode.dto';

// ADMIN until staff permissions exist (SD-01 → INVENTORY). riven-barcode-inventory-plan §K.2.
@Controller('admin/barcodes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminBarcodesController {
  constructor(private readonly barcodesService: BarcodesService) {}

  @Get()
  list(@Query() query: AdminListBarcodesQueryDto) {
    return this.barcodesService.listForAdmin({
      vendorId: query.vendorId,
      variantId: query.variantId,
      status: query.status,
      value: query.value,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.barcodesService.getForAdmin(id);
  }

  @Post('internal')
  createInternal(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateInternalBarcodeDto) {
    return this.barcodesService.createInternal(admin.id, dto);
  }

  @Post('vendor')
  registerVendor(@CurrentUser() admin: AuthenticatedUser, @Body() dto: RegisterVendorBarcodeDto) {
    return this.barcodesService.registerVendorBarcode(admin.id, dto);
  }

  /** Read-only diagnosis with the same resolver scanning uses (plan §F.2). */
  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  lookup(@Body() dto: LookupBarcodeDto) {
    return this.barcodesService.resolve(dto.value, dto.vendorId);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return this.barcodesService.approve(admin.id, id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string, @Body() dto: BarcodeReasonDto) {
    return this.barcodesService.reject(admin.id, id, dto.reason);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  activate(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string, @Body() dto: BarcodeReasonDto) {
    return this.barcodesService.activate(admin.id, id, dto.reason);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string, @Body() dto: BarcodeReasonDto) {
    return this.barcodesService.deactivate(admin.id, id, dto.reason);
  }

  /** Conversion only; the value / vendor / variant mapping is immutable. */
  @Patch(':id')
  changeConversion(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string, @Body() dto: ChangeConversionDto) {
    return this.barcodesService.changeConversion(admin.id, id, dto.unitsPerPackage, dto.reason);
  }
}
