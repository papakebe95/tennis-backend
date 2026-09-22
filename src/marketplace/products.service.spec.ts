import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { withCategoryCode } from './marketplace.shared.js';
import { ProductsService } from './products.service.js';

const product = {
  id: 'p1',
  title: 'Wilson Pro Staff',
  category: { code: 'RACKET' },
  price: 95000,
};

const build = (overrides: Record<string, unknown> = {}) => {
  const prisma = {
    productCategory: {
      findMany: vi.fn().mockResolvedValue([
        { code: 'RACKET', label: 'Rackets', icon: 'racket' },
        { code: 'SHOES', label: 'Shoes', icon: 'shoes' },
      ]),
      findUnique: vi.fn(async ({ where }: { where: { code: string } }) =>
        where.code === 'RACKET' ? { id: 'cat-racket' } : null,
      ),
    },
    product: {
      create: vi.fn().mockResolvedValue(product),
      update: vi.fn().mockResolvedValue(product),
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: 'p1', sellerId: 'u1', status: 'AVAILABLE' }),
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([product]),
    },
    $transaction: vi.fn((queries: Promise<unknown>[]) => Promise.all(queries)),
    ...overrides,
  };
  return { service: new ProductsService(prisma as never), prisma };
};

const dto = (category: string) =>
  ({
    title: 'Wilson Pro Staff',
    price: 95000,
    category,
    condition: 'USED',
    photos: ['http://localhost:3000/uploads/x.jpg'],
  }) as never;

describe('withCategoryCode', () => {
  it('turns the linked category row back into its code', () => {
    expect(withCategoryCode(product)).toEqual({
      id: 'p1',
      title: 'Wilson Pro Staff',
      category: 'RACKET',
      price: 95000,
    });
  });
});

describe('ProductsService categories', () => {
  it('lists categories as value/label/icon, ordered by sortOrder', async () => {
    const { service, prisma } = build();
    expect(await service.categories()).toEqual([
      { value: 'RACKET', label: 'Rackets', icon: 'racket' },
      { value: 'SHOES', label: 'Shoes', icon: 'shoes' },
    ]);
    expect(prisma.productCategory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      }),
    );
  });

  it('links a new product to the category row and returns the code', async () => {
    const { service, prisma } = build();
    const created = await service.create('u1', dto('RACKET'));
    expect(prisma.product.create.mock.calls[0][0].data.categoryId).toBe(
      'cat-racket',
    );
    expect(created.category).toBe('RACKET');
  });

  it('rejects a category code that does not exist', async () => {
    const { service, prisma } = build();
    await expect(service.create('u1', dto('TROPHIES'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.product.create).not.toHaveBeenCalled();
  });

  it('only touches the category on update when one is sent', async () => {
    const { service, prisma } = build();
    await service.update('u1', 'p1', { title: 'New title' } as never);
    expect(prisma.productCategory.findUnique).not.toHaveBeenCalled();
    expect(prisma.product.update.mock.calls[0][0].data.categoryId).toBeUndefined();

    await service.update('u1', 'p1', { category: 'RACKET' } as never);
    expect(prisma.product.update.mock.calls[1][0].data.categoryId).toBe(
      'cat-racket',
    );
    await expect(
      service.update('u1', 'p1', { category: 'NOPE' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('filters the list by category code and returns codes', async () => {
    const { service, prisma } = build();
    const page = await service.list({ category: 'RACKET' } as never);
    expect(prisma.product.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ category: { code: 'RACKET' } }),
    });
    expect(page.items[0].category).toBe('RACKET');
  });
});
