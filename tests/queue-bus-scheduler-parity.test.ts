import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { Schema } from '@lib/database/Schema.js'
import {
  Bus,
  Cache,
  Queue,
  Schedule,
  SerializableRegistry,
  ShouldBeUnique,
  ShouldBeUniqueUntilProcessing,
  ThrottlesExceptions,
  WithoutOverlapping,
  type Job
} from '@lib/index.js'

let handled: string[] = []
let failedCalled = false

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

SerializableRegistry.register(BusJob)
SerializableRegistry.register(UniqueJob)
SerializableRegistry.register(UntilProcessingJob)
SerializableRegistry.register(TaggedEncryptedJob)
SerializableRegistry.register(FailingWithHookJob)
SerializableRegistry.register(MiddlewareParityJob)

beforeEach(async () => {
  handled = []
  failedCalled = false
  Queue.restore()
  Schedule.clear()
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
  app.config.set('logging.default', 'console')
  app.config.set('logging.channels.console', { driver: 'null' })
  app.config.set('queue', {
    default: 'database',
    connections: {
      database: { driver: 'database', table: 'jobs', tries: 2, retry_after: 1, poll_interval: 1 }
    },
    failed: { table: 'failed_jobs' }
  })
  Cache.fake('file')

  await Schema.createQueueTables()
  await Schema.createBatchTable()
})

afterEach(async () => {
  Queue.restore()
  Schedule.clear()
  Cache.restore()
  await DB.close()
})

describe('bus, queue, and scheduler parity', () => {
  it('dispatches through Bus sync and after-response helpers', async () => {
    await Bus.dispatchSync(new BusJob('sync'))
    Bus.dispatchAfterResponse(() => { handled.push('after-response') })
    await new Promise(resolve => setImmediate(resolve))

    expect(handled).toEqual(['sync', 'after-response'])
  })

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

  it('lists and filters scheduled tasks with cache-backed mutexes', async () => {
    Schedule.call('nightly', () => { handled.push('nightly') })
      .dailyAt('23:30')
      .timezone('UTC')
      .between('00:00', '23:59')
      .when(() => true)
      .skip(() => false)
      .onOneServer()
      .withoutOverlapping()
      .runInBackground()
      .group('maintenance')

    expect(Schedule.all()[0]).toMatchObject({
      name: 'nightly',
      timezone: 'UTC',
      onOneServer: true,
      background: true,
      group: 'maintenance'
    })

    await Schedule.runDue()
    await new Promise(resolve => setImmediate(resolve))
    expect(handled).toContain('nightly')

    await Schedule.clearCache()
  })
})
