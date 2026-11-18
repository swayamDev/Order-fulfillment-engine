export interface BookShipmentInput {
  readonly sandboxId: string;
  readonly orderId: string;
  /** The same key always books the same shipment, so a retry never books twice. */
  readonly idempotencyKey: string;
}

export interface CourierClient {
  book(input: BookShipmentInput): Promise<{ id: string }>;
}

/** HTTP client for the (simulated) courier's API. */
export function httpCourierClient(options: {
  baseUrl: () => string;
  apiKey: string;
  timeoutMs?: number;
}): CourierClient {
  return {
    async book(input) {
      const response = await fetch(`${options.baseUrl()}/v1/shipments`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': input.idempotencyKey,
        },
        body: JSON.stringify({ sandbox_id: input.sandboxId, order_id: input.orderId }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
      if (!response.ok) {
        throw new Error(`Courier answered ${response.status}: ${await response.text()}`);
      }
      const body = (await response.json()) as { id?: unknown };
      if (typeof body.id !== 'string') throw new Error('Courier returned no shipment id');
      return { id: body.id };
    },
  };
}
