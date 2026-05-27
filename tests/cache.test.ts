import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { Schema } from '@lib/database/Schema.js'
import { Event } from '@lib/events/Event.js'
import { Cache, CacheHit, CacheMiss, KeyWritten, KeyForgotten, CacheCleared } from '@lib/cache/Cache.js'
import { RateLimit, RateLimiter } from '@lib/http/RateLimiter.js'
import { ThrottleMiddleware } from '@lib/http/SecurityMiddleware.js'
import type { FastifyReply } from 'fastify'
import type { Request } from '@lib/http/Request.js'
import redis from 'redis'

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'

describe('Cache Core', () => {
  beforeEach(() => {
    const app = new Application(process.cwd())
    setApplication(app)
    app.config.set('cache', {
      default: 'memory',
      stores: {
        memory: { driver: 'memory', prefix: 'maxima_cache' }
      }
    })
    Cache.restore()
  })

  afterEach(() => {
    Cache.restore()
    vi.useRealTimers()
  })

  it('stores values, remembers them, and expires ttl entries', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-23T10:00:00.000Z'))

    await Cache.put('user:1', { name: 'Ava' }, 60)
    expect(await Cache.get('user:1')).toEqual({ name: 'Ava' })

    await Cache.remember('settings', 60, () => ({ theme: 'dark' }))
    expect(await Cache.get('settings')).toEqual({ theme: 'dark' })

    vi.setSystemTime(new Date('2026-05-23T10:02:01.000Z'))
    expect(await Cache.get('user:1')).toBeUndefined()
  })

  it('supports tags and invalidation hooks', async () => {
    const invalidated: string[] = []
    const unsubscribe = Cache.onInvalidated(({ key, reason }) => {
      invalidated.push(`${reason}:${key}`)
    })

    const tagged = Cache.tags('posts', 'featured')
    await tagged.put('latest', 'hello')

    expect(await tagged.get('latest')).toBe('hello')
    tagged.flush()
    expect(await tagged.get('latest')).toBeUndefined()
    expect(invalidated.some(entry => entry.startsWith('flushed:'))).toBe(true)

    unsubscribe()
  })

  it('provides locks and assertions', async () => {
    const lock = Cache.lock('reports')
    expect(await lock.get()).toBe(true)
    expect(await Cache.lock('reports').get()).toBe(false)
    expect(await lock.release()).toBe(true)
    expect(await Cache.lock('reports').get()).toBe(true)

    await Cache.put('alpha', 1)
    expect(() => Cache.assertHas('alpha', 1)).not.toThrow()
    expect(() => Cache.assertMissing('alpha')).toThrow()
  })
})

describe('Cache Upgrades (Extras)', () => {
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
    ;(Event as any).listeners.clear()
  })

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
      return
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

describe('Cache Parity', () => {
  beforeEach(() => {
    const app = new Application(process.cwd())
    setApplication(app)
    app.config.set('cache', {
      default: 'memory',
      stores: {
        memory: { driver: 'memory', prefix: 'parity_cache' },
        null: { driver: 'null' },
        memo: { driver: 'memo', prefix: 'memo_cache' },
        memcached: { driver: 'memcached', prefix: 'memcached_cache' },
        dynamodb: { driver: 'dynamodb', prefix: 'dynamodb_cache' }
      }
    })
    Cache.restore()
  })

  afterEach(() => {
    Cache.restore()
  })

  it('supports Laravel-style cache retrieval, write, null, and restored lock APIs', async () => {
    expect(await Cache.add('once', 'first')).toBe(true)
    expect(await Cache.add('once', 'second')).toBe(false)
    expect(await Cache.get('once')).toBe('first')
    expect(await Cache.missing('missing')).toBe(true)

    await Cache.setMultiple(new Map([['a', 1], ['b', 2]]), 60)
    expect(await Cache.getMultiple(['a', 'b', 'c'])).toEqual({ a: 1, b: 2, c: undefined })
    expect(await Cache.pull('a')).toBe(1)
    expect(await Cache.has('a')).toBe(false)
    expect(await Cache.sear('forever-key', () => 'computed')).toBe('computed')
    expect(await Cache.flexible('flexible-key', [10, 60], () => 'fresh')).toBe('fresh')

    const nullStore = Cache.store('null')
    await nullStore.put('discarded', 'value')
    expect(await nullStore.get('discarded', 'fallback')).toBe('fallback')

    const lock = Cache.lock('owned-lock', 30)
    expect(await lock.get()).toBe(true)
    expect(await Cache.restoreLock('owned-lock', lock.ownerToken()).release()).toBe(true)
  })

  it('keeps database-style tag APIs available on tagged stores', async () => {
    const store = Cache.store('memcached')
    expect(store.supportsTags()).toBe(true)
    await store.tags('users').put('active', [1, 2, 3])
    expect(await store.tags('users').get('active')).toEqual([1, 2, 3])
    await store.tags('users').flush()
    expect(await store.tags('users').get('active')).toBeUndefined()
  })
})

describe('Rate Limiting & Throttling Parity', () => {
  beforeEach(() => {
    const app = new Application(process.cwd())
    setApplication(app)
    app.config.set('cache', {
      default: 'memory',
      stores: {
        memory: { driver: 'memory', prefix: 'parity_cache' }
      }
    })
    Cache.restore()
    RateLimiter.clear()
  })

  afterEach(() => {
    Cache.restore()
    RateLimiter.clear()
  })

  it('exposes public rate limiter APIs and custom throttle responses', async () => {
    await RateLimiter.hit('login:ada', 60)
    await RateLimiter.hit('login:ada', 60)
    expect(await RateLimiter.attempts('login:ada')).toBe(2)
    expect(await RateLimiter.tooManyAttempts('login:ada', 2)).toBe(true)
    expect(await RateLimiter.remaining('login:ada', 5)).toBe(3)
    expect(await RateLimiter.availableIn('login:ada')).toBeGreaterThan(0)
    await RateLimiter.clearAttempts('login:ada')
    expect(await RateLimiter.attempts('login:ada')).toBe(0)

    RateLimiter.for('uploads', () => [
      RateLimit.none(),
      RateLimit.perDay(1).by('uploads:key').response((_request, headers) => ({ limited: true, retryAfter: headers['Retry-After'] }))
    ])

    const middleware = new ThrottleMiddleware()
    const request = {
      ip: '127.0.0.1',
      raw: { url: '/upload', routeOptions: { url: '/upload' } },
      user: () => null
    } as unknown as Request
    const reply = {
      statusCode: 200,
      body: undefined as any,
      headers: {} as Record<string, string | number>,
      header(name: string, value: string | number) {
        this.headers[name] = value
        return this
      },
      code(statusCode: number) {
        this.statusCode = statusCode
        return this
      },
      send(body: any) {
        this.body = body
        return this
      }
    }
    const next = async () => {}

    await middleware.handle(request, reply as unknown as FastifyReply, next, 'uploads')
    await middleware.handle(request, reply as unknown as FastifyReply, next, 'uploads')
    expect(reply.statusCode).toBe(429)
    expect(reply.body).toEqual({ limited: true, retryAfter: expect.any(Number) })
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
