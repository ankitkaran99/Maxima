import { beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { Auth, AuthFailed, AuthLogin } from '@lib/auth/AuthManager.js'
import { AbilitiesMiddleware, AbilityMiddleware } from '@lib/auth/Middleware.js'
import { AuthorizationException, AuthorizationResponse, Gate } from '@lib/auth/Gate.js'
import { OAuth } from '@lib/auth/OAuth.js'
import { Event } from '@lib/events/Event.js'
import { Hash } from '@lib/security/Hash.js'
import { Crypt, DecryptException } from '@lib/security/Crypt.js'

const users = [
  { id: 1, email: 'ada@example.com', password: '', token: 'token-1', role: 'admin' },
  { id: 2, email: 'grace@example.com', password: '', token: 'token-2', role: 'writer' }
]

class ArrayUserProvider {
  async retrieveById(id: string | number) {
    return users.find(user => user.id === Number(id)) ?? null
  }

  async retrieveByCredentials(credentials: Record<string, any>) {
    if (credentials.token) return users.find(user => user.token === credentials.token) ?? null
    return users.find(user => user.email === credentials.email) ?? null
  }
}

function session(initial: Record<string, any> = {}) {
  const store = { ...initial }
  return {
    get: (key: string) => store[key],
    put: (key: string, value: any) => { store[key] = value },
    forget: (key: string) => { delete store[key] },
    all: () => store
  }
}

function reply() {
  return {
    status: 200,
    payload: undefined as any,
    cookies: {} as Record<string, any>,
    code(status: number) { this.status = status; return this },
    send(payload: any) { this.payload = payload; return this },
    cookie(name: string, value: any) { this.cookies[name] = value; return this },
    clearCookie(name: string) { delete this.cookies[name]; return this }
  }
}

beforeEach(async () => {
  const app = new Application(process.cwd())
  setApplication(app)
  app.config.set('app.key', 'test-secret')
  app.config.set('auth.defaults.guard', 'web')
  app.config.set('auth.defaults.provider', 'users')
  app.config.set('auth.guards.web', { driver: 'session', provider: 'users' })
  app.config.set('auth.guards.admin', { driver: 'session', provider: 'users' })
  app.config.set('auth.guards.token', { driver: 'token', provider: 'users' })
  app.config.set('auth.guards.callback', { driver: 'request', name: 'callback' })
  app.config.set('auth.providers.users', { driver: ArrayUserProvider })
  app.config.set('auth.throttle', { enabled: true, maxAttempts: 2, decaySeconds: 60 })
  app.config.set('cache.default', 'memory')
  app.config.set('cache.stores.memory', { driver: 'memory', prefix: `auth_parity_${Date.now()}` })
  users[0].password = await Hash.make('secret')
  users[1].password = await Hash.make('secret')
  Auth.setRequest(undefined)
  Gate.clear()
  Event.restore()
})

describe('Auth, Authorization, and Security Parity', () => {
  it('isolates session guard user IDs while keeping legacy session compatibility', async () => {
    const request = { session: session(), headers: {}, query: {}, user: undefined, ip: '127.0.0.1' }
    Auth.setRequest(request)

    await expect(Auth.attempt({ email: 'ada@example.com', password: 'secret' }, 'web')).resolves.toBe(true)
    expect(request.session.get('auth_web_user_id')).toBe(1)
    expect(request.session.get('auth_user_id')).toBeUndefined()

    request.user = undefined
    await expect(Auth.attempt({ email: 'grace@example.com', password: 'secret' }, 'admin')).resolves.toBe(true)
    expect(request.session.get('auth_admin_user_id')).toBe(2)

    request.user = undefined
    await expect(Auth.user('web')).resolves.toMatchObject({ email: 'ada@example.com' })
    request.user = undefined
    await expect(Auth.user('admin')).resolves.toMatchObject({ email: 'grace@example.com' })
  })

  it('supports viaRequest guards and provider factories', async () => {
    Auth.providerUsing('array-custom', () => new ArrayUserProvider())
    Auth.viaRequest('callback', request => request.headers['x-user-id'] ? users[0] : null)

    const app = new Application(process.cwd())
    setApplication(app)
    app.config.set('auth.providers.users', { driver: 'array-custom' })
    app.config.set('auth.guards.callback', { driver: 'request', name: 'callback' })

    Auth.setRequest({ headers: { 'x-user-id': '1' }, query: {}, session: session(), user: undefined })
    await expect(Auth.user('callback')).resolves.toMatchObject({ email: 'ada@example.com' })
  })

  it('dispatches guard events and throttles failed login attempts', async () => {
    const events: string[] = []
    Event.listen(AuthLogin, () => events.push('login'))
    Event.listen(AuthFailed, () => events.push('failed'))
    const request = { session: session(), headers: {}, query: {}, user: undefined, ip: '10.0.0.1' }
    Auth.setRequest(request)

    await expect(Auth.attempt({ email: 'ada@example.com', password: 'bad' }, 'web')).resolves.toBe(false)
    await expect(Auth.attempt({ email: 'ada@example.com', password: 'bad' }, 'web')).resolves.toBe(false)
    await expect(Auth.tooManyLoginAttempts({ email: 'ada@example.com' }, 'web')).resolves.toBe(true)
    await expect(Auth.attempt({ email: 'ada@example.com', password: 'secret' }, 'web')).resolves.toBe(false)

    Auth.setRequest({ session: session(), headers: {}, query: {}, user: undefined, ip: '10.0.0.2' })
    await expect(Auth.attempt({ email: 'ada@example.com', password: 'secret' }, 'web')).resolves.toBe(true)
    expect(events).toContain('failed')
    expect(events).toContain('login')
  })

  it('derives remember cookie names from the app name unless explicitly configured', async () => {
    const request = { session: session(), headers: {}, query: {}, user: undefined, ip: '127.0.0.1' }
    const response = reply()
    Auth.setRequest(request, response)

    await Auth.remember(users[0], 'web')
    expect(response.cookies).toHaveProperty('maxima_remember_web')

    const app = new Application(process.cwd())
    setApplication(app)
    app.config.set('app.name', 'Acme Portal')
    app.config.set('auth.remember.cookie', 'fixed_remember')
    Auth.setRequest(request, response)

    await Auth.remember(users[0], 'web')
    expect(response.cookies).toHaveProperty('fixed_remember')
  })

  it('provides Hash and Crypt facades with rehash and key rotation support', async () => {
    const hashed = await Hash.make('secret')
    await expect(Hash.check('secret', hashed)).resolves.toBe(true)
    expect(Hash.needsRehash(hashed, { timeCost: 4 })).toBe(true)

    const encrypted = Crypt.encrypt({ ok: true })
    expect(Crypt.decrypt(encrypted)).toEqual({ ok: true })
    const stringPayload = Crypt.encryptString('secret text')
    expect(Crypt.decryptString(stringPayload)).toBe('secret text')
    expect(() => Crypt.decryptString(`${stringPayload}tampered`)).toThrow(DecryptException)
  })

  it('returns rich authorization responses and supports inline authorization helpers', async () => {
    Gate.define('archive', () => AuthorizationResponse.deny('No archive', 451))
    const inspected = await Gate.inspect('archive')

    expect(inspected.allowed).toBe(false)
    expect(inspected.message).toBe('No archive')
    expect(inspected.status).toBe(451)
    await expect(Gate.authorize('archive')).rejects.toMatchObject({ statusCode: 451 })
    await expect(Gate.allowIf(true)).resolves.toBe(true)
    await expect(Gate.denyIf(true, 'Denied inline')).rejects.toThrow(AuthorizationException)
  })

  it('registers resource policies explicitly and checks token abilities middleware', async () => {
    class Post {}
    class PostPolicy {
      update(user: any) { return user.role === 'admin' }
    }
    Gate.policy(Post, PostPolicy)
    await expect(Gate.forUser(users[0]).allows('update', new Post())).resolves.toBe(true)

    const tokenUser = { tokenCan: (ability: string) => ability === 'read' || ability === 'write' }
    Auth.viaRequest('token-test', () => tokenUser)
    const app = new Application(process.cwd())
    setApplication(app)
    app.config.set('auth.guards.token', { driver: 'request', name: 'token-test' })

    const allReply = reply()
    let allCalled = false
    await new AbilitiesMiddleware().handle({ raw: { headers: {}, session: session(), query: {}, user: undefined } } as any, allReply as any, async () => { allCalled = true }, 'read,write')
    expect(allCalled).toBe(true)

    const anyReply = reply()
    let anyCalled = false
    await new AbilityMiddleware().handle({ raw: { headers: {}, session: session(), query: {}, user: undefined } } as any, anyReply as any, async () => { anyCalled = true }, 'missing,read')
    expect(anyCalled).toBe(true)
  })

  it('builds OAuth provider redirects from configured services', () => {
    const app = new Application(process.cwd())
    setApplication(app)
    app.config.set('services.github', {
      clientId: 'client-id',
      clientSecret: 'secret',
      redirect: 'https://app.test/callback',
      authorizeUrl: 'https://github.test/oauth/authorize',
      tokenUrl: 'https://github.test/oauth/token',
      userUrl: 'https://github.test/user',
      scopes: ['read:user']
    })

    const url = new URL(OAuth.driver('github').redirect('state-1'))

    expect(url.origin + url.pathname).toBe('https://github.test/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('client-id')
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/callback')
    expect(url.searchParams.get('scope')).toBe('read:user')
    expect(url.searchParams.get('state')).toBe('state-1')
  })
})
