import { MacroRegistry, proxyMacros } from '@lib/support/Macroable.js'

type RequestMiddleware = (request: PendingRequest, next: () => Promise<HttpClientResponse>) => Promise<HttpClientResponse>
type FakeResponse = HttpClientResponse | Record<string, any> | string | ((url: string, init: RequestInit) => FakeResponse | Promise<FakeResponse>)
type FakePattern = { pattern: string, regex?: RegExp, response: FakeResponse }
const noFakeResponse = Symbol('noFakeResponse')

export class HttpClientResponse {
  constructor(public statusCode: number, private body: string, public headers: Headers = new Headers()) {}
  ok() { return this.statusCode >= 200 && this.statusCode < 300 }
  successful() { return this.ok() }
  failed() { return !this.ok() }
  clientError() { return this.statusCode >= 400 && this.statusCode < 500 }
  serverError() { return this.statusCode >= 500 }
  status() { return this.statusCode }
  bodyText() { return this.body }
  text() { return this.body }
  json<T = any>() { return this.body ? JSON.parse(this.body) as T : null as T }
  object<T = any>() { return this.json<T>() }
  header(name: string) { return this.headers.get(name) }
  throw() { if (this.failed()) throw new Error(`HTTP request failed with status ${this.statusCode}.`); return this }
}

export class ResponseSequence {
  private responses: FakeResponse[] = []
  private emptyResponse: FakeResponse = new HttpClientResponse(404, '')
  push(response: FakeResponse, status = 200) { this.responses.push(typeof response === 'function' ? response : normalizeFake(response, status)); return this }
  pushStatus(status: number) { return this.push('', status) }
  whenEmpty(response: FakeResponse) { this.emptyResponse = response; return this }
  async next(url: string, init: RequestInit) {
    const response = this.responses.shift() ?? this.emptyResponse
    return normalizeFake(typeof response === 'function' ? await response(url, init) : response, 200, url, init)
  }
}

export class PendingRequest {
  private base = ''
  private headerBag: Record<string, string> = {}
  private requestOptions: RequestInit = {}
  private retries = 0
  private retryDelay = 0
  private timeoutMs?: number
  private middleware: RequestMiddleware[] = []

  constructor(private manager: HttpClientManager) {
    return proxyMacros(this, HttpClientManager.macros)
  }

  baseUrl(url: string) { this.base = url; return this }
  withHeaders(headers: Record<string, string>) { this.headerBag = { ...this.headerBag, ...headers }; return this }
  accept(value: string) { return this.withHeaders({ Accept: value }) }
  asJson() { return this.accept('application/json').withHeaders({ 'Content-Type': 'application/json' }) }
  withToken(token: string, type = 'Bearer') { return this.withHeaders({ Authorization: `${type} ${token}` }) }
  withBasicAuth(username: string, password: string) { return this.withHeaders({ Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }) }
  timeout(seconds: number) { this.timeoutMs = seconds * 1000; return this }
  retry(times: number, sleepMilliseconds = 0) { this.retries = times; this.retryDelay = sleepMilliseconds; return this }
  withOptions(options: RequestInit) { this.requestOptions = { ...this.requestOptions, ...options }; return this }
  withMiddleware(middleware: RequestMiddleware) { this.middleware.push(middleware); return this }

  async get(url: string, query?: Record<string, any>) { return this.send('GET', url, undefined, query) }
  async post(url: string, data?: any) { return this.send('POST', url, data) }
  async put(url: string, data?: any) { return this.send('PUT', url, data) }
  async patch(url: string, data?: any) { return this.send('PATCH', url, data) }
  async delete(url: string, data?: any) { return this.send('DELETE', url, data) }
  async pool(callback: (pool: { as(name: string): PendingRequest }) => void) {
    const requests: Record<string, Promise<HttpClientResponse>> = {}
    callback({ as: name => this.cloneForPool(requests, name) })
    const entries = await Promise.all(Object.entries(requests).map(async ([name, promise]) => [name, await promise]))
    return Object.fromEntries(entries)
  }

  async send(method: string, url: string, data?: any, query?: Record<string, any>) {
    const target = this.url(url, query)
    const init = this.init(method, data)
    const execute = async () => this.manager.dispatch(target, init)
    const pipeline = this.middleware.reduceRight((next, mw) => () => mw(this, next), execute)
    let attempt = 0
    while (true) {
      const response = await pipeline()
      if (response.successful() || attempt++ >= this.retries) return response
      if (this.retryDelay) await new Promise(resolve => setTimeout(resolve, this.retryDelay))
    }
  }

  private url(url: string, query?: Record<string, any>) {
    const resolved = new URL(url, this.base || undefined)
    for (const [key, value] of Object.entries(query ?? {})) resolved.searchParams.set(key, String(value))
    return resolved.toString()
  }

  private init(method: string, data?: any) {
    const controller = this.timeoutMs ? new AbortController() : undefined
    const timeout = this.timeoutMs ? setTimeout(() => controller!.abort(), this.timeoutMs) : undefined
    return {
      ...this.requestOptions,
      method,
      signal: controller?.signal,
      timeout,
      headers: { ...this.headerBag, ...(this.requestOptions.headers as any ?? {}) },
      body: data === undefined ? undefined : typeof data === 'string' || data instanceof FormData ? data : JSON.stringify(data)
    } as RequestInit
  }

