import { Application } from '@lib/foundation/Application.js'
import { Facade } from '@lib/support/Facade.js'
import { basePath, appPath, configPath, databasePath, publicPath, resourcePath, storagePath } from '@lib/support/paths.js'
import { Route } from '@lib/http/Route.js'
import type { ControllerAction } from '@lib/http/Route.js'
import crypto from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { TranslatorInstance, type TranslationOptions } from '@lib/translation/Translator.js'

let currentApp: Application | undefined
const requestStorage = new AsyncLocalStorage<{ request: any, response: any }>()
type RouteParamValue = string | number | boolean | Date
type RouteParams = RouteParamValue | RouteParamValue[] | Record<string, any>
type SignatureValidationOptions = boolean | { absolute?: boolean, ignore?: string[] }

const routeParameterDefaults: Record<string, RouteParamValue> = {}

export function setApplication(app: Application) {
  currentApp = app
  Facade.setApplication(app)
}

export function app<T = Application>(key?: string | symbol | (new (...args: any[]) => T)): Application | Promise<T> {
  if (!currentApp) throw new Error('Maxima application has not been bootstrapped.')
  return key ? currentApp.make<T>(key) : currentApp
}

export function env<T>(key: string, defaultValue?: T) {
  if (!currentApp) return process.env[key] ?? defaultValue
  return currentApp.env.get(key, defaultValue)
}

export function config<T>(key: string, defaultValue?: T) {
  if (!currentApp) throw new Error('Config is unavailable before bootstrap.')
  return currentApp.config.get<T>(key, defaultValue)
}

export function route(name: string, params: RouteParams = {}, absolute = true) {
  const definition = Route.findByName(name)
  if (!definition) throw new Error(`Route [${name}] is not defined.`)
  const used = new Set<string>()
  const normalizedParams = normalizeRouteParams(params, definition.parameters ?? [])
  const values = { ...routeParameterDefaults, ...(definition.defaults ?? {}), ...normalizedParams }
  const queryValues = typeof params === 'object' && !Array.isArray(params) && !(params instanceof Date) && params._query && typeof params._query === 'object'
    ? params._query as Record<string, RouteParamValue>
    : {}
  let path = definition.path
  let domain = definition.domain
  for (const [key, value] of Object.entries(values)) {
    if (!path.includes(`:${key}`)) continue
    path = path.replace(new RegExp(`:${escapeRouteParameter(key)}(?=/|$)`, 'g'), encodeURIComponent(String(value)))
    used.add(key)
  }
  if (domain) {
    for (const [key, value] of Object.entries(values)) {
      if (!domain.includes(`{${key}}`)) continue
      domain = domain.replace(`{${key}}`, encodeURIComponent(String(value)))
      used.add(key)
    }
  }
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (key in routeParameterDefaults && !(key in normalizedParams)) continue
    if (!used.has(key)) query.set(key, String(value))
  }
  for (const [key, value] of Object.entries(queryValues)) query.set(key, String(value))
  const queryString = query.toString()
  const target = queryString ? `${path}?${queryString}` : path
  if (!domain || !absolute) return target
  const base = new URL(config<string>('app.url', 'http://127.0.0.1:3000'))
  base.host = domain
  base.pathname = path
  base.search = queryString
  return base.toString()
}

export function signedRoute(name: string, params: RouteParams = {}, expiresAt?: Date, absolute = true) {
  return signedUrl(route(name, params, absolute), {}, expiresAt)
}

export function routeDefaults(defaults: Record<string, RouteParamValue>) {
  Object.assign(routeParameterDefaults, defaults)
}

export function clearRouteDefaults(...keys: string[]) {
  if (!keys.length) {
    for (const key of Object.keys(routeParameterDefaults)) delete routeParameterDefaults[key]
    return
  }
  for (const key of keys) delete routeParameterDefaults[key]
}

export function action(action: ControllerAction, params: RouteParams = {}, absolute = true) {
  const definition = Route.all().find(routeDefinition => matchesAction(routeDefinition.action, action))
  if (!definition) throw new Error(`Route action [${describeAction(action)}] is not defined.`)
  const routeName = definition.name
  if (routeName) return route(routeName, params, absolute)

  const used = new Set<string>()
  const normalizedParams = normalizeRouteParams(params, definition.parameters ?? [])
  const values = { ...routeParameterDefaults, ...(definition.defaults ?? {}), ...normalizedParams }
  let resolvedPath = definition.path
  for (const [key, value] of Object.entries(values)) {
    if (!resolvedPath.includes(`:${key}`)) continue
    resolvedPath = resolvedPath.replace(new RegExp(`:${escapeRouteParameter(key)}(?=/|$)`, 'g'), encodeURIComponent(String(value)))
    used.add(key)
  }
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (key in routeParameterDefaults && !(key in normalizedParams)) continue
    if (!used.has(key)) query.set(key, String(value))
  }
  const queryString = query.toString()
  const target = queryString ? `${resolvedPath}?${queryString}` : resolvedPath
  if (!absolute) return target
  return new URL(target, config<string>('app.url', 'http://127.0.0.1:3000')).toString()
}

