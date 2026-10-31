import { IsString, MaxLength, MinLength } from 'class-validator';

/** POST /admin/maintenance/expire-overdue — why the operator ran it (kept in the audit row). */
export class ExpireOverdueDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason!: string;
}
