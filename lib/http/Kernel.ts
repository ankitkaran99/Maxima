import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import staticFiles from '@fastify/static'
import { WebSocketServer } from 'ws'
import { Broadcast } from '@lib/broadcast/Broadcast.js'
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
    this.registerRoutes()
    this.registerErrorHandler()
    this.setupWebSockets()
    await this.server.ready()
    return this.server
  }

  async listen(port = Number(config('app.port', 3000)), host = String(config('app.host', '127.0.0.1'))) {
    await this.bootstrap()
    await this.server.listen({ port, host })

    console.log(`Server running at http://${host}:${port}`)
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
    const cachePath = path.join(this.app.rootPath, 'bootstrap', 'cache', 'routes.json')
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

    for (const file of ['routes/web.js', 'routes/web.ts', 'routes/api.js', 'routes/api.ts']) {
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
    await formRequest.validateResolved()
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
      const exception = error as Error
      const maximaRequest = (request as any).maximaRequest as Request | undefined
      const resolvedRequest = maximaRequest ?? new Request(request, reply)
      const response = new Response(reply)
      const handler = await this.exceptionHandler()

      await handler.report(exception, resolvedRequest)
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
    const acceptsJson = request.url.startsWith('/api') || maximaRequest?.expectsJson() || request.headers.accept?.includes('application/json')
    if (error instanceof ValidationException) {
      return reply.code(422).send({ message: 'Validation failed', errors: error.errors })
    }
    if (error instanceof AuthorizationException) {
      if (acceptsJson) return reply.code(403).send({ message: error.message })
      return this.renderErrorPage(reply, 403, 'errors.403', { message: error.message })
    }
    const status = Number((error as any).statusCode ?? 500)
    if (acceptsJson) return reply.code(status).send({ message: (error as Error).message })
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
      subscriptions.set(ws, new Set())

      ws.on('message', async (messageData) => {
        try {
          const data = JSON.parse(messageData.toString())
          if (data.event === 'subscribe') {
            const channel = data.channel
            if (!channel) return

            let authorized = false
            let user: any = null
            if (!channel.startsWith('private-') && !channel.startsWith('presence-')) {
              authorized = true
            } else {
              if (data.auth) {
                try {
                  const { SessionManager } = await import('@lib/session/Session.js')
                  const sessionManager = new SessionManager()
                  const fakeReq = { cookies: { maxima_session: data.auth } }
                  const session = await sessionManager.load(fakeReq)
                  const userId = session.data?._user_id
                  if (userId) {
                    const { User } = await import('@app/Models/User.js')
                    user = await User.find(userId as any)
                  }
                } catch {}

                if (!user) {
                  try {
                    user = JSON.parse(data.auth)
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
                this.notifyPresence(subscriptions, channel, 'member_added', user, ws)
              } else {
                ws.send(JSON.stringify({ event: 'subscription_succeeded', channel }))
              }
            } else {
              ws.send(JSON.stringify({ event: 'subscription_error', channel, message: 'Unauthorized' }))
            }
          }

          if (data.event === 'unsubscribe') {
            const channel = data.channel
            if (channel) {
              subscriptions.get(ws)?.delete(channel)
              if (channel.startsWith('presence-')) {
                const user = (ws as any).presenceUsers?.[channel]
                if (user) {
                  Broadcast.leavePresence(channel, user)
                  this.notifyPresence(subscriptions, channel, 'member_removed', user, ws)
                }
              }
              ws.send(JSON.stringify({ event: 'unsubscribed', channel }))
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
          if (subs.has(channel)) {
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
      if (request.url?.startsWith('/ws') || request.url?.startsWith('/broadcasting')) {
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
    if (url.startsWith('/assets/') || url.startsWith('/ws') || url.startsWith('/broadcasting')) return false
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
