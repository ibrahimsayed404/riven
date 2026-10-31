import 'reflect-metadata';
import { RequestMethod, Type } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Role } from '@prisma/client';

import { ROLES_KEY } from '../modules/auth/decorators/roles.decorator';

/**
 * Unit-test helpers for controllers: read the route definition Nest builds
 * from decorators (method, path, guards, roles, status code) without booting
 * an application, and auto-mock the injected services.
 */

export interface RouteDefinition {
  handler: string;
  method: string;
  path: string;
  guards: string[];
  roles: Role[] | undefined;
  httpCode: number | undefined;
}

function joinPath(base: string | string[] | undefined, sub: string | string[] | undefined): string {
  const first = (Array.isArray(base) ? base[0] : base) ?? '';
  const second = (Array.isArray(sub) ? sub[0] : sub) ?? '';
  const joined = ['', first, second].join('/').replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

function guardNames(target: object | undefined): string[] {
  const guards = (target ? Reflect.getMetadata(GUARDS_METADATA, target) : undefined) as (Type | object)[] | undefined;
  return (guards ?? []).map((g) => (typeof g === 'function' ? g.name : g.constructor.name));
}

/** Every route handler of a controller class, with its effective guards and roles (method-level overrides class-level roles). */
export function routesOf(controller: Type): RouteDefinition[] {
  const base = Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined;
  const classGuards = guardNames(controller);
  const classRoles = Reflect.getMetadata(ROLES_KEY, controller) as Role[] | undefined;
  const proto = controller.prototype as Record<string, unknown>;

  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && typeof proto[name] === 'function')
    .filter((name) => Reflect.hasMetadata(METHOD_METADATA, proto[name] as object))
    .map((name) => {
      const fn = proto[name] as object;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod];
      return {
        handler: name,
        method,
        path: joinPath(base, Reflect.getMetadata(PATH_METADATA, fn) as string | undefined),
        guards: [...classGuards, ...guardNames(fn)],
        roles: (Reflect.getMetadata(ROLES_KEY, fn) as Role[] | undefined) ?? classRoles,
        httpCode: Reflect.getMetadata(HTTP_CODE_METADATA, fn) as number | undefined,
      };
    });
}

/** The route of one handler; throws if it is not a route. */
export function routeOf(controller: Type, handler: string): RouteDefinition {
  const route = routesOf(controller).find((r) => r.handler === handler);
  if (!route) throw new Error(`${controller.name}.${handler} is not a route handler`);
  return route;
}

/** `METHOD /path` strings, sorted — a compact snapshot of a controller's routes. */
export function routeTable(controller: Type): string[] {
  return routesOf(controller)
    .map((r) => `${r.method} ${r.path}`)
    .sort();
}

export type AutoMock<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? jest.Mock<R, A> : T[K] } & Record<string, jest.Mock>;

/**
 * A service double whose every method is a jest.fn() created on first access,
 * resolving to a unique marker by default so tests can assert pass-through.
 */
export function autoMock<T>(name = 'service'): AutoMock<T> {
  const fns = new Map<string | symbol, jest.Mock>();
  return new Proxy({} as AutoMock<T>, {
    get(_target, prop) {
      if (prop === 'then') return undefined; // not a thenable
      if (!fns.has(prop)) {
        fns.set(prop, jest.fn().mockResolvedValue({ [`${name}.${String(prop)}`]: true }));
      }
      return fns.get(prop);
    },
  });
}

/** The value a handler returns is exactly what the mocked service method resolved to. */
export async function expectPassThrough(result: unknown, mock: jest.Mock) {
  const expected = mock.mock.results[mock.mock.results.length - 1]?.value;
  await expect(Promise.resolve(result)).resolves.toEqual(await expected);
}

/** A minimal authenticated user as @CurrentUser() would inject it. */
export function userOf(role: Role, id = `${role.toLowerCase()}-1`): { id: string; role: Role; email: string; name: string } {
  return { id, role, email: `${id}@example.com`, name: 'Test User' };
}

/**
 * A sample request body / query object for a handler. Typed loosely on purpose:
 * the controller only forwards it, and the test asserts the forwarded values.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loose(value: Record<string, unknown>): any {
  return value;
}
