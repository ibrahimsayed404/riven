import { z } from 'zod';

// An empty string in .env means "not set" — .env.example ships PAYMOB_*="" .
const blankToUndefined = (value: unknown) => (value === '' ? undefined : value);

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
