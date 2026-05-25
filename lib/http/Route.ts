import { AsyncLocalStorage } from 'node:async_hooks'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'
export type ControllerAction = Function | [any, string] | string

export type RouteDefinition = {
  method: HttpMethod
  path: string
  action: ControllerAction
  name?: string
  domain?: string
  middleware: string[]
  excludedMiddleware?: string[]
  validation?: Record<string, any>
  parameters?: string[]
  defaults?: Record<string, string | number>
  where?: Record<string, string>
  scopeBindings?: boolean
  scopedBindingFields?: Record<string, string>
  missing?: Function
}

type GroupOptions = {
  prefix?: string
  middleware?: string | string[]
  withoutMiddleware?: string | string[]
  scopeBindings?: boolean
  name?: string
  as?: string
  controller?: any
  where?: Record<string, string>
  domain?: string
  defaults?: Record<string, string | number>
}

type ResourceAction = 'index' | 'create' | 'store' | 'show' | 'edit' | 'update' | 'destroy'
type ResourceNameMap = Partial<Record<ResourceAction, string>>
type ResourceParameterMap = Record<string, string>
type ResourceDescriptor = {
  path: string
  name: string
  memberParameter?: string
  shallowPath?: string
  shallowName?: string
  parameterByResource: Record<string, string>
}

export class PendingRoute {
  constructor(private route: RouteDefinition) {}

  definition() {
    return this.route
  }

  name(name: string) {
    this.route.name = this.route.name ? `${this.route.name}${name}` : name
    return this
  }

  middleware(middleware: string | string[]) {
    this.route.middleware.push(...(Array.isArray(middleware) ? middleware : [middleware]))
    return this
  }

  withoutMiddleware(middleware: string | string[]) {
    this.route.excludedMiddleware ??= []
    this.route.excludedMiddleware.push(...(Array.isArray(middleware) ? middleware : [middleware]))
    return this
  }

  validate(validation: Record<string, any>) {
    this.route.validation = validation
    return this
  }

  defaults(defaults: Record<string, string | number>): this
  defaults(key: string, value: string | number): this
  defaults(keyOrDefaults: string | Record<string, string | number>, value?: string | number) {
    this.route.defaults ??= {}
    if (typeof keyOrDefaults === 'string') {
      if (value !== undefined) this.route.defaults[keyOrDefaults] = value
    } else {
      Object.assign(this.route.defaults, keyOrDefaults)
    }
    return this
  }

  scopeBindings() {
    this.route.scopeBindings = true
    return this
  }

  missing(callback: Function) {
    this.route.missing = callback
    return this
  }

  where(parameter: string | Record<string, string>, pattern?: string) {
    this.route.where ??= {}
    if (typeof parameter === 'string') {
      if (pattern !== undefined) this.route.where[parameter] = pattern
    } else {
      Object.assign(this.route.where, parameter)
    }
    return this
  }

  whereNumber(parameter: string | string[]) {
    for (const key of Array.isArray(parameter) ? parameter : [parameter]) this.where(key, '[0-9]+')
    return this
  }

  whereAlpha(parameter: string | string[]) {
    for (const key of Array.isArray(parameter) ? parameter : [parameter]) this.where(key, '[A-Za-z]+')
    return this
  }

  whereAlphaNumeric(parameter: string | string[]) {
    for (const key of Array.isArray(parameter) ? parameter : [parameter]) this.where(key, '[A-Za-z0-9]+')
    return this
  }

  whereUuid(parameter: string | string[]) {
    for (const key of Array.isArray(parameter) ? parameter : [parameter]) {
      this.where(key, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}')
    }
    return this
  }

  whereIn(parameter: string, values: string[]) {
    return this.where(parameter, values.map(escapeRegex).join('|'))
  }

  domain(domain: string) {
    this.route.domain = domain
    this.route.parameters = [...new Set([...(this.route.parameters ?? []), ...extractParametersFromDomain(domain)])]
    return this
  }
}

export class Router {
  private routes: RouteDefinition[] = []
  private groupStack: GroupOptions[] = []
  private fallbackRoute?: RouteDefinition

