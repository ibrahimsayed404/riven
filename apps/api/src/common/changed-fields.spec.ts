import { changedFields } from './changed-fields';

describe('changedFields', () => {
  const current = { name: 'Shop', description: 'Old', coverMedia: ['a', 'b'] as string[], logo: null as string | null };

  it('keeps only fields that differ, skipping undefined (not sent)', () => {
    expect(changedFields(current, { name: 'Shop', description: 'New', logo: undefined })).toEqual({ description: 'New' });
  });

  it('compares arrays by value and order', () => {
    expect(changedFields(current, { coverMedia: ['a', 'b'] })).toEqual({});
    expect(changedFields(current, { coverMedia: ['b', 'a'] })).toEqual({ coverMedia: ['b', 'a'] });
    expect(changedFields(current, { coverMedia: ['a'] })).toEqual({ coverMedia: ['a'] });
  });

  it('treats null -> value as a change and an empty update as a no-op', () => {
    expect(changedFields(current, { logo: 'https://cdn/logo.png' })).toEqual({ logo: 'https://cdn/logo.png' });
    expect(changedFields(current, {})).toEqual({});
  });
});
