import { MacroRegistry, proxyMacros } from '@lib/support/Macroable.js'
import { randomBytes, randomUUID } from 'node:crypto'

export class FluentString {
  private static macros = new MacroRegistry()
  static macro(name: string, callback: (...args: any[]) => any) { this.macros.macro(name, callback) }
  static flushMacros() { this.macros.flushMacros() }
  constructor(private value: string) { return proxyMacros(this, FluentString.macros) }
  toString() { return this.value }
  valueOf() { return this.value }
  lower() { return str(this.value.toLowerCase()) }
  upper() { return str(this.value.toUpperCase()) }
  title() { return str(this.value.replace(/\w\S*/g, word => word[0].toUpperCase() + word.slice(1).toLowerCase())) }
  camel() { return str(this.value.replace(/[-_\s]+(.)?/g, (_m, chr) => chr ? chr.toUpperCase() : '').replace(/^./, chr => chr.toLowerCase())) }
  snake(delimiter = '_') { return str(this.value.replace(/[A-Z]/g, letter => `${delimiter}${letter.toLowerCase()}`).replace(/[-\s]+/g, delimiter).replace(new RegExp(`^${delimiter}+`), '')) }
  kebab() { return this.snake('-') }
  slug(separator = '-') { return str(this.value.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, separator)) }
  studly() { return str(this.camel().toString().replace(/^./, chr => chr.toUpperCase())) }
  before(search: string) { const index = this.value.indexOf(search); return str(index >= 0 ? this.value.slice(0, index) : this.value) }
  after(search: string) { const index = this.value.indexOf(search); return str(index >= 0 ? this.value.slice(index + search.length) : this.value) }
  contains(search: string | string[]) { return (Array.isArray(search) ? search : [search]).some(item => this.value.includes(item)) }
  startsWith(search: string | string[]) { return (Array.isArray(search) ? search : [search]).some(item => this.value.startsWith(item)) }
  endsWith(search: string | string[]) { return (Array.isArray(search) ? search : [search]).some(item => this.value.endsWith(item)) }
  replace(search: string | RegExp, replacement: string) { return str(this.value.replace(search as any, replacement)) }
  append(...values: string[]) { return str(this.value + values.join('')) }
  prepend(...values: string[]) { return str(values.join('') + this.value) }
  trim(chars?: string) { return str(chars ? this.value.replace(new RegExp(`^[${escapeRegExp(chars)}]+|[${escapeRegExp(chars)}]+$`, 'g'), '') : this.value.trim()) }
  limit(limit = 100, end = '...') { return str(this.value.length <= limit ? this.value : this.value.slice(0, limit) + end) }
}

export const Str = {
  of: (value: any) => str(value),
  lower: (value: string) => value.toLowerCase(),
  upper: (value: string) => value.toUpperCase(),
  camel: (value: string) => str(value).camel().toString(),
  snake: (value: string, delimiter = '_') => str(value).snake(delimiter).toString(),
  kebab: (value: string) => str(value).kebab().toString(),
  slug: (value: string, separator = '-') => str(value).slug(separator).toString(),
  uuid: () => randomUUID(),
  random: (length = 16) => Array.from(randomBytes(length), byte => (byte % 36).toString(36)).join(''),
  macro: (name: string, callback: (...args: any[]) => any) => FluentString.macro(name, callback),
  flushMacros: () => FluentString.flushMacros()
}

export function str(value: any = '') {
  return new FluentString(String(value))
}

export const Arr = {
  get(object: any, key: string, defaultValue?: any) {
    return key.split('.').reduce((carry, segment) => carry?.[segment], object) ?? defaultValue
  },
  set(object: any, key: string, value: any) {
    const segments = key.split('.')
    let current = object
    while (segments.length > 1) current = current[segments.shift()!] ??= {}
    current[segments[0]] = value
    return object
  },
  has(object: any, key: string) {
    return Arr.get(object, key) !== undefined
  },
  forget(object: any, key: string) {
    const segments = key.split('.')
    let current = object
    while (segments.length > 1) current = current?.[segments.shift()!]
    if (current) delete current[segments[0]]
    return object
  },
  only(object: any, keys: string[]) {
    return Object.fromEntries(keys.filter(key => key in object).map(key => [key, object[key]]))
  },
  except(object: any, keys: string[]) {
    return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)))
  },
  wrap(value: any) { return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value] },
  flatten(value: any[], depth = Infinity) { return value.flat(depth) }
}

export const Obj = {
  get: Arr.get,
  set: Arr.set,
  has: Arr.has,
  only: Arr.only,
  except: Arr.except
}

export class Uri {
  private url: URL
  constructor(value: string, base = 'http://localhost') { this.url = new URL(value, base) }
  static of(value: string, base?: string) { return new Uri(value, base) }
  path(pathname: string) { this.url.pathname = pathname; return this }
  query(values: Record<string, any>) { for (const [key, value] of Object.entries(values)) this.url.searchParams.set(key, String(value)); return this }
  withQuery(key: string, value: any) { this.url.searchParams.set(key, String(value)); return this }
  withoutQuery(...keys: string[]) { for (const key of keys) this.url.searchParams.delete(key); return this }
  fragment(value: string) { this.url.hash = value; return this }
  toString() { return this.url.toString() }
}

export const NumberHelper = {
  format(value: number, options: Intl.NumberFormatOptions = {}, locale = 'en') { return new Intl.NumberFormat(locale, options).format(value) },
  currency(value: number, currency = 'USD', locale = 'en') { return this.format(value, { style: 'currency', currency }, locale) },
  percentage(value: number, precision = 0, locale = 'en') { return this.format(value, { style: 'percent', maximumFractionDigits: precision }, locale) },
  fileSize(bytes: number, precision = 1) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
    return `${value.toFixed(unit === 0 ? 0 : precision)} ${units[unit]}`
  }
}

export { NumberHelper as Number }

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
