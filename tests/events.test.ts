import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { Event, ShouldQueue } from '@lib/events/Event.js'
import { Broadcast } from '@lib/broadcast/Broadcast.js'
import { Queue } from '@lib/queue/Queue.js'
import { Model } from '@lib/database/Model.js'
import { DB } from '@lib/database/DB.js'

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

describe('Eventing', () => {
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

  afterEach(async () => {
    Event.restore()
    Broadcast.restore()
    Queue.restore()
    await DB.close()
  })

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

describe('Event Wildcards and Subscribers', () => {
  afterEach(() => {
    Event.restore()
    ;(Event as any).listeners.clear()
  })

  it('dispatches to wildcard listeners matching patterns', () => {
    const logs: Array<{ name: string, payload: any }> = []

    Event.listen('order.*', (payload, name) => {
      logs.push({ name, payload })
    })

    Event.listen('*', (payload, name) => {
      logs.push({ name: `global:${name}`, payload })
    })

    Event.dispatch('order.created', { id: 1 })
    Event.dispatch('order.fulfilled', { id: 2 })
    Event.dispatch('payment.failed', { amount: 100 })

    expect(logs).toEqual([
      { name: 'order.created', payload: { id: 1 } },
      { name: 'global:order.created', payload: { id: 1 } },
      { name: 'order.fulfilled', payload: { id: 2 } },
      { name: 'global:order.fulfilled', payload: { id: 2 } },
      { name: 'global:payment.failed', payload: { amount: 100 } }
    ])
  })

  it('allows registering event subscribers', () => {
    const logs: string[] = []

    class OrderEventSubscriber {
      subscribe(events: typeof Event) {
        events.listen('OrderCreated', this.onOrderCreated)
        events.listen('OrderCancelled', this.onOrderCancelled)
      }

      onOrderCreated(event: any) {
        logs.push(`created: ${event.id}`)
      }

      onOrderCancelled(event: any) {
        logs.push(`cancelled: ${event.id}`)
      }
    }

    Event.subscribe(OrderEventSubscriber)

    Event.dispatch('OrderCreated', { id: 101 })
    Event.dispatch('OrderCancelled', { id: 102 })

    expect(logs).toEqual([
      'created: 101',
      'cancelled: 102'
    ])
  })
})

describe('Event Providers & Listener Middleware Parity', () => {
  let handled: string[] = []
  let failedCalled = false

  beforeEach(() => {
    handled = []
    failedCalled = false
    Queue.fake()
    Event.fake()
  })

  afterEach(() => {
    Event.restore()
    Queue.restore()
    ;(Event as any).listeners.clear()
  })

  it('supports Laravel-style event providers, scoped fakes, assertions, listener middleware, and queued listener metadata', async () => {
    class OrderPlaced {
      constructor(public id: number) {}
    }

    class AuditOrder {
      middleware = [(event: OrderPlaced, next: Function) => {
        handled.push(`before:${event.id}`)
        return next()
      }]
      handle(event: OrderPlaced) {
        handled.push(`handled:${event.id}`)
      }
    }

    class QueueReceipt extends ShouldQueue {
      queueName = 'listeners'
      tries = 5
      backoff = [1, 5]
      maxExceptions = 2
      retryUntil = () => new Date(Date.now() + 60_000)
      handle(event: OrderPlaced) {
        handled.push(`queued:${event.id}`)
      }
    }

    class EventServiceProvider {
      listen = {
        OrderPlaced: [AuditOrder, QueueReceipt]
      }
    }

    Queue.fake()
    Event.fake(['OrderPlaced'])
    Event.register(EventServiceProvider)
    Event.assertListening('OrderPlaced', AuditOrder)

    await Event.dispatchAsync(new OrderPlaced(42))

    expect(handled).toEqual(['before:42', 'handled:42'])
    expect(() => Event.assertDispatched('OrderPlaced', event => event.id === 42)).not.toThrow()
    expect(() => Event.assertNotDispatched('OtherEvent')).not.toThrow()
    expect(() => Queue.assertPushed('QueuedClosure')).not.toThrow()
  })
})
