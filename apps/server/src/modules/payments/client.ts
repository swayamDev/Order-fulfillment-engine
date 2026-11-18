export interface CreateIntentInput {
  readonly sandboxId: string;
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** The same key always yields the same intent, so a retried call never charges twice. */
  readonly idempotencyKey: string;
}

export interface RefundInput {
  readonly sandboxId: string;
  readonly intentId: string;
}

export interface PaymentsClient {
  createIntent(input: CreateIntentInput): Promise<{ id: string }>;
  /** Refunds a captured payment. Safe to call again for the same payment. */
  refund(input: RefundInput): Promise<void>;
}

/** HTTP client for the (simulated) payment provider's API. */
export function httpPaymentsClient(options: {
  baseUrl: () => string;
  apiKey: string;
  timeoutMs?: number;
}): PaymentsClient {
  return {
    async createIntent(input) {
      const response = await fetch(`${options.baseUrl()}/v1/intents`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': input.idempotencyKey,
        },
        body: JSON.stringify({
          sandbox_id: input.sandboxId,
          order_id: input.orderId,
          amount_minor: input.amountMinor,
          currency: input.currency,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
      if (!response.ok) {
        throw new Error(`Payment provider answered ${response.status}: ${await response.text()}`);
      }
      const body = (await response.json()) as { id?: unknown };
      if (typeof body.id !== 'string') throw new Error('Payment provider returned no intent id');
      return { id: body.id };
    },
    async refund(input) {
      const response = await fetch(
        `${options.baseUrl()}/v1/intents/${encodeURIComponent(input.intentId)}/refunds`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ sandbox_id: input.sandboxId }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
        },
      );
      if (!response.ok) {
        throw new Error(
          `Refund failed: provider answered ${response.status}: ${await response.text()}`,
        );
      }
    },
  };
}
