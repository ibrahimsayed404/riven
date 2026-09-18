import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Placeholder v1 taxonomy. The real list is still open (fashion addendum §7 #4);
// editing this tree is the only change needed. Upserts on slug, so re-running
// is safe and renames propagate without duplicating rows.
const CATEGORY_TREE: { name: string; slug: string; children?: { name: string; slug: string }[] }[] = [
  {
    name: 'Women',
    slug: 'women',
    children: [
      { name: 'Dresses', slug: 'women-dresses' },
      { name: 'Tops', slug: 'women-tops' },
      { name: 'Abayas & Modest', slug: 'women-modest' },
      { name: 'Bags', slug: 'women-bags' },
      { name: 'Jewelry', slug: 'women-jewelry' },
    ],
  },
  {
    name: 'Men',
    slug: 'men',
    children: [
      { name: 'Shirts', slug: 'men-shirts' },
      { name: 'Galabeyas', slug: 'men-galabeyas' },
      { name: 'Accessories', slug: 'men-accessories' },
    ],
  },
  {
    name: 'Kids',
    slug: 'kids',
    children: [
      { name: 'Girls', slug: 'kids-girls' },
      { name: 'Boys', slug: 'kids-boys' },
    ],
  },
  {
    name: 'Home & Crafts',
    slug: 'home-crafts',
    children: [
      { name: 'Textiles', slug: 'home-textiles' },
      { name: 'Ceramics', slug: 'home-ceramics' },
    ],
  },
];

async function seedCategories() {
  let count = 0;
  for (const root of CATEGORY_TREE) {
    const parent = await prisma.category.upsert({
      where: { slug: root.slug },
      update: { name: root.name, parentId: null },
      create: { name: root.name, slug: root.slug },
    });
    count++;
    for (const child of root.children ?? []) {
      await prisma.category.upsert({
        where: { slug: child.slug },
        update: { name: child.name, parentId: parent.id },
        create: { name: child.name, slug: child.slug, parentId: parent.id },
      });
      count++;
    }
  }
  return count;
}

async function main() {
  const categories = await seedCategories();
  console.log(`Seeded ${categories} categories`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
