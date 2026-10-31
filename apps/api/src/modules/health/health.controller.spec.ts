import { autoMock, routesOf } from '../../test-utils/controller-test.helpers';

import { HealthController } from './health.controller';

// Unit tests for every route of HealthController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('HealthController (unit)', () => {
  let healthService: ReturnType<typeof autoMock>;
  let controller: HealthController;

  beforeEach(() => {
    healthService = autoMock('healthService');
    controller = new HealthController(healthService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(HealthController)).toEqual([
      {
        "handler": "dependencies",
        "method": "GET",
        "path": "/health/dependencies",
        "guards": [
          "HealthTokenGuard"
        ]
      },
      {
        "handler": "maintenance",
        "method": "GET",
        "path": "/health/maintenance",
        "guards": [
          "HealthTokenGuard"
        ]
      }
    ]);
  });
  // manual tests (handlers whose body is more than one service call)
  it('GET /health/dependencies → healthService.dependencies(); 200 body when ok', async () => {
    healthService.dependencies.mockResolvedValueOnce({ status: 'ok', postgres: 'up', redis: 'up' });
    await expect(controller.dependencies()).resolves.toEqual({ status: 'ok', postgres: 'up', redis: 'up' });
  });

  it('GET /health/dependencies → 503 DEPENDENCY_DOWN with the result as details when a dependency is down', async () => {
    const down = { status: 'alert', postgres: 'down', redis: 'up' };
    healthService.dependencies.mockResolvedValueOnce(down);
    await expect(controller.dependencies()).rejects.toMatchObject({
      status: 503,
      response: { code: 'DEPENDENCY_DOWN', details: down },
    });
  });

  it('GET /health/maintenance → healthService.maintenance(); 200 when ok, 503 MAINTENANCE_ALERT listing the open conditions', async () => {
    healthService.maintenance.mockResolvedValueOnce({ status: 'ok', checkedAt: 't', conditions: [] });
    await expect(controller.maintenance()).resolves.toMatchObject({ status: 'ok' });

    const alert = { status: 'alert', checkedAt: 't', conditions: [{ code: 'A1', severity: 'P1', detail: 'x' }, { code: 'A5', severity: 'P1', detail: 'y' }] };
    healthService.maintenance.mockResolvedValueOnce(alert);
    await expect(controller.maintenance()).rejects.toMatchObject({
      status: 503,
      response: { code: 'MAINTENANCE_ALERT', message: 'A1 (P1), A5 (P1)', details: alert },
    });
  });
});
