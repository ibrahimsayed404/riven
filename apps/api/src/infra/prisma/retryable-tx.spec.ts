import { Prisma } from '@prisma/client';

import { isContentionError, isRetryableTxError, withRetryableTx } from './retryable-tx';

const known = (code: string, sqlState?: string) =>
  new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 't', meta: sqlState ? { code: sqlState } : undefined });

describe('withRetryableTx / contention classification (commerce/25 §11 – §12)', () => {
  it.each([
    ['serialization failure P2034', known('P2034'), true],
    ['transaction timeout P2028', known('P2028'), true],
    ['dropped connection P1017', known('P1017'), true],
    ['raw-query deadlock 40P01', known('P2010', '40P01'), true],
    ['raw-query serialization 40001', known('P2010', '40001'), true],
    ['lock timeout 55P03 (not retried: the caller decides)', known('P2010', '55P03'), false],
    ['unique violation P2002', known('P2002'), false],
  ])('%s → retryable: %s', (_label, error, retryable) => {
    expect(isRetryableTxError(error)).toBe(retryable);
  });

  it.each([
    ['lock timeout 55P03', known('P2010', '55P03')],
    ['statement timeout 57014', known('P2010', '57014')],
    ['statement timeout in an unknown-request error', new Prisma.PrismaClientUnknownRequestError('canceling statement due to statement timeout', { clientVersion: 't' })],
    ['an exhausted deadlock', known('P2010', '40P01')],
  ])('%s is contention (503), not a bug', (_label, error) => {
    expect(isContentionError(error)).toBe(true);
  });

  it('a real bug is not contention', () => {
    expect(isContentionError(new Error('TypeError: x is undefined'))).toBe(false);
    expect(isContentionError(known('P2002'))).toBe(false);
  });

  it('retries a transient failure up to the attempt limit, then gives up', async () => {
    const work = jest.fn().mockRejectedValue(known('P2034'));
    await expect(withRetryableTx(work, { attempts: 3, baseDelayMs: 1 })).rejects.toMatchObject({ code: 'P2034' });
    expect(work).toHaveBeenCalledTimes(3);
  });

  it('never retries a non-transient failure', async () => {
    const work = jest.fn().mockRejectedValue(known('P2002'));
    await expect(withRetryableTx(work, { attempts: 3, baseDelayMs: 1 })).rejects.toMatchObject({ code: 'P2002' });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('starts no new attempt once the deadline has passed', async () => {
    let now = 1_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const work = jest.fn().mockImplementation(async () => {
        now += 5_000; // each attempt takes 5 s
        throw known('P2034');
      });
      await expect(withRetryableTx(work, { attempts: 5, baseDelayMs: 1, deadline: 8_000 })).rejects.toMatchObject({ code: 'P2034' });
      expect(work).toHaveBeenCalledTimes(2); // 1st ends at 6 s (< 8 s → retry), 2nd ends at 11 s (past → stop)
    } finally {
      clock.mockRestore();
    }
  });
});
