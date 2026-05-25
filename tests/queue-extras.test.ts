import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { Schema } from '@lib/database/Schema.js'
import { Queue, type Job, SerializableRegistry, Batch } from '@lib/queue/Queue.js'

let jobRan = false
let jobValue = ''
let sequence: string[] = []

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


SerializableRegistry.register(TestDbJob)
SerializableRegistry.register(TestFailingJob)
SerializableRegistry.register(ChainJobA)
SerializableRegistry.register(ChainJobB)
SerializableRegistry.register(ChainJobC)
SerializableRegistry.register(ChainJobFailing)
SerializableRegistry.register(MiddlewareJob)
SerializableRegistry.register(MiddlewareAbortingJob)
SerializableRegistry.register(TimeoutJob)

beforeEach(async () => {
  Queue.restore()
  vi.useRealTimers()
  jobRan = false
  jobValue = ''


  sequence = []
  MiddlewareJob.middlewareRan = false
  MiddlewareAbortingJob.middlewareRan = false

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

  app.config.set('queue', {
    default: 'database',
    connections: {
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
  await DB.close()
  Queue.restore()
})

describe('Queue Upgrades (Extras)', () => {
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
})
