#!/usr/bin/env node
/**
 * Run every migration in src/db/ in order against the DB pointed at
 * by $DATABASE_URL. Picks up new migrations automatically as long as
 * they follow the `migrate-NNN.ts` naming convention — no need to hand-
 * update package.json, CI yaml, and install.sh every time.
 *
 * Order:
 *   1. src/db/migrate.ts        (initial schema; always first)
 *   2. src/db/migrate-NNN.ts    (lexical sort by NNN)
 *
 * Each file is run as its own ts-node subprocess. We don't import them
 * into this process because each one calls db.end() at the end, which
 * would close the pool for any subsequent in-process migration.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx ts-node scripts/run-migrations.ts
 *
 * Exits non-zero on the first failing migration.
 */

import { spawnSync } from 'child_process';
import { readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = 'src/db';
const NAME_RE = /^migrate(-[a-zA-Z0-9_]+)?\.ts$/;

function listMigrations(): string[] {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => NAME_RE.test(f));
  return files.sort((a, b) => {
    // migrate.ts is the initial schema — always runs first.
    if (a === 'migrate.ts') return -1;
    if (b === 'migrate.ts') return 1;
    return a.localeCompare(b);
  });
}

function main(): void {
  if (!process.env.DATABASE_URL) {
    console.error('error: DATABASE_URL must be set');
    process.exit(2);
  }

  const files = listMigrations();
  if (files.length === 0) {
    console.error(`error: no migrations found in ${MIGRATIONS_DIR}/`);
    process.exit(2);
  }

  console.log(`Running ${files.length} migration(s) against ${redact(process.env.DATABASE_URL)}:`);
  for (const f of files) console.log(`  - ${f}`);
  console.log();

  for (const f of files) {
    const path = join(MIGRATIONS_DIR, f);
    console.log(`==> ${path}`);
    const result = spawnSync('npx', ['ts-node', path], {
      stdio: 'inherit',
      shell: true, // shell:true so npx resolves cross-platform
      env: process.env,
    });
    if (result.status !== 0) {
      console.error(`\n${f} failed (exit ${result.status})`);
      process.exit(result.status ?? 1);
    }
  }

  console.log('\nAll migrations complete.');
}

function redact(url: string): string {
  // Hide credentials in the log line.
  return url.replace(/\/\/[^@]+@/, '//[redacted]@');
}

main();
