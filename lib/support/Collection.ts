import { MacroRegistry, proxyMacros } from '@lib/support/Macroable.js'

type KeySelector<T> = keyof T | ((item: T) => any)

export class Collection<T = any> implements Iterable<T> {
  private static macros = new MacroRegistry()

  static make<T = any>(items: Iterable<T> | Record<string, T> = []) {
    return collect(items)
  }

  static macro(name: string, callback: (...args: any[]) => any) { this.macros.macro(name, callback) }
  static flushMacros() { this.macros.flushMacros() }

  constructor(protected items: T[] = []) {
    return proxyMacros(this, (this.constructor as typeof Collection).macros)
  }

  [Symbol.iterator]() { return this.items[Symbol.iterator]() }
  all() { return [...this.items] }
  toArray() { return this.all() }
  count() { return this.items.length }
  isEmpty() { return this.items.length === 0 }
  isNotEmpty() { return !this.isEmpty() }
  first(predicate?: (item: T, index: number) => boolean, defaultValue?: any) {
    if (!predicate) return this.items[0] ?? defaultValue
    return this.items.find(predicate) ?? defaultValue
  }
  last(predicate?: (item: T, index: number) => boolean, defaultValue?: any) {
    const list = predicate ? this.items.filter(predicate) : this.items
    return list[list.length - 1] ?? defaultValue
  }
  get(index: number, defaultValue?: any) { return this.items[index] ?? defaultValue }
  map<U>(callback: (item: T, index: number) => U) { return collect(this.items.map(callback)) }
  mapProperty(key: KeySelector<T>) { return this.pluck(key) }
  higher(operation: 'map' | 'filter' | 'reject' = 'map') {
    return new Proxy({}, {
      get: (_target, property) => {
        const key = String(property)
        if (operation === 'map') return this.map(item => typeof (item as any)?.[key] === 'function' ? (item as any)[key]() : (item as any)?.[key])
        if (operation === 'filter') return this.filter(item => Boolean(typeof (item as any)?.[key] === 'function' ? (item as any)[key]() : (item as any)?.[key]))
        return this.reject(item => Boolean(typeof (item as any)?.[key] === 'function' ? (item as any)[key]() : (item as any)?.[key]))
      }
    })
  }
  filter(callback: (item: T, index: number) => boolean = Boolean as any) { return collect(this.items.filter(callback)) }
  reject(callback: (item: T, index: number) => boolean) { return this.filter((item, index) => !callback(item, index)) }
  each(callback: (item: T, index: number) => unknown) { this.items.forEach(callback); return this }
  reduce<U>(callback: (carry: U, item: T, index: number) => U, initial: U) { return this.items.reduce(callback, initial) }
  pluck(key: KeySelector<T>) { return collect(this.items.map(item => valueFor(item, key))) }
  keys() { return collect(this.items.map((_item, index) => index)) }
  values() { return collect(this.items) }
  push(...items: T[]) { this.items.push(...items); return this }
  pop() { return this.items.pop() }
  shift() { return this.items.shift() }
  prepend(item: T) { this.items.unshift(item); return this }
  merge(items: Iterable<T> | Record<string, T>) { return collect([...this.items, ...normalizeItems(items)]) }
  unique(key?: KeySelector<T>) {
    const seen = new Set<any>()
    return this.filter(item => {
      const value = key ? valueFor(item, key) : item
      if (seen.has(value)) return false
      seen.add(value)
      return true
    })
  }
  groupBy(key: KeySelector<T>) {
    return this.items.reduce((groups, item) => {
      const group = String(valueFor(item, key))
      ;(groups[group] ??= []).push(item)
      return groups
    }, {} as Record<string, T[]>)
  }
  keyBy(key: KeySelector<T>) {
    return this.items.reduce((result, item) => ({ ...result, [String(valueFor(item, key))]: item }), {} as Record<string, T>)
  }
  sortBy(key: KeySelector<T>) {
    return collect([...this.items].sort((a, b) => compare(valueFor(a, key), valueFor(b, key))))
  }
  take(count: number) { return collect(count >= 0 ? this.items.slice(0, count) : this.items.slice(count)) }
  skip(count: number) { return collect(this.items.slice(count)) }
  chunk(size: number) {
    const chunks: T[][] = []
    for (let index = 0; index < this.items.length; index += size) chunks.push(this.items.slice(index, index + size))
    return collect(chunks)
  }
  flatten(depth = Infinity): Collection<any> { return collect(this.items.flat(depth)) }
  contains(value: T | ((item: T) => boolean)) { return typeof value === 'function' ? this.items.some(value as any) : this.items.includes(value) }
  sum(key?: KeySelector<T>) { return this.items.reduce((sum, item) => sum + Number(key ? valueFor(item, key) : item), 0) }
  avg(key?: KeySelector<T>) { return this.count() ? this.sum(key) / this.count() : null }
  min(key?: KeySelector<T>) { return Math.min(...this.items.map(item => Number(key ? valueFor(item, key) : item))) }
  max(key?: KeySelector<T>) { return Math.max(...this.items.map(item => Number(key ? valueFor(item, key) : item))) }
  partition(callback: (item: T) => boolean) { return [this.filter(callback), this.reject(callback)] as const }
  when(condition: any, callback: (collection: this) => any, defaultCallback?: (collection: this) => any) {
    if (condition) callback(this)
    else defaultCallback?.(this)
    return this
  }
  unless(condition: any, callback: (collection: this) => any, defaultCallback?: (collection: this) => any) {
    return this.when(!condition, callback, defaultCallback)
  }
  tap(callback: (collection: this) => unknown) { callback(this); return this }
}

export class LazyCollection<T = any> implements AsyncIterable<T> {
  constructor(private source: Iterable<T> | AsyncIterable<T>) {}
  static make<T>(source: Iterable<T> | AsyncIterable<T>) { return new LazyCollection(source) }
  async *[Symbol.asyncIterator]() { yield* this.source as any }
  map<U>(callback: (item: T) => U | Promise<U>) { return new LazyCollection(mapAsync(this.source, callback)) }
  filter(callback: (item: T) => boolean | Promise<boolean>) { return new LazyCollection(filterAsync(this.source, callback)) }
  take(count: number) { return new LazyCollection(takeAsync(this.source, count)) }
  async all() {
    const items: T[] = []
    for await (const item of this.source as any) items.push(item)
    return items
  }
  async collect() { return collect(await this.all()) }
}

export function collect<T = any>(items: Iterable<T> | Record<string, T> = []) {
  return new Collection(normalizeItems(items))
}

function normalizeItems<T>(items: Iterable<T> | Record<string, T>) {
  if (items && typeof (items as any)[Symbol.iterator] === 'function') return [...items as Iterable<T>]
  return Object.values(items ?? {})
}

function valueFor(item: any, key: any) {
  return typeof key === 'function' ? key(item) : item?.[key]
}

function compare(a: any, b: any) {
  if (a === b) return 0
  return a > b ? 1 : -1
}

async function *mapAsync<T, U>(source: Iterable<T> | AsyncIterable<T>, callback: (item: T) => U | Promise<U>) {
  for await (const item of source as any) yield callback(item)
}

async function *filterAsync<T>(source: Iterable<T> | AsyncIterable<T>, callback: (item: T) => boolean | Promise<boolean>) {
  for await (const item of source as any) if (await callback(item)) yield item
}

async function *takeAsync<T>(source: Iterable<T> | AsyncIterable<T>, count: number) {
  let index = 0
  for await (const item of source as any) {
    if (index++ >= count) break
    yield item
  }
}
