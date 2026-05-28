import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import { Readable } from 'node:stream'

import { Application } from '@lib/foundation/Application.js'
import {
  action as actionUrl,
  clearRouteDefaults,
  currentRouteName,
  hasValidSignature,
  route,
  routeDefaults,
  setApplication,
  signedRoute,
  currentUrl,
  fullUrl,
  previousUrl,
  request,
  response
} from '@lib/foundation/helpers.js'
import { HttpKernel } from '@lib/http/Kernel.js'
import { Route } from '@lib/http/Route.js'
import { Controller } from '@lib/http/Controller.js'
import { Request } from '@lib/http/Request.js'
import { Response } from '@lib/http/Response.js'
import { RateLimiter, RateLimit } from '@lib/http/RateLimiter.js'
import { MiddlewarePipeline } from '@lib/http/Middleware.js'
import { ExceptionHandler } from '@lib/http/ExceptionHandler.js'
import { SessionMiddleware } from '@lib/http/SecurityMiddleware.js'
import { Log } from '@lib/logging/LogManager.js'

import { DB } from '@lib/database/DB.js'
import { User } from '@app/Models/User.js'
import { Post } from '@app/Models/Post.js'
import { FormRequest } from '@lib/validation/FormRequest.js'
import { schema } from '@lib/validation/schema.js'
import { ShareErrorsFromSessionMiddleware } from '@lib/validation/ValidationMiddleware.js'
import { runCliCommand } from '@lib/cli/runCliCommand.js'
import { Arr, collect, Concurrency, Context, FluentString, Http, LazyCollection, Number as NumberFormatter, Obj, Process, ProcessResult, Str, Uri } from '@lib/index.js'

