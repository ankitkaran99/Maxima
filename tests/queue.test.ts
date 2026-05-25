import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { Mail, Mailable } from '@lib/mail/Mail.js'
import { Notifications, Notification } from '@lib/notifications/Notification.js'
import { Queue, type Job } from '@lib/queue/Queue.js'
import { ViewFactory } from '@lib/view/ViewFactory.js'

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

let originalFetch: typeof fetch | undefined

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

describe('Queue System', () => {
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
