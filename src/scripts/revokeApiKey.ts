import { z } from 'zod';
import { revokeApiKey } from '../auth/apiKeys';
import { pool } from '../db/pool';

async function main() {
  const id = z.uuid().safeParse(process.argv[2]);
  if (!id.success) {
    console.error('Usage: npm run key:revoke -- <key id>');
    process.exitCode = 1;
    return;
  }
  const revoked = await revokeApiKey(id.data);
  console.log(revoked ? `Revoked key ${id.data}. It stops working immediately.` : 'No active key with that id.');
  if (!revoked) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
