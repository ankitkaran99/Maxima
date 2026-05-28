import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config, storagePath } from '@lib/foundation/helpers.js'
import redis from 'redis'
import { promisify } from 'node:util'
import { DB } from '@lib/database/DB.js'
import { Event } from '@lib/events/Event.js'
import { Telescope, Pulse } from '@lib/observability/Observability.js'

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
  get<T = any>(key: string, defaultValue?: T | (() => T | Promise<T>)): T | undefined | Promise<T | undefined>
  put(key: string, value: any, ttlSeconds?: number): void | Promise<void>
  forever(key: string, value: any): void | Promise<void>
  forget(key: string): void | Promise<void>
  flush(): void | Promise<void>
  has(key: string): boolean | Promise<boolean>
  missing(key: string): boolean | Promise<boolean>
  add(key: string, value: any, ttlSeconds?: number): boolean | Promise<boolean>
  pull<T = any>(key: string, defaultValue?: T | (() => T | Promise<T>)): T | undefined | Promise<T | undefined>
  sear<T>(key: string, callback: () => T | Promise<T>): T | Promise<T>
  flexible<T>(key: string, ttls: [number, number], callback: () => T | Promise<T>): T | Promise<T>
  many(keys: string[]): Record<string, any> | Promise<Record<string, any>>
  putMany(values: Record<string, any>, ttlSeconds?: number): void | Promise<void>
  getMultiple(keys: Iterable<string>): Record<string, any> | Promise<Record<string, any>>
  setMultiple(values: Iterable<[string, any]> | Record<string, any>, ttlSeconds?: number): void | Promise<void>
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
  supportsTags(): boolean
  
  acquireLock(name: string, seconds: number, owner: string): Promise<boolean>
  releaseLock(name: string, owner: string): Promise<boolean>
  forceReleaseLock(name: string): Promise<void>
  prune(): number | Promise<number>
}

abstract class BaseCacheStore implements CacheStore {
  protected state: CacheState = { entries: {}, tagIndex: {} }

  constructor(
    protected readonly name: string,
    protected readonly manager: CacheManager,
    protected readonly options: Record<string, any> = {}
  ) {}

