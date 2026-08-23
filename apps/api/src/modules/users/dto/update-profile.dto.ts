import { ArrayMaxSize, IsArray, IsOptional, IsString, MinLength } from 'class-validator';

import { IsEgyptianPhone } from '../../../common/validators/is-egyptian-phone.validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsEgyptianPhone()
  phone?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  interests?: string[];

  // Any field NOT decorated here (e.g. email, role, location) will be
  // rejected by the global ValidationPipe (forbidNonWhitelisted: true)
  // with a 400 "property X should not exist" error.
}
