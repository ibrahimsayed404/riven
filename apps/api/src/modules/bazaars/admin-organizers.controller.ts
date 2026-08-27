import { Controller, HttpCode, HttpStatus, Param, Patch, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { OrganizersService } from './organizers.service';

@Controller('admin/organizers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminOrganizersController {
  constructor(private readonly organizersService: OrganizersService) {}

  @Patch(':id/verify')
  @HttpCode(HttpStatus.OK)
  verifyOrganizer(@Param('id') id: string) {
    return this.organizersService.verifyOrganizer(id);
  }
}
