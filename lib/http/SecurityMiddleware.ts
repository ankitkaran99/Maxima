import type { FastifyReply } from 'fastify'
import crypto from 'node:crypto'
import type { Request } from '@lib/http/Request.js'
import type { Next } from '@lib/http/Middleware.js'
import { SessionManager, decodeCookie } from '@lib/session/Session.js'
import { config } from '@lib/foundation/helpers.js'

export class SessionAdapter {
  private flashes = new Map<string, unknown>()
  constructor(private backing: Record<string, any> = {}) {}
  get(key: string, defaultValue?: unknown) { return this.backing[key] ?? defaultValue }
  put(key: string, value: unknown) { this.backing[key] = value }
  forget(key: string) { delete this.backing[key] }
  flush() { for (const key of Object.keys(this.backing)) delete this.backing[key] }
  regenerate() { this.backing._session_id = crypto.randomUUID(); return this.backing._session_id }
  flash(key: string, value: unknown) { this.flashes.set(key, value) }
  oldInput() { return this.get('_old_input', {}) }
  errors() { return this.get('_errors', {}) }
}

export class CookieMiddleware {
  async handle(request: Request, _reply: FastifyReply, next: Next) {
    ;(request as any).cookie = (name: string, options: Record<string, any> = {}) => {
      const raw = (request.raw as any).cookies?.[name]
      const cookieConfig = config<Record<string, any>>('session.cookie', {})
      return decodeCookie(raw, { signed: options.signed ?? cookieConfig.signed, encrypted: options.encrypted ?? cookieConfig.encrypted })
    }
    return next()
  }
}

export class SessionMiddleware {
  private manager = new SessionManager()

  async handle(request: Request, reply: FastifyReply, next: Next) {
    const session = await this.manager.start(request, reply)
    ;(request.raw as any).session ??= session
    return next()
  }
}

export class CsrfMiddleware {
  async handle(request: Request, reply: FastifyReply, next: Next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.raw.method)) return next()
    const sessionToken = request.session?.get?.('_csrf') ?? ''
    const token = request.headers['x-csrf-token'] ?? request.body?._token
    if (sessionToken && token !== sessionToken) return reply.code(419).send({ message: 'CSRF token mismatch.' })
    return next()
  }
}

export class ThrottleMiddleware {
  async handle(request: Request, reply: FastifyReply, next: Next, parameter = 'api') {
    const { RateLimiter } = await import('@lib/http/RateLimiter.js')
    const limiterCallback = RateLimiter.get(parameter)

    if (limiterCallback) {
      let limits = limiterCallback(request)
      if (limits === null || limits === undefined) return next()
      if (!Array.isArray(limits)) {
        limits = [limits]
      }

      for (const limit of limits) {
        const max = limit.max
        const windowSeconds = limit.windowSeconds
        const key = limit.key || (request.user() ? `user:${request.user().id}` : `ip:${typeof request.ip === 'function' ? request.ip() : request.ip}`)
        const routeKey = request.raw.routeOptions?.url ?? request.raw.url
        const rawKey = `throttle:${parameter}:${key}:${routeKey}`

        const { Cache } = await import('@lib/cache/Cache.js')
        const now = Math.floor(Date.now() / 1000)
        let limitData = await Cache.get<{ count: number, resetAt: number }>(rawKey)

        if (!limitData || limitData.resetAt <= now) {
          limitData = { count: 0, resetAt: now + windowSeconds }
        }

        if (limitData.count >= max) {
          const retryAfter = limitData.resetAt - now
          reply.code(429)
          reply.header('Retry-After', retryAfter)
          reply.header('X-RateLimit-Limit', max)
          reply.header('X-RateLimit-Remaining', 0)
          return reply.send({ message: 'Too Many Attempts.' })
        }

        limitData.count += 1
        const ttl = limitData.resetAt - now
        await Cache.put(rawKey, limitData, ttl > 0 ? ttl : 1)

        reply.header('X-RateLimit-Limit', max)
        reply.header('X-RateLimit-Remaining', Math.max(0, max - limitData.count))
      }

      return next()
    }

    let max = 60
    let windowSeconds = 60

    const limiterConfig = config<any>(`rateLimit.limiters.${parameter}`)
    if (limiterConfig) {
      max = limiterConfig.max ?? 60
      windowSeconds = parseTimeWindow(limiterConfig.timeWindow ?? '1 minute')
    } else if (parameter.includes(',')) {
      const [maxStr, minutesStr] = parameter.split(',')
      max = Number(maxStr || 60)
      windowSeconds = Number(minutesStr || 1) * 60
    }

    const { Cache } = await import('@lib/cache/Cache.js')
    const ip = typeof request.ip === 'function' ? request.ip() : request.ip
    const user = request.user()
    const identifier = user ? `user:${user.id}` : `ip:${ip}`
    const routeKey = request.raw.routeOptions?.url ?? request.raw.url
    const rawKey = `throttle:${identifier}:${routeKey}`

    const now = Math.floor(Date.now() / 1000)
    let limitData = await Cache.get<{ count: number, resetAt: number }>(rawKey)

    if (!limitData || limitData.resetAt <= now) {
      limitData = { count: 0, resetAt: now + windowSeconds }
    }

    if (limitData.count >= max) {
      const retryAfter = limitData.resetAt - now
      reply.code(429)
      reply.header('Retry-After', retryAfter)
      reply.header('X-RateLimit-Limit', max)
      reply.header('X-RateLimit-Remaining', 0)
      return reply.send({ message: 'Too Many Attempts.' })
    }

    limitData.count += 1
    const ttl = limitData.resetAt - now
    await Cache.put(rawKey, limitData, ttl > 0 ? ttl : 1)

    reply.header('X-RateLimit-Limit', max)
    reply.header('X-RateLimit-Remaining', Math.max(0, max - limitData.count))

    return next()
  }
}

function parseTimeWindow(window: string): number {
  const match = window.match(/^(\d+)\s+(second|minute|hour|day)s?$/i)
  if (!match) return 60
  const val = Number(match[1])
  const unit = match[2].toLowerCase()
  if (unit === 'second') return val
  if (unit === 'minute') return val * 60
  if (unit === 'hour') return val * 3600
  if (unit === 'day') return val * 86400
  return 60
}

export class SignedMiddleware {
  async handle(request: Request, reply: FastifyReply, next: Next) {
    const { hasValidSignature } = await import('@lib/foundation/helpers.js')
    if (!hasValidSignature(request.raw.url)) {
      return reply.code(403).send({ message: 'Invalid or expired signature.' })
    }
    return next()
  }
}