describe('Routing API', () => {
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
    expect(view.body).toContain('Laravel-style velocity')
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

describe('Controllers', () => {
  class StoreArticleRequest extends FormRequest {
    rules() {
      return {
        title: schema.string().minLength(3)
      }
    }

    prepareForValidation() {
      this.merge({ title: this.input<string>('title', '').trim() })
    }
  }

  class DeniedRequest extends StoreArticleRequest {
    authorize() {
      return false
    }
  }

  class ArticleService {
    makeTitle(value: string) {
      return value.toUpperCase()
    }
  }

  class ArticleController extends Controller {
    static inject = [ArticleService]
    static requests = {
      store: StoreArticleRequest,
      denied: DeniedRequest
    }

    constructor(private articles: ArticleService) {
      super()
    }

    index() {
      return [{ id: 1 }]
    }

    store(request: StoreArticleRequest) {
      return { title: this.articles.makeTitle(request.validated<{ title: string }>().title) }
    }

    redirect(_request, response) {
      return response.redirect('/articles')
    }

    denied(request: DeniedRequest) {
      return request.validated()
    }
  }

  async function makeKernel() {
    const app = new Application(process.cwd())
    setApplication(app)
    app.instance(ArticleService, new ArticleService())
    app.config.set('middleware.global', [])
    app.config.set('security.helmet', false)
    const kernel = new HttpKernel(app)
    await kernel.bootstrap({ loadRoutes: false })
    return kernel
  }

  afterEach(() => {
    Route.clear()
  })

  it('returns JSON-compatible controller results', async () => {
    Route.get('/articles', [ArticleController, 'index'])

    const kernel = await makeKernel()
    const response = await kernel.server.inject({ method: 'GET', url: '/articles' })

    expect(response.json()).toEqual([{ id: 1 }])
  })

  it('supports controller dependency injection and FormRequest validation', async () => {
    Route.post('/articles', [ArticleController, 'store'])

    const kernel = await makeKernel()
    const response = await kernel.server.inject({
      method: 'POST',
      url: '/articles',
      payload: { title: '  maxima  ' }
    })

    expect(response.json()).toEqual({ title: 'MAXIMA' })
  })

  it('returns validation errors before the controller action runs', async () => {
    Route.post('/articles', [ArticleController, 'store'])

    const kernel = await makeKernel()
    const response = await kernel.server.inject({
      method: 'POST',
      url: '/articles',
      payload: { title: 'x' }
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ message: 'Validation failed' })
  })

  it('supports redirects through the response helper', async () => {
    Route.get('/articles/redirect', [ArticleController, 'redirect'])

    const kernel = await makeKernel()
    const response = await kernel.server.inject({ method: 'GET', url: '/articles/redirect' })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/articles')
  })

  it('runs FormRequest authorization before the controller action', async () => {
    Route.post('/api/articles/denied', [ArticleController, 'denied'])

    const kernel = await makeKernel()
    const response = await kernel.server.inject({
      method: 'POST',
      url: '/api/articles/denied',
      payload: { title: 'Maxima' }
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ message: 'This action is unauthorized.' })
  })
})

describe('Middleware System', () => {
  class GlobalMiddleware {
    async handle(request, _reply, next) {
      request.raw.headers['x-global-ran'] = 'yes'
      await next()
    }
  }

  class ParameterMiddleware {
    async handle(_request, reply, next, params) {
      reply.header('x-middleware-params', params)
      await next()
    }
  }

  class StopMiddleware {
    async handle(_request, reply) {
      return reply.code(204).send()
    }
  }

  class CountingMiddleware {
    async handle(request, _reply, next) {
      request.raw.headers['x-counted-middleware'] = String(Number(request.raw.headers['x-counted-middleware'] ?? 0) + 1)
      await next()
    }
  }

  async function makeKernel(app: Application) {
    setApplication(app)
    app.config.set('security.helmet', false)
    const kernel = new HttpKernel(app)
    await kernel.bootstrap({ loadRoutes: false })
    return kernel
  }

  afterEach(() => {
    Route.clear()
  })

  it('runs global and route middleware aliases with parameters', async () => {
    Route.get('/middleware', request => ({
      global: request.headers['x-global-ran']
    })).middleware('throttle:100,1m')

    const app = new Application(process.cwd())
    app.config.set('middleware.global', ['global'])
    app.config.set('middleware.aliases.global', GlobalMiddleware)
    app.config.set('middleware.aliases.throttle', ParameterMiddleware)

    const kernel = await makeKernel(app)
    const response = await kernel.server.inject({ method: 'GET', url: '/middleware' })

    expect(response.json()).toEqual({ global: 'yes' })
    expect(response.headers['x-middleware-params']).toBe('100,1m')
  })

  it('expands middleware groups', async () => {
    Route.get('/grouped', () => ({ ok: true })).middleware('api')

    const app = new Application(process.cwd())
    app.config.set('middleware.global', [])
    app.config.set('middleware.groups.api', ['throttle:60,1m'])
    app.config.set('middleware.aliases.throttle', ParameterMiddleware)

    const kernel = await makeKernel(app)
    const response = await kernel.server.inject({ method: 'GET', url: '/grouped' })

    expect(response.headers['x-middleware-params']).toBe('60,1m')
  })

  it('removes route middleware without removing global middleware', async () => {
    Route.get('/without', request => ({
      count: request.headers['x-counted-middleware']
    })).middleware('counted').withoutMiddleware('counted')

    const app = new Application(process.cwd())
    app.config.set('middleware.global', ['counted'])
    app.config.set('middleware.aliases.counted', CountingMiddleware)

    const kernel = await makeKernel(app)
    const response = await kernel.server.inject({ method: 'GET', url: '/without' })

    expect(response.json()).toEqual({ count: '1' })
  })

  it('removes middleware from route groups and expanded middleware groups', async () => {
    Route.group({ middleware: ['web'], withoutMiddleware: ['counted'] }, () => {
      Route.get('/without-group', request => ({
        count: request.headers['x-counted-middleware']
      }))
    })

    const app = new Application(process.cwd())
    app.config.set('middleware.global', [])
    app.config.set('middleware.groups.web', ['counted', 'throttle:60,1m'])
    app.config.set('middleware.aliases.counted', CountingMiddleware)
    app.config.set('middleware.aliases.throttle', ParameterMiddleware)

    const kernel = await makeKernel(app)
    const response = await kernel.server.inject({ method: 'GET', url: '/without-group' })

    expect(response.json()).toEqual({})
    expect(response.headers['x-middleware-params']).toBe('60,1m')
  })

  it('stops before the controller when middleware sends a response without next', async () => {
    Route.get('/stop', () => ({ shouldNotRun: true })).middleware('stop')

    const app = new Application(process.cwd())
    app.config.set('middleware.global', [])
    app.config.set('middleware.aliases.stop', StopMiddleware)

    const kernel = await makeKernel(app)
    const response = await kernel.server.inject({ method: 'GET', url: '/stop' })

    expect(response.statusCode).toBe(204)
    expect(response.body).toBe('')
  })

  it('guards against calling next more than once', async () => {
    const pipeline = new MiddlewarePipeline([
      async (_request, _reply, next) => {
        await next()
        await next()
      }
    ])

    await expect(pipeline.run({} as any, {} as any)).rejects.toThrow('next() called multiple times')
  })
})

describe('HttpKernel', () => {
  class HeaderMiddleware {
    async handle(_request, reply, next) {
      reply.header('x-maxima-middleware', 'active')
      await next()
    }
  }

  class GreetingService {
    message() {
      return 'hello'
    }
  }

  class GreetingController {
    static inject = [GreetingService]

    constructor(private greeting: GreetingService) {}

    index() {
      return { message: this.greeting.message() }
    }
  }

  class RedirectTargetController {
    show() {
      return { ok: true }
    }
  }

  class TeapotError extends Error {}
  class IgnoredError extends Error {}
  class PredicateIgnoredError extends Error {}
  class DuplicateError extends Error {}
  class ThrottledError extends Error {}
  class NotFoundButReportedError extends Error {
    statusCode = 404
  }
  class WarningContextError extends Error {
    context() {
      return { tenant: 'acme' }
    }
  }
  class RenderDependency {
    value() {
      return 'injected-render-dependency'
    }
  }

  async function makeKernel(setup?: (app: Application) => void) {
    const app = new Application(path.join(process.cwd(), 'src'))
    setApplication(app)
    app.config.set('middleware.aliases.header', HeaderMiddleware)
    app.config.set('middleware.aliases.session', SessionMiddleware)
    app.config.set('middleware.aliases.shareErrorsFromSession', ShareErrorsFromSessionMiddleware)
    app.config.set('middleware.groups.web', ['header'])
    app.config.set('middleware.global', [])
    app.config.set('security.helmet', false)
    app.instance(GreetingService, new GreetingService())
    app.instance(RenderDependency, new RenderDependency())
    setup?.(app)
    const kernel = new HttpKernel(app)
    await kernel.bootstrap({ loadRoutes: false })
    return kernel
  }

  afterEach(() => {
    Route.clear()
    Request.flushMacros()
    Response.flushMacros()
    Log.restore()
  })

  it('registers routes and returns JSON responses', async () => {
    Route.get('/health', () => ({ ok: true }))

    const kernel = await makeKernel()
    const response = await kernel.server.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
  })

  it('runs configured route middleware groups', async () => {
    Route.get('/web', () => ({ ok: true })).middleware('web')

    const kernel = await makeKernel()
    const response = await kernel.server.inject({ method: 'GET', url: '/web' })

    expect(response.headers['x-maxima-middleware']).toBe('active')
  })

  it('resolves controller dependencies through the application container', async () => {
    Route.get('/greeting', [GreetingController, 'index'])

    const kernel = await makeKernel()
    const response = await kernel.server.inject({ method: 'GET', url: '/greeting' })

    expect(response.json()).toEqual({ message: 'hello' })
  })

  it('returns JSON validation errors for route-level validation', async () => {
    Route.post('/users', request => request.validated()).validate({
      body: {
        email: schema.string().email()
      }
    })

    const kernel = await makeKernel()
    const response = await kernel.server.inject({
      method: 'POST',
      url: '/users',
      payload: { email: 'not-an-email' }
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ message: 'Validation failed' })
  })

  it('validates and merges body, query, and params data at the route level', async () => {
    Route.post('/users/:id', request => request.validated()).validate({
      body: {
        name: schema.string().minLength(3)
      },
      query: {
        page: schema.integer()
      },
      params: {
        id: schema.integer()
      }
    })

    const kernel = await makeKernel()
    const response = await kernel.server.inject({
      method: 'POST',
      url: '/users/42?page=2',
      payload: { name: 'Maxima' }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ name: 'Maxima', page: 2, id: 42 })
  })

  it('renders not found responses for JSON and HTML requests', async () => {
    const kernel = await makeKernel()

    const jsonResponse = await kernel.server.inject({
      method: 'GET',
      url: '/missing',
      headers: { accept: 'application/json' }
    })

    const htmlResponse = await kernel.server.inject({
      method: 'GET',
      url: '/missing'
    })

    expect(jsonResponse.statusCode).toBe(404)
    expect(jsonResponse.json()).toEqual({ message: 'Not Found' })
    expect(htmlResponse.statusCode).toBe(404)
    expect(htmlResponse.headers['content-type']).toContain('text/html')
    expect(htmlResponse.body).toContain('Not Found')
  })

  it('exposes request and response helpers during request handling', async () => {
    Route.get('/context', () => ({
      name: request().input('name'),
      responseHelper: typeof response().redirect === 'function',
      current: currentUrl(),
      full: fullUrl(),
      previous: previousUrl('/fallback')
    }))

    const kernel = await makeKernel()
    const injectResponse = await kernel.server.inject({
      method: 'GET',
      url: '/context?name=Maxima',
      headers: { host: 'example.test', referer: '/previous' }
    })

    expect(injectResponse.json()).toEqual({
      name: 'Maxima',
      responseHelper: true,
      current: 'http://example.test/context',
      full: 'http://example.test/context?name=Maxima',
      previous: '/previous'
    })
  })

  it('supports response macros', async () => {
    Response.macro('acceptedJson', function (this: Response, payload: Record<string, unknown>) {
      return this.json({ accepted: true, ...payload }, 202)
    })
    Route.get('/macro-response', (_request, response) => response.acceptedJson({ id: 7 }))

    const kernel = await makeKernel()
    const injectResponse = await kernel.server.inject({ method: 'GET', url: '/macro-response' })

    expect(injectResponse.statusCode).toBe(202)
    expect(injectResponse.json()).toEqual({ accepted: true, id: 7 })
  })

  it('supports redirect helpers for back, named routes, and controller actions', async () => {
    Route.get('/posts/:id', () => ({ ok: true })).name('posts.show')
    Route.get('/controllers/:id', [RedirectTargetController, 'show'])
    Route.get('/go-back', (_request, response) => response.back())
    Route.get('/go-route', (_request, response) => response.route('posts.show', { id: 12, tab: 'comments' }))
    Route.get('/go-action', (_request, response) => response.action([RedirectTargetController, 'show'], { id: 34 }))

    const kernel = await makeKernel()
    const back = await kernel.server.inject({ method: 'GET', url: '/go-back', headers: { referer: '/previous' } })
    const named = await kernel.server.inject({ method: 'GET', url: '/go-route' })
    const action = await kernel.server.inject({ method: 'GET', url: '/go-action' })

    expect(back.headers.location).toBe('/previous')
    expect(named.headers.location).toBe('/posts/12?tab=comments')
    expect(action.headers.location).toBe('/controllers/34')
  })

  it('supports streamed responses and stream downloads', async () => {
    Route.get('/stream-response', (_request, response) => response.stream(Readable.from(['hello'])))
    Route.get('/stream-download', (_request, response) => response.streamDownload(Readable.from(['file']), 'report.txt'))

    const kernel = await makeKernel()
    const streamed = await kernel.server.inject({ method: 'GET', url: '/stream-response' })
    const download = await kernel.server.inject({ method: 'GET', url: '/stream-download' })

    expect(streamed.body).toBe('hello')
    expect(download.body).toBe('file')
    expect(download.headers['content-disposition']).toBe('attachment; filename="report.txt"')
  })

  it('supports range and conditional file responses', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-file-response-'))
    const filePath = path.join(directory, 'sample.txt')
    await fs.writeFile(filePath, '0123456789')
    Route.get('/sample-file', (_request, response) => response.file(filePath))
    Route.get('/sample-download', (_request, response) => response.download(filePath, 'sample.txt'))

    const kernel = await makeKernel()
    const full = await kernel.server.inject({ method: 'GET', url: '/sample-file' })
    const partial = await kernel.server.inject({ method: 'GET', url: '/sample-file', headers: { range: 'bytes=2-5' } })
    const multi = await kernel.server.inject({ method: 'GET', url: '/sample-file', headers: { range: 'bytes=0-1,7-9' } })
    const unsatisfiable = await kernel.server.inject({ method: 'GET', url: '/sample-file', headers: { range: 'bytes=50-60' } })
    const cached = await kernel.server.inject({
      method: 'GET',
      url: '/sample-file',
      headers: { 'if-none-match': String(full.headers.etag) }
    })
    const download = await kernel.server.inject({ method: 'GET', url: '/sample-download' })

    expect(full.statusCode).toBe(200)
    expect(full.body).toBe('0123456789')
    expect(full.headers['accept-ranges']).toBe('bytes')
    expect(full.headers.etag).toBeTruthy()
    expect(full.headers['last-modified']).toBeTruthy()
    expect(partial.statusCode).toBe(206)
    expect(partial.body).toBe('2345')
    expect(partial.headers['content-range']).toBe('bytes 2-5/10')
    expect(multi.statusCode).toBe(206)
    expect(multi.headers['content-type']).toContain('multipart/byteranges')
    expect(multi.body).toContain('Content-Range: bytes 0-1/10')
    expect(multi.body).toContain('Content-Range: bytes 7-9/10')
    expect(multi.body).toContain('\r\n01\r\n')
    expect(multi.body).toContain('\r\n789\r\n')
    expect(unsatisfiable.statusCode).toBe(416)
    expect(unsatisfiable.headers['content-range']).toBe('bytes */10')
    expect(cached.statusCode).toBe(304)
    expect(cached.body).toBe('')
    expect(download.headers['content-disposition']).toBe('attachment; filename="sample.txt"')
  })

  it('supports request macros, enum input, and file array accessors', async () => {
    const Status = { draft: 'draft', published: 'published' } as const
    const Role = { admin: 'admin', editor: 'editor' } as const
    Request.macro('tenant', function (this: Request) {
      return this.headers['x-tenant'] ?? 'default'
    })
    Route.post('/request-helpers', request => {
      ;(request.raw as any).files = { avatar: [{ filename: 'a.png' }, { filename: 'b.png' }] }
      return {
        tenant: request.tenant(),
        status: request.enum('status', Status),
        roles: request.enums('roles', Role),
        files: request.files('avatar').map(file => file.filename)
      }
    })

    const kernel = await makeKernel()
    const injectResponse = await kernel.server.inject({
      method: 'POST',
      url: '/request-helpers',
      headers: { 'x-tenant': 'acme' },
      payload: { status: 'published', roles: ['admin', 'editor', 'ignored'] }
    })

    expect(injectResponse.json()).toEqual({
      tenant: 'acme',
      status: 'published',
      roles: ['admin', 'editor'],
      files: ['a.png', 'b.png']
    })
  })

  it('normalizes nested multipart file array field names', async () => {
    Route.post('/nested-files', request => {
      ;(request.raw as any).files = {
        'photos[0]': { filename: 'cover.png' },
        'photos[1]': { filename: 'detail.png' },
        'documents[contracts][0]': { filename: 'contract-a.pdf' },
        'documents[contracts][1]': { filename: 'contract-b.pdf' },
        'documents[ids][front]': { filename: 'front.png' }
      }

      return {
        photo: request.file('photos.0')?.filename,
        photos: request.files('photos').map(file => file.filename),
        contracts: request.files('documents.contracts').map(file => file.filename),
        idFront: request.file('documents[ids][front]')?.filename
      }
    })

    const kernel = await makeKernel()
    const injectResponse = await kernel.server.inject({ method: 'POST', url: '/nested-files' })

    expect(injectResponse.json()).toEqual({
      photo: 'cover.png',
      photos: ['cover.png', 'detail.png'],
      contracts: ['contract-a.pdf', 'contract-b.pdf'],
      idFront: 'front.png'
    })
  })

  it('flashes request input to the session and reads old input', async () => {
    Route.post('/flash-input', request => {
      request.flashOnly(['name'])
      return { ok: true }
    }).middleware('session')
    Route.get('/old-input', request => ({ name: request.old('name') })).middleware('session')

    const kernel = await makeKernel()
    const first = await kernel.server.inject({
      method: 'POST',
      url: '/flash-input',
      payload: { name: 'Ada', ignore: true }
    })
    const setCookie = Array.isArray(first.headers['set-cookie']) ? first.headers['set-cookie'][0] : first.headers['set-cookie']
    const cookie = setCookie?.split(';')[0]
    const second = await kernel.server.inject({
      method: 'GET',
      url: '/old-input',
      headers: { cookie }
    })

    expect(second.json()).toEqual({ name: 'Ada' })
  })

  it('flashes named error bags and old input through redirect responses', async () => {
    Route.post('/submit-login', (_request, response) => {
      return response
        .withInput({ email: 'ada@example.test' })
        .withErrors({ email: ['Invalid credentials'] }, 'login')
        .back()
    }).middleware('session')
    Route.get('/login-form', request => ({
      oldEmail: request.old('email'),
      login: request.errors('login'),
      defaultErrors: request.errors(),
      first: request.firstError('email', 'login'),
      hasEmail: request.hasError('email', 'login'),
      bags: Object.keys(request.errorBags())
    })).middleware(['session', 'shareErrorsFromSession'])

    const kernel = await makeKernel()
    const submitted = await kernel.server.inject({
      method: 'POST',
      url: '/submit-login',
      headers: { referer: '/login-form' }
    })
    const cookie = (Array.isArray(submitted.headers['set-cookie']) ? submitted.headers['set-cookie'][0] : submitted.headers['set-cookie'])?.split(';')[0]
    const form = await kernel.server.inject({
      method: 'GET',
      url: '/login-form',
      headers: { cookie }
    })

    expect(submitted.statusCode).toBe(302)
    expect(submitted.headers.location).toBe('/login-form')
    expect(form.json()).toEqual({
      oldEmail: 'ada@example.test',
      login: { email: ['Invalid credentials'] },
      defaultErrors: {},
      first: 'Invalid credentials',
      hasEmail: true,
      bags: ['login']
    })
  })

  it('uses forwarded request data only for trusted proxies', async () => {
    Route.get('/proxy-info', request => ({
      ip: request.ip(),
      url: request.url(),
      fullUrl: request.fullUrl()
    }))

    const untrustedKernel = await makeKernel()
    const untrusted = await untrustedKernel.server.inject({
      method: 'GET',
      url: '/proxy-info?via=edge',
      headers: {
        host: 'internal.test',
        'x-forwarded-for': '203.0.113.10',
        'x-forwarded-host': 'public.test',
        'x-forwarded-proto': 'https'
      }
    })

    expect(untrusted.json()).toEqual({
      ip: '127.0.0.1',
      url: 'http://internal.test/proxy-info',
      fullUrl: 'http://internal.test/proxy-info?via=edge'
    })

    const trustedKernel = await makeKernel(app => {
      app.config.set('http.trustedProxies', ['loopback'])
    })
    const trusted = await trustedKernel.server.inject({
      method: 'GET',
      url: '/proxy-info?via=edge',
      headers: {
        host: 'internal.test',
        'x-forwarded-for': '203.0.113.10, 10.0.0.5',
        'x-forwarded-host': 'public.test',
        'x-forwarded-proto': 'https'
      }
    })

    expect(trusted.json()).toEqual({
      ip: '203.0.113.10',
      url: 'https://public.test/proxy-info',
      fullUrl: 'https://public.test/proxy-info?via=edge'
    })
  })

  it('supports custom exception reporting and rendering callbacks', async () => {
    const reported: string[] = []
    Route.get('/teapot', () => {
      throw new TeapotError('short and stout')
    })

    const kernel = await makeKernel(app => {
      const exceptions = new ExceptionHandler()
      exceptions.reportable(error => {
        reported.push(error.message)
      })
      exceptions.renderable((error, _request, response) => {
        if (error instanceof TeapotError) {
          return response.json({ message: error.message, handled: true }, 418)
        }
      })
      app.instance(ExceptionHandler, exceptions)
    })

    const response = await kernel.server.inject({ method: 'GET', url: '/teapot' })

    expect(response.statusCode).toBe(418)
    expect(response.json()).toEqual({ message: 'short and stout', handled: true })
    expect(reported).toEqual(['short and stout'])
  })

  it('does not report ignored exception types', async () => {
    const reported: string[] = []
    Route.get('/ignored', () => {
      throw new IgnoredError('ignored boom')
    })

    const kernel = await makeKernel(app => {
      const exceptions = new ExceptionHandler()
      exceptions.dontReport(IgnoredError)
      exceptions.reportable(error => {
        reported.push(error.message)
      })
      app.instance(ExceptionHandler, exceptions)
    })

    const response = await kernel.server.inject({
      method: 'GET',
      url: '/ignored',
      headers: { accept: 'application/json' }
    })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({ message: 'ignored boom' })
    expect(reported).toEqual([])
  })

  it('supports predicate ignores, stopIgnoring, duplicate suppression, and throttling', async () => {
    const reported: string[] = []
    const duplicate = new DuplicateError('duplicate boom')

    Route.get('/predicate-ignored', () => {
      throw new PredicateIgnoredError('skip by predicate')
    })
    Route.get('/stopped-ignoring', () => {
      throw new NotFoundButReportedError('report this 404')
    })
    Route.get('/duplicate', () => {
      throw duplicate
    })
    Route.get('/throttled', () => {
      throw new ThrottledError('throttled boom')
    })

    const kernel = await makeKernel(app => {
      const exceptions = new ExceptionHandler()
      exceptions
        .dontReportWhen(error => error instanceof PredicateIgnoredError)
        .stopIgnoring(NotFoundButReportedError)
        .dontReportDuplicates()
        .throttle(ThrottledError, 1, 60_000)
        .reportable(error => {
          reported.push(error.message)
        })
      app.instance(ExceptionHandler, exceptions)
    })

    await kernel.server.inject({ method: 'GET', url: '/predicate-ignored', headers: { accept: 'application/json' } })
    await kernel.server.inject({ method: 'GET', url: '/stopped-ignoring', headers: { accept: 'application/json' } })
    await kernel.server.inject({ method: 'GET', url: '/duplicate', headers: { accept: 'application/json' } })
    await kernel.server.inject({ method: 'GET', url: '/duplicate', headers: { accept: 'application/json' } })
    await kernel.server.inject({ method: 'GET', url: '/throttled', headers: { accept: 'application/json' } })
    await kernel.server.inject({ method: 'GET', url: '/throttled', headers: { accept: 'application/json' } })

    expect(reported).toEqual(['report this 404', 'duplicate boom', 'throttled boom'])
  })

  it('supports exception log levels, context methods, and injectable render callbacks', async () => {
    Log.fake()
    Route.get('/warning-context', () => {
      throw new WarningContextError('warn boom')
    })
    Route.get('/injectable-render', () => {
      throw new TeapotError('render me')
    })

    const renderable = ((error: TeapotError, dependency: RenderDependency, response: Response) => {
      return response.json({ message: error.message, dependency: dependency.value() }, 418)
    }) as any
    renderable.inject = [TeapotError, RenderDependency, Response]

    const kernel = await makeKernel(app => {
      const exceptions = new ExceptionHandler()
      exceptions
        .level(WarningContextError, 'warn')
        .renderable(renderable)
      app.instance(ExceptionHandler, exceptions)
    })

    await kernel.server.inject({ method: 'GET', url: '/warning-context', headers: { accept: 'application/json' } })
    const rendered = await kernel.server.inject({ method: 'GET', url: '/injectable-render' })

    Log.assertLogged('warn', 'warn boom')
    const warning = (Log as any).fakeRecords.find(record => record.level === 'warn')
    expect(warning.context.tenant).toBe('acme')
    expect(rendered.statusCode).toBe(418)
    expect(rendered.json()).toEqual({ message: 'render me', dependency: 'injected-render-dependency' })
  })
})

describe('HTTP & Routing Extras', () => {
  class DummyService {
    getValue() { return 'injected-service-value' }
  }

  class InlineController {
    static injectMethods = {
      myMethod: [DummyService, Request, Response]
    }

    async myMethod(service: DummyService, request: Request, response: Response) {
      return response.json({
        val: service.getValue(),
        param: request.query.name
      })
    }
  }

  const originalBasePath = process.env.MAXIMA_BASE_PATH
  let root = ''
  let app: Application

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-http-extras-'))
    const srcPath = path.join(root, 'src')
    process.env.MAXIMA_BASE_PATH = srcPath

    app = new Application(srcPath)
    setApplication(app)
    app.config.set('middleware.global', [])
    app.config.set('security.helmet', false)
    app.config.set('cache', {
      default: 'memory',
      stores: {
        memory: { driver: 'memory', prefix: 'http_extras_test' }
      }
    })

    // Register DummyService
    app.singleton(DummyService, () => new DummyService())

    // Register throttle middleware alias
    const { ThrottleMiddleware } = await import('@lib/http/SecurityMiddleware.js')
    app.config.set('middleware.aliases.throttle', ThrottleMiddleware)

    // Create routes and config directories
    await fs.mkdir(path.join(srcPath, 'routes'), { recursive: true })
    await fs.mkdir(path.join(srcPath, 'config'), { recursive: true })
    await fs.writeFile(path.join(srcPath, 'routes', 'web.ts'), '')
    await fs.writeFile(path.join(srcPath, 'routes', 'api.ts'), '')
  })

  afterEach(async () => {
    process.env.MAXIMA_BASE_PATH = originalBasePath
    Route.clear()
    RateLimiter.clear()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('supports method-level dependency injection', async () => {
    Route.get('/inline', [InlineController, 'myMethod'])

    const kernel = new HttpKernel(app)
    await kernel.bootstrap({ loadRoutes: false })

    const response = await kernel.server.inject({
      method: 'GET',
      url: '/inline?name=test-injection'
    })

    expect(response.json()).toEqual({
      val: 'injected-service-value',
      param: 'test-injection'
    })
  })

  it('supports custom rate limiters and ThrottleMiddleware', async () => {
    // 2 requests per minute limit
    RateLimiter.for('custom-limiter', (request) => {
      return RateLimit.perMinute(2).by('fixed-test-key')
    })

    Route.get('/limited', () => ({ ok: true })).middleware('throttle:custom-limiter')

    const kernel = new HttpKernel(app)
    await kernel.bootstrap({ loadRoutes: false })

    // First request
    let response = await kernel.server.inject({ method: 'GET', url: '/limited' })
    expect(response.statusCode).toBe(200)
    expect(Number(response.headers['x-ratelimit-remaining'])).toBe(1)

    // Second request
    response = await kernel.server.inject({ method: 'GET', url: '/limited' })
    expect(response.statusCode).toBe(200)
    expect(Number(response.headers['x-ratelimit-remaining'])).toBe(0)

    // Third request
    response = await kernel.server.inject({ method: 'GET', url: '/limited' })
    expect(response.statusCode).toBe(429)
    expect(response.json()).toEqual({ message: 'Too Many Attempts.' })
  })

  it('serializes routes to routes.json using route:cache and boots from it', async () => {
    // Write a dummy controller file so route:cache can resolve it
    const controllerDir = path.join(root, 'src', 'app', 'Http', 'Controllers')
    await fs.mkdir(controllerDir, { recursive: true })
    
    // We export a test controller class
    await fs.writeFile(path.join(controllerDir, 'CacheTestController.ts'), `
      export class CacheTestController {
        async index(request, response) {
          return { cache: 'hit' }
        }
      }
    `)

    // Write a route referencing it to the web.ts route file
    await fs.writeFile(path.join(root, 'src', 'routes', 'web.ts'), `
      import { Route } from '@lib/http/Route.js'
      import { CacheTestController } from '../app/Http/Controllers/CacheTestController.js'
      Route.get('/cache-test', [CacheTestController, 'index']).name('cache.test')
    `)

    // Run route:cache CLI command
    await runCliCommand(['route:cache'])

    const cachePath = path.join(root, 'src', 'storage', 'framework', 'routes.json')
    expect(fsSync.existsSync(cachePath)).toBe(true)

    // Clear all routes from memory
    Route.clear()
    expect(Route.all().length).toBe(0)

    // Bootstrap a new kernel (which will load routes from cache)
    const newKernel = new HttpKernel(app)
    await newKernel.bootstrap({ loadRoutes: true })

    // Verify route was restored from cache and works
    const response = await newKernel.server.inject({ method: 'GET', url: '/cache-test' })
    expect(response.json()).toEqual({ cache: 'hit' })

    // Run route:clear command
    await runCliCommand(['route:clear'])
    expect(fsSync.existsSync(cachePath)).toBe(false)
  })

  it('renders a Laravel-like debug page for HTML 500 errors when debug is enabled', async () => {
    app.config.set('app.debug', true)
    Route.get('/debug-page', () => {
      throw new Error('debug boom')
    })

    const kernel = new HttpKernel(app)
    await kernel.bootstrap({ loadRoutes: false })

    const response = await kernel.server.inject({ method: 'GET', url: '/debug-page' })

    expect(response.statusCode).toBe(500)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('Application Error')
    expect(response.body).toContain('debug boom')
    expect(response.body).toContain('routing.test.ts')
  })

  it('renders a debug page correctly even when a non-Error string is thrown', async () => {
    app.config.set('app.debug', true)
    Route.get('/debug-page-string', () => {
      throw 'string boom'
    })

    const kernel = new HttpKernel(app)
    await kernel.bootstrap({ loadRoutes: false })

    const response = await kernel.server.inject({ method: 'GET', url: '/debug-page-string' })

    expect(response.statusCode).toBe(500)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('Application Error')
    expect(response.body).toContain('string boom')
  })

  it('renders a debug page highlighting the controller when a string is thrown in a controller method', async () => {
    app.config.set('app.debug', true)
    const { pathToFileURL } = await import('node:url')

    // Write a dummy controller file
    const controllersDir = path.join(root, 'src', 'app', 'Http', 'Controllers')
    await fs.mkdir(controllersDir, { recursive: true })
    const controllerFilePath = path.join(controllersDir, 'DummyExceptionController.ts')
    await fs.writeFile(
      controllerFilePath,
      `import { Controller } from '@lib/http/Controller.js'
export class DummyExceptionController extends Controller {
  async boom() {
    throw 'controller string boom'
  }
}`
    )

    // Import the controller class reference dynamically
    const { DummyExceptionController } = await import(pathToFileURL(controllerFilePath).href)

    Route.get('/debug-controller-string', [DummyExceptionController, 'boom'])

    const kernel = new HttpKernel(app)
    await kernel.bootstrap({ loadRoutes: false })

    const response = await kernel.server.inject({ method: 'GET', url: '/debug-controller-string' })

    expect(response.statusCode).toBe(500)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('Application Error')
    expect(response.body).toContain('controller string boom')
    expect(response.body).toContain('DummyExceptionController.ts')
    expect(response.body).toContain('async boom()')
  })


  it('supports controller method model injection', async () => {
    const { Schema } = await import('@lib/database/Schema.js')
    const { DB } = await import('@lib/database/DB.js')
    const { pathToFileURL } = await import('node:url')

    app.config.set('database.default', 'sqlite')
    app.config.set('database.connections.sqlite', {
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })

    await Schema.create('users', table => {
      table.increments('id')
      table.string('name')
    })
    await DB.table('users').insert({ id: 1, name: 'Bob' })

    const modelsDir = path.join(root, 'src', 'app', 'Models')
    await fs.mkdir(modelsDir, { recursive: true })
    await fs.writeFile(path.join(modelsDir, 'User.ts'), `
      import { Model } from '@lib/database/Model.js'
      export class User extends Model {
        static table = 'users'
      }
    `)

    // Load the model module so we can use the class reference in the test
    const { User } = await import(pathToFileURL(path.join(modelsDir, 'User.ts')).href)

    class UserController {
      static injectMethods = {
        show: [User, Response]
      }
      async show(user: any, response: Response) {
        return response.json({ id: user.id, name: user.name, instanceOfUser: user instanceof User })
      }
    }

    Route.get('/users/:user', [UserController, 'show'])

    const kernel = new HttpKernel(app)
    await kernel.bootstrap({ loadRoutes: false })

    const res = await kernel.server.inject({
      method: 'GET',
      url: '/users/1'
    })

    expect(res.json()).toEqual({
      id: 1,
      name: 'Bob',
      instanceOfUser: true
    })

    await DB.close()
  })

  it('supports rich request helpers on Request instance', async () => {
    Route.get('/request-helpers', (request: Request, response: Response) => {
      return response.json({
        wantsJson: request.wantsJson(),
        expectsJson: request.expectsJson(),
        ajax: request.ajax(),
        method: request.method(),
        path: request.path(),
        url: request.url(),
        fullUrl: request.fullUrl(),
        isMatches: request.is('request-*'),
        literalMatch: request.is('request-helpers'),
        literalMismatch: request.is('request.helpers'),
        isMatchesOther: request.is('other/*'),
        ip: request.ip()
      })
    })

    const kernel = new HttpKernel(app)
    await kernel.bootstrap({ loadRoutes: false })

    const res = await kernel.server.inject({
      method: 'GET',
      url: '/request-helpers?foo=bar',
      headers: {
        accept: 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        host: 'localhost:3000'
      }
    })

    const data = res.json()
    expect(data.wantsJson).toBe(true)
    expect(data.expectsJson).toBe(true)
    expect(data.ajax).toBe(true)
    expect(data.method).toBe('GET')
    expect(data.path).toBe('/request-helpers')
    expect(data.url).toBe('http://localhost:3000/request-helpers')
    expect(data.fullUrl).toBe('http://localhost:3000/request-helpers?foo=bar')
    expect(data.isMatches).toBe(true)
    expect(data.literalMatch).toBe(true)
    expect(data.literalMismatch).toBe(false)
    expect(data.isMatchesOther).toBe(false)
    expect(data.ip).toBeDefined()
  })
})

describe('HTTP Client, Processes, Collections, and Support Helpers Parity', () => {
  afterEach(() => {
    Http.restore()
    Http.flushMacros()
    Process.restore()
    FluentString.flushMacros()
  })

  it('provides fluent HTTP requests with fakes, sequences, retry, pools, middleware, macros, assertions, and response helpers', async () => {
    const sequence = Http.sequence()
      .push({ stale: true }, 500)
      .push({ ok: true }, 200)

    Http.fake({
      'https://api.example.com/users*': sequence,
      'https://api.example.com/posts': { data: [{ id: 1 }] }
    })
    Http.macro('github', function(this: any) {
      return this.baseUrl('https://api.example.com').withToken('token')
    })

    const response = await (Http.pending() as any)
      .github()
      .withHeaders({ 'X-Test': 'yes' })
      .retry(1)
      .withMiddleware(async (_request, next) => next())
      .get('/users', { page: 1 })

    const pool = await Http.baseUrl('https://api.example.com').pool(pool => {
      pool.as('posts').get('/posts')
    })

    expect(response.successful()).toBe(true)
    expect(response.json()).toEqual({ ok: true })
    expect(pool.posts.json()).toEqual({ data: [{ id: 1 }] })
    expect(() => Http.assertSent(request => request.url.includes('/users?page=1') && request.headers.get('X-Test') === 'yes')).not.toThrow()
  })

  it('handles empty-string fakes and lazy sequence callbacks', async () => {
    const sequence = Http.sequence()
      .push((url, init) => ({
        url,
        method: init.method
      }))
      .pushStatus(204)

    Http.fake({
      'https://api.example.com/empty': '',
      'https://api.example.com/sequence': sequence
    })

    const empty = await Http.get('https://api.example.com/empty')
    const first = await Http.post('https://api.example.com/sequence', { ok: true })
    const second = await Http.get('https://api.example.com/sequence')

    expect(empty.successful()).toBe(true)
    expect(empty.text()).toBe('')
    expect(first.json()).toEqual({ url: 'https://api.example.com/sequence', method: 'POST' })
    expect(second.status()).toBe(204)
  })

  it('exposes every HTTP verb and fluent request option from the manager', async () => {
    Http.fake({
      'https://api.example.com/*': (_url, init) => ({
        method: init.method,
        contentType: new Headers(init.headers as any).get('Content-Type'),
        body: init.body
      })
    })

    const put = await Http.asJson().put('https://api.example.com/users/1', { name: 'Ada' })
    const patch = await Http.patch('https://api.example.com/users/1', { active: true })
    const deleted = await Http.delete('https://api.example.com/users/1')
    const custom = await Http.send('OPTIONS', 'https://api.example.com/users')
    const pool = await Http.pool(pool => {
      pool.as('put').put('https://api.example.com/users/2', { name: 'Grace' })
      pool.as('delete').delete('https://api.example.com/users/2')
    })

    expect(put.json()).toMatchObject({ method: 'PUT', contentType: 'application/json', body: JSON.stringify({ name: 'Ada' }) })
    expect(patch.json().method).toBe('PATCH')
    expect(deleted.json().method).toBe('DELETE')
    expect(custom.json().method).toBe('OPTIONS')
    expect(pool.put.json().method).toBe('PUT')
    expect(pool.delete.json().method).toBe('DELETE')
  })

  it('provides process pools, fakes, concurrency, scoped context, and assertions', async () => {
    Process.fake((command, args) => new ProcessResult(command, 0, `${command}:${args.join(',')}`))

    const result = await Process.command('node', ['--version']).timeout(1).run()
    const pool = await Process.pool(pool => {
      pool.command('alpha')
      pool.command('beta', ['one'])
    })

    const scoped = await Context.run({ requestId: 'req-123' }, async () => {
      const values = await Concurrency.run([
        () => Context.get('requestId'),
        () => 'done'
      ], 2)
      return Concurrency.defer(() => values)
    })

    expect(result.successful()).toBe(true)
    expect(pool.map(item => item.stdout)).toEqual(['alpha:', 'beta:one'])
    expect(scoped).toEqual(['req-123', 'done'])
    expect(() => Process.assertRan('node')).not.toThrow()
  })

  it('provides collection, lazy collection, string, array/object, URI, number, and macroable helpers', async () => {
    const users = collect([
      { id: 1, name: 'Ada Lovelace', active: true, score: 10 },
      { id: 2, name: 'Grace Hopper', active: false, score: 20 },
      { id: 3, name: 'Ada Lovelace', active: true, score: 30 }
    ])

    FluentString.macro('initials', function(this: FluentString) {
      return this.toString().split(' ').map(part => part[0].toUpperCase()).join('')
    })

    const lazy = await LazyCollection.make([1, 2, 3, 4])
      .filter(value => value % 2 === 0)
      .map(value => value * 10)
      .all()

    const object: any = {}
    Arr.set(object, 'profile.name', 'Ada')
    Arr.set(object, 'profile.nickname', undefined)

    expect(users.unique('name').pluck('name').all()).toEqual(['Ada Lovelace', 'Grace Hopper'])
    expect(users.groupBy('active')).toMatchObject({ true: expect.any(Array), false: expect.any(Array) })
    expect((users.higher('filter') as any).active.pluck('id').all()).toEqual([1, 3])
    expect(users.sum('score')).toBe(60)
    expect(lazy).toEqual([20, 40])
    expect((Str.of('ada lovelace') as any).initials()).toBe('AL')
    expect(Str.slug('Hello Maxima Framework')).toBe('hello-maxima-framework')
    expect(Arr.get(object, 'profile.name')).toBe('Ada')
    expect(Arr.get(object, 'profile.empty', null)).toBe(null)
    expect(Arr.has(object, 'profile.nickname')).toBe(true)
    expect(Arr.except({ a: 1, b: 2, c: 3 }, ['b', 'c'])).toEqual({ a: 1 })
    expect(Obj.only({ a: 1, b: 2 }, ['a'])).toEqual({ a: 1 })
    expect(Uri.of('/users').query({ page: 2 }).fragment('top').toString()).toBe('http://localhost/users?page=2#top')
    expect(NumberFormatter.fileSize(1536)).toBe('1.5 KB')
  })
})
