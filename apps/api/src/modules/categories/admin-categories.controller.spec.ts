import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { AdminCategoriesController } from './admin-categories.controller';

// Unit tests for every route of AdminCategoriesController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('AdminCategoriesController (unit)', () => {
  let categoriesService: ReturnType<typeof autoMock>;
  let controller: AdminCategoriesController;

  beforeEach(() => {
    categoriesService = autoMock('categoriesService');
    controller = new AdminCategoriesController(categoriesService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(AdminCategoriesController)).toEqual([
      {
        "handler": "listCategories",
        "method": "GET",
        "path": "/admin/categories",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "createCategory",
        "method": "POST",
        "path": "/admin/categories",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "updateCategory",
        "method": "PATCH",
        "path": "/admin/categories/:id",
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
        "handler": "deleteCategory",
        "method": "DELETE",
        "path": "/admin/categories/:id",
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

  it('GET /admin/categories → categoriesService.listForAdmin', async () => {
    const result = await controller.listCategories();
    expect(categoriesService.listForAdmin).toHaveBeenCalledWith();
    expect(categoriesService.listForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, categoriesService.listForAdmin);
  });

  it('POST /admin/categories → categoriesService.createCategory', async () => {
    const admin = userOf(Role.ADMIN);
    const dto = loose({ sample: 'body' });
    const result = await controller.createCategory(admin, dto);
    expect(categoriesService.createCategory).toHaveBeenCalledWith(admin.id, dto);
    expect(categoriesService.createCategory).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, categoriesService.createCategory);
  });

  it('PATCH /admin/categories/:id → categoriesService.updateCategory', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const dto = loose({ sample: 'body' });
    const result = await controller.updateCategory(admin, id, dto);
    expect(categoriesService.updateCategory).toHaveBeenCalledWith(admin.id, id, dto);
    expect(categoriesService.updateCategory).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, categoriesService.updateCategory);
  });

  it('DELETE /admin/categories/:id → categoriesService.deleteCategory', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const result = await controller.deleteCategory(admin, id);
    expect(categoriesService.deleteCategory).toHaveBeenCalledWith(admin.id, id);
    expect(categoriesService.deleteCategory).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, categoriesService.deleteCategory);
  });
});
