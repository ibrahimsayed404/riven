/**
 * The subset of `update` whose values differ from `current` — what an admin
 * edit should actually write. `undefined` means "not sent" and is skipped;
 * arrays compare by value, in order. Empty result = a no-op edit (no write,
 * no audit, no search job: specs/admin-module-spec3.md §0).
 *
 * Typed by `update`, so only fields the caller was allowed to send can come
 * back — never a field that merely exists on the current row.
 */
export function changedFields<U extends object>(current: object, update: U): Partial<U> {
  const row = current as Record<string, unknown>;
  const changes: Partial<U> = {};
  for (const key of Object.keys(update) as (keyof U & string)[]) {
    const next = update[key];
    if (next === undefined) continue;
    if (!sameValue(row[key], next)) changes[key] = next;
  }
  return changes;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => item === b[i]);
  }
  return a === b;
}
