import { AdminAction, AdminTargetType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class ListAuditLogQueryDto {
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @IsEnum(AdminTargetType)
  targetType?: AdminTargetType;

  @IsOptional()
  @IsUUID()
  targetId?: string;

  @IsOptional()
  @IsEnum(AdminAction)
  action?: AdminAction;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
