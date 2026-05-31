import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { Request } from '@lib/http/Request.js'
import { Response } from '@lib/http/Response.js'
import { Route } from '@lib/http/Route.js'
import { HttpKernel } from '@lib/http/Kernel.js'
import type { FastifyReply } from 'fastify'
import type { Next } from '@lib/http/Middleware.js'
import { User } from '@app/Models/User.js'
import { ImpersonateManager } from '../src/ImpersonateManager.js'
import { ImpersonateServiceProvider } from '../src/ImpersonateServiceProvider.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

describe('Impersonation Plugin', () => {
  const originalBasePath = process.env.MAXIMA_BASE_PATH
  let app: Application
  let tempStorageRoot: string

  // Helper to create a mock session
  function mockSession(initial: Record<string, any> = {}) {
    const store = { ...initial }
    return {
      get: (key: string) => store[key],
      put: (key: string, value: any) => { store[key] = value },
      has: (key: string) => store[key] !== undefined,
      forget: (key: string) => { delete store[key] },
      all: () => store
    }
  }

  // Helper to create a mock Request instance
  function createRequest(sessionData: Record<string, any> = {}) {
    const raw = {
      session: mockSession(sessionData),
      user: null,
      headers: {},
      query: {},
      params: {}
    } as any
    const reply = {} as any
    return new Request(raw, reply)
  }

  beforeEach(async () => {
    await DB.close()
    tempStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-impersonate-'))
    process.env.MAXIMA_BASE_PATH = tempStorageRoot

    app = new Application(tempStorageRoot)
    setApplication(app)

    // Reset ImpersonateManager
    ImpersonateManager.reset()

    // Database config
    app.config.set('database.default', 'sqlite')
    app.config.set('database.connections.sqlite', {
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })

    // Setup tables
    await DB.connection().schema.createTable('users', table => {
      table.increments('id')
      table.string('name')
      table.string('email').unique()
      table.string('password')
      table.boolean('is_admin').defaultTo(false)
      table.timestamp('created_at').nullable()
      table.timestamp('updated_at').nullable()
    })

    // Session config
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

    // Auth config
    app.config.set('auth.defaults.guard', 'session')
    app.config.set('auth.defaults.provider', 'users')
    app.config.set('auth.guards.session', { driver: 'session', provider: 'users' })
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
  })

  afterEach(async () => {
    Route.clear()
    await DB.close()
    if (originalBasePath) {
      process.env.MAXIMA_BASE_PATH = originalBasePath
    } else {
      delete process.env.MAXIMA_BASE_PATH
    }
    await fs.rm(tempStorageRoot, { recursive: true, force: true })
  })

  describe('Unit Tests', () => {
    it('can take and leave impersonation', async () => {
      const admin = new User({ name: 'Admin', email: 'admin@test.com', password: 'hash' })
      admin.forceFill({ is_admin: true })
      await admin.save()
      const target = await User.create({ name: 'User', email: 'user@test.com', password: 'hash' })

      const request = createRequest();
      (request.raw as any).user = admin

      // Start impersonating
      await ImpersonateManager.take(request, admin, target)

      expect(request.session?.get('impersonator_user_id')).toBe(admin.id)
      expect(request.session?.get('auth_user_id')).toBe(target.id)
      expect(request.user()).toBe(target)
      expect(ImpersonateManager.isImpersonating(request)).toBe(true)

      // Stop impersonating
      await ImpersonateManager.leave(request)

      expect(request.session?.get('impersonator_user_id')).toBeUndefined()
      expect(request.session?.get('auth_user_id')).toBe(admin.id)
      expect(request.user()).toBeNull() // Cleared to trigger reload
    })

    it('enforces checkTake logic based on default property or callbacks', async () => {
      const admin = { id: 1, is_admin: true }
      const normalUser = { id: 2, is_admin: false }
      const guest = { id: 3 }

      // 1. Default check: checks for is_admin / isAdmin
      expect(await ImpersonateManager.checkTake(admin, normalUser)).toBe(true)
      expect(await ImpersonateManager.checkTake(normalUser, admin)).toBe(false)
      expect(await ImpersonateManager.checkTake(guest, normalUser)).toBe(false)

      // 2. Custom canImpersonate callback
      ImpersonateManager.canImpersonate((impersonator) => impersonator.id === 2)
      expect(await ImpersonateManager.checkTake(normalUser, admin)).toBe(true)
      expect(await ImpersonateManager.checkTake(admin, normalUser)).toBe(false)

      // 3. Custom canBeImpersonated callback
      ImpersonateManager.reset()
      ImpersonateManager.canBeImpersonated((target) => target.id !== 1) // Admins cannot be impersonated
      expect(await ImpersonateManager.checkTake(admin, normalUser)).toBe(true)
      expect(await ImpersonateManager.checkTake(admin, admin)).toBe(false)
    })

    it('implements request macro extensions', async () => {
      // Register service provider to trigger macro definitions
      await app.register(ImpersonateServiceProvider)

      const admin = new User({ name: 'Admin', email: 'admin@test.com', password: 'hash' })
      admin.forceFill({ is_admin: true })
      await admin.save()
      const target = await User.create({ name: 'User', email: 'user@test.com', password: 'hash' })

      const request = createRequest()

      expect(request.isImpersonating()).toBe(false)
      expect(request.impersonatorId()).toBeNull()
      expect(await request.impersonator()).toBeNull()

      // Start impersonating
      await ImpersonateManager.take(request, admin, target)

      expect(request.isImpersonating()).toBe(true)
      expect(request.impersonatorId()).toBe(admin.id)
      
      const impersonatorUser = await request.impersonator()
      expect(impersonatorUser).toBeDefined()
      expect(impersonatorUser?.id).toBe(admin.id)
    })
  })

  describe('Integration / HTTP Tests', () => {
    it('handles impersonate workflow via endpoints and respects middlewares', async () => {
      // 1. Setup mock authentication middleware to log users in via header for testing
      class MockAuthMiddleware {
        async handle(req: Request, reply: FastifyReply, next: Next) {
          const headerValue = req.headers['x-test-user-id']
          const userId = Array.isArray(headerValue) ? headerValue[0] : headerValue
          if (userId) {
            req.session.put('auth_user_id', Number(userId));
            const user = await User.find(Number(userId));
            (req.raw as any).user = user;
          }
          return next()
        }
      }

      // Configure plugin routes to use cookies, session, and our mock auth middleware
      const { CookieMiddleware, SessionMiddleware } = await import('@lib/http/SecurityMiddleware.js')
      const { AuthMiddleware } = await import('@lib/auth/Middleware.js')
      app.config.set('middleware.aliases', {
        cookies: CookieMiddleware,
        session: SessionMiddleware,
        mock_auth: MockAuthMiddleware,
        auth: AuthMiddleware
      })
      app.config.set('impersonate.routes.middleware', ['cookies', 'session', 'mock_auth'])

      // 2. Register the Service Provider & boot
      await app.register(ImpersonateServiceProvider)
      await app.bootProviders()

      // Add a couple of dummy endpoints to verify profile & middleware actions
      Route.group({ middleware: ['cookies', 'session', 'auth'] }, () => {
        Route.get('/profile', async (req: Request) => {
          const user = req.user()
          return {
            id: user?.id,
            name: user?.name,
            is_impersonating: req.isImpersonating(),
            impersonator_id: req.impersonatorId()
          }
        })
      })

      // Add an impersonating-only route
      Route.get('/impersonator-panel', async () => {
        return { panel: 'open' }
      }).middleware(['cookies', 'session', 'impersonating'])

      // Add a block-impersonated route
      Route.post('/change-password', async () => {
        return { success: true }
      }).middleware(['cookies', 'session', 'block_impersonated'])

      // Bootstrap Kernel
      const kernel = new HttpKernel(app)
      await kernel.bootstrap()

      // Create users
      const admin = new User({ name: 'Admin', email: 'admin@test.com', password: 'hash' })
      admin.forceFill({ is_admin: true })
      await admin.save()
      const target = await User.create({ name: 'User', email: 'user@test.com', password: 'hash' })

      // Try to impersonate without log in (401)
      const res401 = await kernel.server.inject({
        method: 'POST',
        url: '/impersonate/take',
        payload: { id: target.id }
      })
      expect(res401.statusCode).toBe(401)

      // Start impersonating target user using admin credentials
      const resTake = await kernel.server.inject({
        method: 'POST',
        url: '/impersonate/take',
        payload: { id: target.id },
        headers: { 'x-test-user-id': String(admin.id) }
      })
      
      expect(resTake.statusCode).toBe(200)
      expect(resTake.json().impersonating).toBe(true)

      // Capture cookie for session tracking
      const cookie = resTake.cookies.find(item => item.name === 'maxima_session')
      expect(cookie).toBeDefined()
      console.log('COOKIE VALUE:', cookie?.value)
      const cookies = cookie ? { maxima_session: cookie.value } : {}

      // Request profile using cookie (should show target user profile and is_impersonating: true)
      const resProfile = await kernel.server.inject({
        method: 'GET',
        url: '/profile',
        cookies
      })
      console.log('resProfile status:', resProfile.statusCode)
      console.log('resProfile payload:', resProfile.payload)
      
      expect(resProfile.statusCode).toBe(200)
      expect(resProfile.json().id).toBe(target.id)
      expect(resProfile.json().is_impersonating).toBe(true)
      expect(resProfile.json().impersonator_id).toBe(admin.id)

      // Access impersonator panel (should be allowed since we are impersonating)
      const resPanel = await kernel.server.inject({
        method: 'GET',
        url: '/impersonator-panel',
        cookies
      })
      expect(resPanel.statusCode).toBe(200)
      expect(resPanel.json().panel).toBe('open')

      // Try to change password (should be blocked by block_impersonated middleware)
      const resChangePassword = await kernel.server.inject({
        method: 'POST',
        url: '/change-password',
        cookies
      })
      expect(resChangePassword.statusCode).toBe(403)
      expect(resChangePassword.json().message).toContain('This action cannot be performed while impersonating')

      // Stop impersonating
      const resLeave = await kernel.server.inject({
        method: 'POST',
        url: '/impersonate/leave',
        cookies
      })
      
      expect(resLeave.statusCode).toBe(200)
      expect(resLeave.json().impersonating).toBe(false)
      const leaveCookie = resLeave.cookies.find(item => item.name === 'maxima_session')
      const leaveCookies = leaveCookie ? { maxima_session: leaveCookie.value } : {}

      // Request profile again (should be restored to admin user and is_impersonating: false)
      const resProfileRestored = await kernel.server.inject({
        method: 'GET',
        url: '/profile',
        cookies: leaveCookies
      })
      
      expect(resProfileRestored.statusCode).toBe(200)
      expect(resProfileRestored.json().id).toBe(admin.id)
      expect(resProfileRestored.json().is_impersonating).toBe(false)
      expect(resProfileRestored.json().impersonator_id).toBeNull()

      // Access impersonator panel again (should now be forbidden)
      const resPanelForbidden = await kernel.server.inject({
        method: 'GET',
        url: '/impersonator-panel',
        cookies: leaveCookies
      })
      expect(resPanelForbidden.statusCode).toBe(403)
    })
  })
})
