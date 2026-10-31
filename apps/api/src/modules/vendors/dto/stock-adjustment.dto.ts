import { Transform } from 'class-transformer';
import { IsInt, IsString, Max, MaxLength, Min, MinLength, NotEquals } from 'class-validator';

import { STOCK_ADJUSTMENT_MAX } from '../../products/inventory-ledger';

/** A signed change to a variant's stock, with why (TD-08, specs/commerce/25 S3). */
export class StockAdjustmentDto {
  /** +5 received 5 more, -2 two were damaged. Never 0. */
  @IsInt()
  @NotEquals(0)
  @Min(-STOCK_ADJUSTMENT_MAX)
  @Max(STOCK_ADJUSTMENT_MAX)
  change!: number;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
