import { IsNumber, IsString, Min } from 'class-validator';

export class CreateBoothDto {
  @IsString()
  label: string;

  @IsNumber()
  @Min(0)
  positionX: number;

  @IsNumber()
  @Min(0)
  positionY: number;

  @IsNumber()
  @Min(1)
  width: number;

  @IsNumber()
  @Min(1)
  height: number;
}
