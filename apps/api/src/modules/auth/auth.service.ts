import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcrypt';

import { RegisterDto } from './dto/register.dto';
import { AuthRepository } from './auth.repository';
import { LoginDto } from './dto/login.dto';

const PASSWORD_SALT_ROUNDS = 12;

type RegisteredUserResponse = {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: Date;
};

type LoginResponse = {
  accessToken: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
};

@Injectable()
export class AuthService {
  constructor(
    private readonly authRepository: AuthRepository,
    private readonly jwtService: JwtService,
  ) {}

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

  async login(loginDto: LoginDto): Promise<LoginResponse> {
    const invalidCredentialsException = new UnauthorizedException({
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password.',
    });

    const user = await this.authRepository.findUserByEmail(loginDto.email);

    if (!user) {
      throw invalidCredentialsException;
    }

    const passwordMatches = await compare(loginDto.password, user.passwordHash);

    if (!passwordMatches) {
      throw invalidCredentialsException;
    }

    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
      role: user.role,
    });

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }
}
