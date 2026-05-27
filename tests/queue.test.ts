import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { Mail, Mailable } from '@lib/mail/Mail.js'
import { Notifications, Notification } from '@lib/notifications/Notification.js'
import { Queue, type Job, SerializableRegistry, Batch, ShouldBeUnique, ShouldBeUniqueUntilProcessing } from '@lib/queue/Queue.js'
import { ViewFactory } from '@lib/view/ViewFactory.js'
import { Schema } from '@lib/database/Schema.js'
import { Bus } from '@lib/queue/Bus.js'
import { Cache } from '@lib/cache/Cache.js'
import { WithoutOverlapping, ThrottlesExceptions } from '@lib/queue/Middleware.js'

// --- Globals ---
let originalFetch: typeof fetch | undefined
let jobRan = false
let jobValue = ''
let sequence: string[] = []
let handled: string[] = []
let failedCalled = false

// --- Classes for Fake Subsystem ---
class ExampleJob implements Job {
  constructor(public label: string) {}
  async handle() {}
}

class FailingJob implements Job {
  async handle() { throw new Error('boom') }
}

class QueueMail extends Mailable {
  subject() { return 'Queued mail' }
  text() { return 'Queued mail' }
}

class QueueNotification extends Notification {
  via() { return ['mail'] }
  toMail() { return new QueueMail() }
}

// --- Classes for Real Drivers Subsystem ---
class TestDbJob implements Job {
  constructor(public val: string) {}
  async handle() {
    jobRan = true
    jobValue = this.val
    sequence.push(this.val)
  }
}

class TestFailingJob implements Job {
  async handle() {
    throw new Error('boom')
  }
}

class ChainJobA implements Job {
  async handle() {
    sequence.push('A')
  }
}

class ChainJobB implements Job {
  async handle() {
    sequence.push('B')
  }
}

class ChainJobC implements Job {
  async handle() {
    sequence.push('C')
  }
}

class ChainJobFailing implements Job {
  async handle() {
    sequence.push('FAIL')
    throw new Error('chain_failing_error')
  }
}

class MiddlewareJob implements Job {
  static middlewareRan = false
  async handle() {
    jobRan = true
  }
  middleware() {
    return [
      async (job: any, next: () => Promise<void>) => {
        MiddlewareJob.middlewareRan = true
        await next()
      }
    ]
  }
}

class MiddlewareAbortingJob implements Job {
  static middlewareRan = false
  async handle() {
    jobRan = true
  }
  middleware() {
    return [
      async (job: any, next: () => Promise<void>) => {
        MiddlewareAbortingJob.middlewareRan = true
        // Do not call next()
      }
    ]
  }
}

class TimeoutJob implements Job {
  async handle() {
    await new Promise(resolve => setTimeout(resolve, 5000))
    jobRan = true
  }
}

class BusJob implements Job {
  constructor(public label = 'bus') {}
  async handle() { handled.push(this.label) }
}

class UniqueJob extends ShouldBeUnique implements Job {
  async handle() { handled.push('unique') }
  uniqueId() { return 'same' }
}

class UntilProcessingJob extends ShouldBeUniqueUntilProcessing implements Job {
  async handle() { handled.push('processing') }
  uniqueId() { return 'same' }
}

class TaggedEncryptedJob implements Job {
  encrypted = true
  maxExceptions = 1
  backoff() { return [2, 4] }
  tags() { return ['account:1'] }
  async handle() { handled.push('encrypted') }
}

class FailingWithHookJob implements Job {
  async handle() { throw new Error('failed-hook') }
  async failed() { failedCalled = true }
}

class MiddlewareParityJob implements Job {
  attempts = 0
  released = 0
  middleware() {
    return [
      new WithoutOverlapping('middleware-parity').expireAfter(1),
      new ThrottlesExceptions(1, 60).backoff(5)
    ]
  }
  async release(seconds: number) { this.released = seconds }
  async handle() {
    this.attempts++
    if (this.attempts === 1) throw new Error('throttle-me')
    handled.push('middleware')
  }
}

class CacheExtrasSyncJob implements Job {
  constructor(public val: string) {}
  async handle() {
    jobRan = true
    jobValue = this.val
  }
}

class CacheExtrasDbJob implements Job {
  constructor(public val: string) {}
  async handle() {
    jobRan = true
    jobValue = this.val
  }
}

class CacheExtrasFailingJob implements Job {
  async handle() {
    throw new Error('db_failing_job_error')
  }
}

