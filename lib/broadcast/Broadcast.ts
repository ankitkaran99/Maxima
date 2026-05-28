import crypto from 'node:crypto'
import { config } from '@lib/foundation/helpers.js'

export type BroadcastPayload = {
  name: string
  channels: string[] | string
  payload: Record<string, any>
  socket?: string
  encrypted?: boolean
  connection?: string
  queue?: string
}

export interface BroadcastableEvent {
  broadcastOn(): string[] | string | Array<{ toString(): string }> | { toString(): string }
  broadcastAs?(): string
  broadcastWith?(): Record<string, any>
  broadcastWhen?(): boolean | Promise<boolean>
  broadcastQueue?(): string | undefined
  broadcastConnection?(): string | undefined
  broadcastSocket?(): string | undefined
  socket?: string
  connection?: string
  queue?: string
  afterCommit?: boolean
}

export interface ShouldBroadcast {}
export interface ShouldBroadcastNow extends ShouldBroadcast {}

export class PrivateChannel {
  constructor(public name: string) {}
  toString() { return this.name.startsWith('private-') ? this.name : `private-${this.name}` }
}

export class PresenceChannel {
  constructor(public name: string) {}
  toString() { return this.name.startsWith('presence-') ? this.name : `presence-${this.name}` }
}

export class Channel {
  constructor(public name: string) {}
  toString() { return this.name }
}

export class EncryptedPrivateChannel extends PrivateChannel {
  override toString() {
    const name = super.toString()
    return name.startsWith('private-encrypted-') ? name : name.replace(/^private-/, 'private-encrypted-')
  }
}

export class PendingBroadcast {
  constructor(private manager: BroadcastManager, private event: BroadcastableEvent) {}
  toOthers() {
    const socket = this.manager.currentSocket()
    if (socket) {
      ;(this.event as any).socket = socket
    }
    return this
  }
  via(connection: string) {
    ;(this.event as any).connection = connection
    return this
  }
  onConnection(connection: string) { return this.via(connection) }
  onQueue(queue: string) {
    ;(this.event as any).queue = queue
    return this
  }
  queue(queue: string) { return this.onQueue(queue) }
  dispatch() { return this.manager.broadcast(this.event) }
}

export class BroadcastManager {
  private fakePayloads: BroadcastPayload[] | null = null
  private channels = new Map<string, (user: any, ...args: any[]) => boolean | Promise<boolean>>()
  private broadcastCallbacks = new Set<(event: BroadcastPayload) => void | Promise<any>>()
  private presenceMembers = new Map<string, Map<string, any>>()
  private socketContext?: string
  private drivers = new Map<string, (event: BroadcastPayload) => Promise<any> | any>()

  fake() {
    this.fakePayloads = []
  }

  restore() {
    this.fakePayloads = null
    this.presenceMembers.clear()
  }

  broadcasted() {
    return this.fakePayloads ?? []
  }

  channel(namePattern: string, callback: (user: any, ...args: any[]) => boolean | Promise<boolean>) {
    this.channels.set(namePattern, callback)
    return this
  }

  routes() {
    return this
  }

  extend(driver: string, callback: (event: BroadcastPayload) => Promise<any> | any) {
    this.drivers.set(driver, callback)
    return this
  }

  socket(socketId: string | undefined) {
    this.socketContext = socketId
    return this
  }

  currentSocket() {
    return this.socketContext
  }

  event(event: BroadcastableEvent) {
    return new PendingBroadcast(this, event)
  }

  toOthers(event: BroadcastableEvent) {
    return this.event(event).toOthers()
  }

  async authorize(user: any, channelName: string): Promise<boolean> {
    channelName = normalizeChannelName(channelName)
    for (const [pattern, callback] of this.channels.entries()) {
      const regexPattern = '^' + pattern
        .replace(/\{[A-Za-z0-9_]+\}/g, '([^.]+)')
        .replace(/:[A-Za-z0-9_]+/g, '([^.]+)')
        .replace(/\./g, '\\.') + '$'
      const regex = new RegExp(regexPattern)
      const match = channelName.match(regex)
      if (match) {
        const args = match.slice(1).map(val => isNaN(Number(val)) ? val : Number(val))
        try {
          return Boolean(await Promise.resolve(callback(user, ...args)))
        } catch {
          return false
        }
      }
    }
    if (!channelName.startsWith('private-') && !channelName.startsWith('presence-')) {
      return true
    }
    return false
  }

  async authResponse(user: any, socketId: string, channelName: string) {
    const authorized = await this.authorize(user, channelName)
    if (!authorized) {
      const error = new Error('Unauthorized')
      ;(error as any).statusCode = 403
      throw error
    }

    const secret = String(config('broadcasting.connections.pusher.secret', config('broadcasting.connections.reverb.secret', config('app.key', 'maxima-secret'))))
    const normalized = normalizeChannelName(channelName)
    const member = normalized.startsWith('presence-') ? {
      user_id: String(user?.id ?? user?.uuid ?? user?.email ?? 'anonymous'),
      user_info: user ?? {}
    } : undefined
    const stringToSign = member
      ? `${socketId}:${normalized}:${JSON.stringify(member)}`
      : `${socketId}:${normalized}`
    const signature = crypto.createHmac('sha256', secret).update(stringToSign).digest('hex')
    const key = String(config('broadcasting.connections.pusher.key', config('broadcasting.connections.reverb.key', 'maxima')))
    return {
      auth: `${key}:${signature}`,
      ...(member ? { channel_data: JSON.stringify(member) } : {})
    }
  }

