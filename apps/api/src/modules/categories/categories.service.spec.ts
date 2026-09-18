import { Category } from '@prisma/client';

import { buildTree } from './categories.service';

const row = (id: string, name: string, parentId: string | null = null): Category => ({
  id,
  name,
  slug: name.toLowerCase(),
  parentId,
});

describe('buildTree', () => {
  it('nests children under their parent and keeps roots at the top level', () => {
    const tree = buildTree([
      row('women', 'Women'),
      row('men', 'Men'),
      row('dresses', 'Dresses', 'women'),
      row('maxi', 'Maxi', 'dresses'),
    ]);

    expect(tree.map((n) => n.slug)).toEqual(['women', 'men']);
    expect(tree[0].children.map((n) => n.slug)).toEqual(['dresses']);
    expect(tree[0].children[0].children.map((n) => n.slug)).toEqual(['maxi']);
    expect(tree[1].children).toEqual([]);
  });

  it('treats a category whose parent row is missing as a root', () => {
    const tree = buildTree([row('orphan', 'Orphan', 'gone')]);
    expect(tree).toHaveLength(1);
    expect(tree[0].slug).toBe('orphan');
  });

  it('does not expose parentId on the response shape', () => {
    const [node] = buildTree([row('women', 'Women')]);
    expect(Object.keys(node)).toEqual(['id', 'name', 'slug', 'children']);
  });
});
