import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import { Application } from '@lib/foundation/Application.js'
import { action as actionUrl, clearRouteDefaults, currentRouteName, hasValidSignature, route, routeDefaults, setApplication, signedRoute } from '@lib/foundation/helpers.js'
import { HttpKernel } from '@lib/http/Kernel.js'
import { Route } from '@lib/http/Route.js'
import { DB } from '@lib/database/DB.js'
import { User } from '@app/Models/User.js'
import { Post } from '@app/Models/Post.js'

class StringBoundController {
  index() {
    return { ok: true }
  }
}

class ResourceController {}

class NestedPostResourceController {
  show(request) {
    return {
      user: request.params.user.name,
      post: request.params.post.title
    }
  }
}

class GroupedController {
  index() {
    return { controller: 'grouped' }
  }
}

class FallbackMiddleware {
  async handle(request, reply, next) {
    reply.header('x-fallback-middleware', 'yes')
    return next()
  }
}

let app: Application

async function makeKernel() {
  const kernel = new HttpKernel(app)
  await kernel.bootstrap({ loadRoutes: false })
  return kernel
}

beforeEach(async () => {
  await DB.close()
  app = new Application(path.join(process.cwd(), 'src'))
  setApplication(app)
  app.config.set('middleware.global', [])
  app.config.set('security.helmet', false)
  app.config.set('cors', false)
  app.config.set('database.default', 'sqlite')
  app.config.set('database.connections.sqlite', {
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  })

  await DB.connection().schema.createTable('users', table => {
    table.increments('id')
    table.string('name')
    table.string('email').nullable()
    table.string('password').nullable()
    table.timestamp('created_at').nullable()
    table.timestamp('updated_at').nullable()
  })

  await DB.connection().schema.createTable('posts', table => {
    table.increments('id')
    table.integer('user_id')
    table.string('title')
    table.text('body').nullable()
    table.timestamp('created_at').nullable()
    table.timestamp('updated_at').nullable()
    table.timestamp('deleted_at').nullable()
  })
})

afterEach(() => {
  Route.clear()
  clearRouteDefaults()
})

afterEach(async () => {
  await DB.close()
})

