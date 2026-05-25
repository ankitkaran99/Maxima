import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { Application } from '@lib/foundation/Application.js'
import { currentUrl, fullUrl, previousUrl, request, response, setApplication } from '@lib/foundation/helpers.js'
import { ExceptionHandler } from '@lib/http/ExceptionHandler.js'
import { HttpKernel } from '@lib/http/Kernel.js'
import { Request } from '@lib/http/Request.js'
import { Response } from '@lib/http/Response.js'
import { Route } from '@lib/http/Route.js'
import { SessionMiddleware } from '@lib/http/SecurityMiddleware.js'
import { Log } from '@lib/logging/LogManager.js'
import { ShareErrorsFromSessionMiddleware } from '@lib/validation/ValidationMiddleware.js'
import { schema } from '@lib/validation/schema.js'

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

describe('HttpKernel', () => {
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
