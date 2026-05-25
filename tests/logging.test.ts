import { afterEach, describe, expect, it, vi } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { Log } from '@lib/logging/LogManager.js'
import { RequestLoggerMiddleware } from '@lib/logging/RequestLoggerMiddleware.js'

afterEach(() => {
  Log.restore?.()
})

describe('Logging', () => {
  it('captures log records in fake mode', () => {
    setApplication(new Application(process.cwd()))
    Log.fake()

    Log.info('hello world', { requestId: 'abc123' })
    Log.error(new Error('boom'))

    expect(() => Log.assertLogged('info', 'hello world')).not.toThrow()
    expect(() => Log.assertLogged('error', 'boom')).not.toThrow()
  })

  it('attaches request context through the request logger middleware', async () => {
    const app = new Application(process.cwd())
    app.config.set('logging', {
      default: 'null',
      channels: { null: { driver: 'null' } }
    })
    setApplication(app)
    Log.fake()

    const middleware = new RequestLoggerMiddleware()
    const request = {
      headers: { 'user-agent': 'vitest' },
      raw: { method: 'GET', url: '/health' },
      ip: '127.0.0.1',
      log: Log.withContext({})
    }
    const reply = { statusCode: 200 }
    const next = vi.fn(async () => undefined)

    await middleware.handle(request as any, reply as any, next)

    expect((request.raw as any).requestId).toBeDefined()
    expect(next).toHaveBeenCalledTimes(1)
    expect(() => Log.assertLogged('info', 'Incoming request')).not.toThrow()
    expect(() => Log.assertLogged('info', 'Request completed')).not.toThrow()
  })
})
