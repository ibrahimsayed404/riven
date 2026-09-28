import { Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { BazaarsService } from './bazaars.service';
import { AdminListBazaarsQueryDto } from './dto/admin-list-bazaars-query.dto';

// specs/admin-module-spec2.md A3 (reads) + spec3 B7 (cancel, organizer rules).
// Shares the admin/bazaars prefix with AdminBoothsController (…/:bazaarId/layout) —
// the paths differ in segment count, so the routes don't collide.
@Controller('admin/bazaars')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminBazaarsController {
  constructor(private readonly bazaarsService: BazaarsService) {}

  /** Every bazaar, any organizer, any status — DRAFT included. */
  @Get()
  listBazaars(@Query() query: AdminListBazaarsQueryDto) {
    return this.bazaarsService.listForAdmin({
      status: query.status,
      organizerId: query.organizerId,
      search: query.search,
      includeDeleted: query.includeDeleted ?? false,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    });
  }

  @Get(':id')
  getBazaar(@Param('id') id: string) {
    return this.bazaarsService.getBazaarForAdmin(id);
  }

  /** Any status but COMPLETED; already CANCELLED is a no-op (specs/admin-module-spec3.md B7). */
  @Patch(':id/cancel')
  cancelBazaar(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return this.bazaarsService.cancelBazaarForAdmin(admin.id, id);
  }
}
