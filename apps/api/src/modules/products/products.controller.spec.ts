import { autoMock, expectPassThrough, loose, routesOf } from '../../test-utils/controller-test.helpers';

import { ProductsController } from './products.controller';

// Unit tests for every route of ProductsController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('ProductsController (unit)', () => {
  let productsService: ReturnType<typeof autoMock>;
  let controller: ProductsController;

  beforeEach(() => {
    productsService = autoMock('productsService');
    controller = new ProductsController(productsService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(ProductsController)).toEqual([
      {
        "handler": "listProducts",
        "method": "GET",
        "path": "/products",
        "guards": []
      },
      {
        "handler": "getProductById",
        "method": "GET",
        "path": "/products/:id",
        "guards": []
      }
    ]);
  });

  it('GET /products → productsService.listProducts', async () => {
    const query = loose({ page: 2, limit: 5 });
    const result = await controller.listProducts(query);
    expect(productsService.listProducts).toHaveBeenCalledWith(query);
    expect(productsService.listProducts).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, productsService.listProducts);
  });

  it('GET /products/:id → productsService.getProductById', async () => {
    const id = 'id-1';
    const result = await controller.getProductById(id);
    expect(productsService.getProductById).toHaveBeenCalledWith(id);
    expect(productsService.getProductById).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, productsService.getProductById);
  });
});
