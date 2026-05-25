import { Queue } from '@lib/queue/Queue.js'
import { Broadcast, type BroadcastableEvent } from '@lib/broadcast/Broadcast.js'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { basePath } from '@lib/support/paths.js'

type EventListenerObject = { handle(event: any): any, queue?: boolean | string, connection?: string, queueName?: string, delay?: number, retries?: number, tries?: number }
type EventListenerConstructor = new () => EventListenerObject
type EventHandler = ((event: any, name?: string) => any) | EventListenerObject | EventListenerConstructor
type DispatchedRecord = { name: string, event: any, queued: boolean }

export class EventManager {
  private listeners = new Map<string, EventHandler[]>()
  private fakeRecords: DispatchedRecord[] | null = null
  private transactionDepth = 0
  private deferredEvents: Array<() => any> = []
  private discoveredRoots = new Set<string>()

  listen(name: any, listener: EventHandler) {
    const eventName = typeof name === 'function' && name.name ? name.name : String(name)
    const bucket = this.listeners.get(eventName) ?? []
    bucket.push(listener)
    this.listeners.set(eventName, bucket)
    return this
  }


  on(name: string, listener: EventHandler) {
    return this.listen(name, listener)
  }

  subscribe(Subscriber: any) {
    const instance = typeof Subscriber === 'function' ? new Subscriber() : Subscriber
    if (typeof instance.subscribe === 'function') {
      instance.subscribe(this)
    }
    return this
  }

  dispatch(event: string | Record<string, any> | BroadcastableEvent, payload?: any) {
    if (this.shouldDispatchAfterCommit(event)) {
      this.deferredEvents.push(() => this.dispatchNow(event, payload))
      return typeof event === 'string' ? payload : event
    }
    return this.dispatchNow(event, payload)
  }

  private dispatchNow(event: string | Record<string, any> | BroadcastableEvent, payload?: any) {
    const name = typeof event === 'string' ? event : event.constructor.name
    const value = typeof event === 'string' ? payload : event

    if (this.fakeRecords) this.fakeRecords.push({ name, event: value, queued: false })

    const matchedListeners: EventHandler[] = []
    for (const [pattern, list] of this.listeners.entries()) {
      if (matchesPattern(pattern, name)) {
        matchedListeners.push(...list)
      }
    }

    for (const listener of matchedListeners) void this.invokeListener(listener, value, name)

    if (typeof event !== 'string' && isBroadcastable(event)) void Broadcast.broadcast(event)
    return value
  }

  async dispatchAsync(event: string | Record<string, any> | BroadcastableEvent, payload?: any) {
    if (this.shouldDispatchAfterCommit(event)) {
      this.deferredEvents.push(() => this.dispatchAsyncNow(event, payload))
      return typeof event === 'string' ? payload : event
    }
    return this.dispatchAsyncNow(event, payload)
  }

  private async dispatchAsyncNow(event: string | Record<string, any> | BroadcastableEvent, payload?: any) {
    const name = typeof event === 'string' ? event : event.constructor.name
    const value = typeof event === 'string' ? payload : event

    if (this.fakeRecords) this.fakeRecords.push({ name, event: value, queued: false })

    const matchedListeners: EventHandler[] = []
    for (const [pattern, list] of this.listeners.entries()) {
      if (matchesPattern(pattern, name)) {
        matchedListeners.push(...list)
      }
    }

    for (const listener of matchedListeners) await this.invokeListener(listener, value, name)

    if (typeof event !== 'string' && isBroadcastable(event)) await Broadcast.broadcast(event)
    return value
  }

  fake() {
    this.fakeRecords = []
  }

  restore() {
    this.fakeRecords = null
  }

  assertDispatched(name: string) {
    if (!this.fakeRecords?.some(record => record.name === name)) throw new Error(`Expected event [${name}] was not dispatched.`)
  }

  assertNothingDispatched() {
    if (this.fakeRecords?.length) throw new Error('Expected no events to be dispatched.')
  }

  observe(ModelClass: any, observer: any) {
    const instance = typeof observer === 'function' ? new observer() : observer
    for (const event of ['creating', 'created', 'updating', 'updated', 'deleting', 'deleted'] as const) {
      if (typeof instance[event] === 'function') {
        ModelClass.on(event, (model: any) => instance[event](model))
      }
    }
  }

  beginTransaction() {
    this.transactionDepth++
  }

  async commitTransaction() {
    if (this.transactionDepth > 0) this.transactionDepth--
    if (this.transactionDepth > 0) return
    const callbacks = this.deferredEvents.splice(0)
    for (const callback of callbacks) await callback()
  }

  rollBackTransaction() {
    if (this.transactionDepth > 0) this.transactionDepth--
    if (this.transactionDepth === 0) this.deferredEvents = []
  }

  async discover(root = basePath()) {
    const normalizedRoot = path.resolve(root)
    if (this.discoveredRoots.has(normalizedRoot)) return this
    this.discoveredRoots.add(normalizedRoot)
    const listenersDir = path.join(root, 'app', 'Listeners')
    if (!fsSync.existsSync(listenersDir)) return this
    const files = await collectModules(listenersDir)
    for (const file of files) {
      const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`)
      const Listener = mod.default ?? Object.values(mod).find(value => typeof value === 'function')
      if (typeof Listener !== 'function') continue
      const eventNames = listenerEventNames(Listener)
      for (const eventName of eventNames) this.listen(eventName, Listener as EventHandler)
    }
    return this
  }

  private async invokeListener(listener: EventHandler, event: any, name?: string) {
    const resolved = typeof listener === 'function' ? this.instantiate(listener) : listener

    if (resolved && typeof resolved === 'object' && 'handle' in resolved) {
      if (resolved.queue) {
        const queueName = resolved.queueName ?? (typeof resolved.queue === 'string' ? resolved.queue : 'default')
        const connection = resolved.connection ?? queueName
        const options = {
          delay: (resolved as any).delay,
          retries: (resolved as any).retries ?? (resolved as any).tries
        }
        return Queue.push({ handle: () => resolved.handle(event, name) }, options, connection)
      }
      return resolved.handle(event, name)
    }

    if (typeof resolved === 'function') return resolved(event, name)
  }

  private instantiate(listener: EventListenerConstructor | ((event: any) => any)) {
    if ('prototype' in listener && typeof (listener as any).prototype?.handle === 'function') {
      return new (listener as any)()
    }
    return listener
  }

  private shouldDispatchAfterCommit(event: string | Record<string, any> | BroadcastableEvent) {
    if (this.transactionDepth <= 0 || typeof event === 'string') return false
    return Boolean((event as any).afterCommit || (event as any).shouldDispatchAfterCommit)
  }
}

async function collectModules(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await collectModules(fullPath))
    else if ((entry.name.endsWith('.ts') || entry.name.endsWith('.js')) && !entry.name.endsWith('.d.ts')) files.push(fullPath)
  }
  return files
}

function listenerEventNames(Listener: any) {
  const configured = Listener.event ?? Listener.events ?? Listener.listens ?? Listener.listen
  const values = Array.isArray(configured) ? configured : configured ? [configured] : []
  if (values.length) return values.map(value => typeof value === 'function' && value.name ? value.name : String(value))
  return [Listener.name.replace(/Listener$/, '')]
}

function matchesPattern(pattern: string, name: string) {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === name

  const regexStr = '^' + pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*') + '$'
  return new RegExp(regexStr).test(name)
}

function isBroadcastable(event: any): event is BroadcastableEvent {
  return event && typeof event.broadcastOn === 'function'
}

export const Event = new EventManager()
