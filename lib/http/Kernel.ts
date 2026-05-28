import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import staticFiles from '@fastify/static'
import { WebSocketServer } from 'ws'
import { Broadcast, normalizeChannelName } from '@lib/broadcast/Broadcast.js'
import { Application } from '@lib/foundation/Application.js'
import { config, publicPath, runWithRequestContext, storagePath } from '@lib/foundation/helpers.js'
import { Request } from '@lib/http/Request.js'
import { Response } from '@lib/http/Response.js'
import { ExceptionHandler } from '@lib/http/ExceptionHandler.js'
import { Route, runWithRouteContext, type RouteDefinition } from '@lib/http/Route.js'
import { MiddlewarePipeline, type MiddlewareHandler } from '@lib/http/Middleware.js'
import { ValidationException } from '@lib/validation/ValidationException.js'
import { AuthorizationException } from '@lib/auth/Gate.js'
import type { FormRequest } from '@lib/validation/FormRequest.js'

type FormRequestConstructor = new (...args: any[]) => FormRequest

export class HttpKernel {
  public server: FastifyInstance

  constructor(private app: Application) {
    this.server = fastify({
      logger: false,
      genReqId: () => randomUUID()
    })
  }

  getFastify() {
    return this.server
  }

  async bootstrap(options: { loadRoutes?: boolean } = {}) {
    await this.registerFastifyPlugins()
    if (options.loadRoutes ?? true) await this.loadRoutes()
    this.registerBroadcastingRoutes()
    this.registerRoutes()
    this.registerErrorHandler()
    this.setupWebSockets()
    await this.server.ready()
    return this.server
  }

  async listen(port = Number(config('app.port', 3000)), host = String(config('app.host', '127.0.0.1'))) {
    await this.bootstrap()
    await this.server.listen({ port, host })

    return {
      port,
      host
    }
  }

  private async registerFastifyPlugins() {
    await this.server.register(cookie, config('cookie', {}))
    const corsConfig = config<any>('cors', { origin: true })
    if (corsConfig !== false) await this.server.register(cors, corsConfig)
    await this.server.register(helmet, config('security.helmet', {}))
    await this.server.register(multipart)
    await this.server.register(rateLimit, config('rateLimit.global', { max: 60, timeWindow: '1 minute' }))
    if (fs.existsSync(publicPath())) {
      await this.server.register(staticFiles, { root: publicPath(), prefix: '/assets/', decorateReply: false })
    }
  }

  private async loadRoutes() {
    const cachePath = storagePath('framework/routes.json')
    if (fs.existsSync(cachePath)) {
      try {
        const content = fs.readFileSync(cachePath, 'utf8')
        const data = JSON.parse(content)
        Route.clear()

        const reconstructAction = async (actionData: any) => {
          if (!actionData) return null
          if (actionData.type === 'string') {
            return actionData.action
          }
          if (actionData.type === 'array') {
            const { className, file, method } = actionData
            const fullPath = path.join(this.app.rootPath, file)
            const mod = await import(`${pathToFileURL(fullPath).href}?t=${Date.now()}`)
            const ControllerClass = mod[className] ?? mod.default ?? mod[Object.keys(mod)[0]]
            return [ControllerClass, method]
          }
          return null
        }

        for (const r of data.routes) {
          const action = await reconstructAction(r.action)
          if (!action) continue
          const routeDef: RouteDefinition = {
            method: r.method,
            path: r.path,
            action: action,
            name: r.name,
            domain: r.domain,
            middleware: r.middleware ?? [],
            excludedMiddleware: r.excludedMiddleware ?? [],
            validation: r.validation,
            parameters: r.parameters,
            defaults: r.defaults,
            where: r.where,
            scopeBindings: r.scopeBindings,
            scopedBindingFields: r.scopedBindingFields
          }
          Route.all().push(routeDef)
        }

        if (data.fallback) {
          const action = await reconstructAction(data.fallback.action)
          if (action) {
            const fallbackRoute = {
              method: data.fallback.method,
              path: data.fallback.path,
              action: action,
              domain: data.fallback.domain,
              middleware: data.fallback.middleware ?? [],
              excludedMiddleware: data.fallback.excludedMiddleware ?? [],
              parameters: data.fallback.parameters ?? [],
              defaults: data.fallback.defaults
            }
            Route['fallbackRoute'] = fallbackRoute
          }
        }
        return
      } catch (err) {
        console.warn('Failed to load cached routes, falling back to file routes:', err)
      }
    }

    for (const file of ['routes/web.js', 'routes/web.ts', 'routes/api.js', 'routes/api.ts', 'routes/channels.js', 'routes/channels.ts']) {
      const fullPath = path.join(this.app.rootPath, file)
      if (fs.existsSync(fullPath)) {
        try {
          await import(`${pathToFileURL(fullPath).href}?t=${Date.now()}`)
        } catch (error: any) {
          if (error.code !== 'ERR_MODULE_NOT_FOUND' && error.code !== 'MODULE_NOT_FOUND') throw error
        }
      }
    }
  }

