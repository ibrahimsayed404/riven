import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ListAuditLogQueryDto } from './dto/list-audit-log-query.dto';

@Controller('admin/audit-log')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminAuditLogController {
  constructor(private readonly auditService: AuditService) {}

  /** Newest first. Read-only: rows are written by the domain services, never here. */
  @Get()
  list(@Query() query: ListAuditLogQueryDto) {
    return this.auditService.list(
      {
        actorId: query.actorId,
        targetType: query.targetType,
        targetId: query.targetId,
        action: query.action,
      },
      query.page ?? 1,
      query.limit ?? 20,
    );
  }
}
