import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { Schema } from '@lib/database/Schema.js'

beforeEach(async () => {
  await DB.close()
  const app = new Application(process.cwd())
  setApplication(app)
  app.config.set('database.default', 'sqlite')
  app.config.set('database.connections.sqlite', {
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  })
  await DB.connection().schema.createTable('items', table => {
    table.increments('id')
    table.string('name')
  })
})

afterEach(async () => {
  DB.disableQueryLog()
  DB.flushQueryLog()
  await DB.close()
})

describe('Database Layer', () => {
  it('resolves configured connections and table builders', async () => {
    await DB.table('items').insert({ name: 'first' })

    const item = await DB.connection()('items').where('name', 'first').first()

    expect(item).toMatchObject({ id: 1, name: 'first' })
  })

  it('commits successful transactions', async () => {
    await DB.transaction(async trx => {
      await trx('items').insert({ name: 'committed' })
    })

    await expect(DB.table('items').where('name', 'committed').first()).resolves.toMatchObject({
      name: 'committed'
    })
  })

  it('rolls back failed transactions', async () => {
    await expect(DB.transaction(async trx => {
      await trx('items').insert({ name: 'rolled-back' })
      throw new Error('rollback')
    })).rejects.toThrow('rollback')

    await expect(DB.table('items').where('name', 'rolled-back').first()).resolves.toBeUndefined()
  })

  it('throws for missing configured connections', () => {
    expect(() => DB.connection('missing')).toThrow('Database connection [missing] is not configured.')
  })

  it('supports Laravel-style query builder helpers', async () => {
    await DB.table('items').insert([{ name: 'first' }, { name: 'second' }, { name: 'third' }])

    const value = await DB.table('items').where('name', 'first').value('name')
    const plucked = await DB.table('items').orderBy('id').pluck('name')
    const keyed = await DB.table('items').pluck('name', 'id')
    const chunks: string[][] = []
    await DB.table('items').orderBy('id').chunk(2, rows => { chunks.push(rows.map(row => row.name)) })

    const conditional = await DB.table('items')
      .when(true, query => query.where('name', 'second'))
      .first()

    const cursorValues: string[] = []
    for await (const row of DB.table('items').where('id', '<', 3).cursor()) {
      cursorValues.push(row.name)
    }

    expect(value).toBe('first')
    expect(plucked).toEqual(['first', 'second', 'third'])
    expect(keyed[1]).toBe('first')
    expect(chunks).toEqual([['first', 'second'], ['third']])
    expect(conditional.name).toBe('second')
    expect(cursorValues).toEqual(['first', 'second'])
  })

  it('supports query logging, listeners, and afterCommit callbacks', async () => {
    const queries: string[] = []
    const committed: string[] = []
    const unsubscribe = DB.listen(query => queries.push(query.sql))
    DB.enableQueryLog()

    await DB.transaction(async trx => {
      DB.afterCommit(() => { committed.push('committed') })
      await trx('items').insert({ name: 'logged' })
    })

    unsubscribe()
    expect(queries.some(sql => sql.includes('insert'))).toBe(true)
    expect(DB.getQueryLog().some(query => query.sql.includes('insert'))).toBe(true)
    expect(committed).toEqual(['committed'])
  })

  it('supports schema rename/drop helpers and framework table helpers', async () => {
    await Schema.rename('items', 'renamed_items')
    await Schema.renameColumn('renamed_items', 'name', 'title')
    await Schema.dropColumns('renamed_items', 'title')
    await Schema.createCacheTable('cache_entries')
    await Schema.createSessionTable('session_entries')
    await Schema.createQueueTables('queued_jobs', 'failed_queued_jobs')

    expect(await Schema.hasTable('renamed_items')).toBe(true)
    expect(await Schema.hasColumn('renamed_items', 'title')).toBe(false)
    expect(await Schema.hasTable('cache_entries')).toBe(true)
    expect(await Schema.hasTable('session_entries')).toBe(true)
    expect(await Schema.hasTable('queued_jobs')).toBe(true)
    expect(await Schema.hasTable('failed_queued_jobs')).toBe(true)
  })
})
