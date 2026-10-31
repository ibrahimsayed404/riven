#!/usr/bin/env node
/**
 * Query benchmark (specs/architecture-and-query-performance-plan.md §2.1).
 *
 *   pnpm --filter @riven/api bench -- --stage S0 [--volume 1|10] [--verified 90|50] [--reseed] [--no-vacuum]
 *
 * - Runs only against BENCH_DATABASE_URL (default: DATABASE_URL with the database
 *   renamed to riven_bench_test) on localhost:5433 — env-guard.mjs refuses
 *   anything else, including for CREATE DATABASE.
 * - Seeds deterministically (setseed) with set-based INSERT … SELECT generate_series.
 * - Times the REAL repository methods from dist/ (run `pnpm build` first), 20 warm-up
 *   + 200 timed runs × 3 repetitions, plus a concurrency run and write costs, and
 *   writes specs/perf/bench-<date>-<stage>.md (also the captured Prisma SQL and the
 *   unindexed-foreign-key report).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkEnvironment } from './env-guard.mjs';

const require = createRequire(import.meta.url);
const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(apiDir, '..', '..');

// ---------------------------------------------------------------- args / env
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const STAGE = arg('stage', 'adhoc');
const VOLUME = Number(arg('volume', '1'));
const VERIFIED = Number(arg('verified', '90'));
const RUNS = Number(arg('runs', '200'));
const WARMUP = Number(arg('warmup', '20'));
const REPS = Number(arg('reps', '3'));
const ONLY = arg('only', '');

function loadDotEnv() {
  const file = join(repoRoot, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}
loadDotEnv();
if (!process.env.BENCH_DATABASE_URL && process.env.DATABASE_URL) {
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = '/riven_bench_test';
  process.env.BENCH_DATABASE_URL = u.toString();
}
const guard = checkEnvironment('bench');
console.log(`bench: env-guard ${JSON.stringify(guard.report)}`);
if (!guard.ok) {
  for (const p of guard.problems) console.error(`bench: REFUSED — ${p}`);
  process.exit(1);
}
const BENCH_URL = new URL(process.env.BENCH_DATABASE_URL);
const DB_NAME = BENCH_URL.pathname.slice(1);

const { PrismaClient, Prisma } = require('@prisma/client');

// ---------------------------------------------------------------- database
async function ensureDatabase() {
  if (DB_NAME !== 'riven_bench_test') throw new Error(`admin statements only for riven_bench_test, not ${DB_NAME}`);
  const adminUrl = new URL(BENCH_URL);
  adminUrl.pathname = '/postgres';
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  try {
    const exists = await admin.$queryRawUnsafe(`SELECT 1 FROM pg_database WHERE datname = 'riven_bench_test'`);
    if (exists.length && flag('reseed')) {
      await admin.$executeRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'riven_bench_test' AND pid <> pg_backend_pid()`);
      await admin.$executeRawUnsafe('DROP DATABASE riven_bench_test');
      console.log('bench: dropped riven_bench_test (--reseed)');
    }
    if (!exists.length || flag('reseed')) {
      await admin.$executeRawUnsafe('CREATE DATABASE riven_bench_test');
      console.log('bench: created riven_bench_test');
      return true;
    }
    return false;
  } finally {
    await admin.$disconnect();
  }
}

function migrate() {
  const env = { ...process.env, DATABASE_URL: BENCH_URL.toString() };
  const g = checkEnvironment('migrate', env);
  if (!g.ok) throw new Error(`migrate guard: ${g.problems.join('; ')}`);
  const r = spawnSync('npx prisma migrate deploy', { cwd: apiDir, env, shell: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`migrate deploy failed:\n${r.stdout}${r.stderr}`);
  console.log('bench: migrations applied');
}

// Deterministic, set-based seed. Every id is a uuid-shaped md5 of a stable key.
function seedSql(m, verifiedPct) {
  const id = (prefix, expr) => `md5('${prefix}' || (${expr}))::uuid::text`;
  const n = {
    users: 20000 * m,
    vendors: 300 * m,
    organizers: 100 * m,
    products: 50000 * m,
    variants: 120000 * m,
    bazaars: 3000 * m,
    groups: 100000 * m,
    ratings: 40000 * m,
  };
  return [
    `SELECT setseed(0.42)`,
    // categories: 6 roots, 18 children, 36 leaves (not scaled)
    `INSERT INTO categories (id, name, slug, "parentId")
       SELECT ${id('c', 'i')}, 'Cat ' || i, 'cat-' || i,
              CASE WHEN i <= 6 THEN NULL WHEN i <= 24 THEN ${id('c', '((i - 7) / 3) + 1')} ELSE ${id('c', '((i - 25) / 2) + 7')} END
       FROM generate_series(1, 60) i ORDER BY i`,
    // users: shoppers, vendor owners, organizer owners
    `INSERT INTO users (id, email, "passwordHash", role, name, "updatedAt", "createdAt")
       SELECT ${id('u', 'i')}, 'shopper' || i || '@bench.test', 'x', 'SHOPPER', 'Shopper ' || i, now(), now() - (i % 700) * interval '1 day'
       FROM generate_series(1, ${n.users}) i`,
    `INSERT INTO users (id, email, "passwordHash", role, name, "updatedAt")
       SELECT ${id('uv', 'i')}, 'vendor' || i || '@bench.test', 'x', 'VENDOR', 'Vendor owner ' || i, now() FROM generate_series(1, ${n.vendors}) i`,
    `INSERT INTO users (id, email, "passwordHash", role, name, "updatedAt")
       SELECT ${id('uo', 'i')}, 'organizer' || i || '@bench.test', 'x', 'ORGANIZER', 'Organizer owner ' || i, now() FROM generate_series(1, ${n.organizers}) i`,
    `INSERT INTO vendors (id, "ownerId", name, verified, "deletedAt", "updatedAt", "createdAt")
       SELECT ${id('v', 'i')}, ${id('uv', 'i')}, 'Vendor ' || i, (i % 100) < ${verifiedPct}, CASE WHEN i % 50 = 0 THEN now() END, now(), now() - (i % 400) * interval '1 day'
       FROM generate_series(1, ${n.vendors}) i`,
    `INSERT INTO organizers (id, "ownerId", name, verified, "updatedAt")
       SELECT ${id('o', 'i')}, ${id('uo', 'i')}, 'Organizer ' || i, (i % 10) <> 0, now() FROM generate_series(1, ${n.organizers}) i`,
    // products: Zipf-like vendor skew; 85 % active; 3 % deleted; 20 % carry 'linen', 0.05 % 'zircon'
    `INSERT INTO products (id, "vendorId", title, description, "categoryId", "basePrice", images, "isActive", "deletedAt", "createdAt", "updatedAt")
       SELECT ${id('p', 'i')}, ${id('v', `1 + floor(${n.vendors} * power(random(), 2))::int`)},
              CASE WHEN i % 5 = 0 THEN 'Linen shirt ' || i WHEN i % 2000 = 0 THEN 'Zircon ring ' || i ELSE 'Item ' || i END,
              'Description of item ' || i || CASE WHEN i % 7 = 0 THEN ' cotton blend' ELSE '' END,
              ${id('c', '25 + (i % 36)')}, 50 + (i % 900), ARRAY['https://cdn.bench.test/' || i || '.jpg'],
              random() < 0.85, CASE WHEN random() < 0.03 THEN now() END,
              now() - (random() * 730) * interval '1 day', now()
       FROM generate_series(1, ${n.products}) i`,
    `INSERT INTO product_variants (id, "productId", sku, size, "stockQuantity")
       SELECT ${id('pv', 'i')}, ${id('p', `1 + ((i - 1) % ${n.products})`)}, 'SKU-' || i, (ARRAY['S','M','L','XL'])[1 + i % 4], (i % 40)
       FROM generate_series(1, ${n.variants}) i`,
    `INSERT INTO inventory_movements (id, "variantId", type, "quantityDelta", "quantityBefore", "quantityAfter", source, "createdAt")
       SELECT md5('im' || v.id)::uuid::text, v.id, 'OPENING_BALANCE', v."stockQuantity", 0, v."stockQuantity", 'migration', now() FROM product_variants v`,
    // bazaars around Cairo / Giza / Alexandria
    `INSERT INTO bazaars (id, "organizerId", name, description, location, "scheduleType", "startDate", "endDate", status, "deletedAt", "createdAt", "updatedAt")
       SELECT ${id('b', 'i')}, ${id('o', `1 + (i % ${n.organizers})`)}, 'Bazaar ' || i, CASE WHEN i % 3 = 0 THEN 'Weekend bazaar ' || i END,
              ST_SetSRID(ST_MakePoint(
                (ARRAY[31.2357, 31.2089, 29.9187])[1 + i % 3] + (random() - 0.5) * 0.3,
                (ARRAY[30.0444, 30.0131, 31.2001])[1 + i % 3] + (random() - 0.5) * 0.3), 4326)::geography,
              CASE WHEN i % 7 = 0 THEN 'RECURRING' ELSE 'ONE_OFF' END::"ScheduleType",
              now() + ((i % 120) - 60) * interval '1 day', now() + ((i % 120) - 58) * interval '1 day',
              (CASE WHEN i % 10 < 7 THEN 'PUBLISHED' WHEN i % 10 < 8 THEN 'COMPLETED' WHEN i % 10 < 9 THEN 'CANCELLED' ELSE 'DRAFT' END)::"BazaarStatus",
              CASE WHEN i % 40 = 0 THEN now() END, now() - (i % 365) * interval '1 day', now()
       FROM generate_series(1, ${n.bazaars}) i`,
    // order groups: kind by g % 100 → 0-59 paid, 60-79 expired, 80-84 shopper-cancelled, 85-88 pending, 89-99 mixed
    `CREATE TEMP TABLE bench_groups AS
       SELECT g, ${id('og', 'g')} AS id, ${id('u', `1 + (g % ${n.users})`)} AS user_id,
              CASE WHEN g % 100 < 60 THEN 'paid' WHEN g % 100 < 80 THEN 'expired' WHEN g % 100 < 85 THEN 'cancelled'
                   WHEN g % 100 < 89 THEN 'pending' ELSE 'mixed' END AS kind,
              CASE WHEN g % 100 BETWEEN 85 AND 88
                   THEN CASE WHEN g % 4 = 0 THEN now() - interval '3 hours' - (g % 600) * interval '1 minute' ELSE now() - (g % 50) * interval '1 minute' END
                   ELSE now() - (random() * 365) * interval '1 day' END AS created_at
       FROM generate_series(1, ${n.groups}) g`,
    `INSERT INTO order_groups (id, "userId", "createdAt", "paymobTransactionId", "paidAt", "paidAmountCents")
       SELECT id, user_id, created_at, CASE WHEN kind IN ('paid', 'mixed') THEN 'tx-' || g END,
              CASE WHEN kind IN ('paid', 'mixed') THEN created_at + interval '5 minutes' END,
              CASE WHEN kind IN ('paid', 'mixed') THEN 10000 END
       FROM bench_groups`,
    // one or two vendor orders per group (half of the groups have two)
    `INSERT INTO orders (id, "orderGroupId", "vendorId", "userId", status, subtotal, "createdAt", "updatedAt")
       SELECT ${id('or', "g || '-' || k")}, id, ${id('v', `1 + floor(${n.vendors} * power(random(), 2))::int`)}, user_id,
              (CASE kind
                 WHEN 'paid' THEN (ARRAY['DELIVERED','DELIVERED','DELIVERED','SHIPPED','FULFILLED','PAID'])[1 + (g + k) % 6]
                 WHEN 'expired' THEN 'CANCELLED' WHEN 'cancelled' THEN 'CANCELLED' WHEN 'pending' THEN 'PENDING'
                 ELSE CASE WHEN k = 1 THEN 'CANCELLED' ELSE 'DELIVERED' END END)::"OrderStatus",
              100, created_at, created_at
       FROM bench_groups, generate_series(1, 2) k WHERE k = 1 OR g % 2 = 0`,
    `INSERT INTO order_items (id, "orderId", "productId", "variantId", "titleSnapshot", "priceSnapshot", quantity)
       SELECT md5('oi' || o.id || j)::uuid::text, o.id, ${id('p', `1 + (abs(hashtext(o.id || j)) % ${n.products})`)},
              ${id('pv', `1 + (abs(hashtext(o.id || j)) % ${n.products})`)}, 'Item', 50, 1 + j % 2
       FROM orders o, generate_series(1, 2) j`,
    // ratings: skewed to 5 % of targets; one per (user, target)
    `INSERT INTO ratings (id, "userId", "targetType", "targetId", score, "createdAt", "updatedAt")
       SELECT ${id('r', 'i')}, ${id('u', `1 + (i % ${n.users})`)},
              (ARRAY['PRODUCT','VENDOR','BAZAAR'])[1 + i % 3]::"RatingTargetType",
              CASE i % 3 WHEN 0 THEN ${id('p', `1 + floor(${n.products} * 0.05 * power(random(), 2))::int`)}
                         WHEN 1 THEN ${id('v', `1 + floor(${n.vendors} * 0.05 * power(random(), 2))::int`)}
                         ELSE ${id('b', `1 + floor(${n.bazaars} * 0.05 * power(random(), 2))::int`)} END,
              1 + i % 5, now() - (random() * 365) * interval '1 day', now()
       FROM generate_series(1, ${n.ratings}) i ON CONFLICT DO NOTHING`,
    // favourites ≈ 3 per user + 50 heavy users × 600; types 70 % PRODUCT / 20 % VENDOR / 10 % BAZAAR
    `INSERT INTO favorites (id, "userId", "favorableType", "favorableId", "createdAt")
       SELECT md5('f' || u || '-' || k)::uuid::text, ${id('u', 'u')},
              (CASE WHEN k % 10 < 7 THEN 'PRODUCT' WHEN k % 10 < 9 THEN 'VENDOR' ELSE 'BAZAAR' END)::"FavorableType",
              CASE WHEN k % 10 < 7 THEN ${id('p', `1 + abs(hashtext(u || '-' || k)) % ${n.products}`)}
                   WHEN k % 10 < 9 THEN ${id('v', `1 + abs(hashtext(u || '-' || k)) % ${n.vendors}`)}
                   ELSE ${id('b', `1 + abs(hashtext(u || '-' || k)) % ${n.bazaars}`)} END,
              now() - (k * 37 % 500) * interval '1 hour'
       FROM generate_series(1, ${n.users}) u, generate_series(1, 600) k
       WHERE k <= CASE WHEN u <= 50 THEN 600 ELSE 3 END
       ON CONFLICT DO NOTHING`,
    // follows ≈ 3 per user + heavy users; 60 % VENDOR / 40 % BAZAAR
    `INSERT INTO follows (id, "userId", "followableType", "followableId", "createdAt")
       SELECT md5('fo' || u || '-' || k)::uuid::text, ${id('u', 'u')},
              (CASE WHEN k % 10 < 6 THEN 'VENDOR' ELSE 'BAZAAR' END)::"FollowableType",
              CASE WHEN k % 10 < 6 THEN ${id('v', `1 + abs(hashtext(u || '+' || k)) % ${n.vendors}`)}
                   ELSE ${id('b', `1 + abs(hashtext(u || '+' || k)) % ${n.bazaars}`)} END,
              now() - (k * 41 % 500) * interval '1 hour'
       FROM generate_series(1, ${n.users}) u, generate_series(1, 600) k
       WHERE k <= CASE WHEN u <= 50 THEN 600 ELSE 3 END
       ON CONFLICT DO NOTHING`,
  ];
}

async function seed(prisma) {
  const started = Date.now();
  for (const sql of seedSql(VOLUME, VERIFIED)) await prisma.$executeRawUnsafe(sql);
  if (!flag('no-vacuum')) await prisma.$executeRawUnsafe('VACUUM ANALYZE');
  else await prisma.$executeRawUnsafe('ANALYZE');
  console.log(`bench: seeded volume ×${VOLUME} (verified ${VERIFIED} %) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

// ---------------------------------------------------------------- reports
const FK_REPORT_SQL = `
  SELECT c.conrelid::regclass::text AS "table", c.conname AS fk,
         string_agg(a.attname, ', ' ORDER BY x.n) AS columns
  FROM pg_constraint c
  CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS x(attnum, n)
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = x.attnum
  WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
    AND NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = c.conrelid
        AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
        AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] <@ c.conkey)
  GROUP BY 1, 2 ORDER BY 1, 2`;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function time(fn) {
  for (let i = 0; i < WARMUP; i++) await fn(i);
  const reps = [];
  for (let r = 0; r < REPS; r++) {
    const samples = [];
    for (let i = 0; i < RUNS; i++) {
      const t = process.hrtime.bigint();
      await fn(i);
      samples.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    samples.sort((a, b) => a - b);
    reps.push({ p50: pct(samples, 50), p95: pct(samples, 95), max: samples[samples.length - 1] });
  }
  const med = (k) => reps.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(reps.length / 2)];
  const spread = Math.max(...reps.map((r) => r.p95)) - Math.min(...reps.map((r) => r.p95));
  return { p50: med('p50'), p95: med('p95'), max: Math.max(...reps.map((r) => r.max)), spread };
}

// ---------------------------------------------------------------- main
const fmt = (n) => (n === undefined ? '' : n.toFixed(2));

async function main() {
  const created = await ensureDatabase();
  migrate();
  const prisma = new PrismaClient({ datasources: { db: { url: BENCH_URL.toString() } }, log: [{ emit: 'event', level: 'query' }] });
  const captured = [];
  let capturing = null;
  prisma.$on('query', (e) => {
    if (capturing) captured.push({ target: capturing, query: e.query, params: e.params });
  });

  const counted = Number((await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM products'))[0].n);
  if (created || counted === 0) await seed(prisma);

  if (!existsSync(join(apiDir, 'dist/modules/products/products.repository.js'))) throw new Error('dist/ missing: run `pnpm build` first');
  const load = (p, name) => new (require(join(apiDir, 'dist', p))[name])(prisma);
  const products = load('modules/products/products.repository.js', 'ProductsRepository');
  const bazaars = load('modules/bazaars/bazaars.repository.js', 'BazaarsRepository');
  const orders = load('modules/orders/orders.repository.js', 'OrdersRepository');
  const social = load('modules/social/social.repository.js', 'SocialRepository');
  const users = load('modules/users/users.repository.js', 'UsersRepository');
  const vendors = load('modules/vendors/vendors.repository.js', 'VendorsRepository');

  // fixed-seed parameter pools
  const pick = async (sql) => (await prisma.$queryRawUnsafe(sql)).map((r) => r.id);
  const pool = {
    categories: await pick(`SELECT id FROM categories WHERE "parentId" IS NOT NULL ORDER BY md5(id) LIMIT 30`),
    vendors: await pick(`SELECT id FROM vendors WHERE verified AND "deletedAt" IS NULL ORDER BY md5(id) LIMIT 30`),
    products: await pick(`SELECT id FROM products WHERE "isActive" AND "deletedAt" IS NULL ORDER BY md5(id) LIMIT 50`),
    shoppers: await pick(`SELECT DISTINCT "userId" AS id FROM order_groups ORDER BY 1 LIMIT 50`),
    orderVendors: await pick(`SELECT "vendorId" AS id FROM orders GROUP BY 1 ORDER BY count(*) DESC LIMIT 30`),
    heavyUsers: await pick(`SELECT "userId" AS id FROM favorites GROUP BY 1 ORDER BY count(*) DESC LIMIT 10`),
    ratedProducts: await pick(`SELECT "targetId" AS id FROM ratings WHERE "targetType" = 'PRODUCT' GROUP BY 1 ORDER BY count(*) DESC LIMIT 20`),
  };
  const at = (list, i) => list[i % list.length];
  const deepCursor = async (table, userId) => {
    const r = await prisma.$queryRawUnsafe(`SELECT "createdAt", id FROM ${table} WHERE "userId" = $1 ORDER BY "createdAt" DESC, id DESC OFFSET 400 LIMIT 1`, userId);
    return r[0] ? { createdAt: r[0].createdAt, id: r[0].id } : undefined;
  };
  const cursors = {
    favorites: await Promise.all(pool.heavyUsers.map((u) => deepCursor('favorites', u))),
    follows: await Promise.all(pool.heavyUsers.map((u) => deepCursor('follows', u))),
  };
  const cutoff = new Date(Date.now() - 60 * 60_000);

  const targets = [
    ['products list (page 1)', (i) => products.findManyPaginated({ page: 1, limit: 20 })],
    ['products list (deep page 100)', (i) => products.findManyPaginated({ page: 100, limit: 20 })],
    ['products by category', (i) => products.findManyPaginated({ categoryId: at(pool.categories, i), page: 1, limit: 20 })],
    ['products by vendor', (i) => products.findManyPaginated({ vendorId: at(pool.vendors, i), page: 1, limit: 20 })],
    ['products search 2-char "sh"', (i) => products.findManyPaginated({ search: 'sh', page: 1, limit: 20 })],
    ['products search common "linen"', (i) => products.findManyPaginated({ search: 'linen', page: 1, limit: 20 })],
    ['products search rare "zircon"', (i) => products.findManyPaginated({ search: 'zircon', page: 1, limit: 20 })],
    ['product detail', (i) => products.findById(at(pool.products, i))],
    ['public bazaars', (i) => bazaars.findPublicPaginated(1, 20, {})],
    ['discovery with location', (i) => bazaars.findNearby({ lat: 30.0444, lng: 31.2357, radiusKm: 25, upcomingOnly: true }, 20)],
    ['discovery without location', (i) => bazaars.findNearby({ radiusKm: 25, upcomingOnly: true }, 20)],
    ['shopper orders', (i) => orders.findShopperOrders(at(pool.shoppers, i), 1, 20)],
    ['vendor orders', (i) => orders.findVendorOrders(at(pool.orderVendors, i), 1, 20)],
    ['vendor orders (status PAID)', (i) => orders.findVendorOrders(at(pool.orderVendors, i), 1, 20, 'PAID')],
    ['expiry candidate scan', (i) => orders.findStalePendingGroups(cutoff, 100)],
    ['expiry backlog', (i) => orders.staleBacklog(cutoff)],
    ['ratings list', (i) => social.findRatings('PRODUCT', at(pool.ratedProducts, i), { take: 21 })],
    ['ratings aggregate', (i) => social.aggregateRatings('PRODUCT', at(pool.ratedProducts, i))],
    ['favorites (deep cursor)', (i) => social.findFavorites(at(pool.heavyUsers, i), undefined, { take: 21, after: at(cursors.favorites, i) })],
    ['favorites PRODUCT (deep cursor)', (i) => social.findFavorites(at(pool.heavyUsers, i), 'PRODUCT', { take: 21, after: at(cursors.favorites, i) })],
    ['follows (deep cursor)', (i) => social.findFollows(at(pool.heavyUsers, i), undefined, { take: 21, after: at(cursors.follows, i) })],
    ['admin user search', (i) => users.findManyPaginated({ search: 'shopper12', includeDeleted: false, page: 1, limit: 20 })],
    ['admin vendor search', (i) => vendors.findManyForAdmin({ search: 'vendor 1', page: 1, limit: 20 })],
  ].filter(([name]) => !ONLY || name.includes(ONLY));

  // captured SQL (one call each)
  for (const [name, fn] of targets) {
    capturing = name;
    await fn(0);
  }
  capturing = null;

  const rows = [];
  for (const [name, fn] of targets) {
    const r = await time(fn);
    rows.push({ name, ...r });
    console.log(`bench: ${name.padEnd(36)} p50 ${fmt(r.p50)} ms  p95 ${fmt(r.p95)} ms  (spread ${fmt(r.spread)})`);
  }

  // write costs
  const writes = [];
  const vendorId = pool.vendors[0];
  const categoryId = pool.categories[0];
  let k = 0;
  const writeTargets = [
    ['product insert', () => prisma.product.create({ data: { vendorId, categoryId, title: `bench write ${STAGE} ${k++}`, description: 'x', basePrice: new Prisma.Decimal(10), images: [] } })],
    ['order group + 1 order + 2 items insert', () => prisma.orderGroup.create({ data: { userId: pool.shoppers[0], orders: { create: [{ vendorId, userId: pool.shoppers[0], subtotal: new Prisma.Decimal(10), items: { create: [{ productId: pool.products[0], variantId: md5uuid('pv', 1), titleSnapshot: 'x', priceSnapshot: new Prisma.Decimal(5), quantity: 1 }, { productId: pool.products[0], variantId: md5uuid('pv', 1), titleSnapshot: 'x', priceSnapshot: new Prisma.Decimal(5), quantity: 1 }] } }] } } })],
    ['favorite insert', () => prisma.favorite.create({ data: { userId: pool.shoppers[(k++) % pool.shoppers.length], favorableType: 'PRODUCT', favorableId: `bench-${STAGE}-${k}` } })],
  ];
  for (const [name, fn] of writeTargets) {
    const saveRuns = RUNS;
    const r = await time(fn);
    writes.push({ name, ...r });
    console.log(`bench: write ${name.padEnd(30)} p50 ${fmt(r.p50)} ms  p95 ${fmt(r.p95)} ms`);
    void saveRuns;
  }

  // concurrency: 50 clients × 15 s, default pool vs connection_limit=5
  const concurrency = [];
  if (!flag('no-concurrency')) {
    for (const limit of ['default', '5']) {
      const url = new URL(BENCH_URL);
      if (limit !== 'default') url.searchParams.set('connection_limit', limit);
      const client = new PrismaClient({ datasources: { db: { url: url.toString() } } });
      const repo = new (require(join(apiDir, 'dist/modules/products/products.repository.js')).ProductsRepository)(client);
      const ord = new (require(join(apiDir, 'dist/modules/orders/orders.repository.js')).OrdersRepository)(client);
      for (const [name, fn] of [
        ['products list', (i) => repo.findManyPaginated({ page: 1 + (i % 5), limit: 20 })],
        ['vendor orders', (i) => ord.findVendorOrders(at(pool.orderVendors, i), 1, 20)],
      ]) {
        const until = Date.now() + 15_000;
        const samples = [];
        let errors = 0;
        let p2024 = 0;
        await Promise.all(
          Array.from({ length: 50 }, async (_, c) => {
            let i = c;
            while (Date.now() < until) {
              const t = process.hrtime.bigint();
              try {
                await fn(i++);
                samples.push(Number(process.hrtime.bigint() - t) / 1e6);
              } catch (e) {
                errors++;
                if (e?.code === 'P2024') p2024++;
              }
            }
          }),
        );
        samples.sort((a, b) => a - b);
        const row = { pool: limit, name, throughput: samples.length / 15, p95: pct(samples, 95), errors, p2024 };
        concurrency.push(row);
        console.log(`bench: concurrency pool=${limit} ${name}: ${row.throughput.toFixed(0)} req/s, p95 ${fmt(row.p95)} ms, errors ${errors} (P2024 ${p2024})`);
      }
      await client.$disconnect();
    }
  }

  const fks = await prisma.$queryRawUnsafe(FK_REPORT_SQL);
  const counts = await prisma.$queryRawUnsafe(`SELECT relname AS t, n_live_tup::int AS n FROM pg_stat_user_tables WHERE relname IN ('products','product_variants','orders','order_items','order_groups','bazaars','ratings','favorites','follows','users','vendors') ORDER BY 1`);
  await prisma.$disconnect();

  // ---------------------------------------------------------------- report
  const date = new Date().toISOString().slice(0, 10);
  const dir = join(repoRoot, 'specs', 'perf');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `bench-${date}-${STAGE}.md`);
  const lines = [
    `# Query benchmark — ${STAGE} (${date})`,
    '',
    `Database \`${DB_NAME}\` on ${BENCH_URL.hostname}:${BENCH_URL.port}; volume ×${VOLUME}; verified vendors ${VERIFIED} %; ${WARMUP} warm-up + ${RUNS} timed runs × ${REPS} repetitions (median of the repetitions; spread = max − min p95). Plan: \`specs/architecture-and-query-performance-plan.md\` §2.1.`,
    '',
    `Row counts: ${counts.map((c) => `${c.t} ${c.n.toLocaleString('en')}`).join(' · ')}`,
    '',
    '## Reads (ms)',
    '',
    '| Query | p50 | p95 | max | p95 spread |',
    '|---|---:|---:|---:|---:|',
    ...rows.map((r) => `| ${r.name} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.max)} | ${fmt(r.spread)} |`),
    '',
    '## Writes (ms)',
    '',
    '| Write | p50 | p95 |',
    '|---|---:|---:|',
    ...writes.map((r) => `| ${r.name} | ${fmt(r.p50)} | ${fmt(r.p95)} |`),
    '',
    '## Concurrency (50 clients × 15 s)',
    '',
    '| Pool | Query | req/s | p95 ms | errors | P2024 |',
    '|---|---|---:|---:|---:|---:|',
    ...concurrency.map((r) => `| ${r.pool} | ${r.name} | ${r.throughput.toFixed(0)} | ${fmt(r.p95)} | ${r.errors} | ${r.p2024} |`),
    '',
    '## Foreign keys without a supporting index',
    '',
    '| Table | FK | Columns |',
    '|---|---|---|',
    ...fks.map((f) => `| ${f.table} | ${f.fk} | ${f.columns} |`),
    '',
    '## Captured SQL (Prisma 6, one call per target)',
    '',
    ...targets.flatMap(([name]) => [
      `### ${name}`,
      '',
      '```sql',
      ...captured.filter((c) => c.target === name).map((c) => `${c.query};  -- params ${c.params}`),
      '```',
      '',
    ]),
  ];
  writeFileSync(file, lines.join('\n'));
  console.log(`bench: report ${file}`);
}

function md5uuid(prefix, n) {
  // matches md5('<prefix>' || n)::uuid::text from the seed
  const hex = require('node:crypto').createHash('md5').update(`${prefix}${n}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