// --- Registration ---
SerializableRegistry.register(TestDbJob)
SerializableRegistry.register(TestFailingJob)
SerializableRegistry.register(ChainJobA)
SerializableRegistry.register(ChainJobB)
SerializableRegistry.register(ChainJobC)
SerializableRegistry.register(ChainJobFailing)
SerializableRegistry.register(MiddlewareJob)
SerializableRegistry.register(MiddlewareAbortingJob)
SerializableRegistry.register(TimeoutJob)

SerializableRegistry.register(BusJob)
SerializableRegistry.register(UniqueJob)
SerializableRegistry.register(UntilProcessingJob)
SerializableRegistry.register(TaggedEncryptedJob)
SerializableRegistry.register(FailingWithHookJob)
SerializableRegistry.register(MiddlewareParityJob)

SerializableRegistry.register(CacheExtrasSyncJob)
SerializableRegistry.register(CacheExtrasDbJob)
SerializableRegistry.register(CacheExtrasFailingJob)

describe('Queue System (Fake)', () => {
  beforeEach(async () => {
    const app = new Application(process.cwd())
    setApplication(app)
    app.config.set('queue', {
      default: 'default',
      connections: {
        redis: { redis: { url: 'redis://127.0.0.1:6379' } }
      },
      failed: { table: 'failed_jobs' }
    })
    app.config.set('database', {
      default: 'sqlite',
      connections: {
        sqlite: {
          client: 'sqlite3',
          connection: { filename: ':memory:' },
          useNullAsDefault: true
        }
      }
    })
    app.config.set('logging', {
      default: 'console',
      channels: {
        console: { driver: 'null' }
      }
    })
    app.config.set('mail', {
      default: 'array',
      mailers: { array: { transport: 'array' } },
      from: { address: 'hello@example.com', name: 'Maxima' }
    })
    app.instance(ViewFactory, new ViewFactory())

    Queue.restore()
    Queue.fake()
    Mail.restore()
    Notifications.restore()

    await DB.close()
    await DB.connection().schema.createTable('failed_jobs', table => {
      table.increments('id')
      table.string('queue')
      table.string('job')
      table.text('payload')
      table.text('error')
      table.timestamp('failed_at')
    })

    originalFetch = global.fetch
    global.fetch = (async () => ({ ok: true })) as unknown as typeof fetch
  })

  afterEach(async () => {
    Queue.restore()
    Mail.restore()
    Notifications.restore()
    if (originalFetch) global.fetch = originalFetch
    await DB.close()
  })

  it('tracks pushed jobs and supports delay/retry metadata', async () => {
    await Queue.dispatch(new ExampleJob('alpha'))
    await Queue.dispatch(new ExampleJob('beta')).delay(5000)
    await Queue.dispatch(new ExampleJob('gamma')).retries(5)

    expect(() => Queue.assertPushed('ExampleJob')).not.toThrow()
  })

  it('records failed jobs when a worker handler throws', async () => {
    await expect(Queue.handle({ id: 1, data: { class: 'FailingJob', payload: new FailingJob() } })).rejects.toThrow('boom')

    expect(() => Queue.assertFailed('FailingJob')).not.toThrow()
    await expect(DB.table('failed_jobs').first()).resolves.toMatchObject({
      queue: 'default',
      job: 'FailingJob'
    })
  })

  it('queues mailables through the queue subsystem', async () => {
    await Mail.to('ada@example.com').queue(new QueueMail())

    expect(() => Queue.assertPushed('Object')).not.toThrow()
  })

  it('queues notifications through the queue subsystem', async () => {
    await Notifications.queue({ id: 1, email: 'ada@example.com' }, new QueueNotification())

    expect(() => Queue.assertPushed('Object')).not.toThrow()
  })

  it('supports delayed notification dispatch', async () => {
    await Notifications.later(250, { id: 1, email: 'ada@example.com' }, new QueueNotification())

    expect(() => Queue.assertPushed('Object')).not.toThrow()
  })
})

