import type { Request } from '@lib/http/Request.js'

export class RateLimit {
  public max: number
  public windowSeconds: number
  public key: string = ''
  public unlimited = false
  public responseCallback?: (request: Request, headers: Record<string, number>) => any

  constructor(max: number, windowSeconds: number) {
    this.max = max
    this.windowSeconds = windowSeconds
  }

  static perMinute(max: number) {
    return new RateLimit(max, 60)
  }

  static perHour(max: number) {
    return new RateLimit(max, 3600)
  }

  static perDay(max: number) {
    return new RateLimit(max, 86400)
  }

  static perSecond(max: number) {
    return new RateLimit(max, 1)
  }

  static per(seconds: number, max: number) {
    return new RateLimit(max, seconds)
  }

  static none() {
    const limit = new RateLimit(Number.POSITIVE_INFINITY, 0)
    limit.unlimited = true
    return limit
  }

  by(key: string) {
    this.key = key
    return this
  }

  response(callback: (request: Request, headers: Record<string, number>) => any) {
    this.responseCallback = callback
    return this
  }
}

export const Limit = RateLimit

export class RateLimiterManager {
  private get limiters(): Map<string, (request: Request) => RateLimit | RateLimit[] | null | undefined> {
    const globalKey = '__maxima_rate_limiters'
    ;(global as any)[globalKey] ??= new Map()
    return (global as any)[globalKey]
  }

  for(name: string, callback: (request: Request) => RateLimit | RateLimit[] | null | undefined) {
    this.limiters.set(name, callback)
    return this
  }

  get(name: string) {
    return this.limiters.get(name)
  }

  clear() {
    this.limiters.clear()
  }

  async hit(key: string, decaySeconds = 60, amount = 1) {
    const { Cache } = await import('@lib/cache/Cache.js')
    const now = Math.floor(Date.now() / 1000)
    let data = await Cache.get<{ count: number, resetAt: number }>(this.cacheKey(key))
    if (!data || data.resetAt <= now) data = { count: 0, resetAt: now + decaySeconds }
    data.count += amount
    await Cache.put(this.cacheKey(key), data, Math.max(1, data.resetAt - now))
    return data.count
  }

  async attempts(key: string) {
    const { Cache } = await import('@lib/cache/Cache.js')
    return (await Cache.get<{ count: number }>(this.cacheKey(key)))?.count ?? 0
  }

  async tooManyAttempts(key: string, maxAttempts: number) {
    return (await this.attempts(key)) >= maxAttempts
  }

  async remaining(key: string, maxAttempts: number) {
    return Math.max(0, maxAttempts - await this.attempts(key))
  }

  async availableIn(key: string) {
    const { Cache } = await import('@lib/cache/Cache.js')
    const resetAt = (await Cache.get<{ resetAt: number }>(this.cacheKey(key)))?.resetAt ?? Math.floor(Date.now() / 1000)
    return Math.max(0, resetAt - Math.floor(Date.now() / 1000))
  }

  async resetAttempts(key: string) {
    return this.clearAttempts(key)
  }

  async clearAttempts(key: string) {
    const { Cache } = await import('@lib/cache/Cache.js')
    await Cache.forget(this.cacheKey(key))
  }

  async reset(key: string) {
    return this.clearAttempts(key)
  }

  private cacheKey(key: string) {
    return `rate-limiter:${key}`
  }
}

export const RateLimiter = new RateLimiterManager()
