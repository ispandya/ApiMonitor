import { z } from 'zod';
import { createApiKey } from '../auth/apiKeys';
import { pool } from '../db/pool';
import { accountExists } from '../services/accounts';

async function main() {
  const name = process.argv[2];
  const accountId = z.uuid().safeParse(process.argv[3]);
  if (!name || !accountId.success) {
    console.error('Usage: npm run key:create -- "<a name for this key>" <account id>');
    console.error('Make an account first with: npm run account:create -- "<account name>"');
    process.exitCode = 1;
    return;
  }
  if (!(await accountExists(accountId.data))) {
    console.error(`No account with id ${accountId.data}`);
    process.exitCode = 1;
    return;
  }
  const { id, key } = await createApiKey(name, accountId.data);
  console.log(`Created API key "${name}" (${id}) for account ${accountId.data}`);
  console.log(`\n  ${key}\n`);
  console.log('Copy it now: it is not stored and cannot be shown again.');
}

main()
  .catch((err) => {
    console.error('failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
