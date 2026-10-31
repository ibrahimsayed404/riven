import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { ApplicationStatus, Role } from '@prisma/client';

import { OrganizerBazaarsController } from './organizer-bazaars.controller';

// Unit tests for every route of OrganizerBazaarsController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('OrganizerBazaarsController (unit)', () => {
  let bazaarsService: ReturnType<typeof autoMock>;
  let organizersService: ReturnType<typeof autoMock>;
  let controller: OrganizerBazaarsController;

  beforeEach(() => {
    bazaarsService = autoMock('bazaarsService');
    organizersService = autoMock('organizersService');
    controller = new OrganizerBazaarsController(bazaarsService as never, organizersService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(OrganizerBazaarsController)).toEqual([
      {
        "handler": "getProfile",
        "method": "GET",
        "path": "/organizers/me",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ORGANIZER"
        ]
      },
      {
        "handler": "updateProfile",
        "method": "PATCH",
        "path": "/organizers/me",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ORGANIZER"
        ]
      },
      {
        "handler": "getBazaars",
        "method": "GET",
        "path": "/organizers/me/bazaars",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ORGANIZER"
        ]
      },
      {
        "handler": "createBazaar",
        "method": "POST",
        "path": "/organizers/me/bazaars",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ORGANIZER"
        ]
      },
      {
        "handler": "getBazaar",
        "method": "GET",
        "path": "/organizers/me/bazaars/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ORGANIZER"
        ]
      },
      {
        "handler": "updateBazaar",
        "method": "PATCH",
        "path": "/organizers/me/bazaars/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ORGANIZER"
        ]
      },
      {
        "handler": "publishBazaar",
        "method": "PATCH",
        "path": "/organizers/me/bazaars/:id/publish",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ORGANIZER"
        ]
      },
      {
        "handler": "cancelBazaar",
        "method": "PATCH",
        "path": "/organizers/me/bazaars/:id/cancel",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ORGANIZER"
        ]
      },
      {
        "handler": "getApplications",
        "method": "GET",
        "path": "/organizers/me/bazaars/:id/applications",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ORGANIZER"
        ]
      },
      {
        "handler": "acceptApplication",
        "method": "PATCH",
        "path": "/organizers/me/bazaars/:id/applications/:applicationId/accept",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ORGANIZER"
        ]
      },
      {
        "handler": "rejectApplication",
        "method": "PATCH",
        "path": "/organizers/me/bazaars/:id/applications/:applicationId/reject",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ORGANIZER"
        ]
      }
    ]);
  });

  it('GET /organizers/me → organizersService.getOrganizerByOwnerId', async () => {
    const ownerId = userOf(Role.ORGANIZER).id;
    const result = await controller.getProfile(ownerId);
    expect(organizersService.getOrganizerByOwnerId).toHaveBeenCalledWith(ownerId);
    expect(organizersService.getOrganizerByOwnerId).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, organizersService.getOrganizerByOwnerId);
  });

  it('PATCH /organizers/me → organizersService.updateMyProfile', async () => {
    const ownerId = userOf(Role.ORGANIZER).id;
    const updateDto = loose({ sample: 'body' });
    const result = await controller.updateProfile(ownerId, updateDto);
    expect(organizersService.updateMyProfile).toHaveBeenCalledWith(ownerId, updateDto);
    expect(organizersService.updateMyProfile).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, organizersService.updateMyProfile);
  });

  it('POST /organizers/me/bazaars → bazaarsService.createBazaar', async () => {
    const ownerId = userOf(Role.ORGANIZER).id;
    const createDto = loose({ sample: 'body' });
    const result = await controller.createBazaar(ownerId, createDto);
    expect(bazaarsService.createBazaar).toHaveBeenCalledWith(ownerId, createDto);
    expect(bazaarsService.createBazaar).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, bazaarsService.createBazaar);
  });

  it('GET /organizers/me/bazaars/:id → bazaarsService.getMyBazaarById', async () => {
    const ownerId = userOf(Role.ORGANIZER).id;
    const id = 'id-1';
    const result = await controller.getBazaar(ownerId, id);
    expect(bazaarsService.getMyBazaarById).toHaveBeenCalledWith(ownerId, id);
    expect(bazaarsService.getMyBazaarById).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, bazaarsService.getMyBazaarById);
  });

  it('PATCH /organizers/me/bazaars/:id → bazaarsService.updateMyBazaar', async () => {
    const ownerId = userOf(Role.ORGANIZER).id;
    const id = 'id-1';
    const updateDto = loose({ sample: 'body' });
    const result = await controller.updateBazaar(ownerId, id, updateDto);
    expect(bazaarsService.updateMyBazaar).toHaveBeenCalledWith(ownerId, id, updateDto);
    expect(bazaarsService.updateMyBazaar).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, bazaarsService.updateMyBazaar);
  });

  it('PATCH /organizers/me/bazaars/:id/publish → bazaarsService.publishBazaar', async () => {
    const ownerId = userOf(Role.ORGANIZER).id;
    const id = 'id-1';
    const result = await controller.publishBazaar(ownerId, id);
    expect(bazaarsService.publishBazaar).toHaveBeenCalledWith(ownerId, id);
    expect(bazaarsService.publishBazaar).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, bazaarsService.publishBazaar);
  });

  it('PATCH /organizers/me/bazaars/:id/cancel → bazaarsService.cancelBazaar', async () => {
    const ownerId = userOf(Role.ORGANIZER).id;
    const id = 'id-1';
    const result = await controller.cancelBazaar(ownerId, id);
    expect(bazaarsService.cancelBazaar).toHaveBeenCalledWith(ownerId, id);
    expect(bazaarsService.cancelBazaar).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, bazaarsService.cancelBazaar);
  });

  it('PATCH /organizers/me/bazaars/:id/applications/:applicationId/accept → bazaarsService.decideApplication', async () => {
    const ownerId = userOf(Role.ORGANIZER).id;
    const bazaarId = 'id-1';
    const applicationId = 'applicationId-1';
    const result = await controller.acceptApplication(ownerId, bazaarId, applicationId);
    expect(bazaarsService.decideApplication).toHaveBeenCalledWith(ownerId,
      bazaarId,
      applicationId,
      ApplicationStatus.ACCEPTED,);
    expect(bazaarsService.decideApplication).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, bazaarsService.decideApplication);
  });

  it('PATCH /organizers/me/bazaars/:id/applications/:applicationId/reject → bazaarsService.decideApplication', async () => {
    const ownerId = userOf(Role.ORGANIZER).id;
    const bazaarId = 'id-1';
    const applicationId = 'applicationId-1';
    const result = await controller.rejectApplication(ownerId, bazaarId, applicationId);
    expect(bazaarsService.decideApplication).toHaveBeenCalledWith(ownerId,
      bazaarId,
      applicationId,
      ApplicationStatus.REJECTED,);
    expect(bazaarsService.decideApplication).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, bazaarsService.decideApplication);
  });
  // manual tests (handlers whose body is more than one service call)
  it('GET /organizers/me/bazaars → bazaarsService.getMyBazaars(ownerId, page, limit), defaulting to page 1 / 20', async () => {
    await controller.getBazaars('organizer-1', loose({}));
    expect(bazaarsService.getMyBazaars).toHaveBeenLastCalledWith('organizer-1', 1, 20);
    const result = await controller.getBazaars('organizer-1', loose({ page: 3, limit: 7 }));
    expect(bazaarsService.getMyBazaars).toHaveBeenLastCalledWith('organizer-1', 3, 7);
    await expectPassThrough(result, bazaarsService.getMyBazaars);
  });

  it('GET /organizers/me/bazaars/:id/applications → bazaarsService.getBazaarApplications(ownerId, bazaarId, page, limit, status)', async () => {
    await controller.getApplications('organizer-1', 'bz-1', loose({}));
    expect(bazaarsService.getBazaarApplications).toHaveBeenLastCalledWith('organizer-1', 'bz-1', 1, 20, undefined);
    const result = await controller.getApplications('organizer-1', 'bz-1', loose({ page: 2, limit: 5, status: 'PENDING' }));
    expect(bazaarsService.getBazaarApplications).toHaveBeenLastCalledWith('organizer-1', 'bz-1', 2, 5, 'PENDING');
    await expectPassThrough(result, bazaarsService.getBazaarApplications);
  });
});
