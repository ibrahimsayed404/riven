/**
 * BullMQ (ioredis) connection options from REDIS_URL.
 *
 * Honours everything the URL can carry: the database number
 * (`redis://host:6379/2`), TLS (`rediss://`, what managed Redis providers hand
 * out) and URL-encoded credentials. Only host, port and the raw credentials
 * used to be read, so two environments pointed at different databases of one
 * Redis silently shared every queue — and a worker of one consumed the other's
 * search-sync jobs against the wrong index.
 */
export interface RedisConnection {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  tls?: Record<string, never>;
}

export function redisConnectionFromUrl(redisUrl: string): RedisConnection {
  const url = new URL(redisUrl);
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(`REDIS_URL must use redis:// or rediss://, got ${url.protocol}//`);
  }

  const dbPath = url.pathname.replace(/^\//, '');
  const db = dbPath === '' ? 0 : Number(dbPath);
  if (!Number.isInteger(db) || db < 0) {
    throw new Error(`REDIS_URL has an invalid database number: "${dbPath}"`);
  }

  return {
    host: url.hostname,
    port: parseInt(url.port || '6379', 10),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}
