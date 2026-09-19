import { Role } from '@prisma/client';
import { Equals, IsEmail, IsOptional, IsString, Matches, MinLength } from 'class-validator';

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

  /**
   * Accepted only for backward compatibility with clients that send
   * role: 'SHOPPER'. Anything else is rejected here and again in the service:
   * vendors and organizers register through their own routes (fix.js AUTH-02).
   */
  @IsOptional()
  @Equals(Role.SHOPPER, { message: 'only SHOPPER accounts can be created here' })
  role?: Role;
}