export function currentUrl() {
  return request().url()
}

export function fullUrl() {
  return request().fullUrl()
}

export function previousUrl(fallback = '/') {
  const headers = request().headers
  const value = headers.referer ?? headers.referrer
  return Array.isArray(value) ? value[0] ?? fallback : value ? String(value) : fallback
}

export async function view(template: string, data: Record<string, unknown> = {}) {
  const { ViewFactory } = await import('@lib/view/ViewFactory.js')
  return (await app<any>(ViewFactory)).render(template, data)
}

export async function renderEmail(template: string, data: Record<string, unknown> = {}) {
  const { ViewFactory } = await import('@lib/view/ViewFactory.js')
  return (await app<any>(ViewFactory)).renderEmail(template, data)
}

export async function viewFirst(templates: string[], data: Record<string, unknown> = {}) {
  const { ViewFactory } = await import('@lib/view/ViewFactory.js')
  return (await app<any>(ViewFactory)).first(templates, data)
}

export async function viewExists(template: string) {
  const { ViewFactory } = await import('@lib/view/ViewFactory.js')
  return (await app<any>(ViewFactory)).exists(template)
}

export async function renderInline(template: string, data: Record<string, unknown> = {}) {
  const { ViewFactory } = await import('@lib/view/ViewFactory.js')
  return (await app<any>(ViewFactory)).renderInline(template, data)
}

export async function renderFragment(template: string, fragment: string, data: Record<string, unknown> = {}) {
  const { ViewFactory } = await import('@lib/view/ViewFactory.js')
  return (await app<any>(ViewFactory)).renderFragment(template, fragment, data)
}

export function logger() {
  return import('@lib/logging/LogManager.js').then(({ Log }) => Log.channel())
}

export function auth() {
  return import('@lib/auth/AuthManager.js').then(({ Auth }) => Auth)
}

export function cache() {
  return import('@lib/cache/Cache.js').then(({ Cache }) => Cache)
}

export function event() {
  return import('@lib/events/Event.js').then(({ Event }) => Event)
}

export function broadcast() {
  return import('@lib/broadcast/Broadcast.js').then(({ Broadcast }) => Broadcast)
}

export function http() {
  return import('@lib/http/HttpClient.js').then(({ Http }) => Http)
}

export function processRunner() {
  return import('@lib/process/Process.js').then(({ Process }) => Process)
}

export function context() {
  return import('@lib/process/Context.js').then(({ Context }) => Context)
}

export function request<T = any>() {
  const context = requestStorage.getStore()
  if (!context) throw new Error('Request is unavailable outside of an active HTTP request.')
  return context.request as T
}

export function response<T = any>() {
  const context = requestStorage.getStore()
  if (!context) throw new Error('Response is unavailable outside of an active HTTP request.')
  return context.response as T
}

export function currentRoute() {
  return Route.current()
}

export function currentRouteName() {
  return Route.currentRouteName()
}

export function currentRouteAction() {
  return Route.currentRouteAction()
}

export function csrf_token() {
  return randomUUID()
}

export function csrf_field() {
  return `<input type="hidden" name="_token" value="${csrf_token()}">`
}

export function asset(path: string) {
  return `/assets/${path.replace(/^\/+/, '')}`
}

export function signedUrl(path: string, params: Record<string, RouteParamValue> = {}, expiresAt?: Date, absolute = true) {
  const url = new URL(path, config<string>('app.url', 'http://127.0.0.1:3000'))
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  if (expiresAt) url.searchParams.set('expires', String(expiresAt.getTime()))
  url.searchParams.set('signature', signUrl(url))
  return absolute ? url.toString() : `${url.pathname}${url.search}`
}

export function hasValidSignature(url: string, options: SignatureValidationOptions = {}) {
  const normalizedOptions = typeof options === 'boolean' ? { absolute: options } : options
  const signed = new URL(url, config<string>('app.url', 'http://127.0.0.1:3000'))
  const expires = signed.searchParams.get('expires')
  if (expires && Number(expires) < Date.now()) return false
  const provided = signed.searchParams.get('signature')
  if (!provided) return false
  return provided === signUrl(signed, normalizedOptions.ignore ?? [], normalizedOptions.absolute ?? true)
}

export function hasValidRelativeSignature(url: string, ignore: string[] = []) {
  return hasValidSignature(url, { absolute: false, ignore })
}

export async function trans(key: string, options: TranslationOptions = {}) {
  return TranslatorInstance.get(key, withConfiguredLocales(options))
}

export async function transChoice(key: string, count: number, options: TranslationOptions = {}) {
  return TranslatorInstance.choice(key, count, withConfiguredLocales(options))
}

export const __ = trans

