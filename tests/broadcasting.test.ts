import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import path from 'node:path'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { HttpKernel } from '@lib/http/Kernel.js'
import { Broadcast, type BroadcastableEvent } from '@lib/broadcast/Broadcast.js'

class TestBroadcastEvent implements BroadcastableEvent {
  constructor(public message: string) {}
  broadcastOn() { return ['public-channel', 'private-user.1'] }
  broadcastAs() { return 'TestBroadcastEvent' }
  broadcastWith() { return { text: this.message } }
}

describe('Broadcasting & WebSockets', () => {
  let app: Application
  let kernel: HttpKernel

  beforeEach(async () => {
    app = new Application(path.join(process.cwd(), 'src'))
    setApplication(app)
    app.config.set('app.port', 0) // random port
    app.config.set('app.host', '127.0.0.1')
    app.config.set('middleware.global', [])
    app.config.set('security.helmet', false)
    app.config.set('session.driver', 'memory')
    
    // Register private channel authorizer
    Broadcast.channel('private-user.{id}', (user, id) => {
      return user && user.id === Number(id)
    })

    kernel = new HttpKernel(app)
    await kernel.listen()
  })

  afterEach(async () => {
    await kernel.close()
  })

  it('authorizes public and private channels correctly', async () => {
    // Public channel
    await expect(Broadcast.authorize(null, 'public-channel')).resolves.toBe(true)

    // Private channel - unauthorized
    await expect(Broadcast.authorize(null, 'private-user.1')).resolves.toBe(false)
    await expect(Broadcast.authorize({ id: 2 }, 'private-user.1')).resolves.toBe(false)

    // Private channel - authorized
    await expect(Broadcast.authorize({ id: 1 }, 'private-user.1')).resolves.toBe(true)
  })

  it('tracks presence channel members', async () => {
    Broadcast.channel('presence-room.{id}', (user, id) => Boolean(user && id))

    const members = Broadcast.joinPresence('presence-room.1', { id: 10, name: 'Ada' })
    expect(members).toEqual([{ id: 10, name: 'Ada' }])
    expect(Broadcast.members('presence-room.1')).toHaveLength(1)

    Broadcast.leavePresence('presence-room.1', { id: 10 })
    expect(Broadcast.members('presence-room.1')).toHaveLength(0)
  })

  it('broadcasts events to connected and subscribed WebSocket clients', async () => {
    const port = (kernel.server.server.address() as any).port
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    await new Promise<void>((resolve) => client.on('open', () => resolve()))

    // Subscribe to public channel
    client.send(JSON.stringify({ event: 'subscribe', channel: 'public-channel' }))

    // Subscribe to private channel with valid auth payload
    client.send(JSON.stringify({
      event: 'subscribe',
      channel: 'private-user.1',
      auth: JSON.stringify({ id: 1 }) // custom user payload format
    }))

    // Wait for subscription succeeded confirmations
    const received: any[] = []
    client.on('message', (data) => {
      received.push(JSON.parse(data.toString()))
    })

    await new Promise((resolve) => setTimeout(resolve, 200))

    // Broadcast the event
    await Broadcast.broadcast(new TestBroadcastEvent('hello world'))

    // Wait for messages to propagate
    await new Promise((resolve) => setTimeout(resolve, 300))
    client.close()

    // Assert that client received subscription success notifications and the broadcasted message
    expect(received.some(m => m.event === 'subscription_succeeded' && m.channel === 'public-channel')).toBe(true)
    expect(received.some(m => m.event === 'subscription_succeeded' && m.channel === 'private-user.1')).toBe(true)
    
    const eventMsg = received.find(m => m.event === 'TestBroadcastEvent')
    expect(eventMsg).toBeDefined()
    expect(eventMsg.channel).toBe('public-channel') // or private-user.1 depending on subscription
    expect(eventMsg.data).toEqual({ text: 'hello world' })
  })
})
