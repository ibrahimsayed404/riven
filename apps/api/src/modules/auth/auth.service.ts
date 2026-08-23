import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';
import { Role } from '@prisma/client';

import { RegisterDto } from './dto/register.dto';
import { AuthRepository } from './auth.repository';
import { LoginDto } from './dto/login.dto';
import { LogoutDto } from './dto/logout.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterVendorDto } from './dto/register-vendor.dto';

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
  refreshToken: string;
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
    private readonly configService: ConfigService,
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

  async registerVendor(registerVendorDto: RegisterVendorDto): Promise<LoginResponse> {
    const existingUser = await this.authRepository.findUserByEmail(registerVendorDto.email);

    if (existingUser) {
      throw new ConflictException({
        code: 'EMAIL_ALREADY_EXISTS',
        message: 'A user with this email already exists.',
      });
    }

    const passwordHash = await hash(registerVendorDto.password, PASSWORD_SALT_ROUNDS);
    
    const user = await this.authRepository.createVendorUser(
      {
        email: registerVendorDto.email,
        name: registerVendorDto.name,
        passwordHash,
        role: Role.VENDOR,
      },
      {
        name: registerVendorDto.businessName,
        category: registerVendorDto.category,
        vendorType: registerVendorDto.vendorType,
        description: registerVendorDto.description,
        // verified defaults to false
      }
    );

    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
      role: user.role,
    });
    const refreshToken = await this.createRefreshToken(user.id);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
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
    const refreshToken = await this.createRefreshToken(user.id);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  async refresh(refreshDto: RefreshDto): Promise<LoginResponse> {
    const tokenHash = this.hashRefreshToken(refreshDto.refreshToken);
    const storedToken = await this.authRepository.findRefreshTokenByHash(tokenHash);
    const invalidRefreshTokenException = this.invalidRefreshTokenException();

    if (!storedToken) {
      throw invalidRefreshTokenException;
    }

    if (storedToken.revokedAt) {
      await this.authRepository.revokeAllActiveRefreshTokensForUser(storedToken.userId);
      throw invalidRefreshTokenException;
    }

    if (storedToken.expiresAt <= new Date()) {
      throw invalidRefreshTokenException;
    }

    const user = await this.authRepository.findUserById(storedToken.userId);

    if (!user) {
      throw invalidRefreshTokenException;
    }

    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
      role: user.role,
    });
    const refreshToken = this.generateRefreshToken();
    const refreshTokenHash = this.hashRefreshToken(refreshToken);
    const refreshTokenExpiresAt = this.getRefreshTokenExpiry();

    const rotatedRefreshToken = await this.authRepository.rotateRefreshToken({
      oldRefreshTokenId: storedToken.id,
      newRefreshToken: {
        userId: user.id,
        tokenHash: refreshTokenHash,
        expiresAt: refreshTokenExpiresAt,
      },
    });

    if (!rotatedRefreshToken) {
      await this.authRepository.revokeAllActiveRefreshTokensForUser(user.id);
      throw invalidRefreshTokenException;
    }

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  async logout(logoutDto: LogoutDto): Promise<void> {
    await this.authRepository.revokeRefreshToken(
      this.hashRefreshToken(logoutDto.refreshToken),
    );
  }

  private async createRefreshToken(userId: string): Promise<string> {
    const refreshToken = this.generateRefreshToken();

    await this.authRepository.createRefreshToken({
      userId,
      tokenHash: this.hashRefreshToken(refreshToken),
      expiresAt: this.getRefreshTokenExpiry(),
    });

    return refreshToken;
  }

  private generateRefreshToken(): string {
    return randomBytes(64).toString('base64url');
  }

  private hashRefreshToken(refreshToken: string): string {
    return createHash('sha256').update(refreshToken).digest('hex');
  }

  private getRefreshTokenExpiry(): Date {
    const ttl = this.configService.getOrThrow<string>('JWT_REFRESH_TOKEN_TTL');
    return new Date(Date.now() + this.parseDurationMs(ttl));
  }

  private parseDurationMs(duration: string): number {
    const match = /^(\d+)([smhd])$/.exec(duration);

    if (!match) {
      throw new Error(`Invalid refresh token TTL: ${duration}`);
    }

    const value = Number(match[1]);
    const unit = match[2];
    const multipliers = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    return value * multipliers[unit as keyof typeof multipliers];
  }

  private invalidRefreshTokenException(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'INVALID_REFRESH_TOKEN',
      message: 'Invalid refresh token.',
    });
  }
}
