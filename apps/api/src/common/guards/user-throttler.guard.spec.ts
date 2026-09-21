import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { UserThrottlerGuard } from './user-throttler.guard';

/**
 * The guard is an APP_GUARD and runs before JwtAuthGuard, so req.user is never
 * populated when it keys the request. It must derive the user from the bearer
 * token itself, or two users behind one NAT share every per-user limit.
 */
describe('UserThrottlerGuard.getTracker', () => {
  const jwt = new JwtService({ secret: 'test-secret-that-is-long-enough-for-hs256' });
  const guard = new UserThrottlerGuard(
    { throttlers: [{ ttl: 60_000, limit: 10 }] },
    {} as any,
    new Reflector(),
    jwt,
  );
  const tracker = (req: any) => (guard as any).getTracker(req) as Promise<string>;

  it('keys by the sub of a valid bearer token even though req.user is not set yet', async () => {
    const token = await jwt.signAsync({ sub: 'user-1', role: 'SHOPPER' });
    await expect(tracker({ ip: '1.1.1.1', headers: { authorization: `Bearer ${token}` } })).resolves.toBe('user:user-1');
  });

  it('two users on the same IP get different keys', async () => {
    const a = await jwt.signAsync({ sub: 'user-a' });
    const b = await jwt.signAsync({ sub: 'user-b' });
    const ka = await tracker({ ip: '1.1.1.1', headers: { authorization: `Bearer ${a}` } });
    const kb = await tracker({ ip: '1.1.1.1', headers: { authorization: `Bearer ${b}` } });
    expect(ka).not.toBe(kb);
  });

  it('falls back to the IP for a forged or expired token', async () => {
    const forged = await new JwtService({ secret: 'another-secret-entirely-not-the-real-one' }).signAsync({ sub: 'attacker' });
    await expect(tracker({ ip: '1.1.1.1', headers: { authorization: `Bearer ${forged}` } })).resolves.toBe('ip:1.1.1.1');
  });

  it('falls back to the IP with no Authorization header', async () => {
    await expect(tracker({ ip: '2.2.2.2', headers: {} })).resolves.toBe('ip:2.2.2.2');
  });

  it('prefers req.user when a later guard already populated it', async () => {
    await expect(tracker({ ip: '1.1.1.1', user: { id: 'user-9' }, headers: {} })).resolves.toBe('user:user-9');
  });
});
