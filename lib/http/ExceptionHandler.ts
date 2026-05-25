import { Log } from '@lib/logging/LogManager.js'
import type { Request } from '@lib/http/Request.js'
import type { Response } from '@lib/http/Response.js'

type ExceptionConstructor = new (...args: any[]) => Error
type ReportCallback = (error: Error, request?: Request) => void | boolean | Promise<void | boolean>
type RenderCallback = (error: Error, request: Request, response: Response) => unknown | Promise<unknown>
type LogLevel = 'debug' | 'info' | 'warn' | 'warning' | 'error' | 'fatal' | 'critical'
type Resolver = (key: any) => unknown | Promise<unknown>

export class ExceptionHandler {
  private ignored = new Set<ExceptionConstructor>()
  private stoppedIgnoring = new Set<ExceptionConstructor>()
  private ignoredPredicates: Array<(error: Error, request?: Request) => boolean> = []
  private reportCallbacks: ReportCallback[] = []
  private renderCallbacks: RenderCallback[] = []
  private levels = new Map<ExceptionConstructor, LogLevel>()
  private duplicateSuppression = false
  private reported = new WeakSet<Error>()
  private throttleRules: Array<{ error: ExceptionConstructor, limit: number, windowMs: number }> = []
  private throttleHits = new Map<string, number[]>()
  private resolver?: Resolver

  dontReport(...errors: ExceptionConstructor[]) {
    for (const error of errors) this.ignored.add(error)
    return this
  }

  stopIgnoring(...errors: ExceptionConstructor[]) {
    for (const error of errors) {
      this.ignored.delete(error)
      this.stoppedIgnoring.add(error)
    }
    return this
  }

  dontReportWhen(predicate: (error: Error, request?: Request) => boolean) {
    this.ignoredPredicates.push(predicate)
    return this
  }

  reportable(callback: ReportCallback) {
    this.reportCallbacks.push(callback)
    return this
  }

  renderable(callback: RenderCallback) {
    this.renderCallbacks.push(callback)
    return this
  }

  level(error: ExceptionConstructor, level: LogLevel) {
    this.levels.set(error, level)
    return this
  }

  dontReportDuplicates() {
    this.duplicateSuppression = true
    return this
  }

  throttle(error: ExceptionConstructor, limit = 1, windowMs = 60_000) {
    this.throttleRules.push({ error, limit, windowMs })
    return this
  }

  setResolver(resolver: Resolver) {
    this.resolver = resolver
    return this
  }

  shouldReport(error: Error) {
    const forceReport = [...this.stoppedIgnoring].some(Stopped => error instanceof Stopped)
    if (!forceReport && ['ValidationException', 'AuthorizationException'].includes(error.name)) return false
    if (!forceReport && Number((error as any).statusCode ?? 500) < 500) return false
    for (const Ignored of this.ignored) {
      if (error instanceof Ignored) return false
    }
    return true
  }

  async report(error: Error, request?: Request) {
    if (!this.shouldReport(error)) return
    if (this.ignoredPredicates.some(predicate => predicate(error, request))) return
    if (this.duplicateSuppression) {
      if (this.reported.has(error)) return
      this.reported.add(error)
    }
    if (this.isThrottled(error)) return

    for (const callback of this.reportCallbacks) {
      const result = await callback(error, request)
      if (result === false) return
    }

    try {
      const context = this.exceptionContext(error)
      const level = this.logLevel(error)
      if (level === 'error' || level === 'fatal') {
        Log[level](error, context)
      } else if (level === 'critical') {
        Log.critical(error.message, { ...context, stack: error.stack })
      } else {
        ;(Log as any)[level](error.message, { ...context, stack: error.stack })
      }
    } catch {}
  }

  async render(error: Error, request: Request, response: Response) {
    for (const callback of this.renderCallbacks) {
      const result = await this.callRenderable(callback, error, request, response)
      if (result !== undefined) return result
    }
  }

  private logLevel(error: Error) {
    for (const [Exception, level] of this.levels) {
      if (error instanceof Exception) return level
    }
    return 'error' as const
  }

  private exceptionContext(error: Error) {
    const context = typeof (error as any).context === 'function' ? (error as any).context() : {}
    return context && typeof context === 'object' ? context as Record<string, unknown> : {}
  }

  private isThrottled(error: Error) {
    const rule = this.throttleRules.find(candidate => error instanceof candidate.error)
    if (!rule) return false
    const key = rule.error.name
    const now = Date.now()
    const hits = (this.throttleHits.get(key) ?? []).filter(timestamp => now - timestamp < rule.windowMs)
    if (hits.length >= rule.limit) {
      this.throttleHits.set(key, hits)
      return true
    }
    hits.push(now)
    this.throttleHits.set(key, hits)
    return false
  }

  private async callRenderable(callback: RenderCallback, error: Error, request: Request, response: Response) {
    const inject = (callback as any).inject as any[] | undefined
    if (!inject?.length) return callback(error, request, response)
    const args = await Promise.all(inject.map(async key => {
      if (key === Error || typeof key === 'function' && error instanceof key) return error
      if (key === request.constructor) return request
      if (key === response.constructor) return response
      return this.resolver ? this.resolver(key) : undefined
    }))
    return (callback as any)(...args)
  }
}
