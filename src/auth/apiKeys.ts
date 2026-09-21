import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db/pool';

// 256 random bits, so guessing is impossible and a fast hash is enough (unlike passwords).
export function generateApiKey(): string {
  return `am_${randomBytes(32).toString('base64url')}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export interface ApiKeyRecord {
  id: string;
  name: string;
}

// The plaintext key is returned here and nowhere else: only its hash is stored.
export async function createApiKey(name: string): Promise<ApiKeyRecord & { key: string }> {
  const key = generateApiKey();
  const { rows } = await pool.query<ApiKeyRecord>(
    `INSERT INTO api_keys (name, key_prefix, key_hash)
     VALUES ($1, $2, $3)
     RETURNING id, name`,
    [name, key.slice(0, 8), hashApiKey(key)],
  );
  const record = rows[0];
  if (!record) throw new Error('INSERT INTO api_keys returned no row');
  return { ...record, key };
}

// Looks a presented key up by its hash. Null if unknown or revoked.
export async function findApiKey(key: string): Promise<ApiKeyRecord | null> {
  const { rows } = await pool.query<ApiKeyRecord>(
    'SELECT id, name FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL',
    [hashApiKey(key)],
  );
  return rows[0] ?? null;
}
