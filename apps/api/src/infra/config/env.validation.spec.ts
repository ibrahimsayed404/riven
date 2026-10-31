import { validateEnv } from './env.validation';

/** A complete, valid production-style configuration; each test breaks one thing. */
const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  DATABASE_URL: 'postgresql://riven:s3cret-db@db.example.com:5432/riven',
  REDIS_URL: 'redis://cache.example.com:6379',
  MEILISEARCH_HOST: 'https://search.example.com',
  MEILISEARCH_API_KEY: 'meili-prod-key',
  JWT_SECRET: 'a'.repeat(48),
  JWT_ACCESS_TOKEN_TTL: '15m',
  JWT_REFRESH_TOKEN_TTL: '30d',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_REGION: 'eu-central-1',
  S3_BUCKET: 'riven',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  S3_SECRET_ACCESS_KEY: 'prod-secret-key',
  S3_PUBLIC_URL: 'https://cdn.example.com',
  NODE_ENV: 'production',
  ...over,
});

describe('validateEnv (commerce/25 §10 – §11)', () => {
  it('accepts a complete production configuration', () => {
    expect(validateEnv(base()).NODE_ENV).toBe('production');
  });

  it('production refuses the .env.example JWT placeholder', () => {
    expect(() => validateEnv(base({ JWT_SECRET: 'replace_with_a_long_random_secret_at_least_32_chars' }))).toThrow(/JWT_SECRET is still the \.env\.example placeholder/);
  });

  it.each([
    ['DATABASE_URL', 'postgresql://riven:riven_dev_password@db.example.com:5432/riven'],
    ['MEILISEARCH_API_KEY', 'riven_dev_master_key'],
    ['S3_SECRET_ACCESS_KEY', 'riven_dev_password'],
  ])('production refuses the published development secret in %s', (name, value) => {
    expect(() => validateEnv(base({ [name]: value }))).toThrow(new RegExp(`${name} still use the published development secrets`));
  });

  it('development keeps working with the published placeholders (local setup unchanged)', () => {
    expect(() =>
      validateEnv(
        base({
          NODE_ENV: 'development',
          JWT_SECRET: 'replace_with_a_long_random_secret_at_least_32_chars',
          DATABASE_URL: 'postgresql://riven:riven_dev_password@localhost:5433/riven',
        }),
      ),
    ).not.toThrow();
  });

  it('a Paymob webhook secret requires the integration and merchant pins (delimiter-less HMAC)', () => {
    expect(() => validateEnv(base({ NODE_ENV: 'development', PAYMOB_HMAC_SECRET: 'hmac' }))).toThrow(/requires PAYMOB_INTEGRATION_ID and PAYMOB_MERCHANT_ID/);
    expect(() => validateEnv(base({ NODE_ENV: 'development', PAYMOB_HMAC_SECRET: 'hmac', PAYMOB_INTEGRATION_ID: '12' }))).toThrow(/PAYMOB_MERCHANT_ID/);
    expect(() =>
      validateEnv(base({ NODE_ENV: 'development', PAYMOB_HMAC_SECRET: 'hmac', PAYMOB_INTEGRATION_ID: '12', PAYMOB_MERCHANT_ID: '7' })),
    ).not.toThrow();
    expect(() => validateEnv(base({ PAYMOB_MERCHANT_ID: 'abc' }))).toThrow();
    // a leading zero could never equal the signed integer the webhook compares it with
    expect(() => validateEnv(base({ PAYMOB_MERCHANT_ID: '0123' }))).toThrow();
    expect(() => validateEnv(base({ PAYMOB_INTEGRATION_ID: '012' }))).toThrow();
  });

  it('Paymob off entirely (no secret) needs no pins', () => {
    expect(() => validateEnv(base({ PAYMOB_HMAC_SECRET: '', PAYMOB_INTEGRATION_ID: '', PAYMOB_MERCHANT_ID: '' }))).not.toThrow();
  });
});
