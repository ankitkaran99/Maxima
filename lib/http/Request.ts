import type { FastifyReply, FastifyRequest } from 'fastify'
import { config } from '@lib/foundation/helpers.js'
import { Validator, type ValidationRules } from '@lib/validation/Validator.js'

export class Request {
  [key: string]: any

  private static macros = new Map<string, Function>()
  private validatedData?: Record<string, unknown>
  private validationErrors?: Record<string, string[]>
  private validationErrorBags?: Record<string, Record<string, string[]>>

  constructor(public readonly raw: FastifyRequest, public readonly reply: FastifyReply) {
    return new Proxy(this, {
      get(target, property, receiver) {
        if (typeof property === 'string' && Request.macros.has(property)) {
          return (...args: unknown[]) => Request.macros.get(property)!.apply(receiver, args)
        }

        return Reflect.get(target, property, receiver)
      }
    })
  }

  static macro(name: string, callback: Function) {
    this.macros.set(name, callback)
  }

  static hasMacro(name: string) {
    return this.macros.has(name)
  }

  static flushMacros() {
    this.macros.clear()
  }

  get body() { return (this.raw.body ?? {}) as Record<string, any> }
  get params() { return (this.raw.params ?? {}) as Record<string, any> }
  get query() { return (this.raw.query ?? {}) as Record<string, any> }
  get headers() { return this.raw.headers }
  get log() { return (this.raw as any).log }
  get session() { return (this.raw as any).session }

  user() {
    return (this.raw as any).user
  }

  input<T = unknown>(key: string, defaultValue?: T): T {
    return (this.body[key] ?? this.query[key] ?? this.params[key] ?? defaultValue) as T
  }

  all() {
    return { ...this.params, ...this.query, ...this.body }
  }

  merge(values: Record<string, unknown>) {
    Object.assign(this.body, values)
  }

  only(keys: string[]) {
    const input = this.all()
    return Object.fromEntries(keys.filter(key => key in input).map(key => [key, input[key]]))
  }

  except(keys: string[]) {
    return Object.fromEntries(Object.entries(this.all()).filter(([key]) => !keys.includes(key)))
  }

  boolean(key: string) {
    const value = this.input<any>(key)
    return value === true || value === 'true' || value === '1' || value === 1 || value === 'on'
  }

  integer(key: string) {
    const value = this.input<any>(key)
    return value === undefined ? undefined : Number.parseInt(value, 10)
  }

  float(key: string) {
    const value = this.input<any>(key)
    return value === undefined ? undefined : Number.parseFloat(value)
  }

  date(key: string) {
    const value = this.input<any>(key)
    return value ? new Date(value) : undefined
  }

  array<T = unknown>(key: string) {
    const value = this.input<any>(key)
    return Array.isArray(value) ? value as T[] : value === undefined ? [] : [value] as T[]
  }

  enum<T>(key: string, values: EnumSource<T>, defaultValue?: T) {
    const value = this.input<any>(key)
    if (value === undefined || value === null || value === '') return defaultValue
    return enumValues(values).find(candidate => candidate === value || String(candidate) === String(value)) ?? defaultValue
  }

  enums<T>(key: string, values: EnumSource<T>) {
    return this.array(key)
      .map(value => enumValues(values).find(candidate => candidate === value || String(candidate) === String(value)))
      .filter((value): value is T => value !== undefined)
  }

  file(key: string) {
    const source = normalizeFiles({ ...(this.raw as any).files, ...(this.raw as any).file })
    return getNestedValue(source, key)
  }

  files(key: string) {
    const value = this.file(key)
    if (value === undefined || value === null) return []
    return flattenFiles(value)
  }

  flash() {
    this.session?.flash?.('_old_input', this.all())
  }

  flashOnly(keys: string[]) {
    this.session?.flash?.('_old_input', this.only(keys))
  }

  flashExcept(keys: string[]) {
    this.session?.flash?.('_old_input', this.except(keys))
  }

  old<T = unknown>(key?: string, defaultValue?: T) {
    const oldInput = this.session?.oldInput?.() ?? {}
    if (!key) return oldInput
    return ((oldInput as Record<string, unknown>)[key] ?? defaultValue) as T
  }

  flashErrors(errors: Record<string, string[]>, bag = 'default') {
    this.session?.flashErrors?.(errors, bag)
  }

  async validate<T extends Record<string, unknown> = Record<string, unknown>>(
    rules: ValidationRules,
    data: Record<string, any> = this.body,
    options = {}
  ) {
    const dataSet = await Validator.validate<T>(data, rules, options)
    this.setValidated(dataSet)
    return dataSet
  }

  setValidated(data: Record<string, unknown>) {
    this.validatedData = data
  }

  validated<T = Record<string, unknown>>() {
    return (this.validatedData ?? {}) as T
  }

  safe<T = Record<string, unknown>>() {
    return this.validated<T>()
  }

  setErrors(errors: Record<string, string[]>, bag = 'default') {
    this.validationErrors = errors
    this.validationErrorBags = { ...(this.validationErrorBags ?? {}), [bag]: errors }
  }

  setErrorBags(bags: Record<string, Record<string, string[]>>) {
    this.validationErrorBags = bags
    this.validationErrors = bags.default ?? {}
  }

