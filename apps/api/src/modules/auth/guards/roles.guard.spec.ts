import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';

import { ROLES_KEY } from '../decorators/roles.decorator';
import { RolesGuard } from './roles.guard';

function createContext(role: Role): ExecutionContext {
  return {
    getClass: jest.fn(),
    getHandler: jest.fn(),
    switchToHttp: () => ({
      getRequest: () => ({
        user: {
          id: 'user-id',
          email: 'user@example.com',
          name: 'Test User',
          role,
        },
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  it('allows a user with a required role', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue([Role.VENDOR]),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    expect(guard.canActivate(createContext(Role.VENDOR))).toBe(true);
  });

  it('rejects a user without a required role', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue([Role.VENDOR]),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    expect(guard.canActivate(createContext(Role.SHOPPER))).toBe(false);
  });

  it('allows any authenticated user when no roles are specified', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(undefined),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    expect(guard.canActivate(createContext(Role.SHOPPER))).toBe(true);
  });
});
