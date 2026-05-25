import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { Schema } from '@lib/database/Schema.js'
import { Cache, CacheHit, CacheMiss, KeyWritten, KeyForgotten, CacheCleared } from '@lib/cache/Cache.js'
import { Event } from '@lib/events/Event.js'
import redis from 'redis'

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'

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
  app.config.set('logging', {
    default: 'console',
    channels: {
      console: { driver: 'null' }
    }
  })

  // Configure cache stores
  app.config.set('cache', {
    default: 'database',
    stores: {
      database: { driver: 'database', table: 'cache', locks_table: 'cache_locks', prefix: 'db_cache' },
      file: { driver: 'file', path: './storage/framework/cache', prefix: 'file_cache' },
      redis: { driver: 'redis', url: redisUrl, prefix: 'redis_cache' }
    }
  })

  // Re-create cache tables for testing database driver
  await Schema.dropIfExists('cache')
  await Schema.dropIfExists('cache_locks')

  await Schema.create('cache', table => {
    table.string('key').primary()
    table.text('value')
    table.integer('expiration').nullable()
  })

  await Schema.create('cache_locks', table => {
    table.string('key').primary()
    table.string('owner')
    table.integer('expiration')
  })
})

afterEach(async () => {
  await DB.close()
  Cache.restore()
  // Clear any registered event listeners
  ;(Event as any).listeners.clear()
})

describe('Cache Upgrades (Extras)', () => {
  it('supports the database cache driver and all standard operations', async () => {
    const dbStore = Cache.store('database')

    // Test put & get
    await dbStore.put('key1', { user: 'Taylor' }, 10)
    expect(await dbStore.get('key1')).toEqual({ user: 'Taylor' })

    // Test has & forget
    expect(await dbStore.has('key1')).toBe(true)
    await dbStore.forget('key1')
    expect(await dbStore.has('key1')).toBe(false)
    expect(await dbStore.get('key1')).toBeUndefined()

    // Test forever
    await dbStore.forever('key2', 'eternal')
    expect(await dbStore.get('key2')).toBe('eternal')

    // Test increment & decrement
    await dbStore.put('counter', 10)
    expect(await dbStore.increment('counter', 5)).toBe(15)
    expect(await dbStore.decrement('counter', 3)).toBe(12)

    // Test remember
    const value = await dbStore.remember('remember_key', 60, () => 'computed_value')
    expect(value).toBe('computed_value')
    expect(await dbStore.get('remember_key')).toBe('computed_value')

    // Test flush
    await dbStore.flush()
    expect(await dbStore.get('key2')).toBeUndefined()
    expect(await dbStore.get('counter')).toBeUndefined()
    expect(await dbStore.get('remember_key')).toBeUndefined()
  })

  it('correctly dispatches cache hit, miss, written, forgotten, and cleared events', async () => {
    const events: string[] = []
    const dbStore = Cache.store('database')

    Event.listen(CacheHit, (e: CacheHit) => events.push(`hit:${e.key}`))
    Event.listen(CacheMiss, (e: CacheMiss) => events.push(`miss:${e.key}`))
    Event.listen(KeyWritten, (e: KeyWritten) => events.push(`write:${e.key}`))
    Event.listen(KeyForgotten, (e: KeyForgotten) => events.push(`forget:${e.key}`))
    Event.listen(CacheCleared, () => events.push('clear'))

    // Miss
    await dbStore.get('missing')
    // Write
    await dbStore.put('present', 'hello')
    // Hit
    await dbStore.get('present')
    // Forget
    await dbStore.forget('present')
    // Miss again
    await dbStore.get('present')
    // Clear
    await dbStore.flush()

    expect(events).toEqual([
      'miss:missing',
      'write:present',
      'hit:present',
      'forget:present',
      'miss:present',
      'clear'
    ])
  })

  it('supports database-backed atomic locks', async () => {
    const dbStore = Cache.store('database')
    const lock1 = dbStore.lock('test-lock', 5)
    const lock2 = dbStore.lock('test-lock', 5)

    // Lock 1 should acquire
    expect(await lock1.get()).toBe(true)

    // Lock 2 should NOT acquire (owned by lock 1)
    expect(await lock2.get()).toBe(false)

    // Lock 1 releases
    expect(await lock1.release()).toBe(true)

    // Lock 2 can now acquire
    expect(await lock2.get()).toBe(true)

    // Force release lock 2
    await lock2.forceRelease()
    expect(await lock1.get()).toBe(true)
    await lock1.release()
  })

  it('supports file-backed atomic locks', async () => {
    const fileStore = Cache.store('file')
    await fileStore.flush()

    const lock1 = fileStore.lock('file-lock', 10)
    const lock2 = fileStore.lock('file-lock', 10)

    expect(await lock1.get()).toBe(true)
    expect(await lock2.get()).toBe(false)
    expect(await lock1.release()).toBe(true)
    expect(await lock2.get()).toBe(true)

    await lock2.forceRelease()
  })

  it('supports Redis-backed atomic locks if Redis server is running', async () => {
    const isRedisRunning = await redisIsReady()

    if (!isRedisRunning) {
      console.warn(`Skipping Redis lock tests because Redis is not ready at ${redisUrl}.`)
      return // Skip
    }

    const redisStore = Cache.store('redis')
    const lock1 = redisStore.lock('redis-lock', 5)
    const lock2 = redisStore.lock('redis-lock', 5)

    expect(await lock1.get()).toBe(true)
    expect(await lock2.get()).toBe(false)
    expect(await lock1.release()).toBe(true)
    expect(await lock2.get()).toBe(true)

    await lock2.forceRelease()
  })
})

function redisIsReady(timeoutMs = 3000) {
  return new Promise<boolean>(resolve => {
    let settled = false
    const settle = (ready: boolean, client: any, timer: NodeJS.Timeout) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.removeAllListeners()
      try {
        client.quit()
      } catch {}
      resolve(ready)
    }

    const client = redis.createClient({ url: redisUrl, retry_strategy: () => undefined })
    client.on('error', () => settle(false, client, timer))
    client.on('end', () => settle(false, client, timer))
    client.on('ready', () => settle(true, client, timer))
    const timer = setTimeout(() => settle(false, client, timer), timeoutMs)
  })
}
