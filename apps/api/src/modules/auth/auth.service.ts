import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma, Role } from '@prisma/client';

import { RegisterDto } from './dto/register.dto';
import { AuthRepository } from './auth.repository';
import { LoginDto } from './dto/login.dto';
import { LogoutDto } from './dto/logout.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterVendorDto } from './dto/register-vendor.dto';
import { RegisterOrganizerDto } from './dto/register-organizer.dto';

const PASSWORD_SALT_ROUNDS = 12;

/**
 * One canonical form for every email we store or look up, so Foo@x.com and
 * foo@x.com are the same account (fix.js AUTH-03). Done here rather than in a
 * DTO @Transform so it also applies when a test boots without transform: true.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

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
    // Public registration is shopper-only. Vendors and organizers have their own
    // routes that create the profile row in the same transaction; a VENDOR user
    // without a Vendor row is unusable (fix.js AUTH-02). ADMIN is rejected here
    // as well as in the DTO — CLAUDE.md wants the service to own that rule.
    if (registerDto.role !== undefined && registerDto.role !== Role.SHOPPER) {
      throw new BadRequestException({
        code: 'ROLE_NOT_SELF_ASSIGNABLE',
        message: 'Only shopper accounts can be created here. Use /auth/register/vendor or /auth/register/organizer.',
      });
    }

    const email = normalizeEmail(registerDto.email);
    await this.assertEmailAvailable(email);

    const passwordHash = await hash(registerDto.password, PASSWORD_SALT_ROUNDS);
    const user = await this.createUserOrConflict(() =>
      this.authRepository.createUser({
        email,
        name: registerDto.name,
        passwordHash,
        role: Role.SHOPPER,
      }),
    );

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt,
    };
  }

  async registerVendor(registerVendorDto: RegisterVendorDto): Promise<LoginResponse> {
    const email = normalizeEmail(registerVendorDto.email);
    await this.assertEmailAvailable(email);

    const passwordHash = await hash(registerVendorDto.password, PASSWORD_SALT_ROUNDS);

    const user = await this.createUserOrConflict(() =>
      this.authRepository.createVendorUser(
        {
          email,
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
        },
      ),
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

  async registerOrganizer(registerOrganizerDto: RegisterOrganizerDto): Promise<LoginResponse> {
    const email = normalizeEmail(registerOrganizerDto.email);
    await this.assertEmailAvailable(email);

    const passwordHash = await hash(registerOrganizerDto.password, PASSWORD_SALT_ROUNDS);

    const user = await this.createUserOrConflict(() =>
      this.authRepository.createOrganizerUser(
        {
          email,
          name: registerOrganizerDto.name,
          passwordHash,
          role: Role.ORGANIZER,
        },
        {
          name: registerOrganizerDto.organizationName,
          // verified defaults to false in schema
        },
      ),
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

    const user = await this.authRepository.findUserByEmail(normalizeEmail(loginDto.email));

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

  /**
   * Kill every session of a user. Called when an account is deactivated or
   * deleted so the soft-delete is not merely cosmetic (fix.js AUTH-01). Access
   * tokens already issued stay valid until their short TTL; JwtStrategy now
   * rejects the user on the next lookup anyway.
   */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.authRepository.revokeAllActiveRefreshTokensForUser(userId);
  }

  private async assertEmailAvailable(email: string): Promise<void> {
    if (await this.authRepository.findUserByEmail(email)) {
      throw this.emailAlreadyExists();
    }
  }

  /**
   * The pre-check above is the friendly path; the unique index is the truth.
   * Two concurrent signups both pass the check — the loser gets P2002, which
   * must be a 409, not a 500 (fix.js AUTH-04).
   */
  private async createUserOrConflict<T>(create: () => Promise<T>): Promise<T> {
    try {
      return await create();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw this.emailAlreadyExists();
      }
      throw error;
    }
  }

  private emailAlreadyExists(): ConflictException {
    return new ConflictException({
      code: 'EMAIL_ALREADY_EXISTS',
      message: 'A user with this email already exists.',
    });
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
