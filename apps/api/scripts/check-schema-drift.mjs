// TD-02 drift check (specs/commerce/06 §6): the migrations, applied to an empty
// shadow database, must produce exactly what prisma/schema.prisma describes.
// Prisma cannot model GIST or partial indexes, so it always proposes to DROP the
// ones registered in prisma/hand-sql-objects.json — those, and only those, are
// allowed. Any other statement means schema.prisma and the migrations disagree.
//
// Usage: SHADOW_DATABASE_URL=postgresql://…/riven_shadow_test node scripts/check-schema-drift.mjs
// The shadow database is wiped by Prisma; its name must end in _test or _shadow.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const shadow = process.env.SHADOW_DATABASE_URL;
if (!shadow) {
  console.error('check-schema-drift: SHADOW_DATABASE_URL is required (an empty, disposable database).');
  process.exit(2);
}
const shadowDb = new URL(shadow).pathname.slice(1);
if (!/(_test|_shadow)$/.test(shadowDb)) {
  console.error(`check-schema-drift: refusing shadow database "${shadowDb}" — its name must end in _test or _shadow (Prisma wipes it).`);
  process.exit(2);
}

const result = spawnSync(
  'npx',
  ['prisma', 'migrate', 'diff', '--from-migrations', 'prisma/migrations', '--to-schema-datamodel', 'prisma/schema.prisma', '--shadow-database-url', shadow, '--script'],
  { cwd: apiDir, encoding: 'utf8', shell: process.platform === 'win32' },
);
if (result.status !== 0) {
  console.error(`check-schema-drift: prisma migrate diff failed\n${result.stdout}\n${result.stderr}`);
  process.exit(1);
}

const registry = JSON.parse(readFileSync(join(apiDir, 'prisma/hand-sql-objects.json'), 'utf8'));
const allowedDrops = new Set(registry.indexes.map((i) => i.name));

const statements = result.stdout
  .split(';')
  .map((s) => s.replace(/--[^\n]*/g, '').trim())
  .filter((s) => s.length > 0 && !/^This is an empty migration\.?$/i.test(s));

const unexpected = statements.filter((s) => {
  const drop = s.match(/^DROP INDEX\s+(?:"public"\.)?"?([A-Za-z0-9_]+)"?$/i);
  return !(drop && allowedDrops.has(drop[1]));
});

if (unexpected.length > 0) {
  console.error('check-schema-drift: schema.prisma and the migrations disagree:\n');
  for (const s of unexpected) console.error(`  ${s};`);
  console.error('\nCreate a migration for the change, or register a new hand-written index in prisma/hand-sql-objects.json.');
  process.exit(1);
}
console.log(`check-schema-drift: no drift (${statements.length} expected hand-SQL index statement(s) ignored).`);
