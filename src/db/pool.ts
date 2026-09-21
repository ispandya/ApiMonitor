import { Pool } from 'pg';

// The fallback matches the credentials in docker-compose.yml, so local dev works
// with zero config. In production you'd set DATABASE_URL instead of editing code.
const connectionString =
  process.env.DATABASE_URL ?? 'postgres://monitor:monitor@localhost:5432/api_monitor';

export const pool = new Pool({ connectionString });
