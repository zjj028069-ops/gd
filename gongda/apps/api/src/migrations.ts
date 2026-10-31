import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Database } from './database.js';

export async function migrate(database: Database) {
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  await database.admin(async (sql) => {
    await sql.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    for (const name of files) {
      const source = await readFile(directory + '/' + name, 'utf8');
      const checksum = createHash('sha256').update(source).digest('hex');
      const previous = (await sql.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name=$1', [name])).rows[0];
      if (previous) {
        if (previous.checksum !== checksum) throw new Error('已执行迁移被修改：' + name);
        continue;
      }
      await sql.exec(source);
      await sql.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
    }
  });
}

