import { pool } from '../db/pool';
import { createAccount } from '../services/accounts';

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: npm run account:create -- "<account name>"');
    process.exitCode = 1;
    return;
  }
  const account = await createAccount(name);
  console.log(`Created account "${account.name}" (${account.id})`);
  console.log(`\nNext, create a key for it:\n  npm run key:create -- "my laptop" ${account.id}`);
}

main()
  .catch((err) => {
    console.error('failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
