import { Injectable } from '@nestjs/common';
import { AdminAction, AdminTargetType, Prisma } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';

const auditLogRowSelect = {
  id: true,
  action: true,
  targetType: true,
  targetId: true,
  reason: true,
  createdAt: true,
  actor: { select: { id: true, name: true, email: true } },
} satisfies Prisma.AdminAuditLogSelect;

export type AuditLogRow = Prisma.AdminAuditLogGetPayload<{ select: typeof auditLogRowSelect }>;

export interface AuditLogEntry {
  actorId: string;
  action: AdminAction;
  targetType: AdminTargetType;
  targetId: string;
  reason?: string | null;
}

export interface AuditLogFilter {
  actorId?: string;
  targetType?: AdminTargetType;
  targetId?: string;
  action?: AdminAction;
}

@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(entry: AuditLogEntry): Promise<void> {
    await this.prisma.adminAuditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        reason: entry.reason ?? null,
      },
    });
  }

  async findManyPaginated(
    filter: AuditLogFilter,
    page: number,
    limit: number,
  ): Promise<{ data: AuditLogRow[]; total: number }> {
    const where: Prisma.AdminAuditLogWhereInput = {};
    if (filter.actorId) where.actorId = filter.actorId;
    if (filter.targetType) where.targetType = filter.targetType;
    if (filter.targetId) where.targetId = filter.targetId;
    if (filter.action) where.action = filter.action;

    return this.prisma.$transaction(async (tx) => {
      const total = await tx.adminAuditLog.count({ where });
      const data = await tx.adminAuditLog.findMany({
        where,
        select: auditLogRowSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      });
      return { data, total };
    });
  }
}