  get(path: string, action: ControllerAction) { return this.add('GET', path, action) }
  post(path: string, action: ControllerAction) { return this.add('POST', path, action) }
  put(path: string, action: ControllerAction) { return this.add('PUT', path, action) }
  patch(path: string, action: ControllerAction) { return this.add('PATCH', path, action) }
  delete(path: string, action: ControllerAction) { return this.add('DELETE', path, action) }
  options(path: string, action: ControllerAction) { return this.add('OPTIONS', path, action) }

  match(methods: HttpMethod[], path: string, action: ControllerAction) {
    const routes = methods.map(method => this.add(method, path, action))
    return new PendingRouteGroup(routes)
  }

  any(path: string, action: ControllerAction) {
    return this.match(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], path, action)
  }

  redirect(path: string, destination: string, status = 302) {
    return this.get(path, (_request: any, response: any) => response.redirect(destination, status))
  }

  permanentRedirect(path: string, destination: string) {
    return this.redirect(path, destination, 301)
  }

  view(path: string, template: string, data: Record<string, unknown> = {}, status = 200) {
    return this.get(path, (_request: any, response: any) => response.view(template, data, status))
  }

  resource(name: string, controller: any) {
    return this.registerResource(name, controller, false)
  }

  apiResource(name: string, controller: any) {
    return this.registerResource(name, controller, true)
  }

  singleton(name: string, controller: any) {
    return this.registerSingletonResource(name, controller, false)
  }

  apiSingleton(name: string, controller: any) {
    return this.registerSingletonResource(name, controller, true)
  }

  fallback(action: ControllerAction) {
    const middleware = this.groupStack.flatMap(group => arrayify(group.middleware))
    const excludedMiddleware = this.groupStack.flatMap(group => arrayify(group.withoutMiddleware))
    const defaults = Object.assign({}, ...this.groupStack.map(group => group.defaults ?? {}))
    const domain = mergeGroupDomains(this.groupStack.map(group => group.domain))
    this.fallbackRoute = {
      method: 'GET',
      path: '__fallback__',
      action,
      middleware,
      excludedMiddleware,
      parameters: domain ? extractParametersFromDomain(domain) : []
    }
    if (domain) this.fallbackRoute.domain = domain
    if (Object.keys(defaults).length) this.fallbackRoute.defaults = defaults
    return new PendingRoute(this.fallbackRoute)
  }

  group(options: GroupOptions, callback: () => void) {
    this.groupStack.push(options)
    callback()
    this.groupStack.pop()
  }

  all() {
    return this.routes
  }

  clear() {
    this.routes = []
    this.groupStack = []
    this.fallbackRoute = undefined
  }

  findByName(name: string) {
    return this.routes.find(route => route.name === name)
  }

  getFallback() {
    return this.fallbackRoute
  }

  current() {
    return currentRouteStorage.getStore()
  }

  currentRouteName() {
    return this.current()?.name
  }

  currentRouteAction() {
    const action = this.current()?.action
    if (Array.isArray(action)) {
      const [controller, method] = action
      return typeof controller === 'function' ? `${controller.name}.${method}` : `${String(controller)}.${method}`
    }
    return typeof action === 'string' ? action : action?.name
  }

  currentRouteNamed(pattern: string | string[]) {
    const name = this.currentRouteName()
    if (!name) return false
    return (Array.isArray(pattern) ? pattern : [pattern]).some(candidate => matchesPattern(name, candidate))
  }

  removeRoutes(routes: RouteDefinition[]) {
    const remove = new Set(routes)
    this.routes = this.routes.filter(route => !remove.has(route))
  }

  private add(method: HttpMethod, path: string, action: ControllerAction) {
    const prefix = mergeGroupPrefixes(this.groupStack.map(group => group.prefix))
    const middleware = this.groupStack.flatMap(group => arrayify(group.middleware))
    const excludedMiddleware = this.groupStack.flatMap(group => arrayify(group.withoutMiddleware))
    const namePrefix = this.groupStack.map(group => group.as ?? group.name ?? '').join('')
    const controller = [...this.groupStack].reverse().find(group => group.controller)?.controller
    const where = Object.assign({}, ...this.groupStack.map(group => group.where ?? {}))
    const defaults = Object.assign({}, ...this.groupStack.map(group => group.defaults ?? {}))
    const domain = mergeGroupDomains(this.groupStack.map(group => group.domain))
    const resolvedAction = resolveGroupControllerAction(controller, action)
    const route: RouteDefinition = {
      method,
      path: normalizePath(prefix, path),
      action: resolvedAction,
      middleware,
      excludedMiddleware,
      parameters: [...new Set([...extractParameters(path), ...(domain ? extractParametersFromDomain(domain) : [])])],
      where
    }

    if (namePrefix) route.name = namePrefix
    if (domain) route.domain = domain
    if (Object.keys(defaults).length) route.defaults = defaults
    if (this.groupStack.some(group => group.scopeBindings)) route.scopeBindings = true

    this.routes.push(route)
    return new PendingRoute(route)
  }

  private registerResource(name: string, controller: any, api: boolean) {
    const resource = describeResource(name)
    const singular = resource.memberParameter ?? singularize(resource.path.split('/').pop() ?? resource.path)
    const controllerAction = (method: string) => resourceAction(controller, method)
    const definitions: Array<[HttpMethod, string, ResourceAction]> = api
      ? [
          ['GET', `/${resource.path}`, 'index'],
          ['POST', `/${resource.path}`, 'store'],
          ['GET', `/${resource.path}/:${singular}`, 'show'],
          ['PUT', `/${resource.path}/:${singular}`, 'update'],
          ['PATCH', `/${resource.path}/:${singular}`, 'update'],
          ['DELETE', `/${resource.path}/:${singular}`, 'destroy']
        ]
      : [
          ['GET', `/${resource.path}`, 'index'],
          ['GET', `/${resource.path}/create`, 'create'],
          ['POST', `/${resource.path}`, 'store'],
          ['GET', `/${resource.path}/:${singular}`, 'show'],
          ['GET', `/${resource.path}/:${singular}/edit`, 'edit'],
          ['PUT', `/${resource.path}/:${singular}`, 'update'],
          ['PATCH', `/${resource.path}/:${singular}`, 'update'],
          ['DELETE', `/${resource.path}/:${singular}`, 'destroy']
        ]

    const routes = new Map<ResourceAction, RouteDefinition[]>()
    for (const [method, path, actionMethod] of definitions) {
      const pending = this.add(method, path, controllerAction(actionMethod)).name(`${resource.name}.${actionMethod}`)
      routes.set(actionMethod, [...(routes.get(actionMethod) ?? []), pending.definition()])
    }

    return new ResourceRouteRegistration(this, resource.name, resource.memberParameter, resource.parameterByResource, routes, resource.path, resource.shallowPath, resource.shallowName)
  }

  private registerSingletonResource(name: string, controller: any, api: boolean) {
    const resource = describeResource(name, true)
    const controllerAction = (method: string) => resourceAction(controller, method)
    const definitions: Array<[HttpMethod, string, ResourceAction]> = api
      ? [
          ['GET', `/${resource.path}`, 'show'],
          ['PUT', `/${resource.path}`, 'update'],
          ['PATCH', `/${resource.path}`, 'update'],
          ['DELETE', `/${resource.path}`, 'destroy']
        ]
      : [
          ['GET', `/${resource.path}/create`, 'create'],
          ['POST', `/${resource.path}`, 'store'],
          ['GET', `/${resource.path}`, 'show'],
          ['GET', `/${resource.path}/edit`, 'edit'],
          ['PUT', `/${resource.path}`, 'update'],
          ['PATCH', `/${resource.path}`, 'update'],
          ['DELETE', `/${resource.path}`, 'destroy']
        ]

    const routes = new Map<ResourceAction, RouteDefinition[]>()
    for (const [method, path, actionMethod] of definitions) {
      const pending = this.add(method, path, controllerAction(actionMethod)).name(`${resource.name}.${actionMethod}`)
      routes.set(actionMethod, [...(routes.get(actionMethod) ?? []), pending.definition()])
    }

    return new ResourceRouteRegistration(this, resource.name, undefined, resource.parameterByResource, routes, resource.path, resource.shallowPath, resource.shallowName)
  }
}

