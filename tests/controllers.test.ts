import { afterEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { Controller } from '@lib/http/Controller.js'
import { HttpKernel } from '@lib/http/Kernel.js'
import { Route } from '@lib/http/Route.js'
import { FormRequest } from '@lib/validation/FormRequest.js'
import { schema } from '@lib/validation/schema.js'

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

describe('Controllers', () => {
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
