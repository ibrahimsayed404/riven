import { Injectable } from '@nestjs/common';
import { Prisma, RefreshToken, User } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  findUserByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findUserById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findAuthenticatedUserById(
    id: string,
  ): Promise<Pick<User, 'id' | 'email' | 'name' | 'role'> | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
      },
    });
  }

  createUser(data: Prisma.UserCreateInput): Promise<User> {
    return this.prisma.user.create({ data });
  }

  createVendorUser(
    userData: Prisma.UserCreateInput,
    vendorData: Omit<Prisma.VendorUncheckedCreateInput, 'ownerId'>,
  ): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: userData });
      await tx.vendor.create({
        data: {
          ...vendorData,
          ownerId: user.id,
        },
      });
      return user;
    });
  }

  createRefreshToken(data: Prisma.RefreshTokenUncheckedCreateInput): Promise<RefreshToken> {
    return this.prisma.refreshToken.create({ data });
  }

  findRefreshTokenByHash(tokenHash: string): Promise<RefreshToken | null> {
    return this.prisma.refreshToken.findUnique({ where: { tokenHash } });
  }

  rotateRefreshToken(params: {
    oldRefreshTokenId: string;
    newRefreshToken: Prisma.RefreshTokenUncheckedCreateInput;
  }): Promise<RefreshToken | null> {
    return this.prisma.$transaction(async (tx) => {
      const revokedToken = await tx.refreshToken.updateMany({
        where: {
          id: params.oldRefreshTokenId,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });

      if (revokedToken.count !== 1) {
        return null;
      }

      return tx.refreshToken.create({ data: params.newRefreshToken });
    });
  }

  revokeRefreshToken(tokenHash: string): Promise<Prisma.BatchPayload> {
    return this.prisma.refreshToken.updateMany({
      where: {
        tokenHash,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }

  revokeAllActiveRefreshTokensForUser(userId: string): Promise<Prisma.BatchPayload> {
    return this.prisma.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }
}