  private cloneForPool(requests: Record<string, Promise<HttpClientResponse>>, name: string) {
    const clone = new PendingRequest(this.manager)
      .baseUrl(this.base)
      .withHeaders(this.headerBag)
      .withOptions(this.requestOptions)
    if (this.timeoutMs) clone.timeout(this.timeoutMs / 1000)
    clone.retry(this.retries, this.retryDelay)
    for (const item of this.middleware) clone.withMiddleware(item)
    return new Proxy(clone, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver)
        if (['get', 'post', 'put', 'patch', 'delete', 'send'].includes(String(property))) {
          return (...args: any[]) => {
            const promise = value.apply(target, args)
            requests[name] = promise
            return promise
          }
        }
        return value
      }
    })
  }
}

export class HttpClientManager {
  static macros = new MacroRegistry()
  private fakePatterns: FakePattern[] = []
  private records: Array<{ url: string, init: RequestInit }> = []

  static macro(name: string, callback: (...args: any[]) => any) { this.macros.macro(name, callback) }
  static flushMacros() { this.macros.flushMacros() }
  macro(name: string, callback: (...args: any[]) => any) { HttpClientManager.macro(name, callback) }
  flushMacros() { HttpClientManager.flushMacros() }

  baseUrl(url: string) { return this.pending().baseUrl(url) }
  withHeaders(headers: Record<string, string>) { return this.pending().withHeaders(headers) }
  accept(value: string) { return this.pending().accept(value) }
  asJson() { return this.pending().asJson() }
  withToken(token: string, type?: string) { return this.pending().withToken(token, type) }
  withBasicAuth(username: string, password: string) { return this.pending().withBasicAuth(username, password) }
  timeout(seconds: number) { return this.pending().timeout(seconds) }
  retry(times: number, sleepMilliseconds = 0) { return this.pending().retry(times, sleepMilliseconds) }
  withOptions(options: RequestInit) { return this.pending().withOptions(options) }
  withMiddleware(middleware: RequestMiddleware) { return this.pending().withMiddleware(middleware) }
  async get(url: string, query?: Record<string, any>) { return this.pending().get(url, query) }
  async post(url: string, data?: any) { return this.pending().post(url, data) }
  async put(url: string, data?: any) { return this.pending().put(url, data) }
  async patch(url: string, data?: any) { return this.pending().patch(url, data) }
  async delete(url: string, data?: any) { return this.pending().delete(url, data) }
  async send(method: string, url: string, data?: any, query?: Record<string, any>) { return this.pending().send(method, url, data, query) }
  async pool(callback: (pool: { as(name: string): PendingRequest }) => void) {
    return this.pending().pool(callback)
  }

  fake(patterns: Record<string, FakeResponse> = { '*': new HttpClientResponse(200, '') }) {
    this.fakePatterns = Object.entries(patterns).map(([pattern, response]) => ({
      pattern,
      response,
      regex: pattern === '*' ? undefined : new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`)
    }))
    this.records = []
  }
  sequence() { return new ResponseSequence() }
  restore() { this.fakePatterns = []; this.records = [] }
  assertSent(predicate: (request: { url: string, method: string, headers: Headers }) => boolean) {
    if (!this.records.some(record => predicate({ url: record.url, method: String(record.init.method ?? 'GET'), headers: new Headers(record.init.headers as any) }))) {
      throw new Error('Expected HTTP request was not sent.')
    }
  }
  assertNothingSent() { if (this.records.length) throw new Error('Expected no HTTP requests to be sent.') }
  recorded() { return [...this.records] }

  pending() { return new PendingRequest(this) }

  async dispatch(url: string, init: RequestInit) {
    const timeout = (init as any).timeout as NodeJS.Timeout | undefined
    const requestInit = { ...init }
    delete (requestInit as any).timeout
    this.records.push({ url, init: requestInit })
    try {
      const fake = this.matchFake(url)
      if (fake !== noFakeResponse) return normalizeFake(typeof fake === 'function' ? await fake(url, requestInit) : fake, 200, url, requestInit)
      const response = await fetch(url, requestInit)
      return new HttpClientResponse(response.status, await response.text(), response.headers)
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private matchFake(url: string) {
    for (const fake of this.fakePatterns) {
      if (fake.pattern === '*' || fake.regex!.test(url)) return fake.response
    }
    return noFakeResponse
  }
}

export const Http = new HttpClientManager()

function normalizeFake(response: FakeResponse, status = 200, url = '', init: RequestInit = {}): any {
  if (response instanceof ResponseSequence) return response.next(url, init)
  if (response instanceof HttpClientResponse) return response
  if (typeof response === 'string') return new HttpClientResponse(status, response)
  return new HttpClientResponse(status, JSON.stringify(response), new Headers({ 'Content-Type': 'application/json' }))
}