  joinPresence(channel: string, user: any) {
    channel = normalizeChannelName(channel)
    const id = String(user?.id ?? user?.uuid ?? user?.email ?? JSON.stringify(user))
    if (!id || id === 'undefined') return []
    const members = this.presenceMembers.get(channel) ?? new Map<string, any>()
    members.set(id, user)
    this.presenceMembers.set(channel, members)
    return [...members.values()]
  }

  leavePresence(channel: string, user: any) {
    channel = normalizeChannelName(channel)
    const id = String(user?.id ?? user?.uuid ?? user?.email ?? JSON.stringify(user))
    const members = this.presenceMembers.get(channel)
    if (!members) return []
    members.delete(id)
    if (!members.size) this.presenceMembers.delete(channel)
    return [...members.values()]
  }

  members(channel: string) {
    channel = normalizeChannelName(channel)
    return [...(this.presenceMembers.get(channel)?.values() ?? [])]
  }

  onBroadcast(callback: (event: BroadcastPayload) => void | Promise<void>) {
    this.broadcastCallbacks.add(callback)
    return () => this.broadcastCallbacks.delete(callback)
  }

  async broadcast(event: BroadcastableEvent) {
    if (event.broadcastWhen && !(await event.broadcastWhen())) return null
    const rawChannels = event.broadcastOn()
    const channels = normalizeChannels(rawChannels)
    const payload: BroadcastPayload = {
      name: event.broadcastAs?.() ?? event.constructor.name,
      channels: Array.isArray(rawChannels) ? channels : channels[0],
      payload: event.broadcastWith?.() ?? serializeEvent(event),
      socket: event.broadcastSocket?.() ?? event.socket,
      encrypted: channels.some(channel => channel.startsWith('private-encrypted-')),
      connection: event.broadcastConnection?.() ?? event.connection ?? config<string>('broadcasting.default', 'local'),
      queue: event.broadcastQueue?.() ?? event.queue
    }

    if (shouldQueue(event)) {
      const { Queue } = await import('@lib/queue/Queue.js')
      const queueName = payload.queue ?? payload.connection ?? 'default'
      const connection = payload.connection ?? queueName
      await Queue.push({ handle: async () => { await this.dispatchPayload(payload) } }, {}, queueName, connection)
      return payload
    }

    if (this.fakePayloads) {
      this.fakePayloads.push(payload)
      return payload
    }

    await this.dispatchPayload(payload)
    return payload
  }

  async dispatchPayload(payload: BroadcastPayload) {
    if (this.fakePayloads) {
      this.fakePayloads.push(payload)
      return payload
    }

    for (const cb of this.broadcastCallbacks) {
      try {
        await Promise.resolve(cb(payload))
      } catch {}
    }

    const driver = this.drivers.get(payload.connection ?? '') ?? this.drivers.get(config<string>('broadcasting.default', 'local'))
    if (driver) await driver(payload)
    return payload
  }

  async clientEvent(channel: string, event: string, data: Record<string, any> = {}, socket?: string) {
    return this.dispatchPayload({
      name: event,
      channels: normalizeChannelName(channel),
      payload: data,
      socket,
      connection: config<string>('broadcasting.default', 'local')
    })
  }

  async model(model: any, event: string) {
    const channels = typeof model.broadcastOn === 'function'
      ? model.broadcastOn(event)
      : [`private-${model.constructor.name}.${model.getRouteKey?.() ?? model.id}`]
    return this.broadcast({
      broadcastOn: () => channels,
      broadcastAs: () => `${model.constructor.name}${event.charAt(0).toUpperCase()}${event.slice(1)}`,
      broadcastWith: () => ({ model: model.toJSON?.() ?? model })
    })
  }

  assertBroadcasted(name: string) {
    if (!this.fakePayloads?.some(payload => payload.name === name)) {
      throw new Error(`Expected broadcast [${name}] was not dispatched.`)
    }
  }

  assertNothingBroadcasted() {
    if (this.fakePayloads?.length) throw new Error('Expected no broadcasts to be dispatched.')
  }
}

export const Broadcast = new BroadcastManager()

function normalizeChannels(channels: string[] | string | Array<{ toString(): string }> | { toString(): string }) {
  const values = Array.isArray(channels) ? channels : [channels]
  return values.map(channel => normalizeChannelName(String(channel)))
}

export function normalizeChannelName(channel: string) {
  return channel.replace(/^private:/, 'private-').replace(/^presence:/, 'presence-')
}

function serializeEvent(event: BroadcastableEvent) {
  return Object.fromEntries(Object.entries(event as any).filter(([key, value]) => {
    return !key.startsWith('_') && typeof value !== 'function' && !['socket', 'connection', 'queue'].includes(key)
  }))
}

function shouldQueue(event: BroadcastableEvent) {
  const immediate = (event as any).shouldBroadcastNow || (event as any).broadcastNow
  if (immediate) return false
  return Boolean((event as any).shouldQueue)
}
