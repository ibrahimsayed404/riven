import { Type } from '@nestjs/common';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { RouteDefinition, routesOf } from './controller-test.helpers';

/**
 * Repository-wide guard rails for every HTTP route:
 * 1. every controller has a unit spec that calls every one of its handlers;
 * 2. owner and admin routes carry the authentication and role guards CLAUDE.md
 *    requires (admin → ADMIN only; /vendors/me → VENDOR; /organizers/me → ORGANIZER).
 * A new route without a unit test or without its guards fails here.
 */
const SRC = join(__dirname, '..');

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test-utils' ? [] : controllerFiles(path);
    return entry.name.endsWith('.controller.ts') ? [path] : [];
  });
}

interface Discovered {
  file: string;
  spec: string;
  controller: Type;
  routes: RouteDefinition[];
}

function discover(): Discovered[] {
  const found: Discovered[] = [];
  for (const file of controllerFiles(SRC)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const exported = require(file) as Record<string, unknown>;
    for (const value of Object.values(exported)) {
      if (typeof value === 'function' && value.name.endsWith('Controller')) {
        found.push({ file, spec: file.replace(/\.ts$/, '.spec.ts'), controller: value as Type, routes: routesOf(value as Type) });
      }
    }
  }
  // The liveness controller is declared inline in app.module.ts.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const app = require(join(SRC, 'app.module')) as { LivenessController: Type };
  found.push({
    file: join(SRC, 'app.module.ts'),
    spec: join(SRC, 'app.liveness.controller.spec.ts'),
    controller: app.LivenessController,
    routes: routesOf(app.LivenessController),
  });
  return found;
}

const controllers = discover();
const allRoutes = controllers.flatMap((c) => c.routes.map((r) => ({ ...r, controller: c.controller.name, spec: c.spec })));

describe('Route coverage and route security (all controllers)', () => {
  it('finds every controller and route (145 routes as of 2026-10-31)', () => {
    expect(controllers.length).toBeGreaterThanOrEqual(39);
    expect(allRoutes.length).toBeGreaterThanOrEqual(145);
  });

  it('no two routes share the same method and path', () => {
    const keys = allRoutes.map((r) => `${r.method} ${r.path}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it.each(allRoutes.map((r) => [`${r.method} ${r.path}`, r] as const))('%s has a unit test calling its handler', (_name, route) => {
    let spec: string;
    try {
      spec = readFileSync(route.spec, 'utf8');
    } catch {
      throw new Error(`${route.controller} has no unit spec (${route.spec})`);
    }
    expect(spec).toMatch(new RegExp(`\\.${route.handler}\\(`));
  });

  const adminRoutes = allRoutes.filter((r) => r.path.startsWith('/admin'));
  it.each(adminRoutes.map((r) => [`${r.method} ${r.path}`, r] as const))('%s is ADMIN-only behind JwtAuthGuard + RolesGuard', (_name, route) => {
    expect(route.guards).toEqual(expect.arrayContaining(['JwtAuthGuard', 'RolesGuard']));
    expect(route.roles).toEqual(['ADMIN']);
  });

  const vendorRoutes = allRoutes.filter((r) => r.path.startsWith('/vendors/me'));
  it.each(vendorRoutes.map((r) => [`${r.method} ${r.path}`, r] as const))('%s is VENDOR-only behind JwtAuthGuard + RolesGuard', (_name, route) => {
    expect(route.guards).toEqual(expect.arrayContaining(['JwtAuthGuard', 'RolesGuard']));
    expect(route.roles).toEqual(['VENDOR']);
  });

  const organizerRoutes = allRoutes.filter((r) => r.path.startsWith('/organizers/me'));
  it.each(organizerRoutes.map((r) => [`${r.method} ${r.path}`, r] as const))('%s is ORGANIZER-only behind JwtAuthGuard + RolesGuard', (_name, route) => {
    expect(route.guards).toEqual(expect.arrayContaining(['JwtAuthGuard', 'RolesGuard']));
    expect(route.roles).toEqual(['ORGANIZER']);
  });

  it('every route with roles also has both guards (a role without RolesGuard is never enforced)', () => {
    const broken = allRoutes.filter((r) => r.roles && !(r.guards.includes('JwtAuthGuard') && r.guards.includes('RolesGuard')));
    expect(broken.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  // Routes that are expensive or abusable (credential guessing, stock holds,
  // presign spam, maintenance runs) carry a per-route limit below the global
  // 300/min. A limit removed or loosened by accident fails here.
  it.each([
    ['POST /auth/register', 10],
    ['POST /auth/register/vendor', 10],
    ['POST /auth/register/organizer', 10],
    ['POST /auth/login', 10],
    ['POST /auth/refresh', 30],
    ['POST /checkout', 10],
    ['POST /checkout/:orderGroupId/retry-payment', 10],
    ['POST /media/upload-url', 30],
    ['POST /admin/maintenance/expire-overdue', 10],
    ['PATCH /users/me/location', 1],
    ['PATCH /vendors/me/location', 1],
    ['POST /admin/outbox/drain', 6],
    ['POST /vendors/me/barcodes', 60],
    ['POST /admin/barcodes/lookup', 120],
    ['POST /webhooks/paymob', 600],
  ] as const)('%s is throttled to at most %i/min', (key, maxPerMinute) => {
    const route = allRoutes.find((r) => `${r.method} ${r.path}` === key);
    expect(route).toBeDefined();
    const owner = controllers.find((c) => c.controller.name === route!.controller)!.controller;
    const handler = (owner.prototype as Record<string, unknown>)[route!.handler] as object;
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBeLessThanOrEqual(maxPerMinute);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
  });

  it('personal routes (/users/me, /cart, /orders, /checkout) require authentication', () => {
    const personal = allRoutes.filter((r) => /^\/(users\/me|cart|orders|checkout)(\/|$)/.test(r.path));
    expect(personal.length).toBeGreaterThan(0);
    expect(personal.filter((r) => !r.guards.includes('JwtAuthGuard')).map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });
});
