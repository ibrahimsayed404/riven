import { Controller, Post, Get, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { BoothsService } from './booths.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { CreateBoothLayoutDto } from './dto/create-booth-layout.dto';
import { UpdateBoothLayoutDto } from './dto/update-booth-layout.dto';
import { CreateBoothDto } from './dto/create-booth.dto';
import { UpdateBoothDto } from './dto/update-booth.dto';
import { AssignBoothDto } from './dto/assign-booth.dto';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminBoothsController {
  constructor(private readonly boothsService: BoothsService) {}

  @Post('bazaars/:bazaarId/layout')
  createLayout(@Param('bazaarId') bazaarId: string, @Body() dto: CreateBoothLayoutDto) {
    return this.boothsService.createLayout(bazaarId, dto.gridConfig);
  }

  @Get('bazaars/:bazaarId/layout')
  getLayout(@Param('bazaarId') bazaarId: string) {
    return this.boothsService.getLayout(bazaarId);
  }

  @Patch('bazaars/:bazaarId/layout')
  updateLayout(@Param('bazaarId') bazaarId: string, @Body() dto: UpdateBoothLayoutDto) {
    return this.boothsService.updateLayout(bazaarId, dto.gridConfig);
  }

  @Post('bazaars/:bazaarId/layout/booths')
  createBooth(@Param('bazaarId') bazaarId: string, @Body() dto: CreateBoothDto) {
    return this.boothsService.createBooth(bazaarId, dto);
  }

  @Patch('booths/:id')
  updateBooth(@Param('id') id: string, @Body() dto: UpdateBoothDto) {
    return this.boothsService.updateBooth(id, dto);
  }

  @Delete('booths/:id')
  deleteBooth(@Param('id') id: string) {
    return this.boothsService.deleteBooth(id);
  }

  @Patch('booths/:id/assign')
  assignBooth(@Param('id') id: string, @Body() dto: AssignBoothDto) {
    return this.boothsService.assignBooth(id, dto.boothListingId);
  }

  @Patch('booths/:id/unassign')
  unassignBooth(@Param('id') id: string) {
    return this.boothsService.unassignBooth(id);
  }
}
