import { Role } from '@prisma/client';
import { IsEmail, IsEnum, IsString, Matches, MinLength, NotEquals } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @Matches(/\d/, { message: 'password must contain at least one number' })
  password!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsEnum(Role)
  @NotEquals(Role.ADMIN, { message: 'ADMIN role cannot be self-assigned' })
  role!: Role;
}
