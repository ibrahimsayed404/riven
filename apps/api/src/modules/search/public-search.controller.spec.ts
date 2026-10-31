import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { PublicSearchController } from './public-search.controller';

// Unit tests for every route of PublicSearchController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('PublicSearchController (unit)', () => {
  let searchService: ReturnType<typeof autoMock>;
  let controller: PublicSearchController;

  beforeEach(() => {
    searchService = autoMock('searchService');
    controller = new PublicSearchController(searchService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(PublicSearchController)).toEqual([
      {
        "handler": "searchAll",
        "method": "GET",
        "path": "/search",
        "guards": [
          "OptionalJwtAuthGuard"
        ]
      },
      {
        "handler": "searchProducts",
        "method": "GET",
        "path": "/search/products",
        "guards": [
          "OptionalJwtAuthGuard"
        ]
      },
      {
        "handler": "searchVendors",
        "method": "GET",
        "path": "/search/vendors",
        "guards": [
          "OptionalJwtAuthGuard"
        ]
      },
      {
        "handler": "searchBazaars",
        "method": "GET",
        "path": "/search/bazaars",
        "guards": [
          "OptionalJwtAuthGuard"
        ]
      }
    ]);
  });

  it('GET /search → searchService.searchAll', async () => {
    const query = loose({ page: 2, limit: 5 });
    const userId = userOf(Role.SHOPPER).id;
    const result = await controller.searchAll(query, userId);
    expect(searchService.searchAll).toHaveBeenCalledWith(query, userId);
    expect(searchService.searchAll).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, searchService.searchAll);
  });

  it('GET /search/products → searchService.searchProducts', async () => {
    const query = loose({ page: 2, limit: 5 });
    const userId = userOf(Role.SHOPPER).id;
    const result = await controller.searchProducts(query, userId);
    expect(searchService.searchProducts).toHaveBeenCalledWith(query, userId);
    expect(searchService.searchProducts).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, searchService.searchProducts);
  });

  it('GET /search/vendors → searchService.searchVendors', async () => {
    const query = loose({ page: 2, limit: 5 });
    const userId = userOf(Role.SHOPPER).id;
    const result = await controller.searchVendors(query, userId);
    expect(searchService.searchVendors).toHaveBeenCalledWith(query, userId);
    expect(searchService.searchVendors).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, searchService.searchVendors);
  });

  it('GET /search/bazaars → searchService.searchBazaars', async () => {
    const query = loose({ page: 2, limit: 5 });
    const userId = userOf(Role.SHOPPER).id;
    const result = await controller.searchBazaars(query, userId);
    expect(searchService.searchBazaars).toHaveBeenCalledWith(query, userId);
    expect(searchService.searchBazaars).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, searchService.searchBazaars);
  });
});
