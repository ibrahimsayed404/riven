#!/usr/bin/env node
// Live smoke test: boots the built API (dist/main.js) against the throwaway
// `<db>_test` database and walks every HTTP route in real order — register the
// four roles, moderate, sell, check out, deliver, rate, run a bazaar with booths,
// cancel, search — checking every status code plus behaviour (stock, audit rows,
// visibility, search documents). Fails if any controller route is left untested.
//
//   pnpm --filter @riven/api smoke        (builds first; needs `docker compose up -d`)
//
// Isolation: the server gets DATABASE_URL=<db>_test (refused otherwise),
// NODE_ENV=test (search indexes riven_test_*), its own Redis database
// (SMOKE_REDIS_DB, default 1) and no Paymob credentials. It never touches the
// dev database, the dev indexes or the dev queues. Don't run it while jest runs:
// both use <db>_test. Data it creates is left in place (unique per run); the
// e2e suites wipe it. Found the five bugs in report/2026-09-25T23-56-23Z_*.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------- environment
function loadDotEnv() {
  for (const file of [join(apiDir, '.env'), join(apiDir, '../../.env')]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}
loadDotEnv();

let server; // the API child process, once started

function fail(message) {
  console.error(`smoke: ${message}`);
  server?.kill();
  process.exit(2);
}

if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set (no .env found)');
const testDbUrl = (() => {
  if (process.env.SMOKE_DATABASE_URL) return new URL(process.env.SMOKE_DATABASE_URL);
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `${url.pathname}_test`;
  return url;
})();
if (!/_test$/.test(testDbUrl.pathname)) fail(`refusing to run against "${testDbUrl.pathname.slice(1)}": the database name must end in _test`);

const PORT = Number(process.env.SMOKE_PORT || 3100);
const BASE = `http://localhost:${PORT}/`;
const redisUrl = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
redisUrl.pathname = `/${process.env.SMOKE_REDIS_DB || 1}`;

if (!existsSync(join(apiDir, 'dist/main.js'))) fail('dist/main.js is missing: run `pnpm --filter @riven/api build` (or use the `smoke` script, which builds)');

// ---------------------------------------------------------------- server
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serverLog = join(tmpdir(), `riven-smoke-server-${Date.now()}.log`);

async function startServer() {
  try {
    await fetch(`${BASE}health`);
    fail(`port ${PORT} is already in use; stop that process or set SMOKE_PORT`);
  } catch {
    /* free */
  }

  const env = {
    ...process.env,
    DATABASE_URL: testDbUrl.toString(),
    NODE_ENV: 'test',
    PORT: String(PORT),
    REDIS_URL: redisUrl.toString(),
    // Blank = "not configured" (env.validation.ts): checkout must not call Paymob.
    PAYMOB_API_KEY: '',
    PAYMOB_INTEGRATION_ID: '',
    PAYMOB_HMAC_SECRET: '',
  };

  const migrate = spawnSync('npx prisma migrate deploy', { cwd: apiDir, env, shell: true, encoding: 'utf8' });
  if (migrate.status !== 0) fail(`prisma migrate deploy failed on ${testDbUrl.pathname.slice(1)}:\n${migrate.stdout}${migrate.stderr}`);

  const log = createWriteStream(serverLog);
  server = spawn(process.execPath, ['dist/main.js'], { cwd: apiDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  let exited = false;
  server.on('exit', () => (exited = true));

  for (let i = 0; i < 120; i++) {
    if (exited) fail(`the API exited during boot; see ${serverLog}`);
    try {
      if ((await fetch(`${BASE}health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  fail(`the API did not answer /health within 60 s; see ${serverLog}`);
}

// ---------------------------------------------------------------- routes under test
function controllerRoutes() {
  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.controller.ts') || e.name === 'app.module.ts') files.push(p);
    }
  })(join(apiDir, 'src'));

  const routes = new Set();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const ctrl = src.match(/@Controller\(\s*(?:'([^']*)')?\s*\)/);
    if (!ctrl) continue;
    for (const m of src.matchAll(/@(Get|Post|Patch|Put|Delete)\(\s*(?:'([^']*)')?\s*\)/g)) {
      const path = '/' + [ctrl[1], m[2]].filter(Boolean).join('/');
      routes.add(`${m[1].toUpperCase()} ${path.replace(/\/+/g, '/')}`);
    }
  }
  return routes;
}

// ---------------------------------------------------------------- harness
const run = Date.now().toString(36);
const WORD = `zq${run}`; // unique search token for this run
const PASS = 'Passw0rd1';
const results = [];
const covered = new Set();
const future = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

async function call(name, method, tpl, { token, body, params = {}, query, expect }) {
  covered.add(`${method} /${tpl}`);
  let path = tpl.replace(/:(\w+)/g, (_, k) => encodeURIComponent(params[k] ?? `missing-${k}`));
  if (query) path += '?' + new URLSearchParams(query).toString();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let status = 0;
  let text = '';
  try {
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    status = res.status;
    text = await res.text();
  } catch (error) {
    text = String(error);
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  const expected = Array.isArray(expect) ? expect : [expect];
  const ok = expected.includes(status);
  results.push({ kind: 'HTTP', name, method, path: '/' + path, expect: expected.join('|'), status, ok, code: json?.code, detail: ok ? '' : text.slice(0, 400) });
  return { status, body: json };
}

function check(name, cond, detail = '') {
  results.push({ kind: 'CHECK', name, ok: !!cond, detail: cond ? '' : String(detail).slice(0, 400) });
  return !!cond;
}

/** Polls until `probe()` returns a truthy value (search indexing is asynchronous). */
async function eventually(probe, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  let last;
  do {
    last = await probe();
    if (last) return last;
    await sleep(500);
  } while (Date.now() < until);
  return last;
}

const reg = (email, name = 'Tester') => ({ email, password: PASS, name });
async function login(email, password = PASS, expect = 201, name = 'login') {
  return (await call(name, 'POST', 'auth/login', { body: { email, password }, expect })).body || {};
}
const searchQuiet = async (path, q) => {
  const res = await fetch(`${BASE}${path}?${new URLSearchParams({ q })}`);
  return res.ok ? res.json() : null;
};

// ---------------------------------------------------------------- scenario
async function scenario(prisma) {
  // infra
  await call('health', 'GET', 'health', { expect: 200 });
  await call('admin route without token -> 401', 'GET', 'admin/users', { expect: 401 });

  // auth
  const shopperEmail = `shopper_${run}@t.com`;
  await call('register shopper', 'POST', 'auth/register', { body: reg(shopperEmail, 'Sara'), expect: 201 });
  await call('register with role ADMIN is refused', 'POST', 'auth/register', { body: { ...reg(`evil_${run}@t.com`), role: 'ADMIN' }, expect: 400 });
  await call('register duplicate email (case-insensitive)', 'POST', 'auth/register', { body: reg(shopperEmail.toUpperCase()), expect: 409 });
  const adminEmail = `admin_${run}@t.com`;
  await call('register admin-to-be', 'POST', 'auth/register', { body: reg(adminEmail, 'Admin'), expect: 201 });
  // The first admin is a manual DB change by design (spec3 B8a).
  await prisma.$executeRawUnsafe(`UPDATE "users" SET "role"='ADMIN' WHERE "email"=$1`, adminEmail);
  const v = await call('register vendor', 'POST', 'auth/register/vendor', {
    body: { ...reg(`vendor_${run}@t.com`, 'Ahmed'), businessName: `Nour ${WORD}`, category: 'FASHION', vendorType: 'MARKETPLACE', description: 'Linen' },
    expect: 201,
  });
  const vendorToken = v.body?.accessToken;
  const o = await call('register organizer', 'POST', 'auth/register/organizer', {
    body: { ...reg(`org_${run}@t.com`, 'Mona'), organizationName: 'Cairo Bazaars' },
    expect: 201,
  });
  const orgToken = o.body?.accessToken;
  const shopperToken = (await login(shopperEmail)).accessToken;
  const adminToken = (await login(adminEmail)).accessToken;
  await login(shopperEmail, 'WrongPass1', 401, 'login wrong password');
  const me = await call('auth/me', 'GET', 'auth/me', { token: shopperToken, expect: 200 });
  check('auth/me returns id, email, name, role', me.body?.id && me.body.email && me.body.name && me.body.role === 'SHOPPER', JSON.stringify(me.body));

  // refresh + logout on a throwaway user (reuse detection revokes every session)
  const t0Email = `t0_${run}@t.com`;
  await call('register throwaway t0', 'POST', 'auth/register', { body: reg(t0Email), expect: 201 });
  const t0 = await login(t0Email);
  const rf = await call('refresh', 'POST', 'auth/refresh', { body: { refreshToken: t0.refreshToken }, expect: 201 });
  await call('refresh reuse of rotated token -> 401', 'POST', 'auth/refresh', { body: { refreshToken: t0.refreshToken }, expect: 401 });
  await call('refresh after theft revocation -> 401', 'POST', 'auth/refresh', { body: { refreshToken: rf.body?.refreshToken }, expect: 401 });
  await call('logout', 'POST', 'auth/logout', { body: { refreshToken: rf.body?.refreshToken }, expect: 204 });

  // users
  await call('users/me', 'GET', 'users/me', { token: shopperToken, expect: 200 });
  const phone = '+2010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  await call('update users/me', 'PATCH', 'users/me', { token: shopperToken, body: { name: 'Sara M', phone, interests: ['fashion'] }, expect: 200 });
  await call('update users/me bad phone', 'PATCH', 'users/me', { token: shopperToken, body: { phone: '12345' }, expect: 400 });
  await call('users/me/location', 'PATCH', 'users/me/location', { token: shopperToken, body: { lat: 30.0444, lng: 31.2357 }, expect: 204 });
  await call('users/me/location twice -> 429', 'PATCH', 'users/me/location', { token: shopperToken, body: { lat: 30.0444, lng: 31.2357 }, expect: 429 });

  await call('admin list users', 'GET', 'admin/users', { token: adminToken, query: { search: run }, expect: 200 });
  await call('admin user detail', 'GET', 'admin/users/:id', { token: adminToken, params: { id: me.body?.id }, expect: 200 });
  await call('admin user detail unknown -> 404', 'GET', 'admin/users/:id', { token: adminToken, params: { id: '00000000-0000-0000-0000-000000000000' }, expect: 404 });
  await call('shopper on admin route -> 403', 'GET', 'admin/users', { token: shopperToken, expect: 403 });

  const t1Email = `t1_${run}@t.com`;
  await call('register throwaway t1', 'POST', 'auth/register', { body: reg(t1Email), expect: 201 });
  const t1 = await login(t1Email);
  const t1Id = (await call('t1 me', 'GET', 'users/me', { token: t1.accessToken, expect: 200 })).body?.id;
  await call('admin deactivate', 'PATCH', 'admin/users/:id/deactivate', { token: adminToken, params: { id: t1Id }, expect: 204 });
  await call('deactivate again (no-op)', 'PATCH', 'admin/users/:id/deactivate', { token: adminToken, params: { id: t1Id }, expect: 204 });
  await login(t1Email, PASS, 403, 'deactivated login -> 403');
  await call('deactivated access token -> 401', 'GET', 'users/me', { token: t1.accessToken, expect: 401 });
  await call('admin reactivate', 'PATCH', 'admin/users/:id/reactivate', { token: adminToken, params: { id: t1Id }, expect: 204 });
  const adminId = (await call('admin me', 'GET', 'auth/me', { token: adminToken, expect: 200 })).body?.id;
  await call('admin deactivate self -> 400', 'PATCH', 'admin/users/:id/deactivate', { token: adminToken, params: { id: adminId }, expect: 400 });

  const t2Email = `t2_${run}@t.com`;
  await call('register throwaway t2', 'POST', 'auth/register', { body: reg(t2Email), expect: 201 });
  const t2 = await login(t2Email);
  await call('delete account wrong password -> 401', 'DELETE', 'users/me', { token: t2.accessToken, body: { password: 'WrongPass1' }, expect: 401 });
  await call('delete account', 'DELETE', 'users/me', { token: t2.accessToken, body: { password: PASS }, expect: 204 });
  await login(t2Email, PASS, 401, 'deleted account login -> 401');

  // categories
  await call('public categories', 'GET', 'categories', { expect: 200 });
  const catId = (await call('admin create category', 'POST', 'admin/categories', { token: adminToken, body: { name: `Cat ${run}`, slug: `cat-${run}` }, expect: 201 })).body?.id;
  await call('duplicate slug -> 409', 'POST', 'admin/categories', { token: adminToken, body: { name: 'Dup', slug: `cat-${run}` }, expect: 409 });
  const childId = (await call('admin create child category', 'POST', 'admin/categories', { token: adminToken, body: { name: `Child ${run}`, slug: `child-${run}`, parentId: catId }, expect: 201 })).body?.id;
  await call('rename category', 'PATCH', 'admin/categories/:id', { token: adminToken, params: { id: catId }, body: { name: `Cat ${run} renamed` }, expect: 200 });
  await call('move under own child -> 400 CATEGORY_CYCLE', 'PATCH', 'admin/categories/:id', { token: adminToken, params: { id: catId }, body: { parentId: childId }, expect: 400 });
  await call('admin list categories', 'GET', 'admin/categories', { token: adminToken, expect: 200 });
  await call('delete category with child -> 409', 'DELETE', 'admin/categories/:id', { token: adminToken, params: { id: catId }, expect: 409 });
  await call('delete unused child category', 'DELETE', 'admin/categories/:id', { token: adminToken, params: { id: childId }, expect: 204 });

  // vendor profile
  const vendorId = (await call('vendors/me', 'GET', 'vendors/me', { token: vendorToken, expect: 200 })).body?.id;
  await call('update vendors/me', 'PATCH', 'vendors/me', { token: vendorToken, body: { description: 'Streetwear', category: 'FASHION', vendorType: 'BOTH' }, expect: 200 });
  await call('lowercase category enum -> 400', 'PATCH', 'vendors/me', { token: vendorToken, body: { category: 'fashion' }, expect: 400 });
  await call('vendors/me/location', 'PATCH', 'vendors/me/location', { token: vendorToken, body: { lat: 30.05, lng: 31.24 }, expect: 204 });
  await call('public vendor while unverified -> 404', 'GET', 'vendors/:id', { params: { id: vendorId }, expect: 404 });
  await call('admin list vendors', 'GET', 'admin/vendors', { token: adminToken, query: { status: 'pending' }, expect: 200 });
  await call('admin vendor detail', 'GET', 'admin/vendors/:id', { token: adminToken, params: { id: vendorId }, expect: 200 });
  await call('admin verify vendor', 'PATCH', 'admin/vendors/:id/verify', { token: adminToken, params: { id: vendorId }, expect: 200 });
  const pubV = await call('public vendor after verify', 'GET', 'vendors/:id', { params: { id: vendorId }, expect: 200 });
  check('public vendor hides internal fields', pubV.body && !('ownerId' in pubV.body) && !('rejectionReason' in pubV.body) && !('subscriptionStatus' in pubV.body), JSON.stringify(Object.keys(pubV.body || {})));
  await call('admin edit vendor', 'PATCH', 'admin/vendors/:id', { token: adminToken, params: { id: vendorId }, body: { description: 'Admin edited' }, expect: 200 });
  await call('admin edit vendor out-of-scope field -> 400', 'PATCH', 'admin/vendors/:id', { token: adminToken, params: { id: vendorId }, body: { vendorType: 'BOTH' }, expect: 400 });

  // products
  const images = ['http://localhost:9000/riven-media/x.jpg'];
  const mkProduct = async (n) =>
    (await call(`create product ${n}`, 'POST', 'vendors/me/products', {
      token: vendorToken, body: { title: `Linen ${n} ${WORD}`, description: 'Summer linen', categoryId: catId, basePrice: 450, images }, expect: 201,
    })).body?.id;
  const p1 = await mkProduct(1);
  const p2 = await mkProduct(2);
  const p3 = await mkProduct(3);
  const p4 = await mkProduct(4);
  await call('create product unknown category -> 400', 'POST', 'vendors/me/products', {
    token: vendorToken, body: { title: 'x', description: 'x', categoryId: '00000000-0000-0000-0000-000000000000', basePrice: 1, images }, expect: 400,
  });
  await call('vendor list products', 'GET', 'vendors/me/products', { token: vendorToken, expect: 200 });
  await call('vendor product detail', 'GET', 'vendors/me/products/:id', { token: vendorToken, params: { id: p1 }, expect: 200 });
  const mkVariant = async (pid, n, stock) =>
    (await call(`create variant ${n}`, 'POST', 'vendors/me/products/:id/variants', {
      token: vendorToken, params: { id: pid }, body: { sku: `SKU-${run}-${n}`, size: 'M', color: 'White', stockQuantity: stock }, expect: 201,
    })).body?.id;
  const v1 = await mkVariant(p1, 1, 10);
  const v2 = await mkVariant(p2, 2, 5);
  const v3 = await mkVariant(p3, 3, 5);
  const v4 = await mkVariant(p4, 4, 5);
  await call('duplicate sku -> 409 SKU_TAKEN', 'POST', 'vendors/me/products/:id/variants', { token: vendorToken, params: { id: p1 }, body: { sku: `SKU-${run}-1` }, expect: 409 });
  await call('update variant stock', 'PATCH', 'vendors/me/products/:id/variants/:variantId', { token: vendorToken, params: { id: p1, variantId: v1 }, body: { stockQuantity: 12 }, expect: 200 });
  await call('admin products list', 'GET', 'admin/products', { token: adminToken, query: { vendorId }, expect: 200 });
  await call('admin product detail', 'GET', 'admin/products/:id', { token: adminToken, params: { id: p1 }, expect: 200 });
  const pub = await call('public product list', 'GET', 'products', { query: { vendorId }, expect: 200 });
  check('public list contains the new product (no approval gate)', pub.body?.data?.some((x) => x.id === p1), JSON.stringify(pub.body?.meta));
  await call('public product detail', 'GET', 'products/:id', { params: { id: p1 }, expect: 200 });
  const ed = await call('vendor edit product', 'PATCH', 'vendors/me/products/:id', { token: vendorToken, params: { id: p2 }, body: { basePrice: 420 }, expect: 200 });
  check('vendor edit applies the change', String(ed.body?.basePrice) === '420', ed.body?.basePrice);
  await call('edited product still public', 'GET', 'products/:id', { params: { id: p2 }, expect: 200 });
  const ae = await call('admin edit product', 'PATCH', 'admin/products/:id', { token: adminToken, params: { id: p1 }, body: { title: `Admin Title ${WORD}` }, expect: 200 });
  check('admin edit applies the title', ae.body?.title === `Admin Title ${WORD}`, ae.body?.title);
  await call('admin edit product price -> 400', 'PATCH', 'admin/products/:id', { token: adminToken, params: { id: p1 }, body: { basePrice: 1 }, expect: 400 });
  await call('admin delete product 3', 'DELETE', 'admin/products/:id', { token: adminToken, params: { id: p3 }, expect: 204 });
  await call('admin delete product 3 again (no-op)', 'DELETE', 'admin/products/:id', { token: adminToken, params: { id: p3 }, expect: 204 });
  await call('vendor delete variant 4', 'DELETE', 'vendors/me/products/:id/variants/:variantId', { token: vendorToken, params: { id: p4, variantId: v4 }, expect: 200 });
  await call('vendor delete product 4', 'DELETE', 'vendors/me/products/:id', { token: vendorToken, params: { id: p4 }, expect: 200 });
  await call('deleted product public -> 404', 'GET', 'products/:id', { params: { id: p4 }, expect: 404 });

  // cart / checkout / orders
  await call('get cart', 'GET', 'cart', { token: shopperToken, expect: 200 });
  const itemId = (await call('add to cart', 'POST', 'cart/items', { token: shopperToken, body: { productId: p1, variantId: v1, quantity: 2 }, expect: 201 })).body?.id;
  await call('add too many -> 400 INSUFFICIENT_STOCK', 'POST', 'cart/items', { token: shopperToken, body: { productId: p1, variantId: v1, quantity: 999 }, expect: 400 });
  await call('update cart qty', 'PATCH', 'cart/items/:itemId', { token: shopperToken, params: { itemId }, body: { quantity: 3 }, expect: 200 });
  await call('remove cart item', 'DELETE', 'cart/items/:itemId', { token: shopperToken, params: { itemId }, expect: 200 });
  await call('add again', 'POST', 'cart/items', { token: shopperToken, body: { productId: p1, variantId: v1, quantity: 1 }, expect: 201 });
  await call('clear cart', 'DELETE', 'cart', { token: shopperToken, expect: 200 });
  await call('checkout empty cart -> 400', 'POST', 'checkout', { token: shopperToken, expect: 400 });
  await call('organizer on cart -> 403', 'POST', 'cart/items', { token: orgToken, body: { productId: p1, variantId: v1, quantity: 1 }, expect: 403 });
  await call('add deleted product -> 404', 'POST', 'cart/items', { token: shopperToken, body: { productId: p3, variantId: v3, quantity: 1 }, expect: 404 });

  const checkout = async (label, lines) => {
    for (const [productId, variantId, quantity] of lines) {
      await call(`${label}: add`, 'POST', 'cart/items', { token: shopperToken, body: { productId, variantId, quantity }, expect: 201 });
    }
    return (await call(`${label}: checkout`, 'POST', 'checkout', { token: shopperToken, expect: 201 })).body || {};
  };
  const g1 = await checkout('order 1', [[p1, v1, 2], [p2, v2, 1]]);
  check('checkout without Paymob sets paymentSetupFailed', g1.paymentSetupFailed === true, JSON.stringify(g1).slice(0, 200));
  const order1 = g1.orders?.[0]?.id;
  const stockAfter = await prisma.productVariant.findUnique({ where: { id: v1 } });
  check('stock reserved at checkout (12 -> 10)', stockAfter?.stockQuantity === 10, stockAfter?.stockQuantity);
  await call('retry payment without Paymob -> 503', 'POST', 'checkout/:orderGroupId/retry-payment', { token: shopperToken, params: { orderGroupId: g1.id }, expect: 503 });
  await call('shopper orders', 'GET', 'orders', { token: shopperToken, expect: 200 });
  await call('shopper order detail', 'GET', 'orders/:id', { token: shopperToken, params: { id: order1 }, expect: 200 });
  await call('vendor orders', 'GET', 'vendors/me/orders', { token: vendorToken, expect: 200 });
  await call('vendor order detail', 'GET', 'vendors/me/orders/:id', { token: vendorToken, params: { id: order1 }, expect: 200 });
  await call('vendor fulfil PENDING -> 400', 'PATCH', 'vendors/me/orders/:id/status', { token: vendorToken, params: { id: order1 }, body: { status: 'FULFILLED' }, expect: 400 });
  // No Paymob locally: mark the group paid the way the webhook would.
  await prisma.$executeRawUnsafe(`UPDATE "orders" SET "status"='PAID' WHERE "orderGroupId"=$1`, g1.id);
  await call('vendor FULFILLED', 'PATCH', 'vendors/me/orders/:id/status', { token: vendorToken, params: { id: order1 }, body: { status: 'FULFILLED' }, expect: 200 });
  await call('vendor SHIPPED', 'PATCH', 'vendors/me/orders/:id/status', { token: vendorToken, params: { id: order1 }, body: { status: 'SHIPPED' }, expect: 200 });
  await call('vendor DELIVERED -> 400', 'PATCH', 'vendors/me/orders/:id/status', { token: vendorToken, params: { id: order1 }, body: { status: 'DELIVERED' }, expect: 400 });
  await call('shopper cancel shipped -> 400', 'PATCH', 'orders/:id/cancel', { token: shopperToken, params: { id: order1 }, expect: 400 });
  await call('confirm delivery', 'PATCH', 'orders/:id/confirm-delivery', { token: shopperToken, params: { id: order1 }, expect: 200 });
  await call('confirm delivery again -> 400', 'PATCH', 'orders/:id/confirm-delivery', { token: shopperToken, params: { id: order1 }, expect: 400 });
  await call('admin orders', 'GET', 'admin/orders', { token: adminToken, query: { orderGroupId: g1.id }, expect: 200 });
  const aod = await call('admin order detail', 'GET', 'admin/orders/:id', { token: adminToken, params: { id: order1 }, expect: 200 });
  check('admin order detail has the payment record', aod.body?.orderGroup && 'paymobIntentId' in aod.body.orderGroup, JSON.stringify(aod.body?.orderGroup));
  await call('admin cancel delivered -> 400', 'PATCH', 'admin/orders/:id/cancel', { token: adminToken, params: { id: order1 }, expect: 400 });

  const g2 = await checkout('order 2', [[p1, v1, 1]]);
  const c2 = await call('shopper cancel pending', 'PATCH', 'orders/:id/cancel', { token: shopperToken, params: { id: g2.orders?.[0]?.id }, expect: 200 });
  check('shopper cancel returns cancelledOrderIds', Array.isArray(c2.body?.cancelledOrderIds), JSON.stringify(c2.body));
  const g3 = await checkout('order 3', [[p1, v1, 1]]);
  await call('admin cancel pending', 'PATCH', 'admin/orders/:id/cancel', { token: adminToken, params: { id: g3.orders?.[0]?.id }, expect: 200 });
  await call('admin cancel again (no-op)', 'PATCH', 'admin/orders/:id/cancel', { token: adminToken, params: { id: g3.orders?.[0]?.id }, expect: 200 });
  const stockEnd = await prisma.productVariant.findUnique({ where: { id: v1 } });
  check('stock restored after both cancels (still 10)', stockEnd?.stockQuantity === 10, stockEnd?.stockQuantity);

  // social
  await call('favorite product', 'POST', 'social/favorites', { token: shopperToken, body: { favorableType: 'PRODUCT', favorableId: p1 }, expect: 200 });
  await call('list favorites', 'GET', 'social/favorites', { token: shopperToken, expect: 200 });
  await call('unfavorite', 'DELETE', 'social/favorites', { token: shopperToken, body: { favorableType: 'PRODUCT', favorableId: p1 }, expect: 200 });
  await call('follow vendor', 'POST', 'social/follows', { token: shopperToken, body: { followableType: 'VENDOR', followableId: vendorId }, expect: 200 });
  await call('list follows', 'GET', 'social/follows', { token: shopperToken, expect: 200 });
  await call('unfollow', 'DELETE', 'social/follows', { token: shopperToken, body: { followableType: 'VENDOR', followableId: vendorId }, expect: 200 });
  await call('rate vendor without order -> 400', 'POST', 'social/ratings', { token: shopperToken, body: { targetType: 'VENDOR', targetId: vendorId, score: 5 }, expect: 400 });
  const rv = await call('rate vendor', 'POST', 'social/ratings', { token: shopperToken, body: { targetType: 'VENDOR', targetId: vendorId, score: 5, comment: 'Great', orderId: order1 }, expect: 200 });
  const rp = await call('rate product', 'POST', 'social/ratings', { token: shopperToken, body: { targetType: 'PRODUCT', targetId: p1, score: 2, comment: 'Meh', orderId: order1 }, expect: 200 });
  await call('rate product not in order -> 403', 'POST', 'social/ratings', { token: shopperToken, body: { targetType: 'PRODUCT', targetId: p4, score: 2, orderId: order1 }, expect: 403 });
  const sum = await call('rating summary', 'GET', 'social/ratings/summary', { query: { targetType: 'VENDOR', targetId: vendorId }, expect: 200 });
  check('summary count 1, average 5', sum.body?.count === 1 && Number(sum.body.average) === 5, JSON.stringify(sum.body));
  const pr = await call('public ratings', 'GET', 'social/ratings', { query: { targetType: 'VENDOR', targetId: vendorId }, expect: 200 });
  check('public ratings expose reviewerName, no userId', pr.body?.data?.[0]?.reviewerName && !('userId' in pr.body.data[0]), JSON.stringify(pr.body?.data?.[0]));
  await call('admin ratings', 'GET', 'admin/ratings', { token: adminToken, query: { hasComment: 'true', maxScore: '2' }, expect: 200 });
  const cc = await call('clear rating comment', 'PATCH', 'admin/ratings/:id/clear-comment', { token: adminToken, params: { id: rv.body?.id }, expect: 200 });
  check('comment cleared, score kept', cc.body?.comment === null && cc.body.score === 5, JSON.stringify(cc.body));
  await call('delete rating', 'DELETE', 'admin/ratings/:id', { token: adminToken, params: { id: rp.body?.id }, expect: 204 });
  await call('delete rating again -> 404', 'DELETE', 'admin/ratings/:id', { token: adminToken, params: { id: rp.body?.id }, expect: 404 });

  // organizer / bazaars
  const organizerId = (await call('organizers/me', 'GET', 'organizers/me', { token: orgToken, expect: 200 })).body?.id;
  await call('update organizers/me', 'PATCH', 'organizers/me', { token: orgToken, body: { name: 'Mona B' }, expect: 200 });
  const bz = (name, extra = {}) => ({ name: `${name} ${WORD}`, lat: 30.0626, lng: 31.2197, scheduleType: 'ONE_OFF', startDate: future(10), endDate: future(11), ...extra });
  await call('create bazaar unverified -> 403', 'POST', 'organizers/me/bazaars', { token: orgToken, body: bz('Early'), expect: 403 });
  await call('admin organizers queue', 'GET', 'admin/organizers', { token: adminToken, query: { status: 'pending' }, expect: 200 });
  await call('admin verify organizer', 'PATCH', 'admin/organizers/:id/verify', { token: adminToken, params: { id: organizerId }, expect: 200 });
  const mkBazaar = async (n) => (await call(`create bazaar ${n}`, 'POST', 'organizers/me/bazaars', { token: orgToken, body: bz(`Bazaar${n}`), expect: 201 })).body?.id;
  const b1 = await mkBazaar(1);
  const b2 = await mkBazaar(2);
  const b3 = await mkBazaar(3);
  const b4 = await mkBazaar(4);
  await call('endDate before startDate -> 400', 'POST', 'organizers/me/bazaars', { token: orgToken, body: bz('Backwards', { endDate: future(5) }), expect: 400 });
  await call('RECURRING without recurrenceRule -> 400', 'POST', 'organizers/me/bazaars', { token: orgToken, body: bz('Recurring', { scheduleType: 'RECURRING' }), expect: 400 });
  await call('organizer bazaars', 'GET', 'organizers/me/bazaars', { token: orgToken, expect: 200 });
  await call('organizer bazaar detail', 'GET', 'organizers/me/bazaars/:id', { token: orgToken, params: { id: b1 }, expect: 200 });
  await call('update bazaar', 'PATCH', 'organizers/me/bazaars/:id', { token: orgToken, params: { id: b1 }, body: { description: 'Food and music' }, expect: 200 });
  await call('update endDate before stored startDate -> 400', 'PATCH', 'organizers/me/bazaars/:id', { token: orgToken, params: { id: b4 }, body: { endDate: future(1) }, expect: 400 });
  await call('DRAFT bazaar public -> 404', 'GET', 'bazaars/:id', { params: { id: b1 }, expect: 404 });
  for (const [id, n] of [[b1, 1], [b2, 2], [b3, 3], [b4, 4]]) {
    await call(`publish bazaar ${n}`, 'PATCH', 'organizers/me/bazaars/:id/publish', { token: orgToken, params: { id }, expect: 200 });
  }
  await call('publish again -> 400', 'PATCH', 'organizers/me/bazaars/:id/publish', { token: orgToken, params: { id: b1 }, expect: 400 });
  await call('public bazaars', 'GET', 'bazaars', { expect: 200 });
  await call('public bazaar detail', 'GET', 'bazaars/:id', { params: { id: b1 }, expect: 200 });
  const disc = await call('discovery near me', 'GET', 'discovery/bazaars', { query: { lat: 30.0626, lng: 31.2197, radiusKm: 5 }, expect: 200 });
  check('discovery finds bazaar 1', disc.body?.data?.some((x) => x.id === b1), `${disc.body?.data?.length} rows`);
  await call('discovery lat without lng -> 400', 'GET', 'discovery/bazaars', { query: { lat: 30 }, expect: 400 });

  await call('vendor apply bazaar 1', 'POST', 'bazaars/:id/apply', { token: vendorToken, params: { id: b1 }, expect: 201 });
  await call('apply twice -> 409', 'POST', 'bazaars/:id/apply', { token: vendorToken, params: { id: b1 }, expect: 409 });
  await call('withdraw application', 'DELETE', 'bazaars/:id/apply', { token: vendorToken, params: { id: b1 }, expect: 204 });
  const app1 = (await call('re-apply after withdraw', 'POST', 'bazaars/:id/apply', { token: vendorToken, params: { id: b1 }, expect: 201 })).body?.id;
  await call('apply unknown bazaar -> 400', 'POST', 'bazaars/:id/apply', { token: vendorToken, params: { id: '00000000-0000-0000-0000-000000000000' }, expect: 400 });
  await call('vendor applications', 'GET', 'vendors/me/bazaar-applications', { token: vendorToken, expect: 200 });
  await call('organizer applications', 'GET', 'organizers/me/bazaars/:id/applications', { token: orgToken, params: { id: b1 }, expect: 200 });
  await call('organizer accept', 'PATCH', 'organizers/me/bazaars/:id/applications/:applicationId/accept', { token: orgToken, params: { id: b1, applicationId: app1 }, expect: 200 });
  await call('withdraw accepted application -> 400', 'DELETE', 'bazaars/:id/apply', { token: vendorToken, params: { id: b1 }, expect: 400 });
  const app2 = (await call('vendor apply bazaar 2', 'POST', 'bazaars/:id/apply', { token: vendorToken, params: { id: b2 }, expect: 201 })).body?.id;
  await call('admin applications', 'GET', 'admin/applications', { token: adminToken, query: { vendorId }, expect: 200 });
  await call('admin application detail', 'GET', 'admin/applications/:id', { token: adminToken, params: { id: app2 }, expect: 200 });
  await call('admin reject application', 'PATCH', 'admin/applications/:id/reject', { token: adminToken, params: { id: app2 }, body: { reason: 'Not a fit' }, expect: 200 });
  await call('admin accept rejected -> 400', 'PATCH', 'admin/applications/:id/accept', { token: adminToken, params: { id: app2 }, expect: 400 });
  await call('admin reject again (no-op)', 'PATCH', 'admin/applications/:id/reject', { token: adminToken, params: { id: app2 }, expect: 200 });
  const app3 = (await call('vendor apply bazaar 3', 'POST', 'bazaars/:id/apply', { token: vendorToken, params: { id: b3 }, expect: 201 })).body?.id;
  await call('organizer reject', 'PATCH', 'organizers/me/bazaars/:id/applications/:applicationId/reject', { token: orgToken, params: { id: b3, applicationId: app3 }, expect: 200 });
  await call('organizer reject again -> 400', 'PATCH', 'organizers/me/bazaars/:id/applications/:applicationId/reject', { token: orgToken, params: { id: b3, applicationId: app3 }, expect: 400 });
  const app4 = (await call('vendor apply bazaar 4', 'POST', 'bazaars/:id/apply', { token: vendorToken, params: { id: b4 }, expect: 201 })).body?.id;
  await call('admin accept application', 'PATCH', 'admin/applications/:id/accept', { token: adminToken, params: { id: app4 }, expect: 200 });

  // booths
  const grid = { gridConfig: { rows: 10, cols: 12, cellSize: 40 } };
  await call('create layout', 'POST', 'admin/bazaars/:bazaarId/layout', { token: adminToken, params: { bazaarId: b1 }, body: grid, expect: 201 });
  await call('create layout twice -> 409', 'POST', 'admin/bazaars/:bazaarId/layout', { token: adminToken, params: { bazaarId: b1 }, body: grid, expect: 409 });
  await call('get layout', 'GET', 'admin/bazaars/:bazaarId/layout', { token: adminToken, params: { bazaarId: b1 }, expect: 200 });
  await call('update layout', 'PATCH', 'admin/bazaars/:bazaarId/layout', { token: adminToken, params: { bazaarId: b1 }, body: { gridConfig: { rows: 12, cols: 12, cellSize: 40 } }, expect: 200 });
  const booth = (label, x) => ({ label, positionX: x, positionY: 0, width: 2, height: 2 });
  const bo1 = (await call('create booth A1', 'POST', 'admin/bazaars/:bazaarId/layout/booths', { token: adminToken, params: { bazaarId: b1 }, body: booth('A1', 0), expect: 201 })).body?.id;
  await call('duplicate booth label -> 409', 'POST', 'admin/bazaars/:bazaarId/layout/booths', { token: adminToken, params: { bazaarId: b1 }, body: booth('A1', 4), expect: 409 });
  const bo2 = (await call('create booth A2', 'POST', 'admin/bazaars/:bazaarId/layout/booths', { token: adminToken, params: { bazaarId: b1 }, body: booth('A2', 4), expect: 201 })).body?.id;
  await call('update booth', 'PATCH', 'admin/booths/:id', { token: adminToken, params: { id: bo1 }, body: { width: 3 }, expect: 200 });
  await call('assign booth', 'PATCH', 'admin/booths/:id/assign', { token: adminToken, params: { id: bo1 }, body: { boothListingId: app1 }, expect: 200 });
  await call('assign rejected application -> 400', 'PATCH', 'admin/booths/:id/assign', { token: adminToken, params: { id: bo2 }, body: { boothListingId: app2 }, expect: 400 });
  const lay = await call('public layout', 'GET', 'bazaars/:bazaarId/layout', { params: { bazaarId: b1 }, expect: 200 });
  check('public layout shows the assigned vendor', JSON.stringify(lay.body || {}).includes(vendorId), JSON.stringify(lay.body).slice(0, 300));
  await call('delete assigned booth -> 400', 'DELETE', 'admin/booths/:id', { token: adminToken, params: { id: bo1 }, expect: 400 });
  await call('unassign booth', 'PATCH', 'admin/booths/:id/unassign', { token: adminToken, params: { id: bo1 }, expect: 200 });
  await call('unassign again (no-op)', 'PATCH', 'admin/booths/:id/unassign', { token: adminToken, params: { id: bo1 }, expect: 200 });
  await call('delete booth', 'DELETE', 'admin/booths/:id', { token: adminToken, params: { id: bo2 }, expect: 200 });

  // cancels
  const oc1 = await call('organizer cancel bazaar 3', 'PATCH', 'organizers/me/bazaars/:id/cancel', { token: orgToken, params: { id: b3 }, expect: 200 });
  const oc2 = await call('organizer cancel bazaar 3 again', 'PATCH', 'organizers/me/bazaars/:id/cancel', { token: orgToken, params: { id: b3 }, expect: 200 });
  check('repeat organizer cancel writes nothing (updatedAt unchanged)', oc1.body?.updatedAt && oc1.body.updatedAt === oc2.body?.updatedAt, `${oc1.body?.updatedAt} vs ${oc2.body?.updatedAt}`);
  await call('admin list bazaars', 'GET', 'admin/bazaars', { token: adminToken, query: { organizerId }, expect: 200 });
  await call('admin bazaar detail', 'GET', 'admin/bazaars/:id', { token: adminToken, params: { id: b2 }, expect: 200 });
  await call('admin cancel bazaar 2', 'PATCH', 'admin/bazaars/:id/cancel', { token: adminToken, params: { id: b2 }, expect: 200 });
  await call('cancelled bazaar public -> 404', 'GET', 'bazaars/:id', { params: { id: b2 }, expect: 404 });

  // organizer reject hides their bazaars, verify restores them (spec3 B8b)
  await call('admin reject organizer', 'PATCH', 'admin/organizers/:id/reject', { token: adminToken, params: { id: organizerId }, body: { reason: 'Permit expired' }, expect: 200 });
  await call('rejected organizer bazaar hidden', 'GET', 'bazaars/:id', { params: { id: b1 }, expect: 404 });
  await call('rejected organizer layout hidden', 'GET', 'bazaars/:bazaarId/layout', { params: { bazaarId: b1 }, expect: 404 });
  await call('admin re-verify organizer', 'PATCH', 'admin/organizers/:id/verify', { token: adminToken, params: { id: organizerId }, expect: 200 });
  await call('bazaar back after re-verify', 'GET', 'bazaars/:id', { params: { id: b1 }, expect: 200 });
  await call('rate bazaar (no order needed)', 'POST', 'social/ratings', { token: shopperToken, body: { targetType: 'BAZAAR', targetId: b1, score: 4 }, expect: 200 });

  // search (indexing is asynchronous: poll, don't sleep)
  const hitIds = (body, key) => (body?.[key]?.hits ?? []).map((h) => h.id);
  const all = await eventually(async () => {
    const body = await searchQuiet('search', WORD);
    return hitIds(body, 'products').includes(p1) && hitIds(body, 'vendors').includes(vendorId) && hitIds(body, 'bazaars').includes(b1) ? body : null;
  });
  check('federated search finds the product, vendor and bazaar', all, 'not indexed within 20 s');
  await call('search all', 'GET', 'search', { query: { q: WORD }, expect: 200 });
  const sp = await call('search products', 'GET', 'search/products', { query: { q: WORD }, expect: 200 });
  check('deleted products are not searchable (3, 4)', sp.body?.hits && !sp.body.hits.some((h) => h.id === p3 || h.id === p4), JSON.stringify(sp.body?.hits?.map((h) => h.id)));
  await call('search vendors', 'GET', 'search/vendors', { query: { q: WORD }, expect: 200 });
  const sb = await call('search bazaars', 'GET', 'search/bazaars', { query: { q: WORD }, expect: 200 });
  check('cancelled bazaars are not searchable (2, 3)', sb.body?.hits && !sb.body.hits.some((h) => h.id === b2 || h.id === b3), JSON.stringify(sb.body?.hits?.map((h) => h.id)));
  await call('search without q -> 400', 'GET', 'search/products', { expect: 400 });

  // a vendor's own rename must reach the product documents (vendorName)
  await call('vendor self-rename', 'PATCH', 'vendors/me', { token: vendorToken, body: { businessName: `Renamed ${WORD}` }, expect: 200 });
  const renamed = await eventually(async () => {
    const hits = (await searchQuiet('search/products', WORD))?.hits ?? [];
    return hits.length >= 2 && hits.every((h) => h.vendorName === `Renamed ${WORD}`) ? hits : null;
  });
  check('product documents carry the new vendorName', renamed, 'still the old name after 20 s');
  await call('reindex (test prefix)', 'POST', 'admin/search/reindex', { token: adminToken, body: { types: ['products'] }, expect: 202 });
  await call('reindex as vendor -> 403', 'POST', 'admin/search/reindex', { token: vendorToken, body: {}, expect: 403 });

  // media / dashboard / webhook
  const upload = { purpose: 'PRODUCT_IMAGE', contentType: 'image/jpeg' };
  await call('upload url', 'POST', 'media/upload-url', { token: vendorToken, body: upload, expect: 200 });
  await call('upload url as shopper -> 403', 'POST', 'media/upload-url', { token: shopperToken, body: upload, expect: 403 });
  await call('upload url bad type -> 400', 'POST', 'media/upload-url', { token: vendorToken, body: { ...upload, contentType: 'application/pdf' }, expect: 400 });
  await call('admin overview', 'GET', 'admin/overview', { token: adminToken, expect: 200 });
  const al = await call('audit log', 'GET', 'admin/audit-log', { token: adminToken, query: { actorId: adminId, limit: '100' }, expect: 200 });
  const rows = al.body?.data ?? [];
  const actions = new Set(rows.map((r) => r.action));
  for (const a of [
    'USER_DEACTIVATED', 'USER_REACTIVATED', 'CATEGORY_CREATED', 'CATEGORY_DELETED', 'VENDOR_VERIFIED', 'VENDOR_EDITED',
    'PRODUCT_EDITED', 'PRODUCT_DELETED', 'ORDER_CANCELLED', 'RATING_COMMENT_CLEARED',
    'RATING_DELETED', 'ORGANIZER_VERIFIED', 'ORGANIZER_REJECTED', 'APPLICATION_REJECTED', 'APPLICATION_ACCEPTED',
    'BOOTH_LAYOUT_CREATED', 'BOOTH_LAYOUT_UPDATED', 'BOOTH_CREATED', 'BOOTH_UPDATED', 'BOOTH_ASSIGNED', 'BOOTH_UNASSIGNED',
    'BOOTH_DELETED', 'BAZAAR_CANCELLED', 'SEARCH_REINDEX_REQUESTED',
  ]) {
    check(`audit row ${a}`, actions.has(a), [...actions].join(','));
  }
  check('unassign no-op wrote no second audit row', rows.filter((r) => r.action === 'BOOTH_UNASSIGNED').length === 1);
  check('admin cancel no-op wrote no second audit row', rows.filter((r) => r.action === 'ORDER_CANCELLED').length === 1);
  await call('paymob webhook unsigned -> 401', 'POST', 'webhooks/paymob', { body: { obj: {} }, expect: 401 });

  // category in use
  const cu = await call('delete used category -> 409', 'DELETE', 'admin/categories/:id', { token: adminToken, params: { id: catId }, expect: 409 });
  check('409 details carry counts', typeof cu.body?.details?.productCount === 'number', JSON.stringify(cu.body));
  await call('vendor on admin overview -> 403', 'GET', 'admin/overview', { token: vendorToken, expect: 403 });

  // vendor reject (= suspend, spec3 B1) hides the shop and products; verify lifts it
  await call('admin reject vendor', 'PATCH', 'admin/vendors/:id/reject', { token: adminToken, params: { id: vendorId }, body: { reason: 'Fake documents' }, expect: 200 });
  await call('rejected vendor public -> 404', 'GET', 'vendors/:id', { params: { id: vendorId }, expect: 404 });
  await call('rejected vendor product public -> 404', 'GET', 'products/:id', { params: { id: p1 }, expect: 404 });
  await call('rejected vendor product not addable to cart', 'POST', 'cart/items', { token: shopperToken, body: { productId: p1, variantId: v1, quantity: 1 }, expect: 404 });
  await call('reject without reason -> 400', 'PATCH', 'admin/vendors/:id/reject', { token: adminToken, params: { id: vendorId }, body: {}, expect: 400 });
  await call('admin re-verify vendor', 'PATCH', 'admin/vendors/:id/verify', { token: adminToken, params: { id: vendorId }, expect: 200 });
  await call('product back after re-verify', 'GET', 'products/:id', { params: { id: p1 }, expect: 200 });
  const restored = await eventually(async () => {
    const ids = ((await searchQuiet('search/products', WORD))?.hits ?? []).map((h) => h.id);
    return ids.includes(p1) && ids.includes(p2);
  });
  check('re-verify restores both products in search', restored, 'not re-indexed within 20 s');
}

// ---------------------------------------------------------------- main
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.toString() } } });
let exitCode = 1;
try {
  console.log(`smoke: run ${run} against ${testDbUrl.pathname.slice(1)} on :${PORT} (redis db ${redisUrl.pathname.slice(1)})`);
  await startServer();
  try {
    await scenario(prisma);
  } catch (error) {
    results.push({ kind: 'CRASH', name: 'scenario crashed', ok: false, detail: error.stack });
  }

  const routes = controllerRoutes();
  const untested = [...routes].filter((r) => !covered.has(r)).sort();
  const failed = results.filter((r) => !r.ok);
  const requests = results.filter((r) => r.kind === 'HTTP').length;
  const resultsFile = join(tmpdir(), `riven-smoke-${run}.json`);
  writeFileSync(resultsFile, JSON.stringify(results, null, 2));

  console.log(`smoke: ${requests} requests, ${results.length - requests} checks, ${failed.length} failed`);
  console.log(`smoke: routes covered ${routes.size - untested.length}/${routes.size}${untested.length ? ` — untested: ${untested.join(', ')}` : ''}`);
  for (const f of failed) {
    console.log(`  FAIL [${f.kind}] ${f.name} ${f.method ?? ''} ${f.path ?? ''} expected=${f.expect ?? ''} got=${f.status ?? ''} ${f.code ?? ''}\n       ${f.detail}`);
  }
  console.log(`smoke: details ${resultsFile}\nsmoke: server log ${serverLog}`);
  exitCode = failed.length === 0 && untested.length === 0 ? 0 : 1;
} finally {
  await prisma.$disconnect();
  server?.kill();
}
process.exit(exitCode);
