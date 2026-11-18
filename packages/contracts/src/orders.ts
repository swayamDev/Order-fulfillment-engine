import { z } from 'zod';

export const IdempotencyKey = z
  .string()
  .min(8, 'Idempotency-Key must be at least 8 characters')
  .max(100, 'Idempotency-Key must be at most 100 characters')
  .regex(/^[A-Za-z0-9_-]+$/, 'Idempotency-Key may use letters, digits, _ and - only');

export const PlaceOrderRequest = z
  .object({
    items: z
      .array(
        z.object({
          sku: z.string().min(1).max(40),
          quantity: z.number().int().min(1).max(10),
        }),
      )
      .min(1)
      .max(10),
  })
  .refine((body) => new Set(body.items.map((i) => i.sku)).size === body.items.length, {
    message: 'Each SKU may appear only once',
    path: ['items'],
  });

export type PlaceOrderRequest = z.infer<typeof PlaceOrderRequest>;

export interface OrderItemView {
  sku: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
}

export interface OrderEventView {
  seq: number;
  kind: string;
  data: Record<string, unknown>;
  at: string;
}

export interface OrderView {
  id: string;
  state: string;
  version: number;
  currency: string;
  totalMinor: number;
  paymentCaptured: boolean;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  items: OrderItemView[];
  events: OrderEventView[];
}
