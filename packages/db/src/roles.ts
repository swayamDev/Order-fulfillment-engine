// Creates the two non-owner roles Sethu needs. Run it as the owner role:
// locally against Docker Compose, in CI, and once against Neon.
//
//   sethu_app     LOGIN. The API and job handlers connect as this role. It does
//                 not own any table and has no BYPASSRLS, so row level security
//                 always applies to it.
//   sethu_system  NOLOGIN. Owns the few SECURITY DEFINER functions that must
//                 work across sandboxes (claiming jobs, reading the outbox,
//                 creating and resolving sandboxes). Nobody can log in as it.
//
// The script is idempotent. Passwords never live in migrations.

import pg from 'pg';
import { requireEnv } from './env.ts';

export const APP_ROLE = 'sethu_app';
export const SYSTEM_ROLE = 'sethu_system';

export async function ensureRoles(ownerUrl: string, appPassword: string): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
    const database = rows[0]?.db;
    if (database === undefined) throw new Error('Could not read current database');

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SYSTEM_ROLE}') THEN
          CREATE ROLE ${SYSTEM_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        END IF;
      END
      $$;
    `);
    await client.query(`ALTER ROLE ${APP_ROLE} PASSWORD ${client.escapeLiteral(appPassword)}`);
    // The owner must be able to SET ROLE to sethu_system to hand it ownership of
    // the definer functions, without inheriting its privileges.
    await client.query(`GRANT ${SYSTEM_ROLE} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`);
    await client.query(
      `GRANT CONNECT ON DATABASE ${client.escapeIdentifier(database)} TO ${APP_ROLE}`,
    );
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  const ownerUrl = requireEnv('DATABASE_OWNER_URL');
  const password = requireEnv('APP_ROLE_PASSWORD');
  await ensureRoles(ownerUrl, password);
  console.log(`Roles ${APP_ROLE} and ${SYSTEM_ROLE} are ready.`);
}
