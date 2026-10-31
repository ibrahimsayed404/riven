import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { AuthController } from './auth.controller';

// Unit tests for every route of AuthController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('AuthController (unit)', () => {
  let authService: ReturnType<typeof autoMock>;
  let controller: AuthController;

  beforeEach(() => {
    authService = autoMock('authService');
    controller = new AuthController(authService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(AuthController)).toEqual([
      {
        "handler": "register",
        "method": "POST",
        "path": "/auth/register",
        "guards": []
      },
      {
        "handler": "registerVendor",
        "method": "POST",
        "path": "/auth/register/vendor",
        "guards": []
      },
      {
        "handler": "registerOrganizer",
        "method": "POST",
        "path": "/auth/register/organizer",
        "guards": []
      },
      {
        "handler": "login",
        "method": "POST",
        "path": "/auth/login",
        "guards": []
      },
      {
        "handler": "refresh",
        "method": "POST",
        "path": "/auth/refresh",
        "guards": []
      },
      {
        "handler": "logout",
        "method": "POST",
        "path": "/auth/logout",
        "guards": [],
        "httpCode": 204
      },
      {
        "handler": "me",
        "method": "GET",
        "path": "/auth/me",
        "guards": [
          "JwtAuthGuard"
        ]
      }
    ]);
  });

  it('POST /auth/register → authService.register', async () => {
    const registerDto = loose({ sample: 'body' });
    const result = await controller.register(registerDto);
    expect(authService.register).toHaveBeenCalledWith(registerDto);
    expect(authService.register).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, authService.register);
  });

  it('POST /auth/register/vendor → authService.registerVendor', async () => {
    const registerVendorDto = loose({ sample: 'body' });
    const result = await controller.registerVendor(registerVendorDto);
    expect(authService.registerVendor).toHaveBeenCalledWith(registerVendorDto);
    expect(authService.registerVendor).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, authService.registerVendor);
  });

  it('POST /auth/register/organizer → authService.registerOrganizer', async () => {
    const registerOrganizerDto = loose({ sample: 'body' });
    const result = await controller.registerOrganizer(registerOrganizerDto);
    expect(authService.registerOrganizer).toHaveBeenCalledWith(registerOrganizerDto);
    expect(authService.registerOrganizer).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, authService.registerOrganizer);
  });

  it('POST /auth/login → authService.login', async () => {
    const loginDto = loose({ sample: 'body' });
    const result = await controller.login(loginDto);
    expect(authService.login).toHaveBeenCalledWith(loginDto);
    expect(authService.login).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, authService.login);
  });

  it('POST /auth/refresh → authService.refresh', async () => {
    const refreshDto = loose({ sample: 'body' });
    const result = await controller.refresh(refreshDto);
    expect(authService.refresh).toHaveBeenCalledWith(refreshDto);
    expect(authService.refresh).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, authService.refresh);
  });

  it('POST /auth/logout → authService.logout', async () => {
    const logoutDto = loose({ sample: 'body' });
    const result = await controller.logout(logoutDto);
    expect(authService.logout).toHaveBeenCalledWith(logoutDto);
    expect(authService.logout).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, authService.logout);
  });
  // manual tests (handlers whose body is more than one service call)
  it('GET /auth/me returns the authenticated user as injected, without calling any service', () => {
    const user = userOf(Role.SHOPPER);
    expect(controller.me(user)).toBe(user);
  });
});
