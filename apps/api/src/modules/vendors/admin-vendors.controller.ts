import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { AdminListVendorsQueryDto } from './dto/admin-list-vendors-query.dto';
import { RejectVendorDto } from './dto/reject-vendor.dto';
import { VendorsService } from './vendors.service';

@Controller('admin/vendors')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminVendorsController {
  constructor(private readonly vendorsService: VendorsService) {}

  /** Moderation queue. `?status=pending` is the "needs a decision" view. */
  @Get()
  listVendors(@Query() query: AdminListVendorsQueryDto) {
    return this.vendorsService.listForAdmin({
      status: query.status,
      search: query.search,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
  }

  /** Any moderation state, soft-deleted included (specs/admin-module-spec2.md A1). */
  @Get(':id')
  getVendor(@Param('id') id: string) {
    return this.vendorsService.getVendorForAdmin(id);
  }

  @Patch(':id/verify')
  @HttpCode(HttpStatus.OK)
  verifyVendor(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return this.vendorsService.verifyVendor(admin.id, id);
  }

  @Patch(':id/reject')
  @HttpCode(HttpStatus.OK)
  rejectVendor(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RejectVendorDto,
  ) {
    return this.vendorsService.rejectVendor(admin.id, id, dto.reason);
  }
}
