import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * TD-02 (specs/commerce/08, 06 §6): Prisma cannot model or diff CHECK
 * constraints, triggers, their functions, GIST or partial indexes, so a future
 * generated migration could drop one silently. After `prisma migrate deploy`
 * this asserts that every object in prisma/hand-sql-objects.json exists — and
 * that no hand-written object exists WITHOUT being registered, so the registry
 * is always complete. Read-only: it only queries the catalogs.
 */
type Named = { table: string; name: string };
const registry = JSON.parse(readFileSync(join(__dirname, '../../../prisma/hand-sql-objects.json'), 'utf8')) as {
  checks: Named[];
  triggers: Named[];
  functions: string[];
  indexes: Named[];
};
// PostGIS owns this table and its CHECK; it is not ours to register.
const EXTENSION_TABLES = new Set(['spatial_ref_sys']);
const key = (o: Named) => `${o.table}.${o.name}`;

describe('Hand-written SQL objects exist and are all registered (TD-02)', () => {
  const prisma = new PrismaClient();
  let live: { checks: Named[]; triggers: Named[]; functions: string[]; indexes: Named[] };

  beforeAll(async () => {
    const clean = (rows: Named[]) => rows.map((r) => ({ table: r.table.replace(/^"|"$/g, ''), name: r.name })).filter((r) => !EXTENSION_TABLES.has(r.table));
    live = {
      checks: clean(
        await prisma.$queryRaw<Named[]>`
          SELECT c.conrelid::regclass::text AS "table", c.conname AS name
          FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = 'public' AND c.contype = 'c'`,
      ),
      triggers: clean(
        await prisma.$queryRaw<Named[]>`
          SELECT t.tgrelid::regclass::text AS "table", t.tgname AS name
          FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
      ),
      functions: (
        await prisma.$queryRaw<{ name: string }[]>`
          SELECT DISTINCT p.proname AS name FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND NOT t.tgisinternal`
      ).map((f) => f.name),
      indexes: clean(
        await prisma.$queryRaw<Named[]>`
          SELECT tablename AS "table", indexname AS name FROM pg_indexes
          WHERE schemaname = 'public' AND (indexdef ILIKE '% USING gist %' OR indexdef ILIKE '% WHERE %')`,
      ),
    };
  });

  afterAll(() => prisma.$disconnect());

  it.each(['checks', 'triggers', 'indexes'] as const)('every registered %s object exists in the migrated database', (kind) => {
    const present = new Set(live[kind].map(key));
    expect(registry[kind].map(key).filter((k) => !present.has(k))).toEqual([]);
  });

  it('every registered trigger function exists', () => {
    expect(registry.functions.filter((f) => !live.functions.includes(f))).toEqual([]);
  });

  it.each(['checks', 'triggers', 'indexes'] as const)('no %s object exists without being registered (add it to hand-sql-objects.json)', (kind) => {
    const registered = new Set(registry[kind].map(key));
    expect(live[kind].map(key).filter((k) => !registered.has(k))).toEqual([]);
  });

  it('no trigger function exists without being registered', () => {
    expect(live.functions.filter((f) => !registry.functions.includes(f))).toEqual([]);
  });
});
