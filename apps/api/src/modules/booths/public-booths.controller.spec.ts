import { autoMock, expectPassThrough, routesOf } from '../../test-utils/controller-test.helpers';

import { PublicBoothsController } from './public-booths.controller';

// Unit tests for every route of PublicBoothsController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('PublicBoothsController (unit)', () => {
  let boothsService: ReturnType<typeof autoMock>;
  let controller: PublicBoothsController;

  beforeEach(() => {
    boothsService = autoMock('boothsService');
    controller = new PublicBoothsController(boothsService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(PublicBoothsController)).toEqual([
      {
        "handler": "getPublicLayout",
        "method": "GET",
        "path": "/bazaars/:bazaarId/layout",
        "guards": []
      }
    ]);
  });

  it('GET /bazaars/:bazaarId/layout → boothsService.getPublicLayout', async () => {
    const bazaarId = 'bazaarId-1';
    const result = await controller.getPublicLayout(bazaarId);
    expect(boothsService.getPublicLayout).toHaveBeenCalledWith(bazaarId);
    expect(boothsService.getPublicLayout).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, boothsService.getPublicLayout);
  });
});