  private registerRoutes() {
    const groups = new Map<string, RouteDefinition[]>()
    for (const route of Route.all()) {
      const key = `${route.method} ${route.path}`
      groups.set(key, [...(groups.get(key) ?? []), route])
    }

    for (const routes of groups.values()) {
      const first = routes[0]
      this.server.route({
        method: first.method,
        url: first.path,
        handler: async (rawRequest, reply) => {
          const route = this.selectRoute(routes, rawRequest)
          if (!route) {
            const error = new Error('Not Found')
            ;(error as any).statusCode = 404
            throw error
          }
          return this.handle(route, rawRequest, reply)
        }
      })
    }
  }

  private registerBroadcastingRoutes() {
    this.server.post('/broadcasting/auth', async (rawRequest, reply) => {
      const request = new Request(rawRequest, reply)
      const middleware = await this.resolveRouteMiddleware(config<string[]>('broadcasting.middleware', ['web', 'auth']), [])
      const middlewareComplete = await new MiddlewarePipeline(middleware).run(request, reply)
      if (reply.sent) return
      if (!middlewareComplete) return

      const body = rawRequest.body as any ?? {}
      const socketId = body.socket_id ?? body.socketId
      const channelName = body.channel_name ?? body.channelName
      const user = request.user?.() ?? body.user ?? body.authUser ?? (rawRequest as any).user ?? null
      if (!socketId || !channelName) return reply.code(422).send({ message: 'socket_id and channel_name are required.' })

      try {
        return reply.send(await Broadcast.authResponse(user, socketId, channelName))
      } catch {
        return reply.code(403).send({ message: 'Unauthorized' })
      }
    })
  }

  private selectRoute(routes: RouteDefinition[], rawRequest: FastifyRequest) {
    const host = String(rawRequest.headers.host ?? '').split(':')[0]
    for (const route of routes) {
      const domainParameters = matchDomain(route.domain, host)
      if (!domainParameters) continue
      Object.assign(rawRequest.params as any, domainParameters)
      return route
    }
    return undefined
  }

  private async handle(route: RouteDefinition, rawRequest: FastifyRequest, reply: FastifyReply) {
    if (this.isDownForMaintenance(rawRequest.url)) {
      return reply.code(503).send({ message: 'Service Unavailable' })
    }
    const request = new Request(rawRequest, reply)
    const response = new Response(reply)
    ;(rawRequest as any).maximaRequest = request
    ;(rawRequest as any).currentRoute = route
    if (route.defaults) {
      for (const [key, value] of Object.entries(route.defaults)) {
        if ((rawRequest.params as any)[key] === undefined) (rawRequest.params as any)[key] = value
      }
    }

    return runWithRouteContext(route, () => runWithRequestContext(request, response, async () => {
      const middleware = await this.resolveRouteMiddleware(route.middleware, route.excludedMiddleware)
      const middlewareComplete = await new MiddlewarePipeline(middleware).run(request, reply)
      if (reply.sent) return
      if (!middlewareComplete) return
      if (!this.routeParameterConstraintsPass(route, request)) {
        const error = new Error('Not Found')
        ;(error as any).statusCode = 404
        throw error
      }

      if (route.validation) {
        const validated = {}
        for (const key of ['body', 'query', 'params'] as const) {
          const rules = route.validation[key]
          if (!rules) continue
          const data = await request.validate(rules, request[key])
          Object.assign(validated, data)
        }
        request.setValidated(validated)
      }

      const boundResult = await this.resolveRouteBindings(route, request, reply)
      if (boundResult !== undefined) return this.respond(reply, boundResult)

      const result = await this.callAction(route.action, request, reply)
      if ((request.raw as any).session?.commit) {
        await (request.raw as any).session.commit(reply)
      }
      if (reply.sent) return
      return this.respond(reply, result)
    }))
  }

