import { z } from 'zod';

// An empty string in .env means "not set" — .env.example ships PAYMOB_*="" .
const blankToUndefined = (value: unknown) => (value === '' ? undefined : value);

/**
 * How many reverse proxies stand between the internet and this process, or
 * which proxy addresses to trust. Express defaults to false: req.ip is then
 * the socket peer — the proxy — and X-Forwarded-For is ignored, so every
 * anonymous caller shares one rate-limit identity.
 *
 * Accepted: "false" (no proxy), a hop count ("1"), or a comma-separated list
 * of addresses/CIDRs/Express presets ("10.0.0.0/8,loopback").
 *
 * "true" is deliberately rejected. It trusts the whole X-Forwarded-For chain,
 * including the part the client wrote, so any caller can forge a fresh
 * rate-limit identity per request — a worse failure than the one this setting
 * exists to fix. A hop count or a CIDR list expresses the same intent safely.
 */
function isTrustProxyValue(raw: string): boolean {
  const value = raw.trim();
  if (/^true$/i.test(value)) return false;
  if (/^false$/i.test(value)) return true;
  if (/^\d+$/.test(value)) return true;
  return value.length > 0 && value.split(',').every((entry) => entry.trim().length > 0);
}

function parseTrustProxy(raw: string | undefined): false | number | string[] {
  const value = (raw ?? 'false').trim();
  if (/^false$/i.test(value)) return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  MEILISEARCH_HOST: z.string().url(),
  MEILISEARCH_API_KEY: z.string().min(1),
  // Index uid prefix, so dev/test/prod (and e2e runs) never share an index.
  // Defaults to `riven_${NODE_ENV}_` in SearchIndexRegistry when unset.
  MEILISEARCH_INDEX_PREFIX: z.string().regex(/^[a-zA-Z0-9_-]*$/).optional(),
  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_TOKEN_TTL: z.string().min(1),
  JWT_REFRESH_TOKEN_TTL: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_PUBLIC_URL: z.string().url(),
  // Wrong value here silently breaks rate limiting in one of two directions —
  // see isTrustProxyValue above. Defaults to false: correct for a process
  // exposed directly, and the safe direction to be wrong in.
  TRUST_PROXY: z
    .preprocess(blankToUndefined, z.string().optional())
    .refine((value) => value === undefined || isTrustProxyValue(value), {
      message:
        'TRUST_PROXY must be "false", a hop count such as "1", or a comma-separated list of proxy addresses/CIDRs ' +
        'such as "10.0.0.0/8,loopback". "true" is rejected: it trusts a client-supplied X-Forwarded-For, which lets ' +
        'any caller forge their rate-limit identity.',
    })
    .transform(parseTrustProxy),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Comma-separated browser origins allowed by CORS. Defaults to the local
  // dashboards; production must set it explicitly.
  CORS_ORIGINS: z
    .preprocess(blankToUndefined, z.string().optional())
    .transform((value) =>
      (value ?? 'http://localhost:3000,http://localhost:3001')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().url())),
  // Paymob is optional at boot (no credentials in dev) but must be well-formed
  // when present, so a typo fails at startup rather than at the first payment.
  PAYMOB_API_KEY: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  PAYMOB_INTEGRATION_ID: z.preprocess(blankToUndefined, z.string().regex(/^[0-9]+$/).optional()),
  PAYMOB_HMAC_SECRET: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  // How long a PENDING checkout keeps its stock before the expiry job cancels
  // it and releases the inventory (fix.js PAY-03).
  CHECKOUT_PENDING_TTL_MINUTES: z.coerce.number().int().positive().default(60),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }

  return parsed.data;
}
