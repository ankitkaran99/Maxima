import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { Log } from '@lib/logging/LogManager.js'
import { RequestLoggerMiddleware } from '@lib/logging/RequestLoggerMiddleware.js'
import { Boost, Horizon, Homestead, Octane, Pennant, Pulse, Reverb, Sail, Scout, Telescope, Valet } from '@lib/observability/Observability.js'

afterEach(() => {
  Log.restore?.()
  Telescope.clear?.()
  Pulse.clear?.()
  Scout.flush?.()
  Pennant.forget?.()
  fs.rmSync(path.join(process.cwd(), 'src', 'storage', 'logs', 'emergency.log'), { force: true })
})

describe('Logging & Observability', () => {
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

  it('supports shared context, deprecations, taps, processors, emergency fallback, and structured errors', () => {
    const app = new Application(process.cwd())
    app.config.set('logging', {
      default: 'stack',
      deprecations: { channel: 'deprecations' },
      channels: {
        stack: { driver: 'stack', channels: ['console', 'slack'] },
        console: { driver: 'console', level: 'debug' },
        slack: { driver: 'slack', level: 'critical' },
        deprecations: { driver: 'null' },
        broken: { driver: 'file', path: undefined }
      }
    })
    setApplication(app)

    Log.fake()
    Log.shareContext({ requestId: 'req-1' })
    Log.info('contextual')
    Log.error(new Error('structured'), { userId: 9 })
    Log.deprecations().warning('old api')

    expect(() => Log.assertLogged('info', 'contextual', context => context.requestId === 'req-1')).not.toThrow()
    expect(() => Log.assertLogged('error', 'structured', context => context.userId === 9 && typeof context.stack === 'string')).not.toThrow()
    expect(() => Log.assertLogged('warn', 'old api')).not.toThrow()

    Log.restore()
    Log.tap('tenant', logger => logger.withContext({ tenant: 'acme' }))
    app.config.set('logging.channels.tapped', { driver: 'null', tap: ['tenant'] })
    expect(() => Log.channel('tapped').info('ok')).not.toThrow()
    expect(() => Log.channel('missing').error('falls back')).not.toThrow()
  })

  it('provides Telescope/Pulse/Horizon/Scout/Pennant/Octane/Reverb/Boost equivalents', async () => {
    Telescope.record('request', { method: 'GET', url: '/health' })
    Telescope.record('job', { queue: 'default', job: 'ImportUsers', failed: true })
    Pulse.increment('requests')
    Pulse.timing('requests.duration', 12)

    Scout.import('posts', [{ id: 1, title: 'Laravel parity' }])
    Pennant.define('new-dashboard', user => user.plan === 'pro')
    await Octane.start()
    Sail.up()
    Valet.link('maxima', process.cwd())
    Homestead.provision('local', { php: false, node: true })

    const realtime: any[] = []
    Reverb.subscribe('orders.1', (event, payload) => realtime.push({ event, payload }))
    Reverb.publish('orders.1', 'updated', { id: 1 })
    Boost.tool('echo', input => ({ input }))

    expect(Telescope.all('request')).toHaveLength(1)
    expect(Pulse.snapshot().counters.requests).toBe(1)
    expect(Horizon.snapshot()).toMatchObject({ jobs: 1, failed: 1, queues: ['default'] })
    expect(Scout.search('posts', 'parity')).toHaveLength(1)
    await expect(Pennant.active('new-dashboard', { plan: 'pro' })).resolves.toBe(true)
    expect(Octane.status().running).toBe(true)
    expect(Sail.status().running).toBe(true)
    expect(Valet.sites().links.maxima).toBe(process.cwd())
    expect(Homestead.list()).toHaveLength(1)
    expect(realtime).toEqual([{ event: 'updated', payload: { id: 1 } }])
    await expect(Boost.call('echo', { ok: true })).resolves.toEqual({ input: { ok: true } })
  })
})