  private async callAction(action: RouteDefinition['action'], request: Request, reply: FastifyReply) {
    if (Array.isArray(action)) {
      const [ControllerClass, method] = action
      const controller = await this.app.make<any>(ControllerClass)
      const actionRequest = await this.resolveActionRequest(controller, method, request, reply)

      let injectList: any[] | undefined
      if (ControllerClass.injectMethods?.[method]) {
        injectList = ControllerClass.injectMethods[method]
      } else if (ControllerClass.prototype?.[method]?.inject) {
        injectList = ControllerClass.prototype[method].inject
      } else if (ControllerClass[method]?.inject) {
        injectList = ControllerClass[method].inject
      }

      if (injectList) {
        const args = await Promise.all(injectList.map(async (key) => {
          if (key === Request || (key && typeof key === 'function' && (key.prototype instanceof Request || key === Request))) {
            return actionRequest
          }
          if (key === Response) {
            return new Response(reply)
          }
          const paramValue = Object.values(actionRequest.params).find(
            val => val && typeof val === 'object' && (val instanceof key || val.constructor === key)
          )
          if (paramValue) {
            return paramValue
          }
          return this.app.make(key)
        }))
        return controller[method](...args)
      }

      return controller[method](actionRequest, new Response(reply))
    }

    if (typeof action === 'function') {
      const injectList = (action as any).inject
      if (injectList) {
        const args = await Promise.all(injectList.map(async (key) => {
          if (key === Request || (key && typeof key === 'function' && (key.prototype instanceof Request || key === Request))) {
            return request
          }
          if (key === Response) {
            return new Response(reply)
          }
          const paramValue = Object.values(request.params).find(
            val => val && typeof val === 'object' && (val instanceof key || val.constructor === key)
          )
          if (paramValue) {
            return paramValue
          }
          return this.app.make(key)
        }))
        return action(...args)
      }
      return action(request, new Response(reply))
    }

    if (typeof action === 'string') {
      const separator = action.lastIndexOf('.')
      const binding = action.slice(0, separator)
      const method = action.slice(separator + 1)
      const controller = await this.app.make<any>(binding)
      const actionRequest = await this.resolveActionRequest(controller, method, request, reply)
      const ControllerClass = controller.constructor

      let injectList: any[] | undefined
      if (ControllerClass.injectMethods?.[method]) {
        injectList = ControllerClass.injectMethods[method]
      } else if (ControllerClass.prototype?.[method]?.inject) {
        injectList = ControllerClass.prototype[method].inject
      } else if (ControllerClass[method]?.inject) {
        injectList = ControllerClass[method].inject
      }

      if (injectList) {
        const args = await Promise.all(injectList.map(async (key) => {
          if (key === Request || (key && typeof key === 'function' && (key.prototype instanceof Request || key === Request))) {
            return actionRequest
          }
          if (key === Response) {
            return new Response(reply)
          }
          const paramValue = Object.values(actionRequest.params).find(
            val => val && typeof val === 'object' && (val instanceof key || val.constructor === key)
          )
          if (paramValue) {
            return paramValue
          }
          return this.app.make(key)
        }))
        return controller[method](...args)
      }

      return controller[method](actionRequest, new Response(reply))
    }
  }

  private async resolveActionRequest(controller: any, method: string, request: Request, reply: FastifyReply) {
    const RequestClass = controller.constructor.requests?.[method] as FormRequestConstructor | undefined
    if (!RequestClass) return request

    const formRequest = new RequestClass(request.raw, reply)
    await formRequest.validateResolved(key => this.app.make(key))
    return formRequest
  }

  private respond(reply: FastifyReply, value: unknown) {
    if (value === undefined) return reply.send()
    if (typeof value === 'string') return reply.type('text/html').send(value)
    return reply.send(value)
  }

  private async resolveRouteBindings(route: RouteDefinition, request: Request, reply: FastifyReply) {
    const params = { ...request.params }
    const boundModels: Record<string, any> = {}
    const keys = route.parameters?.length ? route.parameters : Object.keys(params)

    for (const key of keys) {
      const value = params[key]
      if (value === undefined) continue

      const resolved = await this.resolveModelBinding(key, value, route, boundModels)
      if (resolved === value) continue
      if (resolved === null) {
        if (route.missing) {
          const result = await route.missing(request, reply)
          return result
        }
        const error = new Error(`Route model binding for [${key}] failed.`)
        ;(error as any).statusCode = 404
        throw error
      }

      params[key] = resolved
      boundModels[key] = resolved
    }

    ;(request.raw as any).params = params
  }

  private async resolveMiddleware(names: string[]) {
    return this.resolveRouteMiddleware(names, [])
  }

