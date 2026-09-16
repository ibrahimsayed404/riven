import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ReindexDto } from './dto/reindex.dto';
import { SearchAdminService } from './search-admin.service';

@Controller('admin/search')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminSearchController {
  constructor(private readonly searchAdminService: SearchAdminService) {}

  // 202: the work happens on the queue; nothing here is synchronous.
  @Post('reindex')
  @HttpCode(HttpStatus.ACCEPTED)
  reindex(@Body() dto: ReindexDto) {
    return this.searchAdminService.reindex(dto.types);
  }
}
