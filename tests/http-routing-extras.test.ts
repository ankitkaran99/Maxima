import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCliCommand } from '@lib/cli/runCliCommand.js'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { HttpKernel } from '@lib/http/Kernel.js'
import { Route } from '@lib/http/Route.js'
import { RateLimiter, RateLimit } from '@lib/http/RateLimiter.js'
import { Request } from '@lib/http/Request.js'
import { Response } from '@lib/http/Response.js'

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

describe('HTTP & Routing Extras', () => {
  const originalBasePath = process.env.MAXIMA_BASE_PATH
  let root = ''
  let app: Application
  let logSpy: ReturnType<typeof vi.spyOn>

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

    const cachePath = path.join(root, 'src', 'bootstrap', 'cache', 'routes.json')
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
    expect(data.isMatchesOther).toBe(false)
    expect(data.ip).toBeDefined()
  })
})
