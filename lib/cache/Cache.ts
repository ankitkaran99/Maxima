import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config, storagePath } from '@lib/foundation/helpers.js'
import redis from 'redis'
import { promisify } from 'node:util'
import { DB } from '@lib/database/DB.js'
import { Event } from '@lib/events/Event.js'

type CacheValue = any
type InvalidatedReason = 'expired' | 'forgot' | 'flushed'
type InvalidatedCallback = (event: { store: string, key: string, reason: InvalidatedReason }) => void
type CacheEntry = { value: CacheValue, expiresAt?: number, tags: string[] }
type CacheState = { entries: Record<string, CacheEntry>, tagIndex: Record<string, string[]> }
type StoreFactory = (options: Record<string, any>, name: string, manager: CacheManager) => CacheStore

export class CacheHit {
  constructor(public key: string, public value: any, public tags: string[] = []) {}
}

export class CacheMiss {
  constructor(public key: string, public tags: string[] = []) {}
}

export class KeyWritten {
  constructor(public key: string, public value: any, public seconds: number | null = null, public tags: string[] = []) {}
}

export class KeyForgotten {
  constructor(public key: string, public tags: string[] = []) {}
}

export class CacheCleared {}

export interface CacheStore {
  get<T = any>(key: string): T | undefined | Promise<T | undefined>
  put(key: string, value: any, ttlSeconds?: number): void | Promise<void>
  forever(key: string, value: any): void | Promise<void>
  forget(key: string): void | Promise<void>
  flush(): void | Promise<void>
  has(key: string): boolean | Promise<boolean>
  many(keys: string[]): Record<string, any> | Promise<Record<string, any>>
  putMany(values: Record<string, any>, ttlSeconds?: number): void | Promise<void>
  increment(key: string, amount?: number): number | Promise<number>
  decrement(key: string, amount?: number): number | Promise<number>
  remember<T>(key: string, ttlSeconds: number, callback: () => T | Promise<T>): T | Promise<T>
  rememberForever<T>(key: string, callback: () => T | Promise<T>): T | Promise<T>
  tags(...tags: string[]): TaggedCache
  lock(name: string, seconds?: number, owner?: string): CacheLock
  peek(key: string): CacheEntry | undefined | Promise<CacheEntry | undefined>
  count(): number | Promise<number>
  rawGet<T = any>(rawKey: string): T | undefined | Promise<T | undefined>
  rawPut(rawKey: string, value: any, ttlSeconds?: number, tags?: string[]): void | Promise<void>
  rawForget(rawKey: string): void | Promise<void>
  rawHas(rawKey: string): boolean | Promise<boolean>
  
  acquireLock(name: string, seconds: number, owner: string): Promise<boolean>
  releaseLock(name: string, owner: string): Promise<boolean>
  forceReleaseLock(name: string): Promise<void>
}

abstract class BaseCacheStore implements CacheStore {
  protected state: CacheState = { entries: {}, tagIndex: {} }

  constructor(
    protected readonly name: string,
    protected readonly manager: CacheManager,
    protected readonly options: Record<string, any> = {}
  ) {}

  get<T = any>(key: string) {
    const entry = this.peek(this.rawKey(key))
    if (entry) {
      Event.dispatch(new CacheHit(key, entry.value))
      return clone(entry.value) as T
    }
    Event.dispatch(new CacheMiss(key))
    return undefined
  }

  rawGet<T = any>(rawKey: string) {
    const entry = this.peek(rawKey)
    if (entry) {
      Event.dispatch(new CacheHit(rawKey, entry.value))
      return clone(entry.value) as T
    }
    Event.dispatch(new CacheMiss(rawKey))
    return undefined
  }

  put(key: string, value: any, ttlSeconds?: number) {
    this.writeEntry(this.rawKey(key), value, ttlSeconds)
    Event.dispatch(new KeyWritten(key, value, ttlSeconds))
  }

  rawPut(rawKey: string, value: any, ttlSeconds?: number, tags: string[] = []) {
    this.writeEntry(rawKey, value, ttlSeconds, tags)
    Event.dispatch(new KeyWritten(rawKey, value, ttlSeconds, tags))
  }

