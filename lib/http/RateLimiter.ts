import type { Request } from '@lib/http/Request.js'

export class RateLimit {
  public max: number
  public windowSeconds: number
  public key: string = ''

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

  static perSecond(max: number) {
    return new RateLimit(max, 1)
  }

  static per(seconds: number, max: number) {
    return new RateLimit(max, seconds)
  }

  by(key: string) {
    this.key = key
    return this
  }
}

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
}

export const RateLimiter = new RateLimiterManager()
