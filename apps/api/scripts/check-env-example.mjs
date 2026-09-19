#!/usr/bin/env node
// Fails when a key required by src/infra/config/env.validation.ts is missing from
// .env.example — the drift that left every e2e unable to boot (fix.js CI-01).
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const validation = readFileSync(resolve(here, '../src/infra/config/env.validation.ts'), 'utf8');
const example = readFileSync(resolve(here, '../../../.env.example'), 'utf8');

// Each top-level key in the z.object({...}) starts a line with two spaces and
// runs until the next such key; a key is optional if its definition mentions
// optional() or .default(.
const keyPattern = /^\s{2}([A-Z][A-Z0-9_]+):/gm;
const keys = [...validation.matchAll(keyPattern)].map((m) => ({ name: m[1], start: m.index }));
const definitions = keys.map((key, i) => ({
  name: key.name,
  body: validation.slice(key.start, keys[i + 1]?.start ?? validation.length),
}));

const present = new Set([...example.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));

const required = definitions.filter((d) => !/optional\(\)|\.default\(/.test(d.body)).map((d) => d.name);
const missing = required.filter((key) => !present.has(key));

if (missing.length) {
  console.error('.env.example is missing keys that env.validation.ts requires:', missing.join(', '));
  process.exit(1);
}
console.log(`env check ok: ${required.length} required keys all present in .env.example (${definitions.length - required.length} optional)`);
