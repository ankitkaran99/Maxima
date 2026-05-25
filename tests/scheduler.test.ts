import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { Schedule } from '@lib/scheduler/Schedule.js'
import { schedule as registerAppSchedule } from '@app/Console/Kernel.js'

class CleanupJob {
  constructor(private called: { count: number }) {}
  async handle() {
    this.called.count += 1
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: any) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  const app = new Application(process.cwd())
  setApplication(app)
  app.config.set('logging', {
    default: 'console',
    channels: { console: { driver: 'null' } }
  })
  Schedule.clear()
})

afterEach(() => {
  Schedule.clear()
})

describe('Scheduler', () => {
  it('registers the app console schedule definitions', () => {
    registerAppSchedule()

    expect(Schedule.all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'reports:send', expression: '0 * * * *' }),
      expect.objectContaining({ name: 'cleanup logs', expression: '0 2 * * *', withoutOverlapping: true })
    ]))
  })

  it('supports job, call, command, timezone, and overlap metadata', () => {
    const called = { count: 0 }

    Schedule.job(new CleanupJob(called)).daily().timezone('UTC')
    Schedule.call('cleanup cache', async () => { called.count += 1 }).dailyAt('01:30').withoutOverlapping()
    Schedule.command('reports:send').hourly()

    expect(Schedule.all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'CleanupJob', expression: '0 0 * * *', timezone: 'UTC' }),
      expect.objectContaining({ name: 'cleanup cache', expression: '30 1 * * *', withoutOverlapping: true }),
      expect.objectContaining({ name: 'reports:send', expression: '0 * * * *' })
    ]))
  })

  it('runs due tasks', async () => {
    const called = { count: 0 }
    Schedule.job(new CleanupJob(called))

    await Schedule.runDue()

    expect(called.count).toBe(1)
  })

  it('skips overlapping tasks while one is already running', async () => {
    const gate = deferred<void>()
    const called: string[] = []
    Schedule.call('slow job', async () => {
      called.push('start')
      await gate.promise
      called.push('finish')
    }).withoutOverlapping()

    const first = Schedule.runDue()
    await vi.waitFor(() => expect(called).toContain('start'))
    const second = Schedule.runDue()

    await expect(second).resolves.toBeUndefined()
    gate.resolve()
    await first

    expect(called).toEqual(['start', 'finish'])
  })
})