  forever(key: string, value: any) {
    this.put(key, value)
  }

  forget(key: string) {
    this.deleteEntry(this.rawKey(key), 'forgot')
    Event.dispatch(new KeyForgotten(key))
  }

  rawForget(rawKey: string) {
    this.deleteEntry(rawKey, 'forgot')
    Event.dispatch(new KeyForgotten(rawKey))
  }

  flush() {
    for (const key of Object.keys(this.state.entries)) this.deleteEntry(key, 'flushed')
    this.state.tagIndex = {}
    this.persist()
    Event.dispatch(new CacheCleared())
  }

  has(key: string) {
    return this.get(key) !== undefined
  }

  rawHas(rawKey: string) {
    return this.rawGet(rawKey) !== undefined
  }

  many(keys: string[]) {
    return Object.fromEntries(keys.map(key => [key, this.get(key)]))
  }

  putMany(values: Record<string, any>, ttlSeconds?: number) {
    for (const [key, value] of Object.entries(values)) this.put(key, value, ttlSeconds)
  }

  increment(key: string, amount = 1) {
    const current = Number(this.get(key) ?? 0) + amount
    this.put(key, current)
    return current
  }

  decrement(key: string, amount = 1) {
    return this.increment(key, -amount)
  }

  async remember<T>(key: string, ttlSeconds: number, callback: () => T | Promise<T>) {
    const existing = this.get<T>(key)
    if (existing !== undefined) return existing
    const value = await Promise.resolve(callback())
    this.put(key, value, ttlSeconds)
    return value
  }

  async rememberForever<T>(key: string, callback: () => T | Promise<T>) {
    const existing = this.get<T>(key)
    if (existing !== undefined) return existing
    const value = await Promise.resolve(callback())
    this.forever(key, value)
    return value
  }

  tags(...tags: string[]) {
    return new TaggedCache(this, tags)
  }

  lock(name: string, seconds = 10, owner = randomUUID()) {
    return new CacheLock(this, name, seconds, owner)
  }

  async acquireLock(name: string, seconds: number, owner: string): Promise<boolean> {
    const rawLockKey = `lock::${name}`
    const entry = this.peek(rawLockKey)
    const now = Date.now()
    if (entry && entry.value.expiresAt > now && entry.value.owner !== owner) {
      return false
    }
    this.writeEntry(rawLockKey, { owner, expiresAt: now + (seconds * 1000) }, seconds)
    return true
  }

  async releaseLock(name: string, owner: string): Promise<boolean> {
    const rawLockKey = `lock::${name}`
    const entry = this.peek(rawLockKey)
    if (!entry || entry.value.owner !== owner) return false
    this.deleteEntry(rawLockKey, 'forgot')
    return true
  }

  async forceReleaseLock(name: string): Promise<void> {
    const rawLockKey = `lock::${name}`
    this.deleteEntry(rawLockKey, 'forgot')
  }

  peek(key: string) {
    const entry = this.state.entries[key]
    if (!entry) return undefined
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.deleteEntry(key, 'expired')
      return undefined
    }
    return entry
  }

  count() {
    return Object.keys(this.state.entries).length
  }

  taggedKey(key: string, tags: string[]) {
    return this.rawKey(key, tags)
  }

  flushTagged(tags: string[]) {
    return this.flushTags(tags)
  }

  protected rawKey(key: string, tags: string[] = []) {
    const clean = normalizeKey(key)
    if (!tags.length) return `${this.prefix()}::${clean}`
    return `${this.prefix()}::${normalizeTags(tags)}::${clean}`
  }

  protected tagKey(tag: string) {
    return `${this.prefix()}::tag::${normalizeKey(tag)}`
  }

  protected prefix() {
    return normalizeKey(this.options.prefix ?? this.name)
  }

  protected writeEntry(rawKey: string, value: any, ttlSeconds?: number, tags: string[] = []) {
    const entry: CacheEntry = {
      value: clone(value),
      tags: [...new Set(tags.map(normalizeKey).filter(Boolean))],
      expiresAt: ttlSeconds ? Date.now() + (ttlSeconds * 1000) : undefined
    }

    this.state.entries[rawKey] = entry
    for (const tag of entry.tags) {
      const bucket = new Set(this.state.tagIndex[tag] ?? [])
      bucket.add(rawKey)
      this.state.tagIndex[tag] = [...bucket]
    }
    this.persist()
  }

  protected deleteEntry(rawKey: string, reason: InvalidatedReason) {
    const entry = this.state.entries[rawKey]
    if (!entry) return
    delete this.state.entries[rawKey]
    for (const tag of entry.tags) {
      const bucket = new Set(this.state.tagIndex[tag] ?? [])
      bucket.delete(rawKey)
      if (bucket.size) this.state.tagIndex[tag] = [...bucket]
      else delete this.state.tagIndex[tag]
    }
    this.persist()
    this.manager.notifyInvalidated({ store: this.name, key: rawKey, reason })
  }

  protected flushTags(tags: string[]) {
    const normalized = [...new Set(tags.map(normalizeKey).filter(Boolean))]
    const keys = new Set<string>()
    for (const tag of normalized) for (const key of this.state.tagIndex[tag] ?? []) keys.add(key)
    for (const key of keys) this.deleteEntry(key, 'flushed')
    this.persist()
  }

  protected abstract persist(): void
}

class MemoryCacheStore extends BaseCacheStore {
  protected persist() {}
}

class FileCacheStore extends BaseCacheStore {
  private readonly file: string

  constructor(name: string, manager: CacheManager, options: Record<string, any>) {
    super(name, manager, options)
    const configuredPath = options.path
      ? path.isAbsolute(options.path) ? options.path : storagePath('..', options.path)
      : storagePath('framework/cache')
    const root = path.resolve(configuredPath)
    this.file = path.join(root, `${normalizeKey(name)}.json`)
    this.state = this.read()
  }

  protected persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2))
  }

  private read() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      return normalizeState(JSON.parse(raw))
    } catch {
      return { entries: {}, tagIndex: {} }
    }
  }
}

class RedisCacheStore implements CacheStore {
  private client: any
  private getAsync: any
  private setAsync: any
  private delAsync: any
  private existsAsync: any
  private keysAsync: any
  private connected = false

  constructor(
    protected readonly name: string,
    protected readonly manager: CacheManager,
    protected readonly options: Record<string, any> = {}
  ) {}

  private connect() {
    if (this.connected) return
    const url = this.options.url ?? 'redis://127.0.0.1:6379'
    this.client = redis.createClient({ url, ...this.options.redis })
    this.getAsync = promisify(this.client.get).bind(this.client)
    this.setAsync = promisify(this.client.set).bind(this.client)
    this.delAsync = promisify(this.client.del).bind(this.client)
    this.existsAsync = promisify(this.client.exists).bind(this.client)
    this.keysAsync = promisify(this.client.keys).bind(this.client)
    this.connected = true
  }

  protected prefix() {
    return this.options.prefix ?? this.name
  }

  protected rawKey(key: string): string {
    return `${this.prefix()}:${key}`
  }

  async get<T = any>(key: string): Promise<T | undefined> {
    this.connect()
    const val = await this.getAsync(this.rawKey(key))
    if (val === null || val === undefined) {
      Event.dispatch(new CacheMiss(key))
      return undefined
    }
    let parsed: any
    try {
      parsed = JSON.parse(val)
    } catch {
      parsed = val
    }
    Event.dispatch(new CacheHit(key, parsed))
    return parsed as T
  }

  async put(key: string, value: any, ttlSeconds?: number): Promise<void> {
    this.connect()
    const rawVal = JSON.stringify(value)
    const rawKey = this.rawKey(key)
    if (ttlSeconds) {
      await this.setAsync(rawKey, rawVal, 'EX', ttlSeconds)
    } else {
      await this.setAsync(rawKey, rawVal)
    }
    Event.dispatch(new KeyWritten(key, value, ttlSeconds))
  }

  async forever(key: string, value: any): Promise<void> {
    await this.put(key, value)
  }

  async forget(key: string): Promise<void> {
    this.connect()
    const rKey = this.rawKey(key)
    await this.delAsync(rKey)
    this.manager.notifyInvalidated({ store: this.name, key: rKey, reason: 'forgot' })
    Event.dispatch(new KeyForgotten(key))
  }

  async flush(): Promise<void> {
    this.connect()
    const keys = await this.keysAsync(`${this.prefix()}:*`)
    if (keys && keys.length > 0) {
      await Promise.all(keys.map((k: string) => this.delAsync(k)))
    }
    Event.dispatch(new CacheCleared())
  }

  async has(key: string): Promise<boolean> {
    this.connect()
    const res = await this.existsAsync(this.rawKey(key))
    return res === 1
  }

  async many(keys: string[]): Promise<Record<string, any>> {
    const pairs = await Promise.all(keys.map(async key => [key, await this.get(key)]))
    return Object.fromEntries(pairs)
  }

  async putMany(values: Record<string, any>, ttlSeconds?: number): Promise<void> {
    await Promise.all(Object.entries(values).map(([key, value]) => this.put(key, value, ttlSeconds)))
  }

  async increment(key: string, amount = 1): Promise<number> {
    const current = await this.get<number>(key)
    const next = Number(current ?? 0) + amount
    await this.put(key, next)
    return next
  }

  async decrement(key: string, amount = 1): Promise<number> {
    return this.increment(key, -amount)
  }

  async remember<T>(key: string, ttlSeconds: number, callback: () => T | Promise<T>): Promise<T> {
    const existing = await this.get<T>(key)
    if (existing !== undefined) return existing
    const value = await Promise.resolve(callback())
    await this.put(key, value, ttlSeconds)
    return value
  }

  async rememberForever<T>(key: string, callback: () => T | Promise<T>): Promise<T> {
    const existing = await this.get<T>(key)
    if (existing !== undefined) return existing
    const value = await Promise.resolve(callback())
    await this.forever(key, value)
    return value
  }

  tags(...tags: string[]): TaggedCache {
    return new TaggedCache(this as any, tags)
  }

  lock(name: string, seconds = 10, owner = randomUUID()): CacheLock {
    return new CacheLock(this as any, name, seconds, owner)
  }

  async acquireLock(name: string, seconds: number, owner: string): Promise<boolean> {
    this.connect()
    const lockKey = this.rawKey(`lock:${name}`)
    const setNxPx = promisify(this.client.set).bind(this.client)
    const result = await setNxPx(lockKey, owner, 'NX', 'PX', seconds * 1000)
    return result === 'OK'
  }

  async releaseLock(name: string, owner: string): Promise<boolean> {
    this.connect()
    const lockKey = this.rawKey(`lock:${name}`)
    const getAsync = promisify(this.client.get).bind(this.client)
    const delAsync = promisify(this.client.del).bind(this.client)
    const currentOwner = await getAsync(lockKey)
    if (currentOwner === owner) {
      await delAsync(lockKey)
      return true
    }
    return false
  }

  async forceReleaseLock(name: string): Promise<void> {
    this.connect()
    const lockKey = this.rawKey(`lock:${name}`)
    const delAsync = promisify(this.client.del).bind(this.client)
    await delAsync(lockKey)
  }

  peek(key: string): CacheEntry | undefined { return undefined }
  count(): number { return 0 }
  rawGet<T = any>(rawKey: string): T | undefined { return undefined }
  rawPut(rawKey: string, value: any, ttlSeconds?: number, tags?: string[]): void {}
  rawForget(rawKey: string): void {}
  rawHas(rawKey: string): boolean { return false }
}

export class DatabaseCacheStore implements CacheStore {
  constructor(
    protected readonly name: string,
    protected readonly manager: CacheManager,
    protected readonly options: Record<string, any> = {}
  ) {}

  protected getTable() {
    return this.options.table ?? 'cache'
  }

  protected prefix() {
    return this.options.prefix ?? this.name
  }

  protected rawKey(key: string): string {
    return `${this.prefix()}:${key}`
  }

  async get<T = any>(key: string): Promise<T | undefined> {
    const table = this.getTable()
    const rKey = this.rawKey(key)
    const row = await DB.table(table).where('key', rKey).first()
    if (!row) {
      Event.dispatch(new CacheMiss(key))
      return undefined
    }
    if (row.expiration && row.expiration <= Math.floor(Date.now() / 1000)) {
      await DB.table(table).where('key', rKey).delete()
      Event.dispatch(new CacheMiss(key))
      return undefined
    }
    
    let parsed: any
    try {
      parsed = JSON.parse(row.value)
    } catch {
      parsed = row.value
    }
    Event.dispatch(new CacheHit(key, parsed))
    return parsed as T
  }

  async put(key: string, value: any, ttlSeconds?: number): Promise<void> {
    const table = this.getTable()
    const rKey = this.rawKey(key)
    const rawVal = JSON.stringify(value)
    const expiration = ttlSeconds ? Math.floor(Date.now() / 1000) + ttlSeconds : null

    const exists = await DB.table(table).where('key', rKey).first()
    if (exists) {
      await DB.table(table).where('key', rKey).update({
        value: rawVal,
        expiration
      })
    } else {
      await DB.table(table).insert({
        key: rKey,
        value: rawVal,
        expiration
      })
    }
    Event.dispatch(new KeyWritten(key, value, ttlSeconds))
  }

  async forever(key: string, value: any): Promise<void> {
    await this.put(key, value)
  }

  async forget(key: string): Promise<void> {
    const table = this.getTable()
    const rKey = this.rawKey(key)
    await DB.table(table).where('key', rKey).delete()
    Event.dispatch(new KeyForgotten(key))
  }

  async flush(): Promise<void> {
    const table = this.getTable()
    await DB.table(table).where('key', 'like', `${this.prefix()}:%`).delete()
    Event.dispatch(new CacheCleared())
  }

  async has(key: string): Promise<boolean> {
    const val = await this.get(key)
    return val !== undefined
  }

  async many(keys: string[]): Promise<Record<string, any>> {
    const pairs = await Promise.all(keys.map(async key => [key, await this.get(key)]))
    return Object.fromEntries(pairs)
  }

  async putMany(values: Record<string, any>, ttlSeconds?: number): Promise<void> {
    await Promise.all(Object.entries(values).map(([key, value]) => this.put(key, value, ttlSeconds)))
  }

  async increment(key: string, amount = 1): Promise<number> {
    const current = await this.get<number>(key)
    const next = Number(current ?? 0) + amount
    await this.put(key, next)
    return next
  }

  async decrement(key: string, amount = 1): Promise<number> {
    return this.increment(key, -amount)
  }

  async remember<T>(key: string, ttlSeconds: number, callback: () => T | Promise<T>): Promise<T> {
    const existing = await this.get<T>(key)
    if (existing !== undefined) return existing
    const value = await Promise.resolve(callback())
    await this.put(key, value, ttlSeconds)
    return value
  }

  async rememberForever<T>(key: string, callback: () => T | Promise<T>): Promise<T> {
    const existing = await this.get<T>(key)
    if (existing !== undefined) return existing
    const value = await Promise.resolve(callback())
    await this.forever(key, value)
    return value
  }

  tags(...tags: string[]): TaggedCache {
    throw new Error('Database cache driver does not support tagging.')
  }

  lock(name: string, seconds = 10, owner = randomUUID()): CacheLock {
    return new CacheLock(this as any, name, seconds, owner)
  }

  async acquireLock(name: string, seconds: number, owner: string): Promise<boolean> {
    const table = this.options.locks_table ?? 'cache_locks'
    const lockKey = this.rawKey(`lock:${name}`)
    const now = Math.floor(Date.now() / 1000)
    const expiration = now + seconds

    return await DB.connection().transaction(async trx => {
      const existing = await trx(table).where('key', lockKey).forUpdate().first()
      if (existing && existing.expiration > now && existing.owner !== owner) {
        return false
      }
      if (existing) {
        await trx(table).where('key', lockKey).update({ owner, expiration })
      } else {
        await trx(table).insert({ key: lockKey, owner, expiration })
      }
      return true
    }).catch(() => false)
  }

  async releaseLock(name: string, owner: string): Promise<boolean> {
    const table = this.options.locks_table ?? 'cache_locks'
    const lockKey = this.rawKey(`lock:${name}`)
    
    return await DB.connection().transaction(async trx => {
      const existing = await trx(table).where('key', lockKey).forUpdate().first()
      if (existing && existing.owner === owner) {
        await trx(table).where('key', lockKey).delete()
        return true
      }
      return false
    }).catch(() => false)
  }

  async forceReleaseLock(name: string): Promise<void> {
    const table = this.options.locks_table ?? 'cache_locks'
    const lockKey = this.rawKey(`lock:${name}`)
    await DB.table(table).where('key', lockKey).delete().catch(() => {})
  }

  peek(key: string): CacheEntry | undefined { return undefined }
  count(): number { return 0 }
  rawGet<T = any>(rawKey: string): T | undefined { return undefined }
  rawPut(rawKey: string, value: any, ttlSeconds?: number, tags?: string[]): void {}
  rawForget(rawKey: string): void {}
  rawHas(rawKey: string): boolean { return false }
}

export class TaggedCache {
  constructor(private readonly store: BaseCacheStore, private readonly tagsList: string[]) {}

  get<T = any>(key: string) {
    return this.store.rawGet<T>(this.store.taggedKey(key, this.tagsList))
  }

  put(key: string, value: any, ttlSeconds?: number) {
    this.store.rawPut(this.store.taggedKey(key, this.tagsList), value, ttlSeconds, this.tagsList)
  }

  forever(key: string, value: any) {
    this.put(key, value)
  }

  forget(key: string) {
    this.store.rawForget(this.store.taggedKey(key, this.tagsList))
  }

  flush() {
    this.store.flushTagged(this.tagsList)
  }

  has(key: string) {
    return this.get(key) !== undefined
  }

  remember<T>(key: string, ttlSeconds: number, callback: () => T | Promise<T>) {
    return this.store.remember(this.store.taggedKey(key, this.tagsList), ttlSeconds, callback)
  }

  rememberForever<T>(key: string, callback: () => T | Promise<T>) {
    return this.store.rememberForever(this.store.taggedKey(key, this.tagsList), callback)
  }

  lock(name: string, seconds = 10, owner = randomUUID()) {
    return this.store.lock(name, seconds, owner)
  }
}

export class CacheLock {
  constructor(
    private readonly store: CacheStore,
    private readonly name: string,
    private readonly seconds: number,
    public readonly owner: string
  ) {}

  async get() {
    return await this.store.acquireLock(this.name, this.seconds, this.owner)
  }

  async block(waitSeconds: number, callback: () => any | Promise<any>) {
    const deadline = Date.now() + (waitSeconds * 1000)
    while (Date.now() <= deadline) {
      if (await this.get()) {
        try {
          return await Promise.resolve(callback())
        } finally {
          await this.release()
        }
      }
      await sleep(100)
    }
    throw new Error(`Unable to acquire lock [${this.name}].`)
  }

  async release() {
    return await this.store.releaseLock(this.name, this.owner)
  }

  async forceRelease() {
    await this.store.forceReleaseLock(this.name)
  }
}

export class CacheManager {
  private stores = new Map<string, CacheStore>()
  private fakeStores = new Map<string, CacheStore>()
  private drivers = new Map<string, StoreFactory>()
  private invalidatedCallbacks = new Set<InvalidatedCallback>()

  store(name = config<string>('cache.default', 'file')) {
    if (this.fakeStores.has(name)) return this.fakeStores.get(name)!
    if (!this.stores.has(name)) this.stores.set(name, this.createStore(name))
    return this.stores.get(name)!
  }

  fake(name = config<string>('cache.default', 'file')) {
    this.fakeStores.set(name, new MemoryCacheStore(name, this, this.storeConfig(name)))
  }

  restore() {
    this.fakeStores.clear()
  }

  extend(driver: string, factory: StoreFactory) {
    this.drivers.set(driver, factory)
  }

  onInvalidated(callback: InvalidatedCallback) {
    this.invalidatedCallbacks.add(callback)
    return () => this.invalidatedCallbacks.delete(callback)
  }

  notifyInvalidated(event: { store: string, key: string, reason: InvalidatedReason }) {
    for (const callback of this.invalidatedCallbacks) callback(event)
  }

  async remember<T>(key: string, ttlSeconds: number, callback: () => T | Promise<T>) {
    return this.store().remember(key, ttlSeconds, callback)
  }

  async rememberForever<T>(key: string, callback: () => T | Promise<T>) {
    return this.store().rememberForever(key, callback)
  }

  async put(key: string, value: any, ttlSeconds?: number) {
    return this.store().put(key, value, ttlSeconds)
  }

  async forever(key: string, value: any) {
    return this.store().forever(key, value)
  }

  async get<T = any>(key: string) {
    return this.store().get<T>(key)
  }

  async forget(key: string) {
    return this.store().forget(key)
  }

  async flush() {
    return this.store().flush()
  }

  async has(key: string) {
    return this.store().has(key)
  }

  tags(...tags: string[]) {
    return this.store().tags(...tags)
  }

  lock(name: string, seconds = 10, owner = randomUUID()) {
    return this.store().lock(name, seconds, owner)
  }

  assertHas(key: string, expected?: any) {
    const actual = this.store().get(key)
    if (actual === undefined) throw new Error(`Expected cache key [${key}] to exist.`)
    if (arguments.length > 1 && !deepEqual(actual, expected)) {
      throw new Error(`Expected cache key [${key}] to contain the expected value.`)
    }
  }

  assertMissing(key: string) {
    if (this.store().has(key)) throw new Error(`Expected cache key [${key}] to be missing.`)
  }

  assertNothingStored() {
    if ((this.store() as BaseCacheStore).count() > 0) throw new Error('Expected cache store to be empty.')
  }

  clearFake(name = config<string>('cache.default', 'file')) {
    this.fakeStores.delete(name)
  }

  private createStore(name: string) {
    const store = this.storeConfig(name)
    if (this.drivers.has(store.driver)) return this.drivers.get(store.driver)!(store, name, this)
    if (store.driver === 'memory') return new MemoryCacheStore(name, this, store)
    if (store.driver === 'file' || store.driver === 'local') return new FileCacheStore(name, this, store)
    if (store.driver === 'redis') return new RedisCacheStore(name, this, store)
    if (store.driver === 'database') return new DatabaseCacheStore(name, this, store)
    throw new Error(`Cache store [${name}] with driver [${store.driver}] is not configured.`)
  }

  private storeConfig(name: string) {
    const cache = config<Record<string, any>>('cache', {
      default: 'file',
      stores: {
        file: { driver: 'file', path: storagePath('framework/cache') },
        memory: { driver: 'memory', prefix: 'cache' }
      }
    })
    return cache.stores?.[name] ?? { driver: name, path: storagePath('framework/cache') }
  }
}

function normalizeState(state: any): CacheState {
  return {
    entries: state?.entries ?? {},
    tagIndex: state?.tagIndex ?? {}
  }
}

function normalizeKey(value: string) {
  return String(value).replaceAll('\\', '/').replace(/^\/+/, '').trim()
}

function normalizeTags(tags: string[]) {
  return [...new Set(tags.map(normalizeKey).filter(Boolean))].sort().join('|')
}

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))
}

function deepEqual(a: any, b: any) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export const Cache = new Proxy(new CacheManager(), {
  get(target, prop: string) {
    if (prop in target) {
      const value = (target as any)[prop]
      return typeof value === 'function' ? value.bind(target) : value
    }
    const value = (target.store() as any)[prop]
    return typeof value === 'function' ? value.bind(target.store()) : value
  }
}) as CacheManager & CacheStore
