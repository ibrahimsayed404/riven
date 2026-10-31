import { PaymentExceptionStatus, PaymentExceptionType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class AdminListPaymentExceptionsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(PaymentExceptionStatus)
  status?: PaymentExceptionStatus;

  @IsOptional()
  @IsEnum(PaymentExceptionType)
  type?: PaymentExceptionType;

  @IsOptional()
  @IsUUID()
  orderGroupId?: string;
}

/** What was done about it (e.g. "Refunded manually via Paymob dashboard, ref 1234"). Kept forever. */
export class ResolvePaymentExceptionDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  note!: string;
}