  errors(bag?: string) {
    if (bag) return this.validationErrorBags?.[bag] ?? {}
    return this.validationErrors ?? {}
  }

  errorBags() {
    return this.validationErrorBags ?? {}
  }

  firstError(field: string, bag = 'default') {
    return this.errors(bag)[field]?.[0]
  }

  hasError(field: string, bag = 'default') {
    return Boolean(this.firstError(field, bag))
  }

  wantsJson(): boolean {
    const accept = (this.headers['accept'] as string) ?? ''
    return accept.includes('/json') || accept.includes('+json')
  }

  expectsJson(): boolean {
    return this.wantsJson() || this.ajax()
  }

  ajax(): boolean {
    return this.headers['x-requested-with'] === 'XMLHttpRequest'
  }

  method(): string {
    return this.raw.method
  }

  path(): string {
    const url = this.raw.url ?? ''
    const questionMarkIndex = url.indexOf('?')
    const p = questionMarkIndex === -1 ? url : url.slice(0, questionMarkIndex)
    return p || '/'
  }

  url(): string {
    const host = this.getHost()
    return `${this.getProtocol()}://${host}${this.path()}`
  }

  fullUrl(): string {
    const host = this.getHost()
    return `${this.getProtocol()}://${host}${this.raw.url}`
  }

  is(...patterns: string[]): boolean {
    const pathVal = this.path().replace(/^\/+|\/+$/g, '')
    for (const pattern of patterns) {
      const normalizedPattern = pattern.replace(/^\/+|\/+$/g, '')
      const regexPattern = '^' + normalizedPattern
        .replace(/\*/g, '.*')
        .replace(/\//g, '\\/') + '$'
      const regex = new RegExp(regexPattern)
      if (regex.test(pathVal)) {
        return true
      }
    }
    return false
  }

  ip(): string {
    if (!this.isFromTrustedProxy()) return this.raw.ip
    return firstHeaderValue(this.headers['x-forwarded-for']) ?? this.raw.ip
  }

  private getProtocol(): string {
    if (this.isFromTrustedProxy()) {
      const proto = firstHeaderValue(this.headers['x-forwarded-proto'])
      if (proto) return proto
    }
    return (this.raw.socket as any)?.encrypted ? 'https' : 'http'
  }

  private getHost(): string {
    if (this.isFromTrustedProxy()) {
      const host = firstHeaderValue(this.headers['x-forwarded-host'])
      if (host) return host
    }
    return (this.headers['host'] as string) ?? 'localhost'
  }

  private isFromTrustedProxy() {
    const trusted = config<TrustedProxyConfig>('http.trustedProxies', config<TrustedProxyConfig>('trustedProxies', []))
    return isTrustedProxy(this.raw.ip, trusted)
  }
}

type EnumSource<T> = readonly T[] | Record<string, T | string>
type TrustedProxyConfig = boolean | string | string[] | { proxies?: boolean | string | string[] }

function enumValues<T>(source: EnumSource<T>) {
  if (Array.isArray(source)) return source
  return Object.entries(source)
    .filter(([key]) => !/^\d+$/.test(key))
    .map(([, value]) => value as T)
}

function firstHeaderValue(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value
  return raw?.split(',')[0]?.trim()
}

function isTrustedProxy(ip: string, trusted: TrustedProxyConfig) {
  const proxies = typeof trusted === 'object' && !Array.isArray(trusted) ? trusted.proxies : trusted
  if (proxies === true || proxies === '*') return true
  const list = Array.isArray(proxies) ? proxies : typeof proxies === 'string' ? proxies.split(',') : []
  return list.map(proxy => proxy.trim()).filter(Boolean).some(proxy => proxy === ip || proxy === 'loopback' && isLoopback(ip))
}

function isLoopback(ip: string) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.')
}

function normalizeFiles(files: Record<string, unknown>) {
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(files)) {
    setNestedValue(normalized, parsePath(key), value)
  }
  return normalized
}

function parsePath(path: string) {
  const segments: string[] = []
  const pattern = /([^[.\]]+)|\[([^\]]*)]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(path))) {
    const segment = match[1] ?? match[2]
    if (segment !== '') segments.push(segment)
  }
  return segments.length ? segments : [path]
}

function getNestedValue(source: Record<string, unknown>, key: string) {
  let current: unknown = source
  for (const segment of parsePath(key)) {
    if (current === undefined || current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function setNestedValue(target: Record<string, unknown>, segments: string[], value: unknown) {
  let current: Record<string, unknown> = target
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      current[segment] = mergeFileValue(current[segment], value)
      return
    }
    if (!current[segment] || typeof current[segment] !== 'object') current[segment] = {}
    current = current[segment] as Record<string, unknown>
  }
}

function mergeFileValue(existing: unknown, value: unknown) {
  if (existing === undefined) return value
  return [...flattenFiles(existing), ...flattenFiles(value)]
}

function flattenFiles(value: unknown): any[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.flatMap(item => flattenFiles(item))
  if (isPlainFileMap(value)) return Object.values(value).flatMap(item => flattenFiles(item))
  return [value]
}

function isPlainFileMap(value: unknown) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !('filename' in value) &&
    !('mimetype' in value) &&
    !('file' in value) &&
    !('toBuffer' in value)
  )
}
