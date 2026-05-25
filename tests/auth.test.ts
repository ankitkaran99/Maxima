import { beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { Auth } from '@lib/auth/AuthManager.js'
import { AuthMiddleware, GuestMiddleware } from '@lib/auth/Middleware.js'
import { Gate } from '@lib/auth/Gate.js'

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

describe('Authentication', () => {
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
