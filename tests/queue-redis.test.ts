import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'

const { bullQueueInstances, bullWorkerInstances, MockBullQueue, MockBullWorker } = vi.hoisted(() => {
  const bullQueueInstances: MockBullQueue[] = []
  const bullWorkerInstances: MockBullWorker[] = []

  class MockBullQueue {
    close = vi.fn().mockResolvedValue(undefined)
    constructor(public name: string, public options: any) {
      bullQueueInstances.push(this)
    }
    async add(jobName: string, payload: any, opts: any) {
      return { name: jobName, data: payload, opts }
    }
  }

  class MockBullWorker {
    close = vi.fn().mockResolvedValue(undefined)
    constructor(public name: string, public handler: any, public options: any) {
      bullWorkerInstances.push(this)
    }
  }

  return { bullQueueInstances, bullWorkerInstances, MockBullQueue, MockBullWorker }
})

vi.mock('bullmq', () => ({
  Queue: MockBullQueue,
  Worker: MockBullWorker
}))

import { Queue, type Job } from '@lib/queue/Queue.js'

class RedisNamedJob implements Job {
  constructor(public label: string) {}
  async handle() {}
}

describe('Queue Redis Cache', () => {
  beforeEach(() => {
    bullQueueInstances.length = 0
    bullWorkerInstances.length = 0
    Queue.restore()
    ;(Queue as any).queues?.clear()

    const application = new Application(process.cwd())
    setApplication(application)
    application.config.set('logging', {
      default: 'console',
      channels: {
        console: { driver: 'null' }
      }
    })
    application.config.set('queue', {
      default: 'redis-a',
      connections: {
        'redis-a': { driver: 'redis', redis: { url: 'redis://127.0.0.1:6379/0' } },
        'redis-b': { driver: 'redis', redis: { url: 'redis://127.0.0.1:6379/1' } }
      },
      failed: { table: 'failed_jobs' }
    })
  })

  afterEach(() => {
    Queue.restore()
    ;(Queue as any).queues?.clear()
    bullQueueInstances.length = 0
    bullWorkerInstances.length = 0
  })

  it('keeps separate redis queue instances per connection', async () => {
    await Queue.push(new RedisNamedJob('first'), {}, 'shared', 'redis-a')
    await Queue.push(new RedisNamedJob('second'), {}, 'shared', 'redis-b')

    expect(bullQueueInstances).toHaveLength(2)
    expect(bullQueueInstances[0]).toMatchObject({ name: 'shared', options: { connection: 'redis://127.0.0.1:6379/0' } })
    expect(bullQueueInstances[1]).toMatchObject({ name: 'shared', options: { connection: 'redis://127.0.0.1:6379/1' } })
  })

  it('keeps redis workers registered after run so shutdown handlers can see them', async () => {
    const { QueueWorker } = await import('@lib/queue/QueueWorker.js')
    const instances = (QueueWorker as any).instances as Set<any>
    const before = instances.size
    const worker = new QueueWorker('redis-a')

    expect(instances.size).toBe(before + 1)

    await worker.run()

    expect(instances.size).toBe(before + 1)
  })

  it('closes redis once workers without exiting the process', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const { QueueWorker } = await import('@lib/queue/QueueWorker.js')
    const worker = new QueueWorker('redis-a', { once: true })

    await worker.run()
    await bullWorkerInstances[0].handler({ id: 1, data: { payload: new RedisNamedJob('once') } })

    expect(bullWorkerInstances[0].close).toHaveBeenCalled()
    expect((QueueWorker as any).instances.has(worker)).toBe(false)
    expect(exitSpy).not.toHaveBeenCalled()
    exitSpy.mockRestore()
  })

  it('closes redis workers when maxJobs is reached', async () => {
    const { QueueWorker } = await import('@lib/queue/QueueWorker.js')
    const worker = new QueueWorker('redis-a', { maxJobs: 2 })

    await worker.run()
    await bullWorkerInstances[0].handler({ id: 1, data: { payload: new RedisNamedJob('first') } })
    expect(bullWorkerInstances[0].close).not.toHaveBeenCalled()

    await bullWorkerInstances[0].handler({ id: 2, data: { payload: new RedisNamedJob('second') } })

    expect(bullWorkerInstances[0].close).toHaveBeenCalled()
    expect((QueueWorker as any).instances.has(worker)).toBe(false)
  })
})
