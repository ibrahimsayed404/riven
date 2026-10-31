import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { AdminBoothsController } from './admin-booths.controller';

// Unit tests for every route of AdminBoothsController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('AdminBoothsController (unit)', () => {
  let boothsService: ReturnType<typeof autoMock>;
  let controller: AdminBoothsController;

  beforeEach(() => {
    boothsService = autoMock('boothsService');
    controller = new AdminBoothsController(boothsService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(AdminBoothsController)).toEqual([
      {
        "handler": "createLayout",
        "method": "POST",
        "path": "/admin/bazaars/:bazaarId/layout",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "getLayout",
        "method": "GET",
        "path": "/admin/bazaars/:bazaarId/layout",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "updateLayout",
        "method": "PATCH",
        "path": "/admin/bazaars/:bazaarId/layout",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "createBooth",
        "method": "POST",
        "path": "/admin/bazaars/:bazaarId/layout/booths",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "updateBooth",
        "method": "PATCH",
        "path": "/admin/booths/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "deleteBooth",
        "method": "DELETE",
        "path": "/admin/booths/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "assignBooth",
        "method": "PATCH",
        "path": "/admin/booths/:id/assign",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "unassignBooth",
        "method": "PATCH",
        "path": "/admin/booths/:id/unassign",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      }
    ]);
  });

  it('POST /admin/bazaars/:bazaarId/layout → boothsService.createLayout', async () => {
    const admin = userOf(Role.ADMIN);
    const bazaarId = 'bazaarId-1';
    const dto = loose({ sample: 'body' });
    const result = await controller.createLayout(admin, bazaarId, dto);
    expect(boothsService.createLayout).toHaveBeenCalledWith(admin.id,
      bazaarId,
      dto.gridConfig as any,);
    expect(boothsService.createLayout).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, boothsService.createLayout);
  });

  it('GET /admin/bazaars/:bazaarId/layout → boothsService.getLayout', async () => {
    const bazaarId = 'bazaarId-1';
    const result = await controller.getLayout(bazaarId);
    expect(boothsService.getLayout).toHaveBeenCalledWith(bazaarId);
    expect(boothsService.getLayout).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, boothsService.getLayout);
  });

  it('PATCH /admin/bazaars/:bazaarId/layout → boothsService.updateLayout', async () => {
    const admin = userOf(Role.ADMIN);
    const bazaarId = 'bazaarId-1';
    const dto = loose({ sample: 'body' });
    const result = await controller.updateLayout(admin, bazaarId, dto);
    expect(boothsService.updateLayout).toHaveBeenCalledWith(admin.id,
      bazaarId,
      dto.gridConfig as any,);
    expect(boothsService.updateLayout).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, boothsService.updateLayout);
  });

  it('POST /admin/bazaars/:bazaarId/layout/booths → boothsService.createBooth', async () => {
    const admin = userOf(Role.ADMIN);
    const bazaarId = 'bazaarId-1';
    const dto = loose({ sample: 'body' });
    const result = await controller.createBooth(admin, bazaarId, dto);
    expect(boothsService.createBooth).toHaveBeenCalledWith(admin.id, bazaarId, dto);
    expect(boothsService.createBooth).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, boothsService.createBooth);
  });

  it('PATCH /admin/booths/:id → boothsService.updateBooth', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const dto = loose({ sample: 'body' });
    const result = await controller.updateBooth(admin, id, dto);
    expect(boothsService.updateBooth).toHaveBeenCalledWith(admin.id, id, dto);
    expect(boothsService.updateBooth).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, boothsService.updateBooth);
  });

  it('DELETE /admin/booths/:id → boothsService.deleteBooth', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const result = await controller.deleteBooth(admin, id);
    expect(boothsService.deleteBooth).toHaveBeenCalledWith(admin.id, id);
    expect(boothsService.deleteBooth).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, boothsService.deleteBooth);
  });

  it('PATCH /admin/booths/:id/assign → boothsService.assignBooth', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const dto = loose({ sample: 'body' });
    const result = await controller.assignBooth(admin, id, dto);
    expect(boothsService.assignBooth).toHaveBeenCalledWith(admin.id, id, dto.boothListingId);
    expect(boothsService.assignBooth).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, boothsService.assignBooth);
  });

  it('PATCH /admin/booths/:id/unassign → boothsService.unassignBooth', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const result = await controller.unassignBooth(admin, id);
    expect(boothsService.unassignBooth).toHaveBeenCalledWith(admin.id, id);
    expect(boothsService.unassignBooth).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, boothsService.unassignBooth);
  });
});
