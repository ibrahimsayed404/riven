import { redisConnectionFromUrl } from './redis-connection';

describe('redisConnectionFromUrl', () => {
  it('reads host and port, defaulting to database 0 and no TLS (the local docker URL)', () => {
    expect(redisConnectionFromUrl('redis://localhost:6379')).toEqual({
      host: 'localhost',
      port: 6379,
      username: undefined,
      password: undefined,
      db: 0,
    });
  });

  it('keeps the database number, so environments on one Redis get separate queues', () => {
    expect(redisConnectionFromUrl('redis://localhost:6379/1').db).toBe(1);
    expect(redisConnectionFromUrl('redis://localhost:6379/').db).toBe(0);
  });

  it('turns on TLS for rediss:// (managed Redis)', () => {
    const connection = redisConnectionFromUrl('rediss://default:secret@cache.example.com:6380/0');
    expect(connection).toMatchObject({ host: 'cache.example.com', port: 6380, username: 'default', password: 'secret', tls: {} });
  });

  it('decodes URL-encoded credentials', () => {
    expect(redisConnectionFromUrl('redis://:p%40ss%2Fword@localhost:6379').password).toBe('p@ss/word');
  });

  it('defaults the port to 6379', () => {
    expect(redisConnectionFromUrl('redis://cache').port).toBe(6379);
  });

  it.each(['redis://localhost:6379/abc', 'redis://localhost:6379/-1', 'redis://localhost:6379/1.5'])(
    'refuses an invalid database number: %s',
    (url) => {
      expect(() => redisConnectionFromUrl(url)).toThrow('invalid database number');
    },
  );

  it('refuses a non-Redis scheme', () => {
    expect(() => redisConnectionFromUrl('http://localhost:6379')).toThrow('redis:// or rediss://');
  });
});