describe('Routing API', () => {
  it('registers named routes and generates URLs with params', () => {
    Route.get('/users/:id', () => {}).name('users.show')
    Route.get('/teams/:team/users/:user', () => {}).name('teams.users.show')
    Route.get('/locale/:locale/users/:id', () => {}).name('localized.users.show')
    Route.get('/controllers/:id', [GroupedController, 'index'])

    const app = new Application(process.cwd())
    setApplication(app)
    routeDefaults({ locale: 'en' })

    expect(route('users.show', { id: 15, tab: 'posts' })).toBe('/users/15?tab=posts')
    expect(route('users.show', 15)).toBe('/users/15')
    expect(route('teams.users.show', [7, 15])).toBe('/teams/7/users/15')
    expect(route('users.show', { id: 15, _query: { tab: 'posts' } })).toBe('/users/15?tab=posts')
    expect(route('localized.users.show', { id: 15 })).toBe('/locale/en/users/15')
    expect(actionUrl([GroupedController, 'index'], 34, false)).toBe('/controllers/34')
    expect(hasValidSignature(signedRoute('users.show', { id: 15 }))).toBe(true)
  })

  it('applies grouped prefixes and middleware', () => {
    Route.group({ prefix: '/admin', middleware: ['auth'], name: 'admin.' }, () => {
      Route.get('/dashboard', () => {}).middleware('can:view-dashboard').name('dashboard')
    })

    expect(Route.all()).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: '/admin/dashboard',
        name: 'admin.dashboard',
        middleware: ['auth', 'can:view-dashboard']
      })
    ])
  })

  it('merges nested group prefixes and string middleware attributes', () => {
    Route.group({ prefix: 'admin', middleware: 'auth', withoutMiddleware: 'guest', name: 'admin.' }, () => {
      Route.group({ prefix: 'v1', middleware: ['throttle'], withoutMiddleware: ['csrf'], as: 'api.' }, () => {
        Route.get('reports', () => {}).name('reports')
      })
    })

    expect(Route.findByName('admin.api.reports')).toEqual(expect.objectContaining({
      method: 'GET',
      path: '/admin/v1/reports',
      middleware: ['auth', 'throttle'],
      excludedMiddleware: ['guest', 'csrf']
    }))
  })

  it('supports match, any, options, and controller groups', async () => {
    Route.options('/preflight', () => ({ ok: 'options' })).name('preflight')
    Route.match(['GET', 'POST'], '/matched', request => ({ method: request.method() })).name('matched')
    Route.any('/anything', request => ({ method: request.method() })).name('anything')
    Route.group({ prefix: '/grouped', controller: GroupedController, name: 'grouped.' }, () => {
      Route.get('/controller', 'index').name('index')
    })

    const kernel = await makeKernel()
    const options = await kernel.server.inject({ method: 'OPTIONS', url: '/preflight' })
    const matched = await kernel.server.inject({ method: 'POST', url: '/matched' })
    const any = await kernel.server.inject({ method: 'DELETE', url: '/anything' })
    const grouped = await kernel.server.inject({ method: 'GET', url: '/grouped/controller' })

    expect(options.json()).toEqual({ ok: 'options' })
    expect(matched.json()).toEqual({ method: 'POST' })
    expect(any.json()).toEqual({ method: 'DELETE' })
    expect(grouped.json()).toEqual({ controller: 'grouped' })
    expect(Route.findByName('grouped.index')?.path).toBe('/grouped/controller')
  })

  it('supports domain routes, defaults, and current route helpers', async () => {
    app.config.set('app.url', 'https://example.com')

    Route.group({ domain: '{team}.example.com', name: 'tenant.', defaults: { locale: 'en' } }, () => {
      Route.get('/dashboard/:locale', () => ({
        name: currentRouteName(),
        routeName: Route.currentRouteName()
      })).name('dashboard')
    })
    Route.get('/dashboard/:locale', request => ({ locale: request.params.locale })).defaults('locale', 'en').name('dashboard')

    const kernel = await makeKernel()
    const tenant = await kernel.server.inject({ method: 'GET', url: '/dashboard/en', headers: { host: 'acme.example.com' } })
    const root = await kernel.server.inject({ method: 'GET', url: '/dashboard/en', headers: { host: 'example.com' } })

    expect(tenant.json()).toEqual({
      name: 'tenant.dashboard',
      routeName: 'tenant.dashboard'
    })
    expect(root.json()).toEqual({ locale: 'en' })
    expect(route('tenant.dashboard', { team: 'acme' })).toBe('https://acme.example.com/dashboard/en')
    expect(route('tenant.dashboard', { team: 'acme' }, false)).toBe('/dashboard/en')
    expect(route('dashboard')).toBe('/dashboard/en')
  })

  it('merges relative nested domain groups and lets absolute child domains override', async () => {
    app.config.set('app.url', 'https://example.com')

    Route.group({ domain: '{team}.example.com', name: 'tenant.' }, () => {
      Route.group({ domain: 'api', name: 'api.' }, () => {
        Route.get('/status', request => ({ team: request.params.team })).name('status')
      })
      Route.group({ domain: 'admin.example.net', name: 'admin.' }, () => {
        Route.get('/status', () => ({ ok: true })).name('status')
      })
    })

    const kernel = await makeKernel()
    const nested = await kernel.server.inject({ method: 'GET', url: '/status', headers: { host: 'api.acme.example.com' } })
    const overridden = await kernel.server.inject({ method: 'GET', url: '/status', headers: { host: 'admin.example.net' } })

    expect(nested.json()).toEqual({ team: 'acme' })
    expect(overridden.json()).toEqual({ ok: true })
    expect(Route.findByName('tenant.api.status')?.domain).toBe('api.{team}.example.com')
    expect(Route.findByName('tenant.admin.status')?.domain).toBe('admin.example.net')
    expect(route('tenant.api.status', { team: 'acme' })).toBe('https://api.acme.example.com/status')
  })

  it('supports redirect and view route shortcuts', async () => {
    const { ViewFactory } = await import('@lib/view/ViewFactory.js')
    app.instance(ViewFactory, new ViewFactory(path.join(app.rootPath, 'resources')))

    Route.redirect('/old-path', '/new-path', 302)
    Route.view('/welcome-view', 'home', { name: 'Ada' })

    const kernel = await makeKernel()
    const redirect = await kernel.server.inject({ method: 'GET', url: '/old-path' })
    const view = await kernel.server.inject({ method: 'GET', url: '/welcome-view' })

    expect(redirect.statusCode).toBe(302)
    expect(redirect.headers.location).toBe('/new-path')
    expect(view.body).toContain('Laravel Like DX')
  })

  it('stores route-level validation metadata', () => {
    Route.post('/users', () => {}).validate({ body: { name: 'rule' } })

    expect(Route.all()[0].validation).toEqual({ body: { name: 'rule' } })
  })

  it('dispatches string controller bindings', async () => {
    Route.get('/bound', 'controllers.bound.index')

    app.singleton('controllers.bound', () => new StringBoundController())

    const kernel = await makeKernel()
    const response = await kernel.server.inject({ method: 'GET', url: '/bound' })

    expect(response.json()).toEqual({ ok: true })
  })

  it('resolves implicit model bindings and scoped bindings', async () => {
    const alice = await User.create({ name: 'Alice', email: 'alice@example.com', password: 'secret' }) as any
    const bob = await User.create({ name: 'Bob', email: 'bob@example.com', password: 'secret' }) as any
    const post = await Post.create({ user_id: alice.id, title: 'Hello', body: 'Hello world body' }) as any

    Route.get('/posts/:post', request => ({
      title: request.params.post.title
    }))

    Route.get('/users/:user/posts/:post', request => ({
      user: request.params.user.name,
      title: request.params.post.title
    })).scopeBindings()

    const kernel = await makeKernel()
    const bound = await kernel.server.inject({ method: 'GET', url: `/posts/${post.id}` })
    const scoped = await kernel.server.inject({ method: 'GET', url: `/users/${alice.id}/posts/${post.id}` })
    const missing = await kernel.server.inject({ method: 'GET', url: `/users/${bob.id}/posts/${post.id}` })

    expect(bound.json()).toEqual({ title: 'Hello' })
    expect(scoped.json()).toEqual({ user: 'Alice', title: 'Hello' })
    expect(missing.statusCode).toBe(404)
  })

  it('uses route missing handlers and fallback routes', async () => {
    Route.get('/posts/:post', () => ({ ok: true })).missing(() => ({ message: 'missing model' }))
    Route.fallback(() => ({ message: 'fallback' }))

    const kernel = await makeKernel()
    const missing = await kernel.server.inject({ method: 'GET', url: '/posts/999' })
    const fallback = await kernel.server.inject({ method: 'GET', url: '/no-route-here' })

    expect(missing.json()).toEqual({ message: 'missing model' })
    expect(fallback.json()).toEqual({ message: 'fallback' })
  })

  it('applies route parameter constraints and fallback middleware', async () => {
    app.config.set('middleware.aliases.fallback-header', FallbackMiddleware)

    Route.get('/orders/:order', request => ({ order: request.params.order })).whereNumber('order')
    Route.group({ middleware: ['fallback-header'] }, () => {
      Route.fallback(() => ({ message: 'fallback' }))
    })

    const kernel = await makeKernel()
    const matched = await kernel.server.inject({ method: 'GET', url: '/orders/123' })
    const constrained = await kernel.server.inject({ method: 'GET', url: '/orders/abc' })
    const fallback = await kernel.server.inject({ method: 'GET', url: '/missing-route' })

    expect(matched.json()).toEqual({ order: '123' })
    expect(constrained.statusCode).toBe(404)
    expect(fallback.json()).toEqual({ message: 'fallback' })
    expect(fallback.headers['x-fallback-middleware']).toBe('yes')
  })

  it('registers resource and api resource routes', () => {
    Route.resource('posts', ResourceController)
    Route.apiResource('comments', ResourceController)

    expect(Route.findByName('posts.index')?.path).toBe('/posts')
    expect(Route.findByName('posts.create')?.path).toBe('/posts/create')
    expect(Route.findByName('posts.show')?.path).toBe('/posts/:post')
    expect(Route.findByName('comments.index')?.path).toBe('/comments')
    expect(Route.findByName('comments.create')).toBeUndefined()
    expect(Route.findByName('comments.destroy')?.path).toBe('/comments/:comment')
  })

  it('customizes resource route actions, names, and parameters', () => {
    Route.resource('photos', ResourceController)
      .only(['index', 'show', 'update'])
      .names({ index: 'gallery.index', show: 'gallery.show' })
      .parameters({ photos: 'image' })

    Route.apiResource('comments', ResourceController)
      .except(['destroy'])
      .names('feedback')
      .parameters({ comments: 'message' })

    expect(Route.findByName('gallery.index')?.path).toBe('/photos')
    expect(Route.findByName('gallery.show')?.path).toBe('/photos/:image')
    expect(Route.findByName('photos.update')?.path).toBe('/photos/:image')
    expect(Route.findByName('photos.create')).toBeUndefined()
    expect(Route.findByName('photos.store')).toBeUndefined()
    expect(Route.findByName('photos.edit')).toBeUndefined()
    expect(Route.all().filter(route => route.name === 'photos.update').map(route => route.method).sort()).toEqual(['PATCH', 'PUT'])

    expect(Route.findByName('feedback.index')?.path).toBe('/comments')
    expect(Route.findByName('feedback.show')?.path).toBe('/comments/:message')
    expect(Route.findByName('feedback.destroy')).toBeUndefined()
  })

  it('registers nested resource routes from dot notation', () => {
    Route.resource('photos.comments', ResourceController)
    Route.apiResource('posts.tags', ResourceController)

    expect(Route.findByName('photos.comments.index')?.path).toBe('/photos/:photo/comments')
    expect(Route.findByName('photos.comments.create')?.path).toBe('/photos/:photo/comments/create')
    expect(Route.findByName('photos.comments.show')?.path).toBe('/photos/:photo/comments/:comment')
    expect(Route.findByName('photos.comments.edit')?.path).toBe('/photos/:photo/comments/:comment/edit')
    expect(Route.all().filter(route => route.name === 'photos.comments.update').map(route => route.method).sort()).toEqual(['PATCH', 'PUT'])

    expect(Route.findByName('posts.tags.index')?.path).toBe('/posts/:post/tags')
    expect(Route.findByName('posts.tags.show')?.path).toBe('/posts/:post/tags/:tag')
    expect(Route.findByName('posts.tags.create')).toBeUndefined()
    expect(Route.findByName('posts.tags.edit')).toBeUndefined()
  })

  it('customizes nested resource route parameters', () => {
    Route.resource('photos.comments', ResourceController)
      .only(['show', 'update'])
      .parameters({ photos: 'image', comments: 'note' })

    expect(Route.findByName('photos.comments.show')?.path).toBe('/photos/:image/comments/:note')
    expect(Route.all().filter(route => route.name === 'photos.comments.update').map(route => route.path)).toEqual([
      '/photos/:image/comments/:note',
      '/photos/:image/comments/:note'
    ])
    expect(Route.findByName('photos.comments.show')?.parameters).toEqual(['image', 'note'])
  })

  it('supports shallow nested resource routes', () => {
    Route.resource('photos.comments', ResourceController).shallow()
    Route.apiResource('posts.tags', ResourceController).shallow()

    expect(Route.findByName('photos.comments.index')?.path).toBe('/photos/:photo/comments')
    expect(Route.findByName('photos.comments.create')?.path).toBe('/photos/:photo/comments/create')
    expect(Route.findByName('photos.comments.store')?.path).toBe('/photos/:photo/comments')
    expect(Route.findByName('comments.show')?.path).toBe('/comments/:comment')
    expect(Route.findByName('comments.edit')?.path).toBe('/comments/:comment/edit')
    expect(Route.all().filter(route => route.name === 'comments.update').map(route => route.path)).toEqual([
      '/comments/:comment',
      '/comments/:comment'
    ])
    expect(Route.findByName('comments.destroy')?.path).toBe('/comments/:comment')
    expect(Route.findByName('comments.show')?.parameters).toEqual(['comment'])

    expect(Route.findByName('posts.tags.index')?.path).toBe('/posts/:post/tags')
    expect(Route.findByName('tags.show')?.path).toBe('/tags/:tag')
    expect(Route.findByName('tags.destroy')?.path).toBe('/tags/:tag')
  })

  it('supports shallow routes after nested parameter customization', () => {
    Route.resource('photos.comments', ResourceController)
      .parameters({ photos: 'image', comments: 'note' })
      .shallow()

    expect(Route.findByName('photos.comments.index')?.path).toBe('/photos/:image/comments')
    expect(Route.findByName('comments.show')?.path).toBe('/comments/:note')
    expect(Route.findByName('comments.show')?.parameters).toEqual(['note'])
  })

  it('applies scoped bindings and missing callbacks to nested resources', async () => {
    const alice = await User.create({ name: 'Alice', email: 'alice-resource@example.com', password: 'secret' }) as any
    const bob = await User.create({ name: 'Bob', email: 'bob-resource@example.com', password: 'secret' }) as any
    const post = await Post.create({ user_id: alice.id, title: 'Nested Post', body: 'Scoped body' }) as any

    Route.resource('users.posts', NestedPostResourceController)
      .only(['show'])
      .scopeBindings()
      .missing(() => ({ message: 'nested resource missing' }))

    Route.apiResource('accounts.posts', ResourceController)
      .only(['show'])
      .scoped()

    const kernel = await makeKernel()
    const valid = await kernel.server.inject({ method: 'GET', url: `/users/${alice.id}/posts/${post.id}` })
    const mismatched = await kernel.server.inject({ method: 'GET', url: `/users/${bob.id}/posts/${post.id}` })

    expect(valid.json()).toEqual({ user: 'Alice', post: 'Nested Post' })
    expect(mismatched.json()).toEqual({ message: 'nested resource missing' })
    expect(Route.findByName('accounts.posts.show')?.scopeBindings).toBe(true)
  })

  it('supports custom scoped resource binding keys', async () => {
    const alice = await User.create({ name: 'Alice', email: 'alice-key@example.com', password: 'secret' }) as any
    const bob = await User.create({ name: 'Bob', email: 'bob-key@example.com', password: 'secret' }) as any
    await Post.create({ user_id: alice.id, title: 'custom-key', body: 'Scoped body' })

    Route.resource('users.posts', NestedPostResourceController)
      .only(['show'])
      .scoped({ posts: 'title' })
      .missing(() => ({ message: 'custom key missing' }))

    const kernel = await makeKernel()
    const valid = await kernel.server.inject({ method: 'GET', url: `/users/${alice.id}/posts/custom-key` })
    const mismatched = await kernel.server.inject({ method: 'GET', url: `/users/${bob.id}/posts/custom-key` })

    expect(valid.json()).toEqual({ user: 'Alice', post: 'custom-key' })
    expect(mismatched.json()).toEqual({ message: 'custom key missing' })
    expect(Route.findByName('users.posts.show')?.scopedBindingFields).toEqual({ post: 'title' })
  })

  it('registers singleton and api singleton resource routes', () => {
    Route.singleton('profile', ResourceController)
    Route.apiSingleton('settings', ResourceController)

    expect(Route.findByName('profile.create')?.path).toBe('/profile/create')
    expect(Route.findByName('profile.store')?.path).toBe('/profile')
    expect(Route.findByName('profile.show')?.path).toBe('/profile')
    expect(Route.findByName('profile.edit')?.path).toBe('/profile/edit')
    expect(Route.findByName('profile.destroy')?.path).toBe('/profile')
    expect(Route.all().filter(route => route.name === 'profile.update').map(route => route.method).sort()).toEqual(['PATCH', 'PUT'])

    expect(Route.findByName('settings.show')?.path).toBe('/settings')
    expect(Route.findByName('settings.update')?.path).toBe('/settings')
    expect(Route.findByName('settings.destroy')?.path).toBe('/settings')
    expect(Route.findByName('settings.create')).toBeUndefined()
    expect(Route.findByName('settings.edit')).toBeUndefined()
  })

  it('customizes singleton route actions and names', () => {
    Route.singleton('account', ResourceController)
      .except(['destroy'])
      .names({ show: 'account.current', update: 'account.save' })

    Route.apiSingleton('preferences', ResourceController)
      .only(['show', 'update'])
      .names('user.preferences')

    expect(Route.findByName('account.current')?.path).toBe('/account')
    expect(Route.all().filter(route => route.name === 'account.save').map(route => route.method).sort()).toEqual(['PATCH', 'PUT'])
    expect(Route.findByName('account.destroy')).toBeUndefined()

    expect(Route.findByName('user.preferences.show')?.path).toBe('/preferences')
    expect(Route.all().filter(route => route.name === 'user.preferences.update').map(route => route.method).sort()).toEqual(['PATCH', 'PUT'])
    expect(Route.findByName('user.preferences.destroy')).toBeUndefined()
  })
})