describe('Queue System (Real Drivers - DB & Sync)', () => {
  beforeEach(async () => {
    jobRan = false
    jobValue = ''
    sequence = []
    handled = []
    failedCalled = false
    MiddlewareJob.middlewareRan = false
    MiddlewareAbortingJob.middlewareRan = false

    Queue.restore()
    vi.useRealTimers()

    await DB.close()
    const app = new Application(process.cwd())
    setApplication(app)
    app.config.set('app.key', 'queue-bus-scheduler-test-key')
    app.config.set('cache.default', 'file')
    app.config.set('cache.stores.file', { driver: 'memory', prefix: 'test' })
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

    app.config.set('queue', {
      default: 'database',
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

    Cache.fake('file')

    await Schema.dropIfExists('failed_jobs')
    await Schema.dropIfExists('jobs')
    await Schema.dropIfExists('job_batches')

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

    await Schema.create('job_batches', table => {
      table.string('id').primary()
      table.string('name')
      table.integer('total_jobs')
      table.integer('pending_jobs')
      table.integer('failed_jobs')
      table.text('failed_job_ids')
      table.text('options').nullable()
      table.integer('cancelled_at').nullable()
      table.integer('created_at')
      table.integer('finished_at').nullable()
    })
  })

  afterEach(async () => {
    Queue.restore()
    Cache.restore()
    await DB.close()
  })

  // --- Chaining & Batching (from queue-extras.test.ts) ---
  it('supports job chaining', async () => {
    await Queue.chain([
      new ChainJobA(),
      new ChainJobB(),
      new ChainJobC()
    ], 'database')

    await (Queue as any).processNextDatabaseJob('database')
    await (Queue as any).processNextDatabaseJob('database')
    await (Queue as any).processNextDatabaseJob('database')

    expect(sequence).toEqual(['A', 'B', 'C'])
  })

  it('aborts chained execution when a job in the chain fails', async () => {
    await Queue.chain([
      new ChainJobA(),
      new ChainJobFailing(),
      new ChainJobC()
    ], 'database')

    await (Queue as any).processNextDatabaseJob('database')
    await (Queue as any).processNextDatabaseJob('database')

    expect(sequence).toEqual(['A', 'FAIL'])
    expect(sequence).not.toContain('C')
  })

  it('supports job batching with callbacks', async () => {
    let thenRan = false
    let finallyRan = false
    let batchInstance: Batch | undefined

    const batch = await Queue.batch([
      new TestDbJob('batch-1'),
      new TestDbJob('batch-2')
    ], 'database')
    .name('Test Batch')
    .then((b) => {
      thenRan = true
      batchInstance = b
    })
    .finally(() => {
      finallyRan = true
    })
    .dispatch()

    expect(batch.totalJobs).toBe(2)
    expect(batch.name).toBe('Test Batch')

    await (Queue as any).processNextDatabaseJob('database')
    await (Queue as any).processNextDatabaseJob('database')

    expect(thenRan).toBe(true)
    expect(finallyRan).toBe(true)
    expect(batchInstance).toBeDefined()
    expect(batchInstance?.finished()).toBe(true)
    expect(batchInstance?.hasFailures()).toBe(false)

    const stored = await DB.table('job_batches').where('id', batch.id).first()
    expect(stored.pending_jobs).toBe(0)
    expect(stored.finished_at).not.toBeNull()
  })

  it('supports batch failures and catch callbacks', async () => {
    let catchRan = false
    let finallyRan = false
    let batchInstance: Batch | undefined

    const batch = await Queue.batch([
      new TestDbJob('batch-1'),
      new TestFailingJob()
    ], 'database')
    .catch((b) => {
      catchRan = true
      batchInstance = b
    })
    .finally(() => {
      finallyRan = true
    })
    .dispatch()

    await (Queue as any).processNextDatabaseJob('database')
    await (Queue as any).processNextDatabaseJob('database')

    expect(catchRan).toBe(true)
    expect(finallyRan).toBe(true)
    expect(batchInstance?.hasFailures()).toBe(true)
    expect(batchInstance?.cancelled()).toBe(true)
  })

  it('runs job middleware successfully', async () => {
    await Queue.push(new MiddlewareJob(), {}, 'database')

    await (Queue as any).processNextDatabaseJob('database')

    expect(MiddlewareJob.middlewareRan).toBe(true)
    expect(jobRan).toBe(true)
  })

  it('aborts job execution when middleware does not call next()', async () => {
    await Queue.push(new MiddlewareAbortingJob(), {}, 'database')

    await (Queue as any).processNextDatabaseJob('database')

    expect(MiddlewareAbortingJob.middlewareRan).toBe(true)
    expect(jobRan).toBe(false)
  })

  it('triggers before, after, and failing lifecycle events', async () => {
    const events: string[] = []

    Queue.before((event) => {
      events.push(`before:${event.job.constructor.name}`)
    })

    Queue.after((event) => {
      events.push(`after:${event.job.constructor.name}`)
    })

    Queue.failing((event) => {
      events.push(`failing:${event.job.constructor.name}`)
    })

    await Queue.push(new TestDbJob('event-test'), {}, 'database')
    await Queue.push(new TestFailingJob(), {}, 'database')

    await (Queue as any).processNextDatabaseJob('database')
    await (Queue as any).processNextDatabaseJob('database')

    expect(events).toContain('before:TestDbJob')
    expect(events).toContain('after:TestDbJob')
    expect(events).toContain('before:TestFailingJob')
    expect(events).toContain('failing:TestFailingJob')
  })

  it('enforces execution timeouts', async () => {
    await Queue.push(new TimeoutJob(), {}, 'database')

    // First attempt: times out after 100ms, released back to queue
    const p1 = (Queue as any).processNextDatabaseJob('database', { timeout: 0.1, delay: 0 })
    await new Promise(resolve => setTimeout(resolve, 150))
    await p1

    // Second attempt: times out after 100ms, moved to failed_jobs
    const p2 = (Queue as any).processNextDatabaseJob('database', { timeout: 0.1, delay: 0 })
    await new Promise(resolve => setTimeout(resolve, 150))
    await p2

    // Job should NOT have completed successfully (jobRan remains false)
    expect(jobRan).toBe(false)

    // Job should have been moved to failed_jobs (after exceeding tries limit = 2)
    const failed = await DB.table('failed_jobs').first()
    expect(failed).not.toBeNull()
    expect(failed.error).toContain('timed out')
  })

  // --- Sync Driver (from queue-cache-extras.test.ts) ---
  it('runs sync queue driver immediately', async () => {
    await Queue.dispatch(new CacheExtrasSyncJob('hello-sync'), 'sync')
    
    // Give event loop a turn to run setImmediate
    await new Promise(resolve => setImmediate(resolve))

    expect(jobRan).toBe(true)
    expect(jobValue).toBe('hello-sync')
  })

  // --- Database Driver with Worker (from queue-cache-extras.test.ts) ---
  it('runs database queue driver with polling worker', async () => {
    // Dispatch to database queue
    await Queue.push(new CacheExtrasDbJob('hello-db'), {}, 'database')

    // Verify it is stored in database and not executed yet
    expect(jobRan).toBe(false)
    const storedJob = await DB.table('jobs').first()
    expect(storedJob).not.toBeNull()
    expect(storedJob.queue).toBe('database')
    
    const payload = JSON.parse(storedJob.payload)
    expect(payload.class).toBe('CacheExtrasDbJob')
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
    await Queue.push(new CacheExtrasFailingJob(), {}, 'database')

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
    expect(failedJob.job).toBe('CacheExtrasFailingJob')
    expect(failedJob.error).toBe('db_failing_job_error')
  })

  // --- Bus sync and after response helpers (from queue-bus-scheduler-parity.test.ts) ---
  it('dispatches through Bus sync and after-response helpers', async () => {
    await Bus.dispatchSync(new BusJob('sync'))
    Bus.dispatchAfterResponse(() => { handled.push('after-response') })
    await new Promise(resolve => setImmediate(resolve))

    expect(handled).toEqual(['sync', 'after-response'])
  })

  // --- Unique/Encrypted jobs (from queue-bus-scheduler-parity.test.ts) ---
  it('supports unique jobs, payload hooks, encrypted payloads, and database worker limits', async () => {
    const releaseHook = Queue.createPayloadUsing(() => ({ hook: 'applied' }))

    await Queue.push(new UniqueJob())
    await Queue.push(new UniqueJob())
    await Queue.push(new UntilProcessingJob())
    await Queue.push(new TaggedEncryptedJob())

    const rows = await DB.table('jobs').orderBy('id')
    expect(rows).toHaveLength(3)
    expect(JSON.parse(rows[0].payload).hook).toBe('applied')
    expect(JSON.parse(rows[2].payload)).toMatchObject({ encrypted: true, tags: ['account:1'] })

    await Queue.work('database', { maxJobs: 3, stopWhenEmpty: true, sleep: 0, timeout: 2 })
    expect(handled).toEqual(['unique', 'processing', 'encrypted'])

    releaseHook()
  })

  // --- Failed hooks and queue middleware classes (from queue-bus-scheduler-parity.test.ts) ---
  it('calls failed hooks and exposes queue middleware classes', async () => {
    await Queue.push(new FailingWithHookJob())
    await Queue.work('database', { tries: 1, stopWhenEmpty: true, sleep: 0, timeout: 2 })

    expect(failedCalled).toBe(true)
    const failed = await DB.table('failed_jobs').first()
    expect(failed.job).toBe('FailingWithHookJob')

    const job = new MiddlewareParityJob()
    await expect(Queue.dispatchSync(job)).rejects.toThrow('throttle-me')
    await Queue.dispatchSync(job)
    expect(job.released).toBe(60)
  })
})