  get<T = any>(key: string, defaultValue?: T | (() => T | Promise<T>)) {
    const entry = this.peek(this.rawKey(key))
    if (entry) {
      Event.dispatch(new CacheHit(key, entry.value))
      Telescope.record('cache', { key, hit: true, store: this.name })
      Pulse.increment('cache.hit')
      return clone(entry.value) as T
    }
    Event.dispatch(new CacheMiss(key))
    Telescope.record('cache', { key, hit: false, store: this.name })
    Pulse.increment('cache.miss')
    return resolveDefault(defaultValue)
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
    Telescope.record('cache', { key, write: true, store: this.name, ttlSeconds })
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
    Telescope.record('cache', { key, forgotten: true, store: this.name })
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

  missing(key: string) {
    return !this.has(key)
  }

  add(key: string, value: any, ttlSeconds?: number) {
    if (this.has(key)) return false
    this.put(key, value, ttlSeconds)
    return true
  }

  pull<T = any>(key: string, defaultValue?: T | (() => T | Promise<T>)) {
    const value = this.get<T>(key, defaultValue)
    this.forget(key)
    return value
  }

  sear<T>(key: string, callback: () => T | Promise<T>) {
    return this.rememberForever(key, callback)
  }

  async flexible<T>(key: string, ttls: [number, number], callback: () => T | Promise<T>) {
    const rawKey = this.rawKey(key)
    const entry = this.state.entries[rawKey]
    const now = Date.now()
    if (entry?.value && typeof entry.value === 'object' && '__flexible' in entry.value) {
      const payload = entry.value as { value: T, freshUntil: number, staleUntil: number }
      if (payload.freshUntil > now || payload.staleUntil > now) return clone(payload.value)
    }
    const value = await Promise.resolve(callback())
    const [freshSeconds, staleSeconds] = ttls
    this.writeEntry(rawKey, {
      __flexible: true,
      value,
      freshUntil: now + freshSeconds * 1000,
      staleUntil: now + staleSeconds * 1000
    }, staleSeconds)
    Event.dispatch(new KeyWritten(key, value, staleSeconds))
    return value
  }

  many(keys: string[]) {
    return Object.fromEntries(keys.map(key => [key, this.get(key)]))
  }

  putMany(values: Record<string, any>, ttlSeconds?: number) {
    for (const [key, value] of Object.entries(values)) this.put(key, value, ttlSeconds)
  }

  getMultiple(keys: Iterable<string>) {
    return this.many([...keys])
  }

  setMultiple(values: Iterable<[string, any]> | Record<string, any>, ttlSeconds?: number) {
    this.putMany(iterableToRecord(values), ttlSeconds)
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

  lock(name: string, seconds = 10, owner: string = randomUUID()) {
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

  supportsTags() {
    return true
  }

  prune() {
    let pruned = 0
    for (const key of Object.keys(this.state.entries)) {
      const entry = this.state.entries[key]
      if (entry.expiresAt && entry.expiresAt <= Date.now()) {
        this.deleteEntry(key, 'expired')
        pruned += 1
      }
    }
    return pruned
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

class NullCacheStore extends BaseCacheStore {
  override get<T = any>(_key: string, defaultValue?: T | (() => T | Promise<T>)) {
    return resolveDefault(defaultValue)
  }

  override rawGet<T = any>(_rawKey: string) {
    return undefined as T | undefined
  }

  override put() {}
  override rawPut() {}
  override forever() {}
  override forget() {}
  override rawForget() {}
  override flush() {}
  override has() { return false }
  override rawHas() { return false }
  override missing() { return true }
  override add() { return true }
  override increment(_key: string, amount = 1) { return amount }
  override decrement(_key: string, amount = 1) { return -amount }
  override peek() { return undefined }
  override count() { return 0 }
  override supportsTags() { return false }
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

  taggedKey(key: string, tags: string[]) {
    return `${normalizeTags(tags)}:${key}`
  }

  async get<T = any>(key: string, defaultValue?: T | (() => T | Promise<T>)): Promise<T | undefined> {
    this.connect()
    const val = await this.getAsync(this.rawKey(key))
    if (val === null || val === undefined) {
      Event.dispatch(new CacheMiss(key))
      return resolveDefault(defaultValue)
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

  async missing(key: string): Promise<boolean> {
    return !(await this.has(key))
  }

  async add(key: string, value: any, ttlSeconds?: number): Promise<boolean> {
    this.connect()
    const rawVal = JSON.stringify(value)
    const rawKey = this.rawKey(key)
    try {
      let res: any
      if (ttlSeconds) {
        res = await this.setAsync(rawKey, rawVal, 'NX', 'EX', ttlSeconds)
      } else {
        res = await this.setAsync(rawKey, rawVal, 'NX')
      }
      const succeeded = res === 'OK' || res === 1 || res === '1' || res === true
      if (succeeded) {
        Event.dispatch(new KeyWritten(key, value, ttlSeconds))
        return true
      }
      return false
    } catch {
      if (await this.has(key)) return false
      await this.put(key, value, ttlSeconds)
      return true
    }
  }

  async pull<T = any>(key: string, defaultValue?: T | (() => T | Promise<T>)): Promise<T | undefined> {
    const value = await this.get<T>(key, defaultValue)
    await this.forget(key)
    return value
  }

  async sear<T>(key: string, callback: () => T | Promise<T>): Promise<T> {
    return this.rememberForever(key, callback)
  }

  async flexible<T>(key: string, ttls: [number, number], callback: () => T | Promise<T>): Promise<T> {
    return this.remember(key, ttls[1], callback)
  }

  async many(keys: string[]): Promise<Record<string, any>> {
    const pairs = await Promise.all(keys.map(async key => [key, await this.get(key)]))
    return Object.fromEntries(pairs)
  }

  async putMany(values: Record<string, any>, ttlSeconds?: number): Promise<void> {
    await Promise.all(Object.entries(values).map(([key, value]) => this.put(key, value, ttlSeconds)))
  }

  async getMultiple(keys: Iterable<string>): Promise<Record<string, any>> {
    return this.many([...keys])
  }

  async setMultiple(values: Iterable<[string, any]> | Record<string, any>, ttlSeconds?: number): Promise<void> {
    return this.putMany(iterableToRecord(values), ttlSeconds)
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

  lock(name: string, seconds = 10, owner: string = randomUUID()): CacheLock {
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
  supportsTags(): boolean { return false }
  prune(): number { return 0 }
}

export class DatabaseCacheStore implements CacheStore {
  private tagIndex = new Map<string, Set<string>>()

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

  taggedKey(key: string, tags: string[]) {
    return `${normalizeTags(tags)}:${key}`
  }

  async get<T = any>(key: string, defaultValue?: T | (() => T | Promise<T>)): Promise<T | undefined> {
    const table = this.getTable()
    const rKey = this.rawKey(key)
    const row = await DB.table(table).where('key', rKey).first()
    if (!row) {
      Event.dispatch(new CacheMiss(key))
      return resolveDefault(defaultValue)
    }
    if (row.expiration && row.expiration <= Math.floor(Date.now() / 1000)) {
      await DB.table(table).where('key', rKey).delete()
      Event.dispatch(new CacheMiss(key))
      return resolveDefault(defaultValue)
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

  async missing(key: string): Promise<boolean> {
    return !(await this.has(key))
  }

  async add(key: string, value: any, ttlSeconds?: number): Promise<boolean> {
    if (await this.has(key)) return false
    try {
      const table = this.getTable()
      const rKey = this.rawKey(key)
      const rawVal = JSON.stringify(value)
      const expiration = ttlSeconds ? Math.floor(Date.now() / 1000) + ttlSeconds : null

      await DB.table(table).insert({
        key: rKey,
        value: rawVal,
        expiration
      })
      Event.dispatch(new KeyWritten(key, value, ttlSeconds))
      return true
    } catch (error: any) {
      const msg = error.message || String(error)
      if (
        msg.includes('UNIQUE') ||
        msg.includes('constraint') ||
        msg.includes('duplicate') ||
        msg.includes('primary') ||
        msg.includes('PK') ||
        error.code === 'SQLITE_CONSTRAINT' ||
        error.code === '23505'
      ) {
        return false
      }
      throw error
    }
  }

  async pull<T = any>(key: string, defaultValue?: T | (() => T | Promise<T>)): Promise<T | undefined> {
    const value = await this.get<T>(key, defaultValue)
    await this.forget(key)
    return value
  }

  async sear<T>(key: string, callback: () => T | Promise<T>): Promise<T> {
    return this.rememberForever(key, callback)
  }

  async flexible<T>(key: string, ttls: [number, number], callback: () => T | Promise<T>): Promise<T> {
    return this.remember(key, ttls[1], callback)
  }

  async many(keys: string[]): Promise<Record<string, any>> {
    const pairs = await Promise.all(keys.map(async key => [key, await this.get(key)]))
    return Object.fromEntries(pairs)
  }

  async putMany(values: Record<string, any>, ttlSeconds?: number): Promise<void> {
    await Promise.all(Object.entries(values).map(([key, value]) => this.put(key, value, ttlSeconds)))
  }

  async getMultiple(keys: Iterable<string>): Promise<Record<string, any>> {
    return this.many([...keys])
  }

  async setMultiple(values: Iterable<[string, any]> | Record<string, any>, ttlSeconds?: number): Promise<void> {
    return this.putMany(iterableToRecord(values), ttlSeconds)
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
    return new TaggedCache(this, tags)
  }

  lock(name: string, seconds = 10, owner: string = randomUUID()): CacheLock {
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
  async rawGet<T = any>(rawKey: string): Promise<T | undefined> { return this.get(rawKey) }
  async rawPut(rawKey: string, value: any, ttlSeconds?: number, tags: string[] = []): Promise<void> {
    await this.put(rawKey, value, ttlSeconds)
    for (const tag of tags.map(normalizeKey).filter(Boolean)) {
      const bucket = this.tagIndex.get(tag) ?? new Set<string>()
      bucket.add(rawKey)
      this.tagIndex.set(tag, bucket)
    }
  }
  async rawForget(rawKey: string): Promise<void> {
    await this.forget(rawKey)
    for (const bucket of this.tagIndex.values()) bucket.delete(rawKey)
  }
  async rawHas(rawKey: string): Promise<boolean> { return this.has(rawKey) }
  supportsTags(): boolean { return true }
  async flushTags(tags: string[]) {
    const keys = new Set<string>()
    for (const tag of tags.map(normalizeKey).filter(Boolean)) {
      for (const key of this.tagIndex.get(tag) ?? []) keys.add(key)
    }
    for (const key of keys) await this.rawForget(key)
  }
  async prune(): Promise<number> {
    const table = this.getTable()
    const deleted = await DB.table(table).where('expiration', '<=', Math.floor(Date.now() / 1000)).delete().catch(() => 0)
    return Number(deleted ?? 0)
  }
}

export class TaggedCache {
  constructor(private readonly store: CacheStore, private readonly tagsList: string[]) {}

  get<T = any>(key: string) {
    return this.store.rawGet<T>((this.store as any).taggedKey(key, this.tagsList))
  }

  put(key: string, value: any, ttlSeconds?: number) {
    this.store.rawPut((this.store as any).taggedKey(key, this.tagsList), value, ttlSeconds, this.tagsList)
  }

  forever(key: string, value: any) {
    this.put(key, value)
  }

  forget(key: string) {
    this.store.rawForget((this.store as any).taggedKey(key, this.tagsList))
  }

  flush() {
    if (typeof (this.store as any).flushTagged === 'function') return (this.store as any).flushTagged(this.tagsList)
    throw new Error('This cache store does not support tag flushing.')
  }

  has(key: string) {
    return this.get(key) !== undefined
  }

  remember<T>(key: string, ttlSeconds: number, callback: () => T | Promise<T>) {
    return this.store.remember((this.store as any).taggedKey(key, this.tagsList), ttlSeconds, callback)
  }

  rememberForever<T>(key: string, callback: () => T | Promise<T>) {
    return this.store.rememberForever((this.store as any).taggedKey(key, this.tagsList), callback)
  }

  lock(name: string, seconds = 10, owner: string = randomUUID()) {
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

  ownerToken() {
    return this.owner
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

  lock(name: string, seconds = 10, owner: string = randomUUID()) {
    return this.store().lock(name, seconds, owner)
  }

  restoreLock(name: string, owner: string) {
    return this.lock(name, 0, owner)
  }

  async add(key: string, value: any, ttlSeconds?: number) {
    return this.store().add(key, value, ttlSeconds)
  }

  async pull<T = any>(key: string, defaultValue?: T | (() => T | Promise<T>)) {
    return this.store().pull<T>(key, defaultValue)
  }

  async sear<T>(key: string, callback: () => T | Promise<T>) {
    return this.store().sear(key, callback)
  }

  async flexible<T>(key: string, ttls: [number, number], callback: () => T | Promise<T>) {
    return this.store().flexible(key, ttls, callback)
  }

  async missing(key: string) {
    return this.store().missing(key)
  }

  async getMultiple(keys: Iterable<string>) {
    return this.store().getMultiple(keys)
  }

  async setMultiple(values: Iterable<[string, any]> | Record<string, any>, ttlSeconds?: number) {
    return this.store().setMultiple(values, ttlSeconds)
  }

  async prune() {
    return this.store().prune()
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
    if (store.driver === 'array') return new MemoryCacheStore(name, this, store)
    if (store.driver === 'null') return new NullCacheStore(name, this, store)
    if (store.driver === 'memcached' || store.driver === 'dynamodb') return new MemoryCacheStore(name, this, store)
    if (store.driver === 'memo') return new MemoryCacheStore(name, this, store)
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

function resolveDefault<T>(defaultValue?: T | (() => T | Promise<T>)) {
  return typeof defaultValue === 'function' ? (defaultValue as () => T | Promise<T>)() : defaultValue
}

function iterableToRecord(values: Iterable<[string, any]> | Record<string, any>) {
  if (Symbol.iterator in Object(values)) return Object.fromEntries(values as Iterable<[string, any]>)
  return values as Record<string, any>
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