export class ResourceRouteRegistration {
  constructor(
    private router: Router,
    private base: string,
    private parameter: string | undefined,
    private parameterByResource: Record<string, string>,
    private routes: Map<ResourceAction, RouteDefinition[]>,
    private nestedPath?: string,
    private shallowPath?: string,
    private shallowName?: string
  ) {}

  only(actions: ResourceAction[]) {
    const keep = new Set(actions)
    return this.removeActions(action => !keep.has(action))
  }

  except(actions: ResourceAction[]) {
    const remove = new Set(actions)
    return this.removeActions(action => remove.has(action))
  }

  names(names: ResourceNameMap | string) {
    if (typeof names === 'string') {
      for (const [action, routes] of this.routes) {
        for (const route of routes) route.name = `${names}.${action}`
      }
      return this
    }

    for (const [action, name] of Object.entries(names) as Array<[ResourceAction, string | undefined]>) {
      if (!name) continue
      for (const route of this.routes.get(action) ?? []) route.name = name
    }
    return this
  }

  parameters(parameters: ResourceParameterMap) {
    const replacements = new Map<string, string>()
    for (const [resource, current] of Object.entries(this.parameterByResource)) {
      const custom = parameters[resource]
      if (custom && custom !== current) replacements.set(current, custom)
    }
    if (this.parameter) {
      const custom = parameters[this.base] ?? parameters[this.base.split('.').pop() ?? this.base]
      if (custom && custom !== this.parameter) replacements.set(this.parameter, custom)
    }
    if (!replacements.size) return this

    for (const routes of this.routes.values()) {
      for (const route of routes) {
        for (const [current, custom] of replacements) {
          route.path = replaceRouteParameter(route.path, current, custom)
          route.parameters = route.parameters?.map(parameter => parameter === current ? custom : parameter)
        }
      }
    }
    for (const [resource, current] of Object.entries(this.parameterByResource)) {
      this.parameterByResource[resource] = replacements.get(current) ?? current
    }
    if (this.parameter) this.parameter = replacements.get(this.parameter) ?? this.parameter
    if (this.nestedPath) {
      for (const [current, custom] of replacements) {
        this.nestedPath = replaceRouteParameter(this.nestedPath, current, custom)
      }
    }
    return this
  }

