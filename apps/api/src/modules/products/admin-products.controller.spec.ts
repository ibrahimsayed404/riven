import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { AdminProductsController } from './admin-products.controller';

// Unit tests for every route of AdminProductsController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('AdminProductsController (unit)', () => {
  let productsService: ReturnType<typeof autoMock>;
  let controller: AdminProductsController;

  beforeEach(() => {
    productsService = autoMock('productsService');
    controller = new AdminProductsController(productsService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(AdminProductsController)).toEqual([
      {
        "handler": "listProducts",
        "method": "GET",
        "path": "/admin/products",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "getProduct",
        "method": "GET",
        "path": "/admin/products/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "updateProduct",
        "method": "PATCH",
        "path": "/admin/products/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "deleteProduct",
        "method": "DELETE",
        "path": "/admin/products/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ],
        "httpCode": 204
      }
    ]);
  });

  it('GET /admin/products → productsService.listForAdmin', async () => {
    const query = loose({ page: 2, limit: 5 });
    const result = await controller.listProducts(query);
    expect(productsService.listForAdmin).toHaveBeenCalledWith({
      vendorId: query.vendorId,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    expect(productsService.listForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, productsService.listForAdmin);
  });

  it('GET /admin/products/:id → productsService.getProductForAdmin', async () => {
    const id = 'id-1';
    const result = await controller.getProduct(id);
    expect(productsService.getProductForAdmin).toHaveBeenCalledWith(id);
    expect(productsService.getProductForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, productsService.getProductForAdmin);
  });

  it('PATCH /admin/products/:id → productsService.updateProductForAdmin', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const dto = loose({ sample: 'body' });
    const result = await controller.updateProduct(admin, id, dto);
    expect(productsService.updateProductForAdmin).toHaveBeenCalledWith(admin.id, id, dto);
    expect(productsService.updateProductForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, productsService.updateProductForAdmin);
  });

  it('DELETE /admin/products/:id → productsService.deleteProductForAdmin', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const result = await controller.deleteProduct(admin, id);
    expect(productsService.deleteProductForAdmin).toHaveBeenCalledWith(admin.id, id);
    expect(productsService.deleteProductForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, productsService.deleteProductForAdmin);
  });
});
