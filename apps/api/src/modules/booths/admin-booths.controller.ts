import { Controller, Post, Get, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { BoothsService } from './booths.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { Role } from '@prisma/client';
import { CreateBoothLayoutDto } from './dto/create-booth-layout.dto';
import { UpdateBoothLayoutDto } from './dto/update-booth-layout.dto';
import { CreateBoothDto } from './dto/create-booth.dto';
import { UpdateBoothDto } from './dto/update-booth.dto';
import { AssignBoothDto } from './dto/assign-booth.dto';

// Every write here is audited with the acting admin (specs/admin-module-spec3.md B8c).
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminBoothsController {
  constructor(private readonly boothsService: BoothsService) {}

  @Post('bazaars/:bazaarId/layout')
  createLayout(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('bazaarId') bazaarId: string,
    @Body() dto: CreateBoothLayoutDto,
  ) {
    return this.boothsService.createLayout(
      admin.id,
      bazaarId,
      dto.gridConfig as any,
    );
  }

  @Get('bazaars/:bazaarId/layout')
  getLayout(@Param('bazaarId') bazaarId: string) {
    return this.boothsService.getLayout(bazaarId);
  }

  @Patch('bazaars/:bazaarId/layout')
  updateLayout(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('bazaarId') bazaarId: string,
    @Body() dto: UpdateBoothLayoutDto,
  ) {
    return this.boothsService.updateLayout(
      admin.id,
      bazaarId,
      dto.gridConfig as any,
    );
  }

  @Post('bazaars/:bazaarId/layout/booths')
  createBooth(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('bazaarId') bazaarId: string,
    @Body() dto: CreateBoothDto,
  ) {
    return this.boothsService.createBooth(admin.id, bazaarId, dto);
  }

  @Patch('booths/:id')
  updateBooth(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateBoothDto,
  ) {
    return this.boothsService.updateBooth(admin.id, id, dto);
  }

  @Delete('booths/:id')
  deleteBooth(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.boothsService.deleteBooth(admin.id, id);
  }

  @Patch('booths/:id/assign')
  assignBooth(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AssignBoothDto,
  ) {
    return this.boothsService.assignBooth(admin.id, id, dto.boothListingId);
  }

  @Patch('booths/:id/unassign')
  unassignBooth(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.boothsService.unassignBooth(admin.id, id);
  }
}