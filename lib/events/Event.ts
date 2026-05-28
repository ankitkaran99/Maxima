import { Queue, SerializableRegistry, type Job } from '@lib/queue/Queue.js'
import { Broadcast, type BroadcastableEvent } from '@lib/broadcast/Broadcast.js'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { basePath } from '@lib/support/paths.js'
import { transactionStorage } from '@lib/database/TransactionContext.js'

type EventListenerObject = {
  handle(event: any, name?: string): any
  queue?: boolean | string
  shouldQueue?: boolean
  connection?: string
  queueName?: string
  delay?: number | ((event: any) => number)
  retries?: number
  tries?: number
  backoff?: number | number[] | string | ((event: any) => number | number[] | string)
  retryUntil?: Date | number | (() => Date | number)
  maxExceptions?: number
  middleware?: any[] | ((event: any) => any[])
}
type EventListenerConstructor = new () => EventListenerObject
type EventHandler = ((event: any, name?: string) => any) | EventListenerObject | EventListenerConstructor
type DispatchedRecord = { name: string, event: any, queued: boolean }

export class ShouldQueue {
  shouldQueue = true
}

export class QueuedClosure implements Job {
  constructor(private listener: EventListenerObject, private event: any, private eventName?: string) {}

  get tries() { return valueFrom(this.listener, 'tries', this.event) ?? valueFrom(this.listener, 'retries', this.event) }
  get backoff() { return valueFrom(this.listener, 'backoff', this.event) }
  get retryUntil() { return valueFrom(this.listener, 'retryUntil', this.event) }
  get maxExceptions() { return valueFrom(this.listener, 'maxExceptions', this.event) }
  middleware() { return valueFrom(this.listener, 'middleware', this.event) ?? [] }
  async handle() { return this.listener.handle(this.event, this.eventName) }
}

export class EventManager {
  private listeners = new Map<string, EventHandler[]>()
  private fakeRecords: DispatchedRecord[] | null = null
  private fakeOnly: Set<string> | null = null
  private transactionDepth = 0
  private deferredEvents: Array<() => any> = []
  private discoveredRoots = new Set<string>()

