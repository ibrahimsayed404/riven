import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { AdminOutboxController } from './admin-outbox.controller';

// Unit tests for every route of AdminOutboxController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('AdminOutboxController (unit)', () => {
  let outboxService: ReturnType<typeof autoMock>;
  let controller: AdminOutboxController;

  beforeEach(() => {
    outboxService = autoMock('outboxService');
    controller = new AdminOutboxController(outboxService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(AdminOutboxController)).toEqual([
      {
        "handler": "list",
        "method": "GET",
        "path": "/admin/outbox",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "metrics",
        "method": "GET",
        "path": "/admin/outbox/metrics",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "get",
        "method": "GET",
        "path": "/admin/outbox/deliveries/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "drain",
        "method": "POST",
        "path": "/admin/outbox/drain",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ],
        "httpCode": 200
      },
      {
        "handler": "requeue",
        "method": "PATCH",
        "path": "/admin/outbox/deliveries/:id/requeue",
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

  it('GET /admin/outbox → outboxService.listForAdmin', async () => {
    const query = loose({ page: 2, limit: 5 });
    const result = await controller.list(query);
    expect(outboxService.listForAdmin).toHaveBeenCalledWith({
      status: query.status,
      consumer: query.consumer,
      type: query.type,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    });
    expect(outboxService.listForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, outboxService.listForAdmin);
  });

  it('GET /admin/outbox/metrics → outboxService.metrics', async () => {
    const result = await controller.metrics();
    expect(outboxService.metrics).toHaveBeenCalledWith();
    expect(outboxService.metrics).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, outboxService.metrics);
  });

  it('GET /admin/outbox/deliveries/:id → outboxService.getForAdmin', async () => {
    const id = 'id-1';
    const result = await controller.get(id);
    expect(outboxService.getForAdmin).toHaveBeenCalledWith(id);
    expect(outboxService.getForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, outboxService.getForAdmin);
  });

  it('POST /admin/outbox/drain → outboxService.drainForAdmin', async () => {
    const admin = userOf(Role.ADMIN);
    const dto = loose({ sample: 'body' });
    const result = await controller.drain(admin, dto);
    expect(outboxService.drainForAdmin).toHaveBeenCalledWith(admin.id, dto.max);
    expect(outboxService.drainForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, outboxService.drainForAdmin);
  });

  it('PATCH /admin/outbox/deliveries/:id/requeue → outboxService.requeueForAdmin', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const dto = loose({ sample: 'body' });
    const result = await controller.requeue(admin, id, dto);
    expect(outboxService.requeueForAdmin).toHaveBeenCalledWith(admin.id, id, dto.reason);
    expect(outboxService.requeueForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, outboxService.requeueForAdmin);
  });
});
