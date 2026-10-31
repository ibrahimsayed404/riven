import { autoMock, expectPassThrough, loose, routesOf } from '../../test-utils/controller-test.helpers';

import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { AdminInventoryController } from './admin-inventory.controller';

// Unit tests for every route of AdminInventoryController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('AdminInventoryController (unit)', () => {
  let productsService: ReturnType<typeof autoMock>;
  let controller: AdminInventoryController;

  beforeEach(() => {
    productsService = autoMock('productsService');
    controller = new AdminInventoryController(productsService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(AdminInventoryController)).toEqual([
      { handler: 'listMovements', method: 'GET', path: '/admin/inventory-movements', guards: ['JwtAuthGuard', 'RolesGuard'], roles: ['ADMIN'] },
    ]);
  });

  it('GET /admin/inventory-movements → productsService.listInventoryMovementsForAdmin (defaults page 1 / 20)', async () => {
    await controller.listMovements(loose({}));
    expect(productsService.listInventoryMovementsForAdmin).toHaveBeenLastCalledWith({
      variantId: undefined, productId: undefined, orderGroupId: undefined, type: undefined, page: 1, limit: DEFAULT_PAGE_SIZE,
    });
    const query = loose({ variantId: 'v-1', productId: 'p-1', orderGroupId: 'og-1', type: 'RESERVE', page: 2, limit: 5 });
    const result = await controller.listMovements(query);
    expect(productsService.listInventoryMovementsForAdmin).toHaveBeenLastCalledWith({
      variantId: 'v-1', productId: 'p-1', orderGroupId: 'og-1', type: 'RESERVE', page: 2, limit: 5,
    });
    await expectPassThrough(result, productsService.listInventoryMovementsForAdmin);
  });
});
