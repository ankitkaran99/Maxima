import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { HttpKernel } from '@lib/http/Kernel.js'
import { Route } from '@lib/http/Route.js'
import { Response } from '@lib/http/Response.js'
import { SessionMiddleware } from '@lib/http/SecurityMiddleware.js'
import { SessionManager } from '@lib/session/Session.js'

let app: Application

describe('Session and Cookies', () => {
  beforeEach(() => {
    app = new Application(process.cwd())
    setApplication(app)
    app.config.set('middleware.global', [])
    app.config.set('middleware.aliases', {
      session: SessionMiddleware
    })
    app.config.set('security.helmet', false)
    app.config.set('session', {
      driver: 'cookie',
      lifetime: 120,
      cookie: {
        name: 'maxima_session',
        httpOnly: true,
        secure: false,
        signed: true,
        encrypted: true,
        sameSite: 'lax',
        path: '/'
      }
    })
  })

  afterEach(() => {
    Route.clear()
  })

  it('persists flash data, old input, and error bags across requests', async () => {
    Route.get('/flash', request => {
      const session = request.session
      if (request.query.step === 'set') {
        session.flash('_old_input', { name: 'Ada' })
        session.flash('_errors', { name: ['Required'] })
        return { stored: true }
      }
      return {
        oldInput: session.oldInput(),
        errors: session.errors()
      }
    }).middleware('session')

    const kernel = new HttpKernel(app)
    await kernel.bootstrap({ loadRoutes: false })
    const first = await kernel.server.inject({ method: 'GET', url: '/flash?step=set' })
    const cookie = first.cookies.find(item => item.name === 'maxima_session')
    const second = await kernel.server.inject({
      method: 'GET',
      url: '/flash',
      cookies: cookie ? { maxima_session: cookie.value } : undefined as any
    })
    const secondCookie = second.cookies.find(item => item.name === 'maxima_session')
    const third = await kernel.server.inject({
      method: 'GET',
      url: '/flash',
      cookies: secondCookie ? { maxima_session: secondCookie.value } : undefined as any
    })

    expect(first.statusCode).toBe(200)
    expect(second.json()).toEqual({
      oldInput: { name: 'Ada' },
      errors: { name: ['Required'] }
    })
    expect(third.json()).toEqual({
      oldInput: {},
      errors: {}
    })
  })

  it('can keep or reflash flash data for another request', async () => {
    Route.get('/flash-keep', request => {
      const session = request.session
      if (request.query.step === 'set') {
        session.flash('notice', 'Saved')
        session.flash('status', 'ok')
        return { stored: true }
      }
      if (request.query.step === 'keep') {
        session.keep('notice')
        return { notice: session.get('notice'), status: session.get('status') }
      }
      return { notice: session.get('notice'), status: session.get('status') }
    }).middleware('session')

    const kernel = new HttpKernel(app)
    await kernel.bootstrap({ loadRoutes: false })
    const first = await kernel.server.inject({ method: 'GET', url: '/flash-keep?step=set' })
    const firstCookie = first.cookies.find(item => item.name === 'maxima_session')
    const second = await kernel.server.inject({
      method: 'GET',
      url: '/flash-keep?step=keep',
      cookies: firstCookie ? { maxima_session: firstCookie.value } : undefined as any
    })
    const secondCookie = second.cookies.find(item => item.name === 'maxima_session')
    const third = await kernel.server.inject({
      method: 'GET',
      url: '/flash-keep',
      cookies: secondCookie ? { maxima_session: secondCookie.value } : undefined as any
    })
    const thirdCookie = third.cookies.find(item => item.name === 'maxima_session')
    const fourth = await kernel.server.inject({
      method: 'GET',
      url: '/flash-keep',
      cookies: thirdCookie ? { maxima_session: thirdCookie.value } : undefined as any
    })

    expect(second.json()).toEqual({ notice: 'Saved', status: 'ok' })
    expect(third.json()).toEqual({ notice: 'Saved' })
    expect(fourth.json()).toEqual({})
  })

  it('supports encrypted and signed response cookies', () => {
    const reply = {
      headers: {} as Record<string, string>,
      setCookie(name: string, value: string) {
        this.headers[name] = value
      },
      clearCookie() {}
    } as any
    const response = new Response(reply)

    response.cookie('token', { hello: 'world' })
    expect(reply.headers.token).toContain('enc:')
  })

  it('regenerates session identifiers', async () => {
    const manager = new SessionManager()
    const request = { raw: { cookies: {} } }
    const reply = { setCookie() {} }
    const session = await manager.start(request, reply)
    const before = session.id()
    const after = session.regenerate()

    expect(after).not.toBe(before)
  })
})

describe('Session Helpers Parity', () => {
  beforeEach(() => {
    app = new Application(process.cwd())
    setApplication(app)
    app.config.set('cache', {
      default: 'memory',
      stores: {
        memory: { driver: 'memory', prefix: 'parity_cache' }
      }
    })
    app.config.set('session', {
      driver: 'memory',
      lifetime: 120,
      cookie: { name: 'maxima_session', httpOnly: true, secure: false, sameSite: 'lax', path: '/' },
      stores: { memory: {} }
    })
  })

  it('supports session invalidation, previous URL, old input flashing, cache, and blocking helpers', async () => {
    const manager = new SessionManager()
    const request = { raw: { cookies: {} } }
    const reply = { setCookie() {} }
    const session = await manager.start(request, reply)

    session.put('user_id', 10)
    session.setPreviousUrl('/dashboard')
    session.flashInput({ email: 'ada@example.com' })
    expect(session.previousUrl()).toBe('/dashboard')
    expect(session.oldInput()).toEqual({ email: 'ada@example.com' })

    await session.cache().put('draft', { title: 'Hello' }, 60)
    expect(await session.cache().get('draft')).toEqual({ title: 'Hello' })
    await expect(session.block(1, () => 'locked')).resolves.toBe('locked')

    const previousId = session.id()
    const nextId = session.invalidate()
    expect(nextId).not.toBe(previousId)
    expect(session.all()).toEqual({})
  })
})
