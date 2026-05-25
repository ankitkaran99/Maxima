import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { Schema } from '@lib/database/Schema.js'
import { Queue, type Job, SerializableRegistry } from '@lib/queue/Queue.js'
import { Cache } from '@lib/cache/Cache.js'
import redis from 'redis'

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'

let jobRan = false
let jobValue = ''

class TestSyncJob implements Job {
  constructor(public val: string) {}
  async handle() {
    jobRan = true
    jobValue = this.val
  }
}

class TestDbJob implements Job {
  constructor(public val: string) {}
  async handle() {
    jobRan = true
    jobValue = this.val
  }
}

class TestFailingJob implements Job {
  async handle() {
    throw new Error('db_failing_job_error')
  }
}

SerializableRegistry.register(TestSyncJob)
SerializableRegistry.register(TestDbJob)
SerializableRegistry.register(TestFailingJob)

beforeEach(async () => {
  jobRan = false
  jobValue = ''

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

  // Configure queues
  app.config.set('queue', {
    default: 'sync',
    connections: {
      sync: { driver: 'sync' },
      database: {
        driver: 'database',
        table: 'jobs',
        tries: 2,
        retry_after: 90,
        poll_interval: 20
      }
    },
    failed: { table: 'failed_jobs' }
  })

  // Configure caches
  app.config.set('cache', {
    default: 'memory',
    stores: {
      memory: { driver: 'memory', prefix: 'test_mem' },
      redis: { driver: 'redis', url: redisUrl, prefix: 'test_redis' }
    }
  })

  // Create queue tables
  await Schema.dropIfExists('failed_jobs')
  await Schema.dropIfExists('jobs')

  await Schema.create('jobs', table => {
    table.increments('id')
    table.string('queue')
    table.text('payload')
    table.integer('attempts')
    table.integer('reserved_at').nullable()
    table.integer('available_at')
    table.integer('created_at')
  })

  await Schema.create('failed_jobs', table => {
    table.increments('id')
    table.string('queue')
    table.string('job')
    table.text('payload')
    table.text('error')
    table.timestamp('failed_at')
  })
})

afterEach(async () => {
  await DB.close()
  Queue.restore()
})

describe('Queue & Cache Extras', () => {
  it('runs sync queue driver immediately', async () => {
    await Queue.dispatch(new TestSyncJob('hello-sync'))
    
    // Give event loop a turn to run setImmediate
    await new Promise(resolve => setImmediate(resolve))

    expect(jobRan).toBe(true)
    expect(jobValue).toBe('hello-sync')
  })

  it('runs database queue driver with polling worker', async () => {
    // Dispatch to database queue
    await Queue.push(new TestDbJob('hello-db'), {}, 'database')

    // Verify it is stored in database and not executed yet
    expect(jobRan).toBe(false)
    const storedJob = await DB.table('jobs').first()
    expect(storedJob).not.toBeNull()
    expect(storedJob.queue).toBe('database')
    
    const payload = JSON.parse(storedJob.payload)
    expect(payload.class).toBe('TestDbJob')
    expect(payload.properties.properties.val).toBe('hello-db')

    // Process the job directly
    const processed = await (Queue as any).processNextDatabaseJob('database')
    expect(processed).toBe(true)

    expect(jobRan).toBe(true)
    expect(jobValue).toBe('hello-db')

    // Job should be deleted after completion
    const jobAfterCompletion = await DB.table('jobs').first()
    expect(jobAfterCompletion).toBeUndefined()
  })

  it('moves database jobs to failed_jobs after tries are exceeded', async () => {
    await Queue.push(new TestFailingJob(), {}, 'database')

    // Process first time
    const processed1 = await (Queue as any).processNextDatabaseJob('database')
    expect(processed1).toBe(true)

    let storedJob = await DB.table('jobs').first()
    expect(storedJob).not.toBeNull()
    expect(storedJob.attempts).toBe(1)

    // Speed up retry: bypass delay and set available_at to past so it picks it up again immediately:
    await DB.table('jobs').update({ available_at: Math.floor(Date.now() / 1000) - 10, reserved_at: null })

    // Process second time
    const processed2 = await (Queue as any).processNextDatabaseJob('database')
    expect(processed2).toBe(true)

    // After 2 tries, it should be deleted from jobs and written to failed_jobs
    const jobsCount = await DB.table('jobs').count({ count: '*' }).first()
    expect(Number(jobsCount?.count ?? 0)).toBe(0)

    const failedJob = await DB.table('failed_jobs').first()
    expect(failedJob).not.toBeNull()
    expect(failedJob.job).toBe('TestFailingJob')
    expect(failedJob.error).toBe('db_failing_job_error')
  })

  it('verifies Redis cache driver functionality if Redis server is running', async () => {
    const isRedisRunning = await redisIsReady()

    if (!isRedisRunning) {
      console.warn(`Skipping Redis Cache tests because Redis is not ready at ${redisUrl}.`)
      return
    }

    const redisStore = Cache.store('redis')
    await redisStore.flush()

    // Test put & get
    await redisStore.put('key1', { a: 1 })
    expect(await redisStore.get('key1')).toEqual({ a: 1 })

    // Test has & forget
    expect(await redisStore.has('key1')).toBe(true)
    await redisStore.forget('key1')
    expect(await redisStore.has('key1')).toBe(false)
    expect(await redisStore.get('key1')).toBeUndefined()

    // Test increment & decrement
    await redisStore.put('counter', 10)
    expect(await redisStore.increment('counter', 5)).toBe(15)
    expect(await redisStore.decrement('counter', 3)).toBe(12)

    // Test remember
    const rememberVal = await redisStore.remember('remember_key', 60, () => 'remembered_value')
    expect(rememberVal).toBe('remembered_value')
    expect(await redisStore.get('remember_key')).toBe('remembered_value')

    await redisStore.flush()
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
