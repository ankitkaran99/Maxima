import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { Auth } from '@lib/auth/AuthManager.js'
import { AuthMiddleware, PasswordConfirmedMiddleware, VerifiedMiddleware } from '@lib/auth/Middleware.js'
import { DB } from '@lib/database/DB.js'
import { Mail } from '@lib/mail/Mail.js'
import { HttpKernel } from '@lib/http/Kernel.js'
import { Route } from '@lib/http/Route.js'
import { SessionMiddleware } from '@lib/http/SecurityMiddleware.js'
import { User } from '@app/Models/User.js'

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

describe('Auth Extras', () => {
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

function extractCookie(header: string | string[] | undefined, name: string) {
  const entries = Array.isArray(header) ? header : header ? [header] : []
  const match = entries.map(entry => entry.match(new RegExp(`${name}=([^;]+)`))).find(Boolean)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}
