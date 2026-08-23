import { IsString, MinLength } from 'class-validator';

export class RejectProductDto {
  @IsString()
  @MinLength(1)
  reason!: string;
}
