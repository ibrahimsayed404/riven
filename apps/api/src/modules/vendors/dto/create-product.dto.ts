import { IsArray, IsBoolean, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateProductDto {
  @IsString()
  title!: string;

  @IsString()
  description!: string;

  @IsString()
  categoryId!: string;

  @IsNumber()
  @Min(0)
  basePrice!: number;

  @IsArray()
  @IsString({ each: true })
  images!: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
