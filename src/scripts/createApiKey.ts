import { createApiKey } from '../auth/apiKeys';
import { pool } from '../db/pool';

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: npm run key:create -- "<a name for this key>"');
    process.exitCode = 1;
    return;
  }
  const { id, key } = await createApiKey(name);
  console.log(`Created API key "${name}" (${id})`);
  console.log(`\n  ${key}\n`);
  console.log('Copy it now: it is not stored and cannot be shown again.');
}

main()
  .catch((err) => {
    console.error('failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
