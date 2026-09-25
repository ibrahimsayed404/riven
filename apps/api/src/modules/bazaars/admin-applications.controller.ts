import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { BazaarsService } from './bazaars.service';
import { AdminListApplicationsQueryDto } from './dto/admin-list-applications-query.dto';

// specs/admin-module-spec2.md A4. Read-only: admin accept/reject is Open Item B5 —
// the organizer's decideApplication stays the only way to decide one.
@Controller('admin/applications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminApplicationsController {
  constructor(private readonly bazaarsService: BazaarsService) {}

  /** Every booth application on every bazaar, newest first. */
  @Get()
  listApplications(@Query() query: AdminListApplicationsQueryDto) {
    return this.bazaarsService.listApplicationsForAdmin({
      bazaarId: query.bazaarId,
      vendorId: query.vendorId,
      status: query.status,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    });
  }

  @Get(':id')
  getApplication(@Param('id') id: string) {
    return this.bazaarsService.getApplicationForAdmin(id);
  }
}