  private async resolveRouteMiddleware(names: string[], excluded: string[] = []) {
    const testingExcluded = this.app.config.get<string[]>('__testing.withoutMiddleware', [])
    if (testingExcluded.includes('*')) return []
    excluded = [...excluded, ...testingExcluded]
    const aliases = config<Record<string, any>>('middleware.aliases', {})
    const groups = config<Record<string, string[]>>('middleware.groups', {})
    const global = config<string[]>('middleware.global', [])
    const routeNames = names
      .filter(name => !middlewareIsExcluded(name, excluded))
      .flatMap(name => groups[name] ?? [name])
      .filter(name => !middlewareIsExcluded(name, excluded))
    const expanded = [...global, ...routeNames]

    const handlers: MiddlewareHandler[] = []
    for (const entry of expanded) {
      const [name, ...params] = entry.split(':')
      const Middleware = aliases[name]
      if (!Middleware) continue
      const instance = typeof Middleware === 'function' ? await this.app.make<any>(Middleware) : Middleware
      handlers.push((request, reply, next) => instance.handle(request, reply, next, params.join(':')))
    }
    return handlers
  }

  private registerErrorHandler() {
    this.server.setNotFoundHandler(async (request, reply) => {
      const fallback = Route.getFallback()
      if (fallback) {
        const maximaRequest = (request as any).maximaRequest as Request | undefined
        const resolvedRequest = maximaRequest ?? new Request(request, reply)
        const response = new Response(reply)
        const middleware = await this.resolveRouteMiddleware(fallback.middleware, fallback.excludedMiddleware)
        const middlewareComplete = await new MiddlewarePipeline(middleware).run(resolvedRequest, reply)
        if (reply.sent) return
        if (!middlewareComplete) return
        const result = await this.callAction(fallback.action, resolvedRequest, reply)
        if (reply.sent) return
        return this.respond(reply, result)
      }

      const acceptsJson = request.url.startsWith('/api') || request.headers.accept?.includes('application/json')
      request.log?.warn?.({ url: request.url }, 'Route not found')
      if (acceptsJson) return reply.code(404).send({ message: 'Not Found' })
      return this.renderErrorPage(reply, 404, 'errors.404', { url: request.url, message: 'Not Found' })
    })

    this.server.setErrorHandler(async (error, request, reply) => {
      let exception: Error
      if (error instanceof Error) {
        exception = error
      } else if (error && typeof error === 'object' && 'message' in error) {
        exception = error as Error
      } else {
        exception = new Error(typeof error === 'string' ? error : String(error || 'Unknown error'))
      }

      if (error && typeof error === 'object') {
        const anyError = error as any
        const anyException = exception as any
        if ('statusCode' in anyError && !('statusCode' in anyException)) {
          anyException.statusCode = anyError.statusCode
        }
        if ('status' in anyError && !('status' in anyException)) {
          anyException.status = anyError.status
        }
      }

      if (this.app.config.get('__testing.withoutExceptionHandling', false)) throw exception
      const maximaRequest = (request as any).maximaRequest as Request | undefined
      const resolvedRequest = maximaRequest ?? new Request(request, reply)
      const response = new Response(reply)
      const handler = await this.exceptionHandler()

      await handler.report(exception, resolvedRequest)

      if (exception instanceof ValidationException) {
        const acceptsHtml = request.headers.accept?.includes('text/html')
        const acceptsJson = request.url.startsWith('/api') || (
          !acceptsHtml && (
            resolvedRequest.expectsJson() ||
            request.headers.accept?.includes('application/json') ||
            (request.headers['content-type'] as string | undefined)?.includes('application/json')
          )
        )
        if (!acceptsJson) {
          const session = (request.raw as any).session
          if (session) {
            session.flashErrors(exception.errors, exception.errorBag)
            session.flashInput(resolvedRequest.input())
          }
        }
      }

      if ((request.raw as any).session?.commit) {
        await (request.raw as any).session.commit(reply)
      }

      const rendered = await handler.render(exception, resolvedRequest, response)
      if (reply.sent) return
      if (rendered !== undefined) return this.respond(reply, rendered)
      return this.renderDefaultError(exception, request, reply)
    })
  }

  private async exceptionHandler() {
    const handler = this.app.has(ExceptionHandler)
      ? await this.app.make<ExceptionHandler>(ExceptionHandler)
      : new ExceptionHandler()
    handler.setResolver((key: any) => this.app.make(key))
    return handler
  }

