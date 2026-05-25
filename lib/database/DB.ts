import knex, { type Knex } from 'knex'
import { config } from '@lib/foundation/helpers.js'

type QueryListener = (query: { sql: string, bindings?: unknown[], connection: string }) => void
type AfterCommitCallback = () => void | Promise<void>

export class DatabaseManager {
  private connections = new Map<string, Knex>()
  private listeners: QueryListener[] = []
  private queryLog: Array<{ sql: string, bindings?: unknown[], connection: string }> = []
  private loggingQueries = false
  private afterCommitCallbacks: AfterCommitCallback[] = []

  connection(name = config<string>('database.default', 'sqlite')) {
    if (!this.connections.has(name)) {
      const connectionConfig = config<Knex.Config>(`database.connections.${name}`)
      if (!connectionConfig) throw new Error(`Database connection [${name}] is not configured.`)
      const connection = knex(connectionConfig)
      connection.on('query', query => this.recordQuery(name, query))
      this.connections.set(name, connection)
    }
    return this.connections.get(name)!
  }

  table(table: string) {
    return enhanceQueryBuilder(this.connection()(table))
  }

  raw(sql: string, bindings?: unknown[]) {
    return this.connection().raw(sql, bindings as any)
  }

  expression(value: string) {
    return this.connection().raw(value)
  }

  listen(callback: QueryListener) {
    this.listeners.push(callback)
    return () => {
      this.listeners = this.listeners.filter(listener => listener !== callback)
    }
  }

  enableQueryLog() {
    this.loggingQueries = true
    this.queryLog = []
  }

  disableQueryLog() {
    this.loggingQueries = false
  }

  getQueryLog() {
    return [...this.queryLog]
  }

  flushQueryLog() {
    this.queryLog = []
  }

  afterCommit(callback: AfterCommitCallback) {
    this.afterCommitCallbacks.push(callback)
  }

  async transaction<T>(callback: (trx: Knex.Transaction) => Promise<T>) {
    const { Event } = await import('@lib/events/Event.js')
    Event.beginTransaction()
    try {
      const result = await this.connection().transaction(callback)
      await this.runAfterCommitCallbacks()
      await Event.commitTransaction()
      return result
    } catch (error) {
      Event.rollBackTransaction()
      this.afterCommitCallbacks = []
      throw error
    }
  }

  async beginTransaction(): Promise<Knex.Transaction> {
    const { Event } = await import('@lib/events/Event.js')
    Event.beginTransaction()
    return this.connection().transaction()
  }

  async commit(trx: Knex.Transaction): Promise<void> {
    await trx.commit()
    await this.runAfterCommitCallbacks()
    const { Event } = await import('@lib/events/Event.js')
    await Event.commitTransaction()
  }

  async rollBack(trx: Knex.Transaction): Promise<void> {
    await trx.rollback()
    this.afterCommitCallbacks = []
    const { Event } = await import('@lib/events/Event.js')
    Event.rollBackTransaction()
  }

  async close() {
    await Promise.all([...this.connections.values()].map(connection => connection.destroy()))
    this.connections.clear()
  }

  private recordQuery(connection: string, query: any) {
    const entry = { sql: query.sql, bindings: query.bindings, connection }
    if (this.loggingQueries) this.queryLog.push(entry)
    for (const listener of this.listeners) listener(entry)
  }

  private async runAfterCommitCallbacks() {
    const callbacks = this.afterCommitCallbacks.splice(0)
    for (const callback of callbacks) await callback()
  }
}

export const DB = new DatabaseManager()

function enhanceQueryBuilder(builder: any): any {
  return new Proxy(builder, {
    get(target, property, receiver) {
      if (property === 'when') {
        return (condition: unknown, truthy: Function, falsy?: Function) => {
          if (condition) truthy(receiver, condition)
          else falsy?.(receiver, condition)
          return receiver
        }
      }
      if (property === 'unless') {
        return (condition: unknown, truthy: Function, falsy?: Function) => {
          if (!condition) truthy(receiver, condition)
          else falsy?.(receiver, condition)
          return receiver
        }
      }
      if (property === 'tap') {
        return (callback: Function) => {
          callback(receiver)
          return receiver
        }
      }
      if (property === 'value') {
        return async (column: string) => {
          const row = await target.clone().select(column).first()
          return row?.[column]
        }
      }
      if (property === 'pluck') {
        return async (column: string, key?: string) => {
          const rows = await target.clone().select(...(key ? [key, column] : [column]))
          return key ? Object.fromEntries(rows.map((row: any) => [row[key], row[column]])) : rows.map((row: any) => row[column])
        }
      }
      if (property === 'chunk') {
        return async (size: number, callback: Function) => {
          let page = 0
          while (true) {
            const rows = await target.clone().limit(size).offset(page * size)
            if (!rows.length) break
            const result = await callback(rows, page + 1)
            if (result === false) break
            page++
          }
        }
      }
      if (property === 'chunkById') {
        return async (size: number, callback: Function, column = 'id') => {
          let lastId: unknown = undefined
          while (true) {
            const query = target.clone().orderBy(column).limit(size)
            if (lastId !== undefined) query.where(column, '>', lastId)
            const rows = await query
            if (!rows.length) break
            const result = await callback(rows)
            if (result === false) break
            lastId = rows[rows.length - 1][column]
          }
        }
      }
      if (property === 'lazy' || property === 'cursor') {
        return async function * () {
          const rows = await target.clone()
          for (const row of rows) yield row
        }
      }
      if (property === 'upsert') {
        return (values: any | any[], conflictColumns: string | string[], mergeColumns?: string[]) => {
          const query = target.clone().insert(values).onConflict(conflictColumns as any)
          return mergeColumns ? query.merge(mergeColumns) : query.merge()
        }
      }
      if (property === 'lockForUpdate') return () => enhanceQueryBuilder(target.forUpdate())
      if (property === 'sharedLock') return () => enhanceQueryBuilder(target.forShare())

      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const result = value.apply(target, args)
        return result === target ? receiver : result
      }
    }
  })
}
