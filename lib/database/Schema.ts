import { DB } from '@lib/database/DB.js'
import type { Knex } from 'knex'

export class SchemaBuilder {
  constructor(private connectionName?: string) {}

  private get schema() {
    return DB.connection(this.connectionName).schema
  }

  async create(table: string, callback: (table: Knex.CreateTableBuilder) => void): Promise<void> {
    await this.schema.createTable(table, callback)
  }

  async table(table: string, callback: (table: Knex.TableBuilder) => void): Promise<void> {
    await this.schema.alterTable(table, callback)
  }

  async drop(table: string): Promise<void> {
    await this.schema.dropTable(table)
  }

  async dropIfExists(table: string): Promise<void> {
    await this.schema.dropTableIfExists(table)
  }

  async rename(from: string, to: string): Promise<void> {
    await this.schema.renameTable(from, to)
  }

  async dropColumns(table: string, columns: string | string[]): Promise<void> {
    const names = Array.isArray(columns) ? columns : [columns]
    await this.schema.alterTable(table, builder => {
      for (const column of names) builder.dropColumn(column)
    })
  }

  async renameColumn(table: string, from: string, to: string): Promise<void> {
    await this.schema.alterTable(table, builder => {
      builder.renameColumn(from, to)
    })
  }

  async createCacheTable(table = 'cache'): Promise<void> {
    await this.create(table, builder => {
      builder.string('key').primary()
      builder.text('value').notNullable()
      builder.integer('expiration').notNullable()
    })
  }

  async createSessionTable(table = 'sessions'): Promise<void> {
    await this.create(table, builder => {
      builder.string('id').primary()
      builder.integer('user_id').nullable().index()
      builder.string('ip_address', 45).nullable()
      builder.text('user_agent').nullable()
      builder.text('payload').notNullable()
      builder.integer('last_activity').notNullable().index()
    })
  }

  async createQueueTables(jobs = 'jobs', failed = 'failed_jobs'): Promise<void> {
    await this.create(jobs, builder => {
      builder.increments('id')
      builder.string('queue').notNullable().index()
      builder.text('payload').notNullable()
      builder.integer('attempts').notNullable().defaultTo(0)
      builder.integer('reserved_at').nullable()
      builder.integer('available_at').notNullable()
      builder.integer('created_at').notNullable()
    })
    await this.create(failed, builder => {
      builder.increments('id')
      builder.string('uuid').nullable().unique()
      builder.text('connection').notNullable()
      builder.text('queue').notNullable()
      builder.text('payload').notNullable()
      builder.text('exception').notNullable()
      builder.timestamp('failed_at').defaultTo(DB.connection(this.connectionName).fn.now())
    })
  }

  async hasTable(table: string): Promise<boolean> {
    return this.schema.hasTable(table)
  }

  async hasColumn(table: string, column: string): Promise<boolean> {
    return this.schema.hasColumn(table, column)
  }
}

export const Schema = new SchemaBuilder()
