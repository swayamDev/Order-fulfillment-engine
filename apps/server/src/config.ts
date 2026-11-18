import { z } from 'zod';

const ConfigSchema = z.object({
  DATABASE_URL: z.url(),
  CONSOLE_ORIGIN: z.url().default('http://localhost:3000'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  /** This API's public base URL; simulated providers send webhooks here. */
  PUBLIC_API_URL: z.url().default('http://localhost:4000'),
  /** API key the payments module uses with the simulated payment provider. */
  SIM_PAYMENTS_API_KEY: z.string().min(16).default('sk_sim_dev_only_0000000000'),
  /** Gap between the simulated provider's webhooks for one payment. */
  SIM_PAYMENTS_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(1_500),
  /**
   * Secrets the simulated payment provider signs webhooks with, comma separated.
   * The first signs; all are accepted, which is how a secret is rotated.
   */
  SIM_PAYMENTS_WEBHOOK_SECRETS: z
    .string()
    .default('dev-only-sim-payments-secret-0000000000')
    .transform((value) => value.split(',').map((s) => s.trim()))
    .pipe(z.array(z.string().min(32)).min(1)),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse(env);
}
