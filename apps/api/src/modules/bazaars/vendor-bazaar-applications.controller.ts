import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Role, ApplicationStatus } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { BazaarsService } from './bazaars.service';

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.VENDOR)
export class VendorBazaarApplicationsController {
  constructor(private readonly bazaarsService: BazaarsService) {}

  @Post('bazaars/:id/apply')
  applyToBazaar(
    @CurrentUser('id') ownerId: string,
    @Param('id') bazaarId: string,
  ) {
    return this.bazaarsService.applyToBazaar(ownerId, bazaarId);
  }

  @Delete('bazaars/:id/apply')
  @HttpCode(HttpStatus.NO_CONTENT)
  withdrawApplication(
    @CurrentUser('id') ownerId: string,
    @Param('id') bazaarId: string,
  ) {
    return this.bazaarsService.withdrawApplication(ownerId, bazaarId);
  }

  @Get('vendors/me/bazaar-applications')
  getApplications(
    @CurrentUser('id') ownerId: string,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '10',
    @Query('status') status?: ApplicationStatus,
  ) {
    return this.bazaarsService.getVendorApplications(ownerId, parseInt(page, 10), parseInt(limit, 10), status);
  }
}