  shallow() {
    if (!this.parameter || !this.nestedPath || !this.shallowPath || !this.shallowName) return this

    for (const action of ['show', 'edit', 'update', 'destroy'] as ResourceAction[]) {
      for (const route of this.routes.get(action) ?? []) {
        route.path = replaceNestedResourcePath(route.path, this.nestedPath, this.shallowPath)
        route.name = `${this.shallowName}.${action}`
        route.parameters = route.parameters?.filter(parameter => parameter === this.parameter || !Object.values(this.parameterByResource).includes(parameter))
      }
    }

    return this
  }

  scopeBindings() {
    for (const routes of this.routes.values()) {
      for (const route of routes) route.scopeBindings = true
    }
    return this
  }

  scoped(bindings: Record<string, string> = {}) {
    const bindingFields = new Map<string, string>()
    for (const [resource, field] of Object.entries(bindings)) {
      const parameter = this.parameterByResource[resource] ?? resource
      bindingFields.set(parameter, field)
    }

    for (const routes of this.routes.values()) {
      for (const route of routes) {
        route.scopeBindings = true
        if (bindingFields.size) {
          route.scopedBindingFields ??= {}
          for (const [parameter, field] of bindingFields) route.scopedBindingFields[parameter] = field
        }
      }
    }
    return this
  }

  missing(callback: Function) {
    for (const routes of this.routes.values()) {
      for (const route of routes) route.missing = callback
    }
    return this
  }

  private removeActions(predicate: (action: ResourceAction) => boolean) {
    const removed: RouteDefinition[] = []
    for (const [action, routes] of [...this.routes]) {
      if (!predicate(action)) continue
      removed.push(...routes)
      this.routes.delete(action)
    }
    this.router.removeRoutes(removed)
    return this
  }
}

export class PendingRouteGroup {
  constructor(private routes: PendingRoute[]) {}

  name(name: string) {
    this.routes.forEach(route => route.name(name))
    return this
  }

  middleware(middleware: string | string[]) {
    this.routes.forEach(route => route.middleware(middleware))
    return this
  }

  withoutMiddleware(middleware: string | string[]) {
    this.routes.forEach(route => route.withoutMiddleware(middleware))
    return this
  }

  validate(validation: Record<string, any>) {
    this.routes.forEach(route => route.validate(validation))
    return this
  }

  defaults(defaults: Record<string, string | number>): this
  defaults(key: string, value: string | number): this
  defaults(keyOrDefaults: string | Record<string, string | number>, value?: string | number) {
    this.routes.forEach(route => route.defaults(keyOrDefaults as any, value as any))
    return this
  }

