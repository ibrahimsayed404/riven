import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApplicationStatus, Role } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { BazaarsService } from './bazaars.service';
import { OrganizersService } from './organizers.service';
import { CreateBazaarDto } from './dto/create-bazaar.dto';
import { UpdateBazaarDto } from './dto/update-bazaar.dto';
import { UpdateOrganizerProfileDto } from './dto/update-organizer-profile.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

@Controller('organizers/me')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ORGANIZER)
export class OrganizerBazaarsController {
  constructor(
    private readonly bazaarsService: BazaarsService,
    private readonly organizersService: OrganizersService,
  ) {}

  @Get()
  getProfile(@CurrentUser('id') ownerId: string) {
    return this.organizersService.getOrganizerByOwnerId(ownerId);
  }

  @Patch()
  updateProfile(
    @CurrentUser('id') ownerId: string,
    @Body() updateDto: UpdateOrganizerProfileDto,
  ) {
    return this.organizersService.updateMyProfile(ownerId, updateDto);
  }

  @Get('bazaars')
  getBazaars(
    @CurrentUser('id') ownerId: string,
    @Query() query: PaginationQueryDto,
  ) {
    const { page = 1, limit = 20 } = query;
    return this.bazaarsService.getMyBazaars(ownerId, page, limit);
  }

  @Post('bazaars')
  createBazaar(
    @CurrentUser('id') ownerId: string,
    @Body() createDto: CreateBazaarDto,
  ) {
    return this.bazaarsService.createBazaar(ownerId, createDto);
  }

  @Get('bazaars/:id')
  getBazaar(
    @CurrentUser('id') ownerId: string,
    @Param('id') id: string,
  ) {
    return this.bazaarsService.getMyBazaarById(ownerId, id);
  }

  @Patch('bazaars/:id')
  updateBazaar(
    @CurrentUser('id') ownerId: string,
    @Param('id') id: string,
    @Body() updateDto: UpdateBazaarDto,
  ) {
    return this.bazaarsService.updateMyBazaar(ownerId, id, updateDto);
  }

  @Patch('bazaars/:id/publish')
  publishBazaar(
    @CurrentUser('id') ownerId: string,
    @Param('id') id: string,
  ) {
    return this.bazaarsService.publishBazaar(ownerId, id);
  }

  @Patch('bazaars/:id/cancel')
  cancelBazaar(
    @CurrentUser('id') ownerId: string,
    @Param('id') id: string,
  ) {
    return this.bazaarsService.cancelBazaar(ownerId, id);
  }

  // --- Vendor Applications Management ---

  @Get('bazaars/:id/applications')
  getApplications(
    @CurrentUser('id') ownerId: string,
    @Param('id') bazaarId: string,
    @Query() query: ListApplicationsQueryDto,
  ) {
    const { page = 1, limit = 20, status } = query;
    return this.bazaarsService.getBazaarApplications(
      ownerId,
      bazaarId,
      page,
      limit,
      status,
    );
  }

  @Patch('bazaars/:id/applications/:applicationId/accept')
  acceptApplication(
    @CurrentUser('id') ownerId: string,
    @Param('id') bazaarId: string,
    @Param('applicationId') applicationId: string,
  ) {
    return this.bazaarsService.decideApplication(
      ownerId,
      bazaarId,
      applicationId,
      ApplicationStatus.ACCEPTED,
    );
  }

  @Patch('bazaars/:id/applications/:applicationId/reject')
  rejectApplication(
    @CurrentUser('id') ownerId: string,
    @Param('id') bazaarId: string,
    @Param('applicationId') applicationId: string,
  ) {
    return this.bazaarsService.decideApplication(
      ownerId,
      bazaarId,
      applicationId,
      ApplicationStatus.REJECTED,
    );
  }
}