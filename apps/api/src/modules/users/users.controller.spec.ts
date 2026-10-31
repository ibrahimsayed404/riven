import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { UsersController } from './users.controller';

// Unit tests for every route of UsersController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('UsersController (unit)', () => {
  let usersService: ReturnType<typeof autoMock>;
  let controller: UsersController;

  beforeEach(() => {
    usersService = autoMock('usersService');
    controller = new UsersController(usersService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(UsersController)).toEqual([
      {
        "handler": "getProfile",
        "method": "GET",
        "path": "/users/me",
        "guards": [
          "JwtAuthGuard"
        ]
      },
      {
        "handler": "updateProfile",
        "method": "PATCH",
        "path": "/users/me",
        "guards": [
          "JwtAuthGuard"
        ]
      },
      {
        "handler": "updateLocation",
        "method": "PATCH",
        "path": "/users/me/location",
        "guards": [
          "JwtAuthGuard"
        ],
        "httpCode": 204
      },
      {
        "handler": "deleteAccount",
        "method": "DELETE",
        "path": "/users/me",
        "guards": [
          "JwtAuthGuard"
        ],
        "httpCode": 204
      }
    ]);
  });

  it('GET /users/me → usersService.getProfile', async () => {
    const user = userOf(Role.SHOPPER);
    const result = await controller.getProfile(user);
    expect(usersService.getProfile).toHaveBeenCalledWith(user.id);
    expect(usersService.getProfile).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, usersService.getProfile);
  });

  it('PATCH /users/me → usersService.updateProfile', async () => {
    const user = userOf(Role.SHOPPER);
    const dto = loose({ sample: 'body' });
    const result = await controller.updateProfile(user, dto);
    expect(usersService.updateProfile).toHaveBeenCalledWith(user.id, dto);
    expect(usersService.updateProfile).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, usersService.updateProfile);
  });

  it('PATCH /users/me/location → usersService.updateLocation', async () => {
    const user = userOf(Role.SHOPPER);
    const dto = loose({ sample: 'body' });
    const result = await controller.updateLocation(user, dto);
    expect(usersService.updateLocation).toHaveBeenCalledWith(user.id, dto.lat, dto.lng);
    expect(usersService.updateLocation).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, usersService.updateLocation);
  });

  it('DELETE /users/me → usersService.deleteAccount', async () => {
    const user = userOf(Role.SHOPPER);
    const dto = loose({ sample: 'body' });
    const result = await controller.deleteAccount(user, dto);
    expect(usersService.deleteAccount).toHaveBeenCalledWith(user.id, dto.password);
    expect(usersService.deleteAccount).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, usersService.deleteAccount);
  });
});
