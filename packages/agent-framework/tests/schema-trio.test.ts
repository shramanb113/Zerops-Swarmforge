import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDb, products, architectureProposals, type Db } from '../src/index.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://swarmforge:swarmforge@localhost:5432/swarmforge';

describe('products and architectureProposals schema', () => {
  let db: Db;

  beforeAll(async () => {
    db = await createDb(DB_URL);
  });

  it('inserts a product and a linked architecture proposal', async () => {
    const productId = randomUUID();
    await db.insert(products).values({ id: productId, name: 'todo-api', description: 'a todo app', status: 'proposed' });

    const proposalId = randomUUID();
    await db.insert(architectureProposals).values({
      id: proposalId,
      productId,
      serviceName: 'todo-api',
      summary: 'A REST API for managing todos.',
      endpoints: [{ method: 'GET', path: '/todos' }],
      dataModel: { todo: { id: 'string', title: 'string', done: 'boolean' } },
    });

    const [row] = await db.select().from(products).where(eq(products.id, productId));
    expect(row?.status).toBe('proposed');

    const [proposal] = await db.select().from(architectureProposals).where(eq(architectureProposals.productId, productId));
    expect(proposal?.serviceName).toBe('todo-api');
  });
});
