import { afterEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { HttpKernel } from '@lib/http/Kernel.js'
import { MiddlewarePipeline } from '@lib/http/Middleware.js'
import { Route } from '@lib/http/Route.js'

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

describe('Middleware System', () => {
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
