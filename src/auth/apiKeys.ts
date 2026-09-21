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
  // The account this key acts for. Monitors belong to the account, not to the key.
  accountId: string;
}

// The plaintext key is returned here and nowhere else: only its hash is stored.
export async function createApiKey(name: string, accountId: string): Promise<ApiKeyRecord & { key: string }> {
  const key = generateApiKey();
  const { rows } = await pool.query<ApiKeyRecord>(
    `INSERT INTO api_keys (name, key_prefix, key_hash, account_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, account_id AS "accountId"`,
    [name, key.slice(0, 8), hashApiKey(key), accountId],
  );
  const record = rows[0];
  if (!record) throw new Error('INSERT INTO api_keys returned no row');
  return { ...record, key };
}

// Looks a presented key up by its hash. Null if unknown or revoked.
export async function findApiKey(key: string): Promise<ApiKeyRecord | null> {
  const { rows } = await pool.query<ApiKeyRecord>(
    `SELECT id, name, account_id AS "accountId"
       FROM api_keys
      WHERE key_hash = $1 AND revoked_at IS NULL`,
    [hashApiKey(key)],
  );
  return rows[0] ?? null;
}

// Revoking keeps the row (so history and audits still make sense) and takes effect on the
// very next request. Returns false if there was no such active key.
export async function revokeApiKey(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
    [id],
  );
  return (rowCount ?? 0) > 0;
}
