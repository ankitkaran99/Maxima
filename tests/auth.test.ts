import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyReply } from 'fastify'

import { Application } from '@lib/foundation/Application.js'
import { setApplication, hasValidRelativeSignature, hasValidSignature, signedUrl } from '@lib/foundation/helpers.js'
import { Auth, AuthFailed, AuthLogin } from '@lib/auth/AuthManager.js'
import {
  AuthMiddleware,
  GuestMiddleware,
  PasswordConfirmedMiddleware,
  VerifiedMiddleware,
  AbilitiesMiddleware,
  AbilityMiddleware,
  CanMiddleware
} from '@lib/auth/Middleware.js'
import { Gate, AuthorizationException, AuthorizationResponse, setCurrentUserResolver } from '@lib/auth/Gate.js'
import { DB } from '@lib/database/DB.js'
import { Mail } from '@lib/mail/Mail.js'
import { HttpKernel } from '@lib/http/Kernel.js'
import { Route } from '@lib/http/Route.js'
import { SessionMiddleware, ThrottleMiddleware } from '@lib/http/SecurityMiddleware.js'
import { User } from '@app/Models/User.js'
import { Model } from '@lib/database/Model.js'
import { HasApiTokens } from '@lib/auth/HasApiTokens.js'
import { PersonalAccessToken } from '@lib/auth/PersonalAccessToken.js'
import { SerializableModelRegistry } from '@lib/database/SerializableModelRegistry.js'
import { OAuth } from '@lib/auth/OAuth.js'
import { Event } from '@lib/events/Event.js'
import { Hash } from '@lib/security/Hash.js'
import { Crypt, DecryptException } from '@lib/security/Crypt.js'
import { Cache } from '@lib/cache/Cache.js'
import { Validator } from '@lib/validation/Validator.js'
import { schema } from '@lib/validation/schema.js'
import { Request } from '@lib/http/Request.js'
import { Controller } from '@lib/http/Controller.js'