export function setLocale(locale: string) { return TranslatorInstance.setLocale(locale) }
export function getLocale() { return TranslatorInstance.getLocale() }
export function setFallbackLocale(locale: string) { return TranslatorInstance.setFallbackLocale(locale) }
export function getFallbackLocale() { return TranslatorInstance.getFallbackLocale() }
export function withLocale<T>(locale: string, callback: () => T) { return TranslatorInstance.withLocale(locale, callback) }
export function stringable(match: Function | ((value: unknown) => boolean), formatter?: (value: any) => string) {
  return TranslatorInstance.stringable(match, formatter)
}
export function usePluralizer(language: string) { return TranslatorInstance.usePluralizer(language) }
export function pluralize(word: string, count = 2) { return TranslatorInstance.pluralize(word, count) }

export { basePath, appPath, configPath, databasePath, publicPath, resourcePath, storagePath }

export function base_path(...segments: string[]) { return basePath(...segments) }
export function app_path(...segments: string[]) { return appPath(...segments) }
export function config_path(...segments: string[]) { return configPath(...segments) }
export function database_path(...segments: string[]) { return databasePath(...segments) }
export function resource_path(...segments: string[]) { return resourcePath(...segments) }
export function storage_path(...segments: string[]) { return storagePath(...segments) }
export function public_path(...segments: string[]) { return publicPath(...segments) }

export function url(path = '', params: Record<string, string | number> = {}) {
  const base = config<string>('app.url', 'http://127.0.0.1:3000')
  const resolved = new URL(path, base)
  for (const [key, value] of Object.entries(params)) {
    resolved.searchParams.set(key, String(value))
  }
  return resolved.toString()
}

export function registerGlobalHelpers() {
  const helpers = {
    env,
    config,
    route,
    routeDefaults,
    clearRouteDefaults,
    action,
    signedRoute,
    url,
    currentUrl,
    fullUrl,
    previousUrl,
    view,
    renderEmail,
    viewFirst,
    viewExists,
    renderInline,
    renderFragment,
    logger,
    auth,
    cache,
    event,
    broadcast,
    http,
    processRunner,
    context,
    request,
    response,
    currentRoute,
    currentRouteName,
    currentRouteAction,
    csrf_token,
    csrf_field,
    asset,
    signedUrl,
    hasValidSignature,
    hasValidRelativeSignature,
    trans,
    transChoice,
    __,
    setLocale,
    getLocale,
    setFallbackLocale,
    getFallbackLocale,
    withLocale,
    stringable,
    usePluralizer,
    pluralize,
    base_path,
    app_path,
    config_path,
    database_path,
    resource_path,
    storage_path,
    public_path,
    basePath,
    appPath,
    configPath,
    databasePath,
    resourcePath,
    storagePath,
    publicPath
  }

  for (const [name, fn] of Object.entries(helpers)) {
    (global as any)[name] = fn
  }
}

export function runWithRequestContext<T>(request: any, response: any, callback: () => T) {
  return requestStorage.run({ request, response }, callback)
}

function normalizeRouteParams(params: RouteParams, parameterNames: string[]) {
  if (params === undefined || params === null) return {}
  if (typeof params !== 'object' || params instanceof Date) {
    const [first] = parameterNames
    return first ? { [first]: params } : {}
  }
  if (Array.isArray(params)) {
    return Object.fromEntries(params.map((value, index) => [parameterNames[index] ?? String(index), value]))
  }
  return Object.fromEntries(Object.entries(params).filter(([key]) => key !== '_query'))
}

function withConfiguredLocales(options: TranslationOptions) {
  return {
    ...options,
    locale: options.locale ?? (TranslatorInstance.hasScopedLocale() ? undefined : safeConfig('app.locale', process.env.APP_LOCALE ?? TranslatorInstance.getLocale())),
    fallbackLocale: options.fallbackLocale ?? safeConfig('app.fallback_locale', process.env.APP_FALLBACK_LOCALE ?? TranslatorInstance.getFallbackLocale())
  }
}

function safeConfig<T>(key: string, defaultValue: T) {
  try {
    return currentApp ? currentApp.config.get<T>(key, defaultValue) : defaultValue
  } catch {
    return defaultValue
  }
}

function escapeRouteParameter(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchesAction(candidate: ControllerAction, expected: ControllerAction) {
  if (typeof expected === 'string') return candidate === expected
  if (!Array.isArray(expected)) return candidate === expected
  return Array.isArray(candidate) && candidate[0] === expected[0] && candidate[1] === expected[1]
}

function describeAction(action: ControllerAction) {
  if (typeof action === 'string') return action
  if (Array.isArray(action)) return `${action[0]?.name ?? 'anonymous'}.${action[1]}`
  return action.name || 'anonymous'
}

function signUrl(url: URL, ignore: string[] = [], _absolute = true) {
  const key = String(config('app.key', 'maxima-secret'))
  const canonical = new URL(url.toString())
  canonical.searchParams.delete('signature')
  for (const key of ignore) canonical.searchParams.delete(key)
  const payload = `${canonical.pathname}?${[...canonical.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${value}`).join('&')}`
  return crypto.createHmac('sha256', key).update(payload).digest('hex')
}
