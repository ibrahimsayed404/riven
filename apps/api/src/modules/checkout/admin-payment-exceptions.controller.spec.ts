import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { AdminPaymentExceptionsController } from './admin-payment-exceptions.controller';

// Unit tests for every route of AdminPaymentExceptionsController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('AdminPaymentExceptionsController (unit)', () => {
  let paymentExceptionsService: ReturnType<typeof autoMock>;
  let controller: AdminPaymentExceptionsController;

  beforeEach(() => {
    paymentExceptionsService = autoMock('paymentExceptionsService');
    controller = new AdminPaymentExceptionsController(paymentExceptionsService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(AdminPaymentExceptionsController)).toEqual([
      { handler: 'list', method: 'GET', path: '/admin/payment-exceptions', guards: ['JwtAuthGuard', 'RolesGuard'], roles: ['ADMIN'] },
      { handler: 'get', method: 'GET', path: '/admin/payment-exceptions/:id', guards: ['JwtAuthGuard', 'RolesGuard'], roles: ['ADMIN'] },
      { handler: 'resolve', method: 'PATCH', path: '/admin/payment-exceptions/:id/resolve', guards: ['JwtAuthGuard', 'RolesGuard'], roles: ['ADMIN'] },
    ]);
  });

  it('GET /admin/payment-exceptions → paymentExceptionsService.listForAdmin (defaults page 1 / 20)', async () => {
    await controller.list(loose({}));
    expect(paymentExceptionsService.listForAdmin).toHaveBeenLastCalledWith({ status: undefined, type: undefined, orderGroupId: undefined, page: 1, limit: DEFAULT_PAGE_SIZE });
    const query = loose({ status: 'OPEN', type: 'LATE_PAYMENT', orderGroupId: 'og-1', page: 2, limit: 5 });
    const result = await controller.list(query);
    expect(paymentExceptionsService.listForAdmin).toHaveBeenLastCalledWith({ status: 'OPEN', type: 'LATE_PAYMENT', orderGroupId: 'og-1', page: 2, limit: 5 });
    await expectPassThrough(result, paymentExceptionsService.listForAdmin);
  });

  it('GET /admin/payment-exceptions/:id → paymentExceptionsService.getForAdmin', async () => {
    const result = await controller.get('id-1');
    expect(paymentExceptionsService.getForAdmin).toHaveBeenCalledWith('id-1');
    await expectPassThrough(result, paymentExceptionsService.getForAdmin);
  });

  it('PATCH /admin/payment-exceptions/:id/resolve → paymentExceptionsService.resolveForAdmin(admin.id from the token, id, note)', async () => {
    const admin = userOf(Role.ADMIN);
    const result = await controller.resolve(admin, 'id-1', loose({ note: 'Refunded manually, ref 77' }));
    expect(paymentExceptionsService.resolveForAdmin).toHaveBeenCalledWith(admin.id, 'id-1', 'Refunded manually, ref 77');
    await expectPassThrough(result, paymentExceptionsService.resolveForAdmin);
  });
});
