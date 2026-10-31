import { autoMock, expectPassThrough, loose, routesOf } from '../../test-utils/controller-test.helpers';

import { PublicBazaarsController } from './public-bazaars.controller';

// Unit tests for every route of PublicBazaarsController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('PublicBazaarsController (unit)', () => {
  let bazaarsService: ReturnType<typeof autoMock>;
  let controller: PublicBazaarsController;

  beforeEach(() => {
    bazaarsService = autoMock('bazaarsService');
    controller = new PublicBazaarsController(bazaarsService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(PublicBazaarsController)).toEqual([
      {
        "handler": "getBazaars",
        "method": "GET",
        "path": "/bazaars",
        "guards": []
      },
      {
        "handler": "getBazaar",
        "method": "GET",
        "path": "/bazaars/:id",
        "guards": []
      }
    ]);
  });

  it('GET /bazaars/:id → bazaarsService.getPublicBazaarById', async () => {
    const id = 'id-1';
    const result = await controller.getBazaar(id);
    expect(bazaarsService.getPublicBazaarById).toHaveBeenCalledWith(id);
    expect(bazaarsService.getPublicBazaarById).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, bazaarsService.getPublicBazaarById);
  });
  // manual tests (handlers whose body is more than one service call)
  it('GET /bazaars → bazaarsService.getPublicBazaars(page, limit, remaining filters)', async () => {
    await controller.getBazaars(loose({}));
    expect(bazaarsService.getPublicBazaars).toHaveBeenLastCalledWith(1, 20, {});
    const result = await controller.getBazaars(loose({ page: 2, limit: 9, status: 'PUBLISHED', q: 'craft' }));
    expect(bazaarsService.getPublicBazaars).toHaveBeenLastCalledWith(2, 9, { status: 'PUBLISHED', q: 'craft' });
    await expectPassThrough(result, bazaarsService.getPublicBazaars);
  });
});
