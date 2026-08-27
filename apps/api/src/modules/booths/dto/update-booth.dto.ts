import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class UpdateBoothDto {
  @IsString()
  @IsOptional()
  label?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  positionX?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  positionY?: number;

  @IsNumber()
  @Min(1)
  @IsOptional()
  width?: number;

  @IsNumber()
  @Min(1)
  @IsOptional()
  height?: number;
}
