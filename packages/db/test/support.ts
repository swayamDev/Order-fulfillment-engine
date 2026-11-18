// Connection settings for integration tests. Defaults match docker-compose.yml;
// CI overrides them with the Postgres service container.

import { createDb, type Db } from '../src/client.ts';

export const TEST_OWNER_URL =
  process.env['TEST_DATABASE_OWNER_URL'] ??
  'postgres://sethu_owner:sethu_owner_dev@localhost:54329/sethu_test';

export const TEST_APP_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgres://sethu_app:sethu_app_dev@localhost:54329/sethu_test';

export const TEST_APP_PASSWORD = process.env['APP_ROLE_PASSWORD'] ?? 'sethu_app_dev';

export function ownerDb(max = 4): Db {
  return createDb(TEST_OWNER_URL, max);
}

export function appDb(max = 10): Db {
  return createDb(TEST_APP_URL, max);
}
