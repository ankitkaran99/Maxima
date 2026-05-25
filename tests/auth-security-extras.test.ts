import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { Cache } from '@lib/cache/Cache.js'
import { Validator } from '@lib/validation/Validator.js'
import { schema } from '@lib/validation/schema.js'
import { ThrottleMiddleware } from '@lib/http/SecurityMiddleware.js'
import { Request } from '@lib/http/Request.js'
import type { FastifyReply } from 'fastify'

beforeEach(() => {
  const app = new Application(process.cwd())
  setApplication(app)
  app.config.set('cache', {
    default: 'memory',
    stores: {
      memory: { driver: 'memory', prefix: 'test_auth_sec_cache' }
    }
  })
  app.config.set('rateLimit', {
    limiters: {
      api: { max: 3, timeWindow: '1 minute' }
    }
  })
  Cache.restore()
})

afterEach(() => {
  Cache.restore()
})

describe('Authentication & Security Extras', () => {
  describe('ThrottleMiddleware', () => {
    it('throttles requests when limit is exceeded', async () => {
      const middleware = new ThrottleMiddleware()
      
      const headers: Record<string, string | number> = {}
      let responseCode = 200
      let responseBody: any = null

      const mockReply = {
        header(name: string, val: string | number) {
          headers[name] = val
          return this
        },
        code(statusCode: number) {
          responseCode = statusCode
          return this
        },
        send(body: any) {
          responseBody = body
          return this
        }
      } as unknown as FastifyReply

      const mockRequest = (ip: string, url: string) => {
        const reqObj = {
          ip,
          url,
          raw: {
            method: 'GET',
            routeOptions: { url }
          },
          user: () => null
        } as unknown as Request
        return reqObj
      }

      const next = async () => {}

      // Request 1: success
      await middleware.handle(mockRequest('127.0.0.1', '/test-route'), mockReply, next, 'api')
      expect(responseCode).toBe(200)
      expect(headers['X-RateLimit-Limit']).toBe(3)
      expect(headers['X-RateLimit-Remaining']).toBe(2)

      // Request 2: success
      await middleware.handle(mockRequest('127.0.0.1', '/test-route'), mockReply, next, 'api')
      expect(responseCode).toBe(200)
      expect(headers['X-RateLimit-Remaining']).toBe(1)

      // Request 3: success
      await middleware.handle(mockRequest('127.0.0.1', '/test-route'), mockReply, next, 'api')
      expect(responseCode).toBe(200)
      expect(headers['X-RateLimit-Remaining']).toBe(0)

      // Request 4: throttled (Too Many Attempts)
      await middleware.handle(mockRequest('127.0.0.1', '/test-route'), mockReply, next, 'api')
      expect(responseCode).toBe(429)
      expect(responseBody).toEqual({ message: 'Too Many Attempts.' })
      expect(headers['Retry-After']).toBeGreaterThan(0)
    })

    it('supports custom inline throttling limits (max,decayMinutes)', async () => {
      const middleware = new ThrottleMiddleware()
      
      const headers: Record<string, string | number> = {}
      let responseCode = 200

      const mockReply = {
        header(name: string, val: string | number) {
          headers[name] = val
          return this
        },
        code(statusCode: number) {
          responseCode = statusCode
          return this
        },
        send() {
          return this
        }
      } as unknown as FastifyReply

      const mockRequest = {
        ip: '127.0.0.2',
        url: '/custom-route',
        raw: {
          method: 'GET',
          routeOptions: { url: '/custom-route' }
        },
        user: () => null
      } as unknown as Request

      const next = async () => {}

      // Using raw parameters "2,1" (limit 2 requests)
      await middleware.handle(mockRequest, mockReply, next, '2,1')
      expect(headers['X-RateLimit-Limit']).toBe(2)
      expect(headers['X-RateLimit-Remaining']).toBe(1)

      await middleware.handle(mockRequest, mockReply, next, '2,1')
      expect(headers['X-RateLimit-Remaining']).toBe(0)

      await middleware.handle(mockRequest, mockReply, next, '2,1')
      expect(responseCode).toBe(429)
    })
  })

  describe('Password Complexity Validation', () => {
    it('enforces min length of 8 by default', async () => {
      const validator = Validator.make(
        { password: '123' },
        { password: schema.password() }
      )
      expect(await validator.fails()).toBe(true)
      expect(validator.errors().password[0]).toContain('password')
    })

    it('enforces custom min length', async () => {
      const validator = Validator.make(
        { password: '12345' },
        { password: schema.password().min(6) }
      )
      expect(await validator.fails()).toBe(true)
    })

    it('validates password with letters, mixedCase, numbers, and symbols requirements', async () => {
      const rule = schema.password()
        .letters()
        .mixedCase()
        .numbers()
        .symbols()

      // Missing letter
      let validator = Validator.make({ password: '12345678!' }, { password: rule })
      expect(await validator.fails()).toBe(true)
      expect(validator.errors().password[0]).toContain('letter')

      // Missing uppercase (mixedCase)
      validator = Validator.make({ password: 'abc12345!' }, { password: rule })
      expect(await validator.fails()).toBe(true)
      expect(validator.errors().password[0]).toContain('uppercase')

      // Missing number
      validator = Validator.make({ password: 'abcABCDE!' }, { password: rule })
      expect(await validator.fails()).toBe(true)
      expect(validator.errors().password[0]).toContain('number')

      // Missing symbol
      validator = Validator.make({ password: 'abcABC12' }, { password: rule })
      expect(await validator.fails()).toBe(true)
      expect(validator.errors().password[0]).toContain('symbol')

      // Passing password
      validator = Validator.make({ password: 'Password123!' }, { password: rule })
      expect(await validator.fails()).toBe(false)
    })
  })
})
