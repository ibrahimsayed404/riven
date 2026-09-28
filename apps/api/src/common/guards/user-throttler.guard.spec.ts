import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';

import { UserThrottlerGuard } from './user-throttler.guard';

/**
 * These cover the tracker only — the rest of ThrottlerGuard is the library's.
 *
 * The case that matters: this guard is an APP_GUARD, so Nest runs it before
 * JwtAuthGuard and `req.user` is always undefined when getTracker is called.
 * Every request on every route was therefore keyed by IP, which quietly turned
 * "one location update per minute per user" into "per IP" — two people behind
 * one NAT blocked each other, and an anonymous caller could spend the bucket.
 */
describe('UserThrottlerGuard.getTracker', () => {
  const secret = 'test-secret-that-is-at-least-32-chars-long';
  const jwtService = new JwtService({ secret });

  function guardWith(jwt: JwtService = jwtService): UserThrottlerGuard {
    return new UserThrottlerGuard(
      [{ name: 'default', ttl: 60_000, limit: 300 }] as unknown as ThrottlerModuleOptions,
      { increment: jest.fn() } as unknown as ThrottlerStorage,
      new Reflector(),
      jwt,
    );
  }

  // getTracker is protected; these tests exercise it the way the base class does.
  const track = (guard: UserThrottlerGuard, req: unknown): Promise<string> =>
    (guard as unknown as { getTracker(req: unknown): Promise<string> }).getTracker(req);

  it('keys by the token subject when req.user is not populated yet (the APP_GUARD case)', async () => {
    const token = await jwtService.signAsync({ sub: 'user-1', role: 'SHOPPER' });

    const tracker = await track(guardWith(), {
      ip: '10.0.0.1',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(tracker).toBe('user:user-1');
  });

  it('gives two users on the same IP separate buckets', async () => {
    const guard = guardWith();
    const headersFor = async (sub: string) => ({
      authorization: `Bearer ${await jwtService.signAsync({ sub, role: 'SHOPPER' })}`,
    });

    const first = await track(guard, { ip: '10.0.0.1', headers: await headersFor('user-1') });
    const second = await track(guard, { ip: '10.0.0.1', headers: await headersFor('user-2') });

    expect(first).not.toBe(second);
  });

  it('prefers req.user when a route-level guard has already populated it', async () => {
    const tracker = await track(guardWith(), {
      ip: '10.0.0.1',
      user: { id: 'user-from-request' },
      headers: { authorization: 'Bearer nonsense' },
    });

    expect(tracker).toBe('user:user-from-request');
  });

  it('falls back to the IP for an anonymous caller', async () => {
    expect(await track(guardWith(), { ip: '10.0.0.1', headers: {} })).toBe('ip:10.0.0.1');
    expect(await track(guardWith(), {})).toBe('ip:unknown');
  });

  it('falls back to the IP rather than trusting an unverifiable token', async () => {
    const forged = await new JwtService({ secret: 'a-different-secret-of-sufficient-length' }).signAsync({
      sub: 'attacker-chosen-id',
    });
    const expired = await jwtService.signAsync({ sub: 'user-1' }, { expiresIn: '-1s' });

    // A forged sub would otherwise hand the caller a fresh bucket per request.
    expect(await track(guardWith(), { ip: '10.0.0.1', headers: { authorization: `Bearer ${forged}` } })).toBe(
      'ip:10.0.0.1',
    );
    expect(await track(guardWith(), { ip: '10.0.0.1', headers: { authorization: `Bearer ${expired}` } })).toBe(
      'ip:10.0.0.1',
    );
    expect(await track(guardWith(), { ip: '10.0.0.1', headers: { authorization: 'Basic abc' } })).toBe('ip:10.0.0.1');
  });

  it('prefers the forwarded client address over the socket address when one is present', async () => {
    expect(await track(guardWith(), { ip: '10.0.0.1', ips: ['203.0.113.7', '10.0.0.1'], headers: {} })).toBe(
      'ip:203.0.113.7',
    );
  });
});
