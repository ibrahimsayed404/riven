import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { BazaarsService } from './bazaars.service';
import { AdminListApplicationsQueryDto } from './dto/admin-list-applications-query.dto';
import { AdminRejectApplicationDto } from './dto/admin-reject-application.dto';

// specs/admin-module-spec2.md A4 (reads) + spec3 B5 (decisions): admin may
// accept or reject a PENDING application; decided ones can't be reversed.
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

  @Patch(':id/accept')
  acceptApplication(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return this.bazaarsService.decideApplicationForAdmin(admin.id, id, 'ACCEPTED');
  }

  @Patch(':id/reject')
  rejectApplication(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdminRejectApplicationDto,
  ) {
    return this.bazaarsService.decideApplicationForAdmin(admin.id, id, 'REJECTED', dto.reason);
  }
}
