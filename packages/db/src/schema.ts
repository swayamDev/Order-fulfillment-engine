// Kysely table types. They mirror the migrations by hand; the integration
// tests exercise every column used by the application.

import type { OrderState } from '@sethu/domain';
import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json<T = unknown> = ColumnType<T, T, T>;

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'dead';
export type ReservationStatus = 'held' | 'released' | 'consumed';
export type SimPaymentStatus = 'authorized' | 'captured' | 'failed';
export type PaymentStatus = 'pending' | 'authorized' | 'captured' | 'failed' | 'refunded';

export interface SandboxesTable {
  id: Generated<string>;
  token_hash: Buffer;
  ip_hash: Buffer | null;
  created_at: Timestamp;
  last_active_at: Timestamp;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  hard_expires_at: ColumnType<Date, Date | string, Date | string>;
}

export interface ProductsTable {
  sandbox_id: string;
  sku: string;
  name: string;
  price_minor: number;
}

export interface StockTable {
  sandbox_id: string;
  sku: string;
  available: number;
  reserved: ColumnType<number, number | undefined, number>;
  updated_at: Timestamp;
}

export interface OrdersTable {
  id: Generated<string>;
  sandbox_id: string;
  idempotency_key: string;
  request_hash: string;
  state: OrderState;
  version: ColumnType<number, number | undefined, number>;
  currency: ColumnType<string, string | undefined, string>;
  total_minor: number;
  payment_captured: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrderItemsTable {
  order_id: string;
  sandbox_id: string;
  line: number;
  sku: string;
  quantity: number;
  unit_price_minor: number;
}

export interface OrderEventsTable {
  id: Generated<string>;
  sandbox_id: string;
  order_id: string;
  seq: number;
  kind: string;
  data: Json<Record<string, unknown>>;
  created_at: Timestamp;
}

export interface ReservationsTable {
  order_id: string;
  sandbox_id: string;
  status: ReservationStatus;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OutboxTable {
  id: Generated<string>;
  sandbox_id: string;
  topic: string;
  aggregate_id: string;
  payload: Json<Record<string, unknown>>;
  created_at: Timestamp;
  published_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface JobsTable {
  id: Generated<string>;
  sandbox_id: string;
  queue: string;
  payload: Json<Record<string, unknown>>;
  status: ColumnType<JobStatus, JobStatus | undefined, JobStatus>;
  attempts: ColumnType<number, number | undefined, number>;
  max_attempts: ColumnType<number, number | undefined, number>;
  run_at: Timestamp;
  locked_by: string | null;
  locked_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  last_error: string | null;
  dedupe_key: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  finished_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface ProcessedMessagesTable {
  consumer: string;
  message_id: string;
  sandbox_id: string;
  processed_at: Timestamp;
}

export interface WebhookInboxTable {
  id: Generated<string>;
  sandbox_id: string;
  provider: string;
  provider_event_id: string;
  event_type: string;
  payload: Json<Record<string, unknown>>;
  received_at: Timestamp;
  duplicate_count: ColumnType<number, number | undefined, number>;
  processed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  held_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface PaymentsTable {
  intent_id: string;
  sandbox_id: string;
  order_id: string;
  provider: string;
  status: ColumnType<PaymentStatus, PaymentStatus | undefined, PaymentStatus>;
  last_seq: ColumnType<number, number | undefined, number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SimPaymentIntentsTable {
  id: string;
  sandbox_id: string;
  order_id: string;
  idempotency_key: string;
  amount_minor: number;
  currency: string;
  status: SimPaymentStatus;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface Database {
  sandboxes: SandboxesTable;
  products: ProductsTable;
  stock: StockTable;
  orders: OrdersTable;
  order_items: OrderItemsTable;
  order_events: OrderEventsTable;
  reservations: ReservationsTable;
  outbox: OutboxTable;
  jobs: JobsTable;
  processed_messages: ProcessedMessagesTable;
  webhook_inbox: WebhookInboxTable;
  payments: PaymentsTable;
  sim_payment_intents: SimPaymentIntentsTable;
}

export type Order = Selectable<OrdersTable>;
export type NewOrder = Insertable<OrdersTable>;
export type Job = Selectable<JobsTable>;
export type OutboxRow = Selectable<OutboxTable>;
