// Shared by Sethu's SIMULATED providers: delivering one signed webhook.

import type { Job, Tx } from '@sethu/db';
import { z } from 'zod';
import { PermanentJobError } from '../queue/index.ts';
import { signatureHeader, SIGNATURE_HEADER } from '../webhooks/index.ts';

export interface SignedDelivery {
  readonly signingSecret: string;
  /** A function so tests can bind to a random port. */
  readonly webhookUrl: () => string;
}

const DeliveryPayload = z.object({
  envelope: z.object({
    id: z.string(),
    type: z.string(),
    created: z.number(),
    sandbox_id: z.uuid(),
    simulated: z.literal(true),
    data: z.record(z.string(), z.unknown()),
  }),
});

/**
 * Job handler that POSTs one signed webhook. A non-2xx answer throws, so the
 * queue retries with backoff, as a real provider would.
 */
export function deliverSignedWebhook(target: SignedDelivery) {
  return async (_tx: Tx, job: Job): Promise<void> => {
    const parsed = DeliveryPayload.safeParse(job.payload);
    if (!parsed.success) throw new PermanentJobError(`${job.queue}: bad payload`);
    const body = JSON.stringify(parsed.data.envelope);
    const response = await fetch(target.webhookUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signatureHeader(
          [target.signingSecret],
          Math.floor(Date.now() / 1000),
          body,
        ),
      },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Webhook endpoint answered ${response.status}`);
  };
}