  listen(name: any, listener: EventHandler) {
    const eventName = typeof name === 'function' && name.name ? name.name : String(name)
    const bucket = this.listeners.get(eventName) ?? []
    bucket.push(listener)
    this.listeners.set(eventName, bucket)
    this.registerSerializableListener(listener)
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
      const store = transactionStorage.getStore()
      if (store) {
        store.deferredEvents.push(() => this.dispatchNow(event, payload))
      } else {
        this.deferredEvents.push(() => this.dispatchNow(event, payload))
      }
      return typeof event === 'string' ? payload : event
    }
    return this.dispatchNow(event, payload)
  }

  private dispatchNow(event: string | Record<string, any> | BroadcastableEvent, payload?: any) {
    const name = typeof event === 'string' ? event : event.constructor.name
    const value = typeof event === 'string' ? payload : event

    if (this.fakeRecords && (!this.fakeOnly || this.fakeOnly.has(name))) this.fakeRecords.push({ name, event: value, queued: false })

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
      const store = transactionStorage.getStore()
      if (store) {
        store.deferredEvents.push(() => this.dispatchAsyncNow(event, payload))
      } else {
        this.deferredEvents.push(() => this.dispatchAsyncNow(event, payload))
      }
      return typeof event === 'string' ? payload : event
    }
    return this.dispatchAsyncNow(event, payload)
  }

  private async dispatchAsyncNow(event: string | Record<string, any> | BroadcastableEvent, payload?: any) {
    const name = typeof event === 'string' ? event : event.constructor.name
    const value = typeof event === 'string' ? payload : event

    if (this.fakeRecords && (!this.fakeOnly || this.fakeOnly.has(name))) this.fakeRecords.push({ name, event: value, queued: false })

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

  fake(events?: string | string[]) {
    if (events) {
      const selected = Array.isArray(events) ? events.map(String) : [String(events)]
      this.fakeRecords = []
      this.fakeOnly = new Set(selected)
      return this
    }
    this.fakeRecords = []
    this.fakeOnly = null
    return this
  }

  restore() {
    this.fakeRecords = null
    this.fakeOnly = null
  }

  assertDispatched(name: string, predicate?: (event: any) => boolean) {
    if (!this.fakeRecords?.some(record => record.name === name && (!predicate || predicate(record.event)))) throw new Error(`Expected event [${name}] was not dispatched.`)
  }

  assertNotDispatched(name: string) {
    if (this.fakeRecords?.some(record => record.name === name)) throw new Error(`Expected event [${name}] not to be dispatched.`)
  }

  assertNothingDispatched() {
    if (this.fakeRecords?.length) throw new Error('Expected no events to be dispatched.')
  }

  assertListening(event: string, listener: any) {
    const listeners = this.listeners.get(event) ?? []
    const expected = typeof listener === 'function' ? listener.name : listener.constructor?.name
    if (!listeners.some(item => (typeof item === 'function' ? item.name : item.constructor?.name) === expected)) {
      throw new Error(`Expected listener [${expected}] to listen for event [${event}].`)
    }
  }

  registeredListeners(event?: string) {
    if (event) return [...(this.listeners.get(event) ?? [])]
    return new Map(this.listeners)
  }

  register(provider: any) {
    const instance = typeof provider === 'function' ? new provider() : provider
    const listen = instance.listen ?? provider.listen ?? {}
    for (const [event, listeners] of Object.entries(listen)) {
      for (const listener of Array.isArray(listeners) ? listeners : [listeners]) this.listen(event, listener as EventHandler)
    }
    for (const subscriber of instance.subscribe ?? provider.subscribe ?? []) this.subscribe(subscriber)
    for (const [model, observer] of Object.entries(instance.observers ?? provider.observers ?? {})) this.observe(model, observer)
    return this
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
    const store = transactionStorage.getStore()
    if (store) {
      // depth is managed by DB.ts
    } else {
      this.transactionDepth++
    }
  }

  async commitTransaction() {
    const store = transactionStorage.getStore()
    if (store) {
      if (store.depth > 0) store.depth--
      if (store.depth > 0) return
      const callbacks = store.deferredEvents.splice(0)
      for (const callback of callbacks) await callback()
    } else {
      if (this.transactionDepth > 0) this.transactionDepth--
      if (this.transactionDepth > 0) return
      const callbacks = this.deferredEvents.splice(0)
      for (const callback of callbacks) await callback()
    }
  }

  rollBackTransaction() {
    const store = transactionStorage.getStore()
    if (store) {
      if (store.depth > 0) store.depth--
      if (store.depth === 0) store.deferredEvents = []
    } else {
      if (this.transactionDepth > 0) this.transactionDepth--
      if (this.transactionDepth === 0) this.deferredEvents = []
    }
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
      this.registerSerializableListener(Listener as EventHandler)
      const eventNames = listenerEventNames(Listener)
      for (const eventName of eventNames) this.listen(eventName, Listener as EventHandler)
    }
    return this
  }

  private async invokeListener(listener: EventHandler, event: any, name?: string) {
    const resolved = typeof listener === 'function' ? this.instantiate(listener) : listener

    if (resolved && typeof resolved === 'object' && 'handle' in resolved) {
      if (shouldQueueListener(resolved)) {
        const queueName = resolved.queueName ?? (typeof resolved.queue === 'string' ? resolved.queue : 'default')
        const connection = resolved.connection ?? queueName
        const options = {
          delay: valueFrom(resolved, 'delay', event),
          retries: valueFrom(resolved, 'retries', event) ?? valueFrom(resolved, 'tries', event),
          backoff: valueFrom(resolved, 'backoff', event),
          retryUntil: normalizeRetryUntil(valueFrom(resolved, 'retryUntil', event)),
          maxExceptions: valueFrom(resolved, 'maxExceptions', event)
        }
        const job = new QueuedClosure(resolved, event, name)
        return Queue.push(job, options, queueName, connection)
      }
      return runListenerMiddleware(resolved, event, name)
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
    if (typeof event === 'string') return false
    const store = transactionStorage.getStore()
    const depth = store ? store.depth : this.transactionDepth
    if (depth <= 0) return false
    return Boolean((event as any).afterCommit || (event as any).shouldDispatchAfterCommit)
  }

  private registerSerializableListener(listener: EventHandler) {
    if (typeof listener === 'function' && typeof (listener as any).prototype?.handle === 'function') {
      SerializableRegistry.register(listener)
    } else if (listener && typeof listener === 'object' && typeof (listener as EventListenerObject).handle === 'function') {
      SerializableRegistry.register(listener.constructor)
    }
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

SerializableRegistry.register(QueuedClosure)

function shouldQueueListener(listener: EventListenerObject) {
  return listener instanceof ShouldQueue || Boolean(listener.queue || listener.shouldQueue)
}

async function runListenerMiddleware(listener: EventListenerObject, event: any, name?: string) {
  const middleware = valueFrom(listener, 'middleware', event) ?? []
  const run = async (index: number): Promise<any> => {
    if (index >= middleware.length) return listener.handle(event, name)
    const current = middleware[index]
    if (typeof current === 'function') return current(event, () => run(index + 1))
    if (current && typeof current.handle === 'function') return current.handle(event, () => run(index + 1))
    return run(index + 1)
  }
  return run(0)
}

function valueFrom(target: any, key: string, event: any) {
  const value = target?.[key]
  return typeof value === 'function' ? value.call(target, event) : value
}

function normalizeRetryUntil(value: any) {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  return value
}
