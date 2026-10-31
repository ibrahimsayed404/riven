import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { VendorsController } from './vendors.controller';

// Unit tests for every route of VendorsController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('VendorsController (unit)', () => {
  let vendorsService: ReturnType<typeof autoMock>;
  let controller: VendorsController;

  beforeEach(() => {
    vendorsService = autoMock('vendorsService');
    controller = new VendorsController(vendorsService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(VendorsController)).toEqual([
      {
        "handler": "getMyProfile",
        "method": "GET",
        "path": "/vendors/me",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ]
      },
      {
        "handler": "updateMyProfile",
        "method": "PATCH",
        "path": "/vendors/me",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ]
      },
      {
        "handler": "updateMyLocation",
        "method": "PATCH",
        "path": "/vendors/me/location",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ],
        "httpCode": 204
      },
      {
        "handler": "getVendorById",
        "method": "GET",
        "path": "/vendors/:id",
        "guards": []
      },
      {
        "handler": "getMyProducts",
        "method": "GET",
        "path": "/vendors/me/products",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ]
      },
      {
        "handler": "createProduct",
        "method": "POST",
        "path": "/vendors/me/products",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ]
      },
      {
        "handler": "getMyProduct",
        "method": "GET",
        "path": "/vendors/me/products/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ]
      },
      {
        "handler": "updateProduct",
        "method": "PATCH",
        "path": "/vendors/me/products/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ]
      },
      {
        "handler": "deleteProduct",
        "method": "DELETE",
        "path": "/vendors/me/products/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ]
      },
      {
        "handler": "createProductVariant",
        "method": "POST",
        "path": "/vendors/me/products/:id/variants",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ]
      },
      {
        "handler": "updateProductVariant",
        "method": "PATCH",
        "path": "/vendors/me/products/:id/variants/:variantId",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ]
      },
      {
        "handler": "adjustVariantStock",
        "method": "POST",
        "path": "/vendors/me/products/:id/variants/:variantId/stock-adjustments",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ]
      },
      {
        "handler": "getVariantStockMovements",
        "method": "GET",
        "path": "/vendors/me/products/:id/variants/:variantId/stock-movements",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ]
      },
      {
        "handler": "deleteProductVariant",
        "method": "DELETE",
        "path": "/vendors/me/products/:id/variants/:variantId",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ]
      }
    ]);
  });

  it('GET /vendors/me → vendorsService.getMyProfile', async () => {
    const user = userOf(Role.VENDOR);
    const result = await controller.getMyProfile(user);
    expect(vendorsService.getMyProfile).toHaveBeenCalledWith(user.id);
    expect(vendorsService.getMyProfile).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, vendorsService.getMyProfile);
  });

  it('PATCH /vendors/me → vendorsService.updateMyProfile', async () => {
    const user = userOf(Role.VENDOR);
    const updateDto = loose({ sample: 'body' });
    const result = await controller.updateMyProfile(user, updateDto);
    expect(vendorsService.updateMyProfile).toHaveBeenCalledWith(user.id, updateDto);
    expect(vendorsService.updateMyProfile).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, vendorsService.updateMyProfile);
  });

  it('PATCH /vendors/me/location → vendorsService.updateMyLocation', async () => {
    const user = userOf(Role.VENDOR);
    const locationDto = loose({ sample: 'body' });
    const result = await controller.updateMyLocation(user, locationDto);
    expect(vendorsService.updateMyLocation).toHaveBeenCalledWith(user.id, locationDto);
    expect(vendorsService.updateMyLocation).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, vendorsService.updateMyLocation);
  });

  it('GET /vendors/:id → vendorsService.getVendorById', async () => {
    const id = 'id-1';
    const result = await controller.getVendorById(id);
    expect(vendorsService.getVendorById).toHaveBeenCalledWith(id);
    expect(vendorsService.getVendorById).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, vendorsService.getVendorById);
  });

  it('GET /vendors/me/products → vendorsService.getMyProducts', async () => {
    const user = userOf(Role.VENDOR);
    const query = loose({ page: 2, limit: 5 });
    const result = await controller.getMyProducts(user, query);
    expect(vendorsService.getMyProducts).toHaveBeenCalledWith(user.id, query.page ?? 1, query.limit ?? 20);
    expect(vendorsService.getMyProducts).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, vendorsService.getMyProducts);
  });

  it('POST /vendors/me/products → vendorsService.createProduct', async () => {
    const user = userOf(Role.VENDOR);
    const createDto = loose({ sample: 'body' });
    const result = await controller.createProduct(user, createDto);
    expect(vendorsService.createProduct).toHaveBeenCalledWith(user.id, createDto);
    expect(vendorsService.createProduct).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, vendorsService.createProduct);
  });

  it('GET /vendors/me/products/:id → vendorsService.getMyProduct', async () => {
    const user = userOf(Role.VENDOR);
    const productId = 'id-1';
    const result = await controller.getMyProduct(user, productId);
    expect(vendorsService.getMyProduct).toHaveBeenCalledWith(user.id, productId);
    expect(vendorsService.getMyProduct).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, vendorsService.getMyProduct);
  });

  it('PATCH /vendors/me/products/:id → vendorsService.updateProduct', async () => {
    const user = userOf(Role.VENDOR);
    const productId = 'id-1';
    const updateDto = loose({ sample: 'body' });
    const result = await controller.updateProduct(user, productId, updateDto);
    expect(vendorsService.updateProduct).toHaveBeenCalledWith(user.id, productId, updateDto);
    expect(vendorsService.updateProduct).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, vendorsService.updateProduct);
  });

  it('DELETE /vendors/me/products/:id → vendorsService.deleteProduct', async () => {
    const user = userOf(Role.VENDOR);
    const productId = 'id-1';
    const result = await controller.deleteProduct(user, productId);
    expect(vendorsService.deleteProduct).toHaveBeenCalledWith(user.id, productId);
    expect(vendorsService.deleteProduct).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, vendorsService.deleteProduct);
  });

  it('POST /vendors/me/products/:id/variants → vendorsService.createProductVariant', async () => {
    const user = userOf(Role.VENDOR);
    const productId = 'id-1';
    const createVariantDto = loose({ sample: 'body' });
    const result = await controller.createProductVariant(user, productId, createVariantDto);
    expect(vendorsService.createProductVariant).toHaveBeenCalledWith(user.id, productId, createVariantDto);
    expect(vendorsService.createProductVariant).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, vendorsService.createProductVariant);
  });

  it('PATCH /vendors/me/products/:id/variants/:variantId → vendorsService.updateProductVariant', async () => {
    const user = userOf(Role.VENDOR);
    const productId = 'id-1';
    const variantId = 'variantId-1';
    const updateVariantDto = loose({ sample: 'body' });
    const result = await controller.updateProductVariant(user, productId, variantId, updateVariantDto);
    expect(vendorsService.updateProductVariant).toHaveBeenCalledWith(user.id, productId, variantId, updateVariantDto);
    expect(vendorsService.updateProductVariant).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, vendorsService.updateProductVariant);
  });

  it('POST /vendors/me/products/:id/variants/:variantId/stock-adjustments → vendorsService.adjustVariantStock (owner from the token)', async () => {
    const user = userOf(Role.VENDOR);
    const dto = loose({ change: -2, reason: 'two damaged in storage' });
    const result = await controller.adjustVariantStock(user, 'prod-1', 'var-1', dto);
    expect(vendorsService.adjustVariantStock).toHaveBeenCalledWith(user.id, 'prod-1', 'var-1', dto);
    await expectPassThrough(result, vendorsService.adjustVariantStock);
  });

  it('GET /vendors/me/products/:id/variants/:variantId/stock-movements → vendorsService.getVariantStockMovements (defaults 1 / 20)', async () => {
    const user = userOf(Role.VENDOR);
    await controller.getVariantStockMovements(user, 'prod-1', 'var-1', loose({}));
    expect(vendorsService.getVariantStockMovements).toHaveBeenLastCalledWith(user.id, 'prod-1', 'var-1', 1, 20);
    const result = await controller.getVariantStockMovements(user, 'prod-1', 'var-1', loose({ page: 3, limit: 5 }));
    expect(vendorsService.getVariantStockMovements).toHaveBeenLastCalledWith(user.id, 'prod-1', 'var-1', 3, 5);
    await expectPassThrough(result, vendorsService.getVariantStockMovements);
  });

  it('DELETE /vendors/me/products/:id/variants/:variantId → vendorsService.deleteProductVariant', async () => {
    const user = userOf(Role.VENDOR);
    const productId = 'id-1';
    const variantId = 'variantId-1';
    const result = await controller.deleteProductVariant(user, productId, variantId);
    expect(vendorsService.deleteProductVariant).toHaveBeenCalledWith(user.id, productId, variantId);
    expect(vendorsService.deleteProductVariant).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, vendorsService.deleteProductVariant);
  });
});
