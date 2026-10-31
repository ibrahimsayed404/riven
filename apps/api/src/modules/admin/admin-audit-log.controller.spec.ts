import { autoMock, expectPassThrough, loose, routesOf } from '../../test-utils/controller-test.helpers';

import { AdminAuditLogController } from './admin-audit-log.controller';

// Unit tests for every route of AdminAuditLogController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('AdminAuditLogController (unit)', () => {
  let auditService: ReturnType<typeof autoMock>;
  let controller: AdminAuditLogController;

  beforeEach(() => {
    auditService = autoMock('auditService');
    controller = new AdminAuditLogController(auditService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(AdminAuditLogController)).toEqual([
      {
        "handler": "list",
        "method": "GET",
        "path": "/admin/audit-log",
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

  it('GET /admin/audit-log → auditService.list', async () => {
    const query = loose({ page: 2, limit: 5 });
    const result = await controller.list(query);
    expect(auditService.list).toHaveBeenCalledWith({
        actorId: query.actorId,
        targetType: query.targetType,
        targetId: query.targetId,
        action: query.action,
      },
      query.page ?? 1,
      query.limit ?? 20,);
    expect(auditService.list).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, auditService.list);
  });
});
