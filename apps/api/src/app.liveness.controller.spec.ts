import { routesOf } from './test-utils/controller-test.helpers';
import { LivenessController } from './app.module';

// The public liveness check used by the host's health check: unauthenticated,
// static, and never touching a dependency (detailed checks: HealthModule).
describe('LivenessController (unit)', () => {
  it('declares exactly GET /health, with no guards', () => {
    expect(routesOf(LivenessController)).toEqual([{ handler: 'health', method: 'GET', path: '/health', guards: [] }]);
  });

  it('GET /health returns { status: "ok" }', () => {
    expect(new LivenessController().health()).toEqual({ status: 'ok' });
  });
});
