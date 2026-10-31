#!/usr/bin/env node
/**
 * Environment guard (specs/architecture-and-query-performance-plan.md §0).
 *
 * Run immediately before any database-touching command of the refactor work:
 *   node scripts/env-guard.mjs test     jest / pnpm smoke  → DATABASE_URL must be localhost:5433/riven_test
 *   node scripts/env-guard.mjs bench    bench / its admin  → BENCH_DATABASE_URL must be localhost:5433/<x>_bench_test
 *   node scripts/env-guard.mjs migrate  prisma migrate *   → DATABASE_URL must be localhost:5433 (riven, riven_test or *_bench_test)
 *
 * In every mode REDIS_URL and MEILISEARCH_HOST (when set) must point at localhost.
 * Prints what it parsed (kept as stage evidence) and exits 1 on any mismatch, so
 * production (Supabase, Redis Cloud, hosted Meilisearch) can never be reached.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const DB_PORT = '5433';

function loadDotEnv() {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

export function checkEnvironment(mode, env = process.env) {
  const problems = [];
  const report = { mode };

  const dbVar = mode === 'bench' ? 'BENCH_DATABASE_URL' : 'DATABASE_URL';
  const raw = env[dbVar];
  if (!raw) {
    problems.push(`${dbVar} is not set`);
  } else {
    let url;
    try {
      url = new URL(raw);
    } catch {
      problems.push(`${dbVar} is not a URL`);
    }
    if (url) {
      const database = url.pathname.replace(/^\//, '');
      report.database = { host: url.hostname, port: url.port, name: database };
      if (!LOCAL_HOSTS.has(url.hostname)) problems.push(`${dbVar} host "${url.hostname}" is not localhost`);
      if (url.port !== DB_PORT) problems.push(`${dbVar} port "${url.port}" is not ${DB_PORT}`);
      if (mode === 'test' && database !== 'riven_test') problems.push(`database "${database}" is not riven_test`);
      if (mode === 'bench' && !/_bench_test$/.test(database)) problems.push(`database "${database}" does not end in _bench_test`);
      if (mode === 'migrate' && !['riven', 'riven_test'].includes(database) && !/_bench_test$/.test(database)) {
        problems.push(`database "${database}" is not riven, riven_test or *_bench_test`);
      }
    }
  }

  for (const name of ['REDIS_URL', 'MEILISEARCH_HOST']) {
    if (!env[name]) continue;
    try {
      const host = new URL(env[name]).hostname;
      report[name] = host;
      if (!LOCAL_HOSTS.has(host)) problems.push(`${name} host "${host}" is not localhost`);
    } catch {
      problems.push(`${name} is not a URL`);
    }
  }

  if (!['test', 'bench', 'migrate'].includes(mode)) problems.push(`unknown mode "${mode}" (test | bench | migrate)`);
  return { ok: problems.length === 0, report, problems };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('env-guard.mjs')) {
  loadDotEnv();
  const { ok, report, problems } = checkEnvironment(process.argv[2]);
  console.log(`env-guard: ${JSON.stringify(report)}`);
  if (!ok) {
    for (const p of problems) console.error(`env-guard: REFUSED — ${p}`);
    process.exit(1);
  }
  console.log('env-guard: ok');
}
