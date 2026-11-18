// Builds the provider clients and simulated providers from configuration.
// Shared by the API process and every worker process, so they agree.

import type { Config } from './config.ts';
import type { EngineDeps } from './engine.ts';
import { httpPaymentsClient } from './modules/payments/index.ts';
import { httpCourierClient } from './modules/shipping/index.ts';
import type { SimCourierConfig } from './modules/sim-courier/index.ts';
import type { SimPaymentsConfig } from './modules/sim-payments/index.ts';

function first(secrets: readonly string[], name: string): string {
  const [secret] = secrets;
  if (secret === undefined) throw new Error(`${name} is empty`);
  return secret;
}

export interface Providers extends Required<EngineDeps> {
  readonly webhookSecrets: ReadonlyMap<string, readonly string[]>;
}

/**
 * The simulated providers live in the API process but are reached over HTTP
 * at PUBLIC_API_URL, exactly as real third parties would be.
 */
export function buildProviders(config: Config): Providers {
  const simPayments: SimPaymentsConfig = {
    apiKey: config.SIM_PAYMENTS_API_KEY,
    signingSecret: first(config.SIM_PAYMENTS_WEBHOOK_SECRETS, 'SIM_PAYMENTS_WEBHOOK_SECRETS'),
    webhookUrl: () => `${config.PUBLIC_API_URL}/v1/webhooks/sim-payments`,
    delayMs: config.SIM_PAYMENTS_DELAY_MS,
  };
  const simCourier: SimCourierConfig = {
    apiKey: config.SIM_COURIER_API_KEY,
    signingSecret: first(config.SIM_COURIER_WEBHOOK_SECRETS, 'SIM_COURIER_WEBHOOK_SECRETS'),
    webhookUrl: () => `${config.PUBLIC_API_URL}/v1/webhooks/sim-courier`,
    delayMs: config.SIM_COURIER_DELAY_MS,
  };
  return {
    simPayments,
    simCourier,
    payments: httpPaymentsClient({
      baseUrl: () => `${config.PUBLIC_API_URL}/sim/payments`,
      apiKey: config.SIM_PAYMENTS_API_KEY,
    }),
    courier: httpCourierClient({
      baseUrl: () => `${config.PUBLIC_API_URL}/sim/courier`,
      apiKey: config.SIM_COURIER_API_KEY,
    }),
    webhookSecrets: new Map([
      ['sim-payments', config.SIM_PAYMENTS_WEBHOOK_SECRETS],
      ['sim-courier', config.SIM_COURIER_WEBHOOK_SECRETS],
    ]),
  };
}
