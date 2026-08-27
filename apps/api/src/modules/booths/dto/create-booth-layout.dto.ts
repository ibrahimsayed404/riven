import { IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class GridConfigDto {
  @IsNumber()
  @Min(1)
  rows: number;

  @IsNumber()
  @Min(1)
  cols: number;

  @IsNumber()
  @Min(1)
  cellSize: number;

  @IsString()
  @IsOptional()
  background?: string;
}

export class CreateBoothLayoutDto {
  @ValidateNested()
  @Type(() => GridConfigDto)
  gridConfig: GridConfigDto;
}
