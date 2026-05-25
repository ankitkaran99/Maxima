import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { AuthorizationException, Gate, setCurrentUserResolver } from '@lib/auth/Gate.js'
import { CanMiddleware } from '@lib/auth/Middleware.js'
import { Controller } from '@lib/http/Controller.js'

class Post {
  constructor(public userId: number) {}
}

class PostPolicy {
  update(user, post: Post) {
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

describe('Authorization', () => {
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
