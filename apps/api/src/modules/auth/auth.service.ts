import { ConflictException, Injectable } from '@nestjs/common';
import { hash } from 'bcrypt';

import { RegisterDto } from './dto/register.dto';
import { AuthRepository } from './auth.repository';

const PASSWORD_SALT_ROUNDS = 12;

type RegisteredUserResponse = {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: Date;
};

@Injectable()
export class AuthService {
  constructor(private readonly authRepository: AuthRepository) {}

  async register(registerDto: RegisterDto): Promise<RegisteredUserResponse> {
    const existingUser = await this.authRepository.findUserByEmail(registerDto.email);

    if (existingUser) {
      throw new ConflictException({
        code: 'EMAIL_ALREADY_EXISTS',
        message: 'A user with this email already exists.',
      });
    }

    const passwordHash = await hash(registerDto.password, PASSWORD_SALT_ROUNDS);
    const user = await this.authRepository.createUser({
      email: registerDto.email,
      name: registerDto.name,
      passwordHash,
      role: registerDto.role,
    });

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt,
    };
  }
}
