import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { Event } from '@lib/events/Event.js'
import { Broadcast } from '@lib/broadcast/Broadcast.js'
import { Queue } from '@lib/queue/Queue.js'
import { Model } from '@lib/database/Model.js'
import { DB } from '@lib/database/DB.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

class DomainEvent {
  constructor(public message: string) {}
}

class BroadcastEvent {
  broadcastOn() { return ['public'] }
  broadcastAs() { return 'BroadcastEvent' }
  broadcastWith() { return { message: 'hello' } }
}

class UserObserver {
  created(model: any) {
    model.observed = true
  }
}

class QueuedListener {
  queue: true = true
  handle(event: DomainEvent) {
    return event.message.toUpperCase()
  }
}

class EventModel extends Model {
  static table = 'events'
  static timestamps = false
  declare observed?: boolean
}

beforeEach(async () => {
  const app = new Application(process.cwd())
  setApplication(app)
  app.config.set('database.default', 'sqlite')
  app.config.set('database.connections.sqlite', {
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  })
  Event.restore()
  Event.fake()
  Broadcast.restore()
  Broadcast.fake()
  Queue.restore()
  Queue.fake()
  await DB.close()
  await DB.connection().schema.createTable('events', table => {
    table.increments('id')
    table.string('name')
    table.boolean('observed').defaultTo(false)
  })
})

afterEach(() => {
  Event.restore()
  Broadcast.restore()
  Queue.restore()
})

afterEach(async () => {
  await DB.close()
})

describe('Eventing', () => {
  it('dispatches events to listeners and supports fakes', async () => {
    const seen: string[] = []
    Event.listen('DomainEvent', (event: DomainEvent) => seen.push(event.message))
    Event.listen('DomainEvent', new QueuedListener())

    await Event.dispatchAsync(new DomainEvent('alpha'))

    expect(seen).toEqual(['alpha'])
    expect(() => Event.assertDispatched('DomainEvent')).not.toThrow()
    expect(() => Queue.assertPushed('Object')).not.toThrow()
  })

  it('observes model lifecycle hooks', async () => {
    EventModel.observe(UserObserver)

    const created = await EventModel.create({ name: 'Ada' })

    expect(created.observed).toBe(true)
    expect(await DB.table('events').first()).toMatchObject({
      name: 'Ada',
      observed: 0
    })
  })

  it('broadcasts broadcastable events', async () => {
    await Event.dispatchAsync(new BroadcastEvent())
    expect(() => Broadcast.assertBroadcasted('BroadcastEvent')).not.toThrow()
  })

  it('discovers listener classes and defers after-commit events', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-events-'))
    await fs.mkdir(path.join(root, 'app', 'Listeners'), { recursive: true })
    await fs.writeFile(path.join(root, 'app', 'Listeners', 'DiscoveredEventListener.ts'), `
      export default class DiscoveredEventListener {
        static event = 'DiscoveredEvent'
        handle(event) { event.handled = true }
      }
    `)

    await Event.discover(root)
    const event = { constructor: { name: 'DiscoveredEvent' }, handled: false, afterCommit: true }

    Event.beginTransaction()
    await Event.dispatchAsync(event)
    expect(event.handled).toBe(false)
    await Event.commitTransaction()
    expect(event.handled).toBe(true)

    await fs.rm(root, { recursive: true, force: true })
  })
})