  scopeBindings() {
    this.routes.forEach(route => route.scopeBindings())
    return this
  }

  missing(callback: Function) {
    this.routes.forEach(route => route.missing(callback))
    return this
  }

  where(parameter: string | Record<string, string>, pattern?: string) {
    this.routes.forEach(route => route.where(parameter as any, pattern))
    return this
  }

  domain(domain: string) {
    this.routes.forEach(route => route.domain(domain))
    return this
  }
}

function normalizePath(prefix: string, path: string) {
  return `/${[prefix, path].join('/').split('/').filter(Boolean).join('/')}`.replace(/\/$/, '') || '/'
}

function mergeGroupPrefixes(prefixes: Array<string | undefined>) {
  return prefixes
    .filter((prefix): prefix is string => Boolean(prefix))
    .map(prefix => prefix.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

function mergeGroupDomains(domains: Array<string | undefined>) {
  let merged: string | undefined
  for (const domain of domains) {
    if (!domain) continue
    const normalized = domain.replace(/^\.+|\.+$/g, '')
    if (!normalized) continue
    merged = merged && !normalized.includes('.')
      ? `${normalized}.${merged}`
      : normalized
  }
  return merged
}

function arrayify<T>(value: T | T[] | undefined) {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function normalizeResourceName(name: string) {
  return name.replace(/^\/+|\/+$/g, '')
}

function describeResource(name: string, singleton = false): ResourceDescriptor {
  const normalized = normalizeResourceName(name)
  const parameterByResource: Record<string, string> = {}

  if (!normalized.includes('.')) {
    const routeName = normalized.replace(/\//g, '.')
    const leaf = normalized.split('/').pop() ?? normalized
    const memberParameter = singleton ? undefined : singularize(leaf)
    if (memberParameter) parameterByResource[leaf] = memberParameter
    return {
      path: normalized,
      name: routeName,
      memberParameter,
      parameterByResource
    }
  }

  const parts = normalized.split('.').filter(Boolean)
  const pathSegments: string[] = []
  for (const [index, part] of parts.entries()) {
    pathSegments.push(part)
    if (index === parts.length - 1) continue
    const parameter = singularize(part)
    parameterByResource[part] = parameter
    pathSegments.push(`:${parameter}`)
  }

  const leaf = parts[parts.length - 1]
  const memberParameter = singleton ? undefined : singularize(leaf)
  if (memberParameter) parameterByResource[leaf] = memberParameter

  return {
    path: pathSegments.join('/'),
    name: parts.join('.'),
    memberParameter,
    shallowPath: leaf,
    shallowName: leaf,
    parameterByResource
  }
}

function singularize(name: string) {
  return name.endsWith('s') ? name.slice(0, -1) : name
}

function resourceAction(controller: any, method: string): ControllerAction {
  if (Array.isArray(controller)) return [controller[0], method]
  if (typeof controller === 'function' && controller.prototype) return [controller, method]
  if (typeof controller === 'string') return `${controller}.${method}`
  return [controller, method]
}

function extractParameters(path: string) {
  return [...path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => match[1])
}

function extractParametersFromDomain(domain: string) {
  return [...domain.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)}/g)].map(match => match[1])
}

function resolveGroupControllerAction(controller: any, action: ControllerAction): ControllerAction {
  if (!controller || typeof action !== 'string' || action.includes('.')) return action
  return resourceAction(controller, action)
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchesPattern(value: string, pattern: string) {
  const regex = new RegExp(`^${escapeRegex(pattern).replace(/\\\*/g, '.*')}$`)
  return regex.test(value)
}

function replaceRouteParameter(path: string, current: string, replacement: string) {
  return path.replace(new RegExp(`:${escapeRegex(current)}(?=/|$)`, 'g'), `:${replacement}`)
}

function replaceNestedResourcePath(path: string, nestedPath: string, shallowPath: string) {
  return path.replace(new RegExp(`/${escapeRegex(nestedPath)}(?=/|$)`), `/${shallowPath}`)
}

export const Route = new Router()

const currentRouteStorage = new AsyncLocalStorage<RouteDefinition>()

export function runWithRouteContext<T>(route: RouteDefinition, callback: () => T) {
  return currentRouteStorage.run(route, callback)
}