  private renderDefaultError(error: Error, request: FastifyRequest, reply: FastifyReply) {
    const maximaRequest = (request as any).maximaRequest as Request | undefined
    const acceptsHtml = request.headers.accept?.includes('text/html')
    const acceptsJson = request.url.startsWith('/api') || (
      !acceptsHtml && (
        maximaRequest?.expectsJson() ||
        request.headers.accept?.includes('application/json') ||
        (request.headers['content-type'] as string | undefined)?.includes('application/json')
      )
    )
    if (error instanceof ValidationException) {
      if (acceptsJson) {
        return reply.code(422).send({ message: 'Validation failed', errors: error.errors })
      }
      const redirectUrl = error.redirectTo ?? (maximaRequest?.headers['referer'] as string | undefined) ?? '/'
      return reply.redirect(redirectUrl)
    }
    if (error instanceof AuthorizationException) {
      if (acceptsJson) return reply.code(403).send({ message: error.message })
      return this.renderErrorPage(reply, 403, 'errors.403', { message: error.message })
    }
    const status = Number((error as any).statusCode ?? 500)
    if (acceptsJson) return reply.code(status).send({ message: (error as Error).message })
    if (status >= 500 && this.isDebugMode()) {
      return this.renderDebugErrorPage(reply, error, maximaRequest ?? new Request(request, reply), status)
    }
    return this.renderErrorPage(reply, status, status >= 500 ? 'errors.500' : `errors.${status}`, {
      message: (error as Error).message,
      statusCode: status
    })
  }

  private async renderErrorPage(reply: FastifyReply, statusCode: number, template: string, data: Record<string, unknown>) {
    try {
      const { ViewFactory } = await import('@lib/view/ViewFactory.js')
      const viewFactory = await this.app.make<any>(ViewFactory)
      const html = await viewFactory.render(template, data)
      return reply.code(statusCode).type('text/html').send(html)
    } catch {
      return reply.code(statusCode).type('text/plain').send(statusCode === 404 ? 'Not Found' : statusCode === 403 ? 'Forbidden' : 'Server Error')
    }
  }

  private async renderDebugErrorPage(reply: FastifyReply, error: Error, request: Request, statusCode: number) {
    try {
      const { ViewFactory } = await import('@lib/view/ViewFactory.js')
      let viewFactory = await this.app.make<any>(ViewFactory)
      if (!viewFactory.exists('errors.debug')) {
        let frameworkRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
        if (path.basename(frameworkRoot) === 'dist') {
          frameworkRoot = path.dirname(frameworkRoot)
        }
        const bundledViews = path.join(frameworkRoot, 'src', 'resources')
        const bundledTemplate = path.join(bundledViews, 'views', 'errors', 'debug.edge')
        if (fs.existsSync(bundledTemplate)) {
          viewFactory = new ViewFactory(bundledViews, storagePath('framework/views'))
        }
      }
      const debug = this.buildDebugErrorData(error, request, statusCode)
      const html = await viewFactory.render('errors.debug', debug)
      return reply.code(statusCode).type('text/html').send(html)
    } catch (renderError) {
      return this.renderErrorPage(reply, statusCode, 'errors.500', {
        message: error.message,
        statusCode
      })
    }
  }

  private buildDebugErrorData(error: Error, request: Request, statusCode: number) {
    const frames = this.parseStack(error.stack ?? '')
    let source = frames[0] ? this.readSourceFrame(frames[0]) : null
    if (!source && (request.raw as any).currentRoute) {
      const fallbackFrame = this.findControllerSourceFrame((request.raw as any).currentRoute)
      if (fallbackFrame) {
        source = this.readSourceFrame(fallbackFrame)
      }
    }
    return {
      statusCode,
      errorName: error.name,
      message: error.message,
      req: {
        method: request.method(),
        url: request.url(),
        fullUrl: request.fullUrl(),
        ip: request.ip(),
        route: (request.raw as any).currentRoute?.name ?? (request.raw as any).currentRoute?.path ?? request.path()
      },
      app: {
        name: this.app.config.get('app.name', 'Maxima'),
        env: this.app.config.get('app.env', 'local'),
        debug: this.app.config.get('app.debug', false)
      },
      sourceFile: source ? source.file : 'No source frame available',
      sourceHtml: source ? this.buildSourceMarkup(source) : '',
      traceCount: frames.length,
      traceHtml: this.buildTraceMarkup(frames),
      stack: error.stack ?? ''
    }
  }

