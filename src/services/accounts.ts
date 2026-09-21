import { pool } from '../db/pool';

export interface Account {
  id: string;
  name: string;
}

export async function createAccount(name: string): Promise<Account> {
  const { rows } = await pool.query<Account>(
    'INSERT INTO accounts (name) VALUES ($1) RETURNING id, name',
    [name],
  );
  const account = rows[0];
  if (!account) throw new Error('INSERT INTO accounts returned no row');
  return account;
}

export async function accountExists(id: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM accounts WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}
