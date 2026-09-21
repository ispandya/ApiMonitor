import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from './pool';

async function migrate() {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('schema.sql applied');

  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name`,
  );
  console.log('tables:', rows.map((r) => r.table_name).join(', '));
}

migrate()
  .catch((err) => {
    console.error('migration failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
