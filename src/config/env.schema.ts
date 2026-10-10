import { z } from 'zod';

const mongoUri = z
  .string()
  .regex(
    /^mongodb(\+srv)?:\/\/.+/,
    'must be a mongodb:// or mongodb+srv:// URI',
  );

const positiveInt = z.coerce.number().int().positive();

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: positiveInt.default(3000),
  MONGO_RAW_URI: mongoUri,
  MONGO_TARGET_URI: mongoUri,
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: positiveInt.max(65535),
  BATCH_SIZE: positiveInt,
  WORKER_CONCURRENCY: positiveInt,
});

export type Env = z.infer<typeof envSchema>;

// Called by ConfigModule at startup. Throwing here aborts boot before any
// connection is opened, so a bad config never makes it into a run.
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
