import { pgTable, text, timestamp, jsonb, uuid } from 'drizzle-orm/pg-core';

export const agents = pgTable('agents', {
  role: text('role').primaryKey(),
  displayName: text('display_name').notNull(),
});

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  type: text('type').notNull(),
  role: text('role').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const taskEvents = pgTable('task_events', {
  id: uuid('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  taskId: uuid('task_id').notNull().references(() => tasks.id),
  role: text('role').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const products = pgTable('products', {
  id: uuid('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text('name').notNull(),
  description: text('description').notNull(),
  language: text('language').notNull().default('typescript'),
  status: text('status').notNull().default('proposed'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const architectureProposals = pgTable('architecture_proposals', {
  id: uuid('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  productId: uuid('product_id').notNull().references(() => products.id),
  taskId: uuid('task_id').references(() => tasks.id),
  serviceName: text('service_name').notNull(),
  summary: text('summary').notNull(),
  endpoints: jsonb('endpoints').notNull(),
  dataModel: jsonb('data_model').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
