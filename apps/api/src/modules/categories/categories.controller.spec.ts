import { autoMock, expectPassThrough, routesOf } from '../../test-utils/controller-test.helpers';

import { CategoriesController } from './categories.controller';

// Unit tests for every route of CategoriesController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('CategoriesController (unit)', () => {
  let categoriesService: ReturnType<typeof autoMock>;
  let controller: CategoriesController;

  beforeEach(() => {
    categoriesService = autoMock('categoriesService');
    controller = new CategoriesController(categoriesService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(CategoriesController)).toEqual([
      {
        "handler": "getTree",
        "method": "GET",
        "path": "/categories",
        "guards": []
      }
    ]);
  });

  it('GET /categories → categoriesService.getTree', async () => {
    const result = await controller.getTree();
    expect(categoriesService.getTree).toHaveBeenCalledWith();
    expect(categoriesService.getTree).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, categoriesService.getTree);
  });
});