  private findControllerSourceFrame(route: RouteDefinition) {
    if (!route || !Array.isArray(route.action)) return null
    const [ControllerClass, method] = route.action
    if (typeof ControllerClass !== 'function') return null
    const className = ControllerClass.name
    if (!className) return null

    const controllersDir = path.join(this.app.rootPath, 'app', 'Http', 'Controllers')
    if (!fs.existsSync(controllersDir)) return null

    const findFile = (dir: string, targetName: string): string | null => {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          const found = findFile(fullPath, targetName)
          if (found) return found
        } else if (entry.isFile() && (entry.name === `${targetName}.ts` || entry.name === `${targetName}.js`)) {
          return fullPath
        }
      }
      return null
    }

    const file = findFile(controllersDir, className)
    if (!file) return null

    let lineNumber = 1
    try {
      const content = fs.readFileSync(file, 'utf8')
      const lines = content.split(/\r?\n/)
      const methodRegex = new RegExp(`(?:async\\s+)?${method}\\s*\\(`)
      for (let i = 0; i < lines.length; i++) {
        if (methodRegex.test(lines[i])) {
          lineNumber = i + 1
          break
        }
      }
    } catch {
      // ignore
    }

    return {
      file,
      line: lineNumber
    }
  }


  private parseStack(stack: string) {
    return stack
      .split('\n')
      .map(line => line.trim())
      .map(line => {
        const match = line.match(/^at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?$/)
        if (!match) return null
        const file = this.normalizeStackFile(match[2])
        if (!file || this.isInternalStackFile(file)) return null
        return {
          method: match[1] && match[1] !== 'Object.<anonymous>' ? match[1] : null,
          file,
          line: Number(match[3]),
          column: Number(match[4]),
          relative: this.relativeStackFile(file)
        }
      })
      .filter((frame): frame is { method: string | null, file: string, line: number, column: number, relative: string } => Boolean(frame))
  }

  private normalizeStackFile(file: string) {
    if (file.startsWith('file://')) return fileURLToPath(file)
    if (file.startsWith('node:')) return file
    return path.resolve(file)
  }

  private isInternalStackFile(file: string) {
    const frameworkLib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    return file.startsWith('node:') || 
           file.includes(`${path.sep}node_modules${path.sep}`) || 
           file.includes(`${path.sep}internal${path.sep}`) ||
           file.startsWith(frameworkLib)
  }

  private relativeStackFile(file: string) {
    const root = this.app.rootPath
    if (file.startsWith(root)) return path.relative(root, file).replace(/\\/g, '/')
    return file.replace(/\\/g, '/')
  }

  private readSourceFrame(frame: { file: string, line: number }) {
    try {
      const contents = fs.readFileSync(frame.file, 'utf8').split(/\r?\n/)
      const start = Math.max(0, frame.line - 4)
      const end = Math.min(contents.length, frame.line + 2)
      return {
        file: this.relativeStackFile(frame.file),
        line: frame.line,
        snippet: contents.slice(start, end).map((content, index) => {
          const lineNumber = start + index + 1
          return {
            number: lineNumber,
            content,
            highlight: lineNumber === frame.line
          }
        })
      }
    } catch {
      return null
    }
  }

  private buildSourceMarkup(source: { file: string, snippet: Array<{ number: number, content: string, highlight: boolean }> }) {
    return source.snippet.map(line => `
      <div class="code-line${line.highlight ? ' highlight' : ''}">
        <span class="line-number">${line.number}</span>
        <span class="line-content">${this.escapeHtml(line.content)}</span>
      </div>
    `).join('')
  }

  private buildTraceMarkup(frames: Array<{ method: string | null, relative: string, line: number, column: number }>) {
    return frames.map(frame => `
      <div class="trace-item">
        <p class="trace-method">${this.escapeHtml(frame.method || 'anonymous')}</p>
        <p class="trace-path">${this.escapeHtml(frame.relative)}:${frame.line}:${frame.column}</p>
      </div>
    `).join('')
  }

  private escapeHtml(value: string) {
    return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char] ?? char))
  }

  private isDebugMode() {
    return Boolean(this.app.config.get('app.debug', false))
  }

  private async resolveModelBinding(param: string, value: any, route: RouteDefinition, boundModels: Record<string, any>) {
    const modelName = this.normalizeModelName(param)
    const modelClass = await this.loadModelClass(modelName)
    if (!modelClass) return value

    const bindingField = route.scopedBindingFields?.[param]
    const primaryKey = modelClass.primaryKey ?? 'id'
    const model = bindingField && bindingField !== primaryKey
      ? await modelClass.query?.().where(bindingField, value).first()
      : await modelClass.find?.(value)
    if (!model) return null

    if (route.scopeBindings) {
      for (const [parentParam, parentModel] of Object.entries(boundModels)) {
        const foreignKey = `${parentParam}_id`
        if (foreignKey in model && parentModel?.id !== undefined && String((model as any)[foreignKey]) !== String(parentModel.id)) {
          return null
        }
      }
    }

    return model
  }

  private routeParameterConstraintsPass(route: RouteDefinition, request: Request) {
    if (!route.where) return true
    for (const [parameter, pattern] of Object.entries(route.where)) {
      const value = request.params[parameter]
      if (value === undefined) continue
      const regex = new RegExp(`^(?:${pattern})$`)
      if (!regex.test(String(value))) return false
    }
    return true
  }

  private async loadModelClass(name: string) {
    const file = path.join(this.app.rootPath, 'app', 'Models', `${name}.js`)
    try {
      const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`)
      return mod.default ?? mod[name] ?? mod[Object.keys(mod)[0]]
    } catch (error: any) {
      if (
        error.code === 'ERR_MODULE_NOT_FOUND' ||
        error.code === 'MODULE_NOT_FOUND' ||
        error.message?.includes('Failed to load url') ||
        error.message?.includes('Cannot find module')
      ) {
        return null
      }
      throw error
    }
  }

  private normalizeModelName(name: string) {
    const singular = name.endsWith('s') ? name.slice(0, -1) : name
    return singular.charAt(0).toUpperCase() + singular.slice(1)
  }

  private wss: WebSocketServer | undefined
  private unsubscribeBroadcaster?: () => void

  private setupWebSockets() {
    this.wss = new WebSocketServer({ noServer: true })
    const subscriptions = new Map<any, Set<string>>()

    this.wss.on('connection', (ws) => {
      ;(ws as any).socketId = `${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`
      subscriptions.set(ws, new Set())
      ws.send(JSON.stringify({
        event: 'pusher:connection_established',
        data: JSON.stringify({ socket_id: (ws as any).socketId, activity_timeout: 120 })
      }))

      ws.on('message', async (messageData) => {
        try {
          const data = JSON.parse(messageData.toString())
          const eventName = data.event
          const eventData = normalizeSocketData(data.data ?? data)
          if (eventName === 'subscribe' || eventName === 'pusher:subscribe') {
            const channel = normalizeChannelName(eventData.channel ?? data.channel)
            if (!channel) return

            let authorized = false
            let user: any = null
            if (!channel.startsWith('private-') && !channel.startsWith('presence-')) {
              authorized = true
            } else {
              if (eventData.channel_data) {
                try {
                  const channelData = typeof eventData.channel_data === 'string' ? JSON.parse(eventData.channel_data) : eventData.channel_data
                  user = channelData.user_info ?? { id: channelData.user_id }
                } catch {}
              }
              if (!user && eventData.auth) {
                try {
                  const { SessionManager } = await import('@lib/session/Session.js')
                  const sessionManager = new SessionManager()
                  const fakeReq = { cookies: { maxima_session: eventData.auth } }
                  const session = await sessionManager.load(fakeReq)
                  const userId = session.data?._user_id
                  if (userId) {
                    const { User } = await import('@app/Models/User.js')
                    user = await User.find(userId as any)
                  }
                } catch {}

                if (!user) {
                  try {
                    user = JSON.parse(eventData.auth)
                  } catch {}
                }
              }

              authorized = await Broadcast.authorize(user, channel)
            }

            if (authorized) {
              if (channel.startsWith('presence-')) {
                ;(ws as any).presenceUsers ??= {}
                ;(ws as any).presenceUsers[channel] = user
              }
              subscriptions.get(ws)?.add(channel)
              if (channel.startsWith('presence-')) {
                const members = Broadcast.joinPresence(channel, user)
                ws.send(JSON.stringify({ event: 'subscription_succeeded', channel, members }))
                ws.send(JSON.stringify({ event: 'pusher_internal:subscription_succeeded', channel, data: JSON.stringify({ presence: { hash: presenceHash(members), count: members.length } }) }))
                this.notifyPresence(subscriptions, channel, 'member_added', user, ws)
                this.notifyPresence(subscriptions, channel, 'pusher_internal:member_added', user, ws)
              } else {
                ws.send(JSON.stringify({ event: 'subscription_succeeded', channel }))
                ws.send(JSON.stringify({ event: 'pusher_internal:subscription_succeeded', channel, data: '{}' }))
              }
            } else {
              ws.send(JSON.stringify({ event: 'subscription_error', channel, message: 'Unauthorized' }))
              ws.send(JSON.stringify({ event: 'pusher:subscription_error', channel, data: { message: 'Unauthorized' } }))
            }
          }

          if (eventName === 'unsubscribe' || eventName === 'pusher:unsubscribe') {
            const channel = normalizeChannelName(eventData.channel ?? data.channel)
            if (channel) {
              subscriptions.get(ws)?.delete(channel)
              if (channel.startsWith('presence-')) {
                const user = (ws as any).presenceUsers?.[channel]
                if (user) {
                  Broadcast.leavePresence(channel, user)
                  this.notifyPresence(subscriptions, channel, 'member_removed', user, ws)
                  this.notifyPresence(subscriptions, channel, 'pusher_internal:member_removed', user, ws)
                }
              }
              ws.send(JSON.stringify({ event: 'unsubscribed', channel }))
            }
          }

          if (typeof eventName === 'string' && eventName.startsWith('client-')) {
            const channel = normalizeChannelName(eventData.channel ?? data.channel)
            if (channel && subscriptions.get(ws)?.has(channel)) {
              await Broadcast.clientEvent(channel, eventName, eventData.data ?? data.data ?? {}, (ws as any).socketId)
            }
          }
        } catch {}
      })

      ws.on('close', () => {
        for (const channel of subscriptions.get(ws) ?? []) {
          if (channel.startsWith('presence-')) {
            const user = (ws as any).presenceUsers?.[channel]
            if (user) {
              Broadcast.leavePresence(channel, user)
              this.notifyPresence(subscriptions, channel, 'member_removed', user, ws)
              this.notifyPresence(subscriptions, channel, 'pusher_internal:member_removed', user, ws)
            }
          }
        }
        subscriptions.delete(ws)
      })
    })

    this.unsubscribeBroadcaster = Broadcast.onBroadcast((event) => {
      const channels = Array.isArray(event.channels) ? event.channels : [event.channels]
      for (const [ws, subs] of subscriptions.entries()) {
        for (const channel of channels) {
          if (subs.has(channel) && event.socket !== (ws as any).socketId) {
            ws.send(JSON.stringify({
              event: event.name,
              channel: channel,
              data: event.payload
            }))
          }
        }
      }
    })

    this.server.server.on('upgrade', (request, socket, head) => {
      if (request.url?.startsWith('/ws') || request.url?.startsWith('/broadcasting') || request.url?.startsWith('/app/')) {
        this.wss?.handleUpgrade(request, socket, head, (ws) => {
          this.wss?.emit('connection', ws, request)
        })
      }
    })
  }

  private notifyPresence(subscriptions: Map<any, Set<string>>, channel: string, event: string, user: any, except?: any) {
    for (const [client, channels] of subscriptions.entries()) {
      if (client === except || !channels.has(channel)) continue
      client.send(JSON.stringify({ event, channel, user, members: Broadcast.members(channel) }))
    }
  }

  private isDownForMaintenance(url: string) {
    if (url.startsWith('/assets/') || url.startsWith('/ws') || url.startsWith('/broadcasting') || url.startsWith('/app/')) return false
    return fs.existsSync(storagePath('framework/down'))
  }

  // Gracefully close websocket server if kernel is closed/terminated
  async close() {
    if (this.unsubscribeBroadcaster) this.unsubscribeBroadcaster()
    if (this.wss) {
      this.wss.close()
    }
    await this.server.close()
  }
}

function normalizeSocketData(data: any) {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data)
    } catch {
      return {}
    }
  }
  return data ?? {}
}

function presenceHash(members: any[]) {
  return Object.fromEntries(members.map(member => [String(member?.id ?? member?.uuid ?? member?.email), member]))
}

function matchDomain(pattern: string | undefined, host: string) {
  if (!pattern) return {}
  const parameterNames: string[] = []
  const regexPattern = pattern
    .split('.')
    .map(part => {
      const parameter = part.match(/^\{([A-Za-z_][A-Za-z0-9_]*)}$/)
      if (parameter) {
        parameterNames.push(parameter[1])
        return '([^\\.]+)'
      }
      return escapeRegex(part)
    })
    .join('\\.')
  const match = host.match(new RegExp(`^${regexPattern}$`, 'i'))
  if (!match) return undefined
  return Object.fromEntries(parameterNames.map((name, index) => [name, decodeURIComponent(match[index + 1])]))
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function middlewareIsExcluded(entry: string, excluded: string[]) {
  const name = entry.split(':')[0]
  return excluded.some(candidate => {
    const excludedName = candidate.split(':')[0]
    return candidate === entry || excludedName === name
  })
}