describe('Authentication', () => {
  const users = [
    { id: 1, email: 'ada@example.com', password: '', token: 'token-1', role: 'admin' }
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

  function authRequest(initial: Record<string, any> = {}, headers: Record<string, string> = {}, query: Record<string, any> = {}) {
    return { session: session(initial), headers, query, user: undefined as any }
  }

  function reply() {
    return {
      status: 200,
      payload: undefined as any,
      redirectedTo: undefined as string | undefined,
      code(status: number) { this.status = status; return this },
      send(payload: any) { this.payload = payload; return this },
      redirect(to: string) { this.redirectedTo = to; return this }
    }
  }

  beforeEach(async () => {
    const app = new Application(process.cwd())
    setApplication(app)
    app.config.set('auth.defaults.guard', 'session')
    app.config.set('auth.defaults.provider', 'users')
    app.config.set('auth.guards.session', { driver: 'session', provider: 'users' })
    app.config.set('auth.guards.token', { driver: 'token', provider: 'users' })
    app.config.set('auth.providers.users', { driver: ArrayUserProvider })
    users[0].password = await Auth.hash('secret')
    Auth.setRequest(undefined)
  })

  it('attempts login, stores session user id, and logs out', async () => {
    const request = authRequest()
    Auth.setRequest(request)

    await expect(Auth.attempt({ email: 'ada@example.com', password: 'secret' })).resolves.toBe(true)
    expect(request.user.email).toBe('ada@example.com')
    expect(request.session.get('auth_user_id')).toBe(1)
    expect(await Auth.check()).toBe(true)

    await Auth.logout()

    expect(request.user).toBeNull()
    expect(request.session.get('auth_user_id')).toBeUndefined()
  })

  it('rejects invalid credentials', async () => {
    const request = authRequest()
    Auth.setRequest(request)

    await expect(Auth.attempt({ email: 'ada@example.com', password: 'wrong' })).resolves.toBe(false)
    expect(request.user).toBeUndefined()
  })

  it('restores users from the session guard', async () => {
    const request = authRequest({ auth_user_id: 1 })
    Auth.setRequest(request)

    await expect(Auth.user()).resolves.toMatchObject({ email: 'ada@example.com' })
    expect(request.user.can).toEqual(expect.any(Function))
  })

  it('resolves users from bearer tokens', async () => {
    const request = authRequest({}, { authorization: 'Bearer token-1' })
    Auth.setRequest(request)

    await expect(Auth.user('token')).resolves.toMatchObject({ email: 'ada@example.com' })
  })

  it('auth middleware rejects guests and allows authenticated requests', async () => {
    const middleware = new AuthMiddleware()
    const guestReply = reply()

    await middleware.handle({ raw: authRequest() } as any, guestReply as any, async () => {})
    expect(guestReply.status).toBe(401)
    expect(guestReply.payload).toEqual({ message: 'Unauthenticated.' })

    const authenticatedReply = reply()
    let called = false
    await middleware.handle({ raw: authRequest({ auth_user_id: 1 }) } as any, authenticatedReply as any, async () => { called = true })
    expect(called).toBe(true)
  })

  it('guest middleware redirects authenticated users', async () => {
    const middleware = new GuestMiddleware()
    const response = reply()

    await middleware.handle({ raw: authRequest({ auth_user_id: 1 }) } as any, response as any, async () => {})

    expect(response.redirectedTo).toBe('/')
  })

  it('adds can and cannot helpers to authenticated users', async () => {
    Gate.define('admin', user => user.role === 'admin')
    const request = authRequest({ auth_user_id: 1 })
    Auth.setRequest(request)

    const user = await Auth.user()

    await expect(user.can('admin')).resolves.toBe(true)
    await expect(user.cannot('admin')).resolves.toBe(false)
  })
})

describe('Auth Extras', () => {
  let app: Application

  function session(initial: Record<string, any> = {}) {
    const store = { ...initial }
    return {
      get: (key: string) => store[key],
      put: (key: string, value: any) => { store[key] = value },
      forget: (key: string) => { delete store[key] },
      all: () => store
    }
  }

  function extractCookie(header: string | string[] | undefined, name: string) {
    const entries = Array.isArray(header) ? header : header ? [header] : []
    const match = entries.map(entry => entry.match(new RegExp(`${name}=([^;]+)`))).find(Boolean)
    return match?.[1] ? decodeURIComponent(match[1]) : undefined
  }

  beforeEach(async () => {
    app = new Application(process.cwd())
    setApplication(app)
    app.config.set('database.default', 'sqlite')
    app.config.set('database.connections.sqlite', {
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    app.config.set('mail.default', 'array')
    app.config.set('mail.mailers.array', { transport: 'array' })
    app.config.set('mail.from', { address: 'hello@example.com', name: 'Maxima' })
    app.config.set('auth.defaults.guard', 'session')
    app.config.set('auth.defaults.provider', 'users')
    app.config.set('auth.guards.session', { driver: 'session', provider: 'users' })
    app.config.set('auth.guards.token', { driver: 'token', provider: 'users' })
    app.config.set('auth.providers.users', {
      driver: class {
        async retrieveById(id: string | number) {
          return User.find(id)
        }

        async retrieveByCredentials(credentials: Record<string, any>) {
          return User.where('email', credentials.email).first()
        }
      }
    })
    app.config.set('session', {
      driver: 'cookie',
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
    app.config.set('auth.jwt.enabled', true)
    app.config.set('auth.jwt.secret', 'secret')
    app.config.set('auth.jwt.issuer', 'maxima')
    app.config.set('auth.jwt.audience', 'maxima-api')
    app.config.set('auth.remember.cookie', 'maxima_remember_session')
    app.config.set('middleware.aliases', {
      session: SessionMiddleware,
      auth: AuthMiddleware,
      verified: VerifiedMiddleware,
      passwordConfirmed: PasswordConfirmedMiddleware
    })

    Mail.restore()
    Mail.fake()
    Auth.setRequest(undefined)

    await DB.close()
    await DB.connection().schema.createTable('users', table => {
      table.increments('id')
      table.string('name')
      table.string('email').unique()
      table.string('password')
      table.timestamp('created_at').nullable()
      table.timestamp('updated_at').nullable()
    })
    await DB.connection().schema.createTable('password_reset_tokens', table => {
      table.string('email').primary()
      table.string('token_hash')
      table.timestamp('created_at')
      table.timestamp('expires_at').nullable()
    })
    await DB.connection().schema.createTable('email_verifications', table => {
      table.increments('id')
      table.integer('user_id')
      table.string('email')
      table.timestamp('verified_at')
    })
    await DB.connection().schema.createTable('remember_tokens', table => {
      table.increments('id')
      table.integer('user_id')
      table.string('guard')
      table.string('token_hash')
      table.timestamp('created_at')
    })
  })

  afterEach(async () => {
    Route.clear()
    Mail.restore()
    await DB.close()
  })

  it('sends reset and verification emails and completes the reset flow', async () => {
    const user = await User.create({ name: 'Ada', email: 'ada@example.com', password: await Auth.hash('secret') }) as any

    await expect(Auth.sendPasswordResetLink('ada@example.com')).resolves.toBe(true)
    expect(() => Mail.assertSent('Reset your password')).not.toThrow()

    const token = await Auth.createPasswordResetToken('ada@example.com')
    await expect(Auth.resetPassword('ada@example.com', token, 'new-secret')).resolves.toBe(true)
    const updated = await User.find(user.id) as any
    await expect(Auth.verify('new-secret', updated.password)).resolves.toBe(true)

    const verificationToken = crypto.createHash('sha1').update('ada@example.com').digest('hex')
    await expect(Auth.sendEmailVerification(user)).resolves.toBe(true)
    expect(() => Mail.assertSent('Verify your email address')).not.toThrow()
    await expect(Auth.verifyEmail(user.id, verificationToken)).resolves.toBe(true)
    expect(await Auth.hasVerifiedEmail(user)).toBe(true)
  })

  it('confirms passwords and remembers sessions across requests', async () => {
    const user = await User.create({ name: 'Grace', email: 'grace@example.com', password: await Auth.hash('secret') }) as any

    const request = { session: session({ auth_user_id: user.id }), headers: {}, query: {}, user: undefined }
    Auth.setRequest(request)
    await expect(Auth.confirmPassword('secret')).resolves.toBe(true)
    expect(Auth.passwordConfirmed()).toBe(true)

    Route.get('/login', async (request, response) => {
      Auth.setRequest(request.raw, response)
      return { ok: await Auth.attempt({ email: 'grace@example.com', password: 'secret' }, 'session', true) }
    }).middleware('session')

    const kernel = new HttpKernel(app)
    await kernel.bootstrap({ loadRoutes: false })

    const login = await kernel.server.inject({ method: 'GET', url: '/login' })
    const remember = extractCookie(login.headers['set-cookie'], 'maxima_remember_session')

    expect(login.statusCode).toBe(200)
    expect(login.json()).toEqual({ ok: true })
    await expect(DB.table('remember_tokens').first()).resolves.toMatchObject({
      user_id: user.id
    })
    expect(remember).toBeDefined()

    const restoreRequest = { cookies: { maxima_remember_session: remember }, session: session(), headers: {}, query: {}, user: undefined }
    Auth.setRequest(restoreRequest)
    await expect(Auth.user()).resolves.toMatchObject({ email: 'grace@example.com' })
    expect(user.id).toBeDefined()
  })

  it('issues and verifies hardened jwt tokens', async () => {
    const user = await User.create({ name: 'Linus', email: 'linus@example.com', password: await Auth.hash('secret') })
    const token = await Auth.issueJwt(user, { scope: 'api' })
    const request = { headers: { authorization: `Bearer ${token}` }, query: {}, session: session(), user: undefined }

    Auth.setRequest(request)
    await expect(Auth.user('token')).resolves.toMatchObject({ email: 'linus@example.com' })
  })
})

describe('Authentication & Security Gaps', () => {
  const originalBasePath = process.env.MAXIMA_BASE_PATH
  let root = ''
  let app: Application

  class CustomUser extends HasApiTokens {
    static table = 'users'
  }
  SerializableModelRegistry.register(CustomUser)

  class AutoDummyPost extends Model {
    static table = 'posts'
  }
  SerializableModelRegistry.register(AutoDummyPost)

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-auth-gaps-'))
    const srcPath = path.join(root, 'src')
    process.env.MAXIMA_BASE_PATH = srcPath

    app = new Application(srcPath)
    setApplication(app)
    app.config.set('database.default', 'sqlite')
    app.config.set('database.connections.sqlite', {
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    app.config.set('auth', {
      defaults: {
        guard: 'token',
        provider: 'users'
      },
      guards: {
        token: {
          driver: 'token',
          provider: 'users'
        }
      },
      providers: {
        users: {
          driver: {
            async retrieveById(id: any) {
              return CustomUser.find(id)
            },
            async retrieveByCredentials(creds: any) {
              if (creds.token) {
                // PersonalAccessToken fallback
                return null
              }
              return CustomUser.where('email', creds.email).first()
            }
          }
        }
      }
    })

    // Create DB tables
    await DB.connection().schema.createTable('users', table => {
      table.increments('id')
      table.string('name')
      table.string('email')
      table.timestamps(true, true)
    })

    await DB.connection().schema.createTable('posts', table => {
      table.increments('id')
      table.integer('user_id')
      table.string('title')
      table.timestamps(true, true)
    })

    await DB.connection().schema.createTable('personal_access_tokens', table => {
      table.increments('id')
      table.string('tokenable_type')
      table.integer('tokenable_id')
      table.string('name')
      table.string('token', 64).unique()
      table.text('abilities').nullable()
      table.timestamp('last_used_at').nullable()
      table.timestamp('expires_at').nullable()
      table.timestamps(true, true)
    })

    await fs.mkdir(path.join(srcPath, 'app', 'Policies'), { recursive: true })
    await fs.mkdir(path.join(srcPath, 'config'), { recursive: true })
  })

  afterEach(async () => {
    process.env.MAXIMA_BASE_PATH = originalBasePath
    Gate.clear()
    await DB.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('supports policy auto-discovery from app/Policies directory', async () => {
    const policyContent = `
      export default class AutoDummyPostPolicy {
        update(user, post) {
          return Number(post.user_id) === Number(user.id)
        }
      }
    `
    await fs.writeFile(path.join(root, 'src', 'app', 'Policies', 'AutoDummyPostPolicy.ts'), policyContent)

    const user = await CustomUser.create({ name: 'Alice', email: 'alice@example.com' })
    const user2 = await CustomUser.create({ name: 'Bob', email: 'bob@example.com' })
    const post = await AutoDummyPost.create({ user_id: user.id, title: 'My Post' })

    const canUpdate = await Gate.forUser(user).allows('update', post)
    const canUpdate2 = await Gate.forUser(user2).allows('update', post)

    expect(canUpdate).toBe(true)
    expect(canUpdate2).toBe(false)
  })

  it('issues personal access tokens with abilities and validates via Auth guard', async () => {
    const user = await CustomUser.create({ name: 'Alice', email: 'alice@example.com' }) as CustomUser
    
    const tokenResult = await user.createToken('test-device', ['read:posts'])
    expect(tokenResult.plainTextToken).toBeDefined()
    expect(tokenResult.accessToken.token).toBeDefined()

    const tokenable = await tokenResult.accessToken.tokenable().first()
    expect(tokenable.id).toBe(user.id)

    const tokens = await user.tokens().get()
    expect(tokens.length).toBe(1)
    expect(tokens[0].name).toBe('test-device')

    const mockRequest = {
      headers: {
        authorization: `Bearer ${tokenResult.plainTextToken}`
      },
      query: {},
      raw: {}
    } as any
    mockRequest.raw.maximaRequest = mockRequest

    Auth.setRequest(mockRequest, {})

    const authenticatedUser = await Auth.user() as CustomUser
    expect(authenticatedUser).toBeDefined()
    expect(authenticatedUser.id).toBe(user.id)
    expect(authenticatedUser.accessToken).toBeDefined()

    expect(authenticatedUser.tokenCan('read:posts')).toBe(true)
    expect(authenticatedUser.tokenCan('write:posts')).toBe(false)

    await tokenResult.accessToken.delete()
    const revokedTokens = await user.tokens().get()
    expect(revokedTokens.length).toBe(0)

    Auth.setRequest({ headers: { authorization: `Bearer ${tokenResult.plainTextToken}` } } as any)
    const failedUser = await Auth.user()
    expect(failedUser).toBeNull()
  })
})

describe('Auth, Authorization, and Security Parity', () => {
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

describe('Authentication & Security Extras', () => {
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

      await middleware.handle(mockRequest('127.0.0.1', '/test-route'), mockReply, next, 'api')
      expect(responseCode).toBe(200)
      expect(headers['X-RateLimit-Limit']).toBe(3)
      expect(headers['X-RateLimit-Remaining']).toBe(2)

      await middleware.handle(mockRequest('127.0.0.1', '/test-route'), mockReply, next, 'api')
      expect(responseCode).toBe(200)
      expect(headers['X-RateLimit-Remaining']).toBe(1)

      await middleware.handle(mockRequest('127.0.0.1', '/test-route'), mockReply, next, 'api')
      expect(responseCode).toBe(200)
      expect(headers['X-RateLimit-Remaining']).toBe(0)

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

      let validator = Validator.make({ password: '12345678!' }, { password: rule })
      expect(await validator.fails()).toBe(true)
      expect(validator.errors().password[0]).toContain('letter')

      validator = Validator.make({ password: 'abc12345!' }, { password: rule })
      expect(await validator.fails()).toBe(true)
      expect(validator.errors().password[0]).toContain('uppercase')

      validator = Validator.make({ password: 'abcABCDE!' }, { password: rule })
      expect(await validator.fails()).toBe(true)
      expect(validator.errors().password[0]).toContain('number')

      validator = Validator.make({ password: 'abcABC12' }, { password: rule })
      expect(await validator.fails()).toBe(true)
      expect(validator.errors().password[0]).toContain('symbol')

      validator = Validator.make({ password: 'Password123!' }, { password: rule })
      expect(await validator.fails()).toBe(false)
    })
  })
})

describe('Authorization', () => {
  class Post {
    constructor(public userId: number) {}
  }

  class PostPolicy {
    update(user: any, post: Post) {
      return user.id === post.userId
    }
  }

  class Comment {
    constructor(public user_id: number) {}
  }

  beforeEach(() => {
    const app = new Application(process.cwd())
    setApplication(app)
    app.config.set('auth.policies.Post', PostPolicy)
    Gate.clear()
    setCurrentUserResolver(() => ({ id: 1, role: 'user' }))
  })

  afterEach(() => {
    Gate.clear()
    setCurrentUserResolver(() => undefined)
  })

  it('authorizes direct gates and denials', async () => {
    Gate.define('manage-users', user => user.role === 'admin')

    await expect(Gate.allows('manage-users')).resolves.toBe(false)
    await expect(Gate.denies('manage-users')).resolves.toBe(true)
    await expect(Gate.authorize('manage-users')).rejects.toBeInstanceOf(AuthorizationException)
  })

  it('supports before and after hooks', async () => {
    const afterResults: boolean[] = []
    Gate.define('delete-post', () => false)
    Gate.before(user => user.role === 'super-admin' ? true : undefined)
    Gate.after((_user, _ability, result) => { afterResults.push(result) })

    await expect(Gate.allows('delete-post', undefined, { id: 1, role: 'super-admin' })).resolves.toBe(true)
    expect(afterResults).toEqual([])

    await expect(Gate.allows('delete-post', undefined, { id: 1, role: 'user' })).resolves.toBe(false)
    expect(afterResults).toEqual([false])
  })

  it('uses policies for model-aware authorization', async () => {
    await expect(Gate.allows('update', new Post(1))).resolves.toBe(true)
    await expect(Gate.allows('update', new Post(2))).resolves.toBe(false)
  })

  it('auto-discovers policies from the conventional policies directory', async () => {
    await expect(Gate.allows('delete', new Comment(1))).resolves.toBe(true)
    await expect(Gate.allows('delete', new Comment(2))).resolves.toBe(false)
  })

  it('supports manual user injection with forUser', async () => {
    Gate.define('impersonate', user => user.role === 'admin')

    await expect(Gate.forUser({ id: 2, role: 'admin' }).allows('impersonate')).resolves.toBe(true)
    await expect(Gate.forUser({ id: 3, role: 'user' }).denies('impersonate')).resolves.toBe(true)
  })

  it('supports controller authorization helpers', async () => {
    Gate.define('view-dashboard', user => user.id === 1)
    const controller = new Controller()

    await expect(controller.authorize('view-dashboard')).resolves.toBeUndefined()
    await expect(Gate.forUser({ id: 2 }).authorize('view-dashboard')).rejects.toBeInstanceOf(AuthorizationException)
  })

  it('supports can middleware', async () => {
    Gate.define('update', (_user, subject) => subject === 'allowed')
    const middleware = new CanMiddleware()
    let called = false

    await middleware.handle({
      params: { post: 'allowed' },
      input: () => undefined,
      user: () => ({ id: 1 })
    } as any, {} as any, async () => { called = true }, 'update,post')

    expect(called).toBe(true)
  })

  it('supports fake allow and deny helpers for tests', async () => {
    Gate.deny()
    await expect(Gate.allows('anything')).resolves.toBe(false)

    Gate.allow()
    await expect(Gate.allows('anything')).resolves.toBe(true)

    Gate.restore()
    await expect(Gate.allows('anything')).resolves.toBe(false)
  })

  it('supports custom denial messages', async () => {
    Gate.define('archive-post', () => false)

    await expect(Gate.authorize('archive-post', undefined, undefined, 'You cannot archive this post.'))
      .rejects.toThrow('You cannot archive this post.')
  })
})

describe('Security', () => {
  it('creates and verifies signed URLs', () => {
    const app = new Application(process.cwd())
    setApplication(app)
    app.config.set('app.url', 'https://example.test')
    app.config.set('app.key', 'super-secret')

    const url = signedUrl('/verify-email', { id: 15 }, new Date(Date.now() + 60_000))

    expect(hasValidSignature(url)).toBe(true)
    expect(hasValidSignature(url.replace('id=15', 'id=16'))).toBe(false)
  })

  it('validates relative signed URLs and ignored query parameters', () => {
    const app = new Application(process.cwd())
    setApplication(app)
    app.config.set('app.url', 'https://example.test')
    app.config.set('app.key', 'super-secret')

    const url = signedUrl('/download', { id: 15 }, undefined, false)

    expect(url.startsWith('/download?')).toBe(true)
    expect(hasValidRelativeSignature(`${url}&page=2`, ['page'])).toBe(true)
    expect(hasValidSignature(`${url}&id=16`, { absolute: false })).toBe(false)
  })
})
