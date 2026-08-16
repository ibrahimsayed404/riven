import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  MEILISEARCH_HOST: z.string().url(),
  MEILISEARCH_API_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_TOKEN_TTL: z.string().min(1),
  JWT_REFRESH_TOKEN_TTL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }

  return parsed.data;
}
