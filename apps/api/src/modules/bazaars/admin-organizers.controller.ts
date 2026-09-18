import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { AdminListOrganizersQueryDto } from './dto/admin-list-organizers-query.dto';
import { RejectOrganizerDto } from './dto/reject-organizer.dto';
import { OrganizersService } from './organizers.service';

@Controller('admin/organizers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminOrganizersController {
  constructor(private readonly organizersService: OrganizersService) {}

  /** Moderation queue. `?status=pending` is the "needs a decision" view. */
  @Get()
  listOrganizers(@Query() query: AdminListOrganizersQueryDto) {
    return this.organizersService.listForAdmin({
      status: query.status,
      search: query.search,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
  }

  @Patch(':id/verify')
  @HttpCode(HttpStatus.OK)
  verifyOrganizer(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return this.organizersService.verifyOrganizer(admin.id, id);
  }

  @Patch(':id/reject')
  @HttpCode(HttpStatus.OK)
  rejectOrganizer(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RejectOrganizerDto,
  ) {
    return this.organizersService.rejectOrganizer(admin.id, id, dto.reason);
  }
}
