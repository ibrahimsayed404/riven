import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { PublicDiscoveryController } from './public-discovery.controller';

// Unit tests for every route of PublicDiscoveryController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('PublicDiscoveryController (unit)', () => {
  let discoveryService: ReturnType<typeof autoMock>;
  let controller: PublicDiscoveryController;

  beforeEach(() => {
    discoveryService = autoMock('discoveryService');
    controller = new PublicDiscoveryController(discoveryService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(PublicDiscoveryController)).toEqual([
      {
        "handler": "discoverBazaars",
        "method": "GET",
        "path": "/discovery/bazaars",
        "guards": [
          "OptionalJwtAuthGuard"
        ]
      }
    ]);
  });

  it('GET /discovery/bazaars → discoveryService.discoverBazaars', async () => {
    const query = loose({ page: 2, limit: 5 });
    const userId = userOf(Role.SHOPPER).id;
    const result = await controller.discoverBazaars(query, userId);
    expect(discoveryService.discoverBazaars).toHaveBeenCalledWith(query, userId);
    expect(discoveryService.discoverBazaars).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, discoveryService.discoverBazaars);
  });
});
