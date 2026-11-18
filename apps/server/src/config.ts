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
  /** Secrets the simulated courier signs webhooks with, comma separated. */
  SIM_COURIER_WEBHOOK_SECRETS: z
    .string()
    .default('dev-only-sim-courier-secret-00000000000')
    .transform((value) => value.split(',').map((s) => s.trim()))
    .pipe(z.array(z.string().min(32)).min(1)),
  /** API key the shipping module uses with the simulated courier. */
  SIM_COURIER_API_KEY: z.string().min(16).default('ck_sim_dev_only_0000000000'),
  /** Gap between the simulated courier's tracking webhooks for one shipment. */
  SIM_COURIER_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(2_500),
  /**
   * Keys that sign sandbox session cookies, comma separated. The first signs;
   * all verify, so a key can be rotated without logging everyone out.
   */
  SESSION_SIGNING_KEYS: z
    .string()
    .default('dev-only-session-signing-key-000000000')
    .transform((value) => value.split(',').map((s) => s.trim()))
    .pipe(z.array(z.string().min(32)).min(1)),
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

/** Secrets that have development defaults and must never use them in production. */
const PRODUCTION_SECRETS = [
  'SESSION_SIGNING_KEYS',
  'SIM_PAYMENTS_WEBHOOK_SECRETS',
  'SIM_PAYMENTS_API_KEY',
  'SIM_COURIER_WEBHOOK_SECRETS',
  'SIM_COURIER_API_KEY',
] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env['NODE_ENV'] === 'production') {
    const missing = PRODUCTION_SECRETS.filter((name) => (env[name] ?? '') === '');
    if (missing.length > 0) {
      throw new Error(
        `Set these in production; the development defaults are public: ${missing.join(', ')}`,
      );
    }
  }
  return ConfigSchema.parse(env);
}
