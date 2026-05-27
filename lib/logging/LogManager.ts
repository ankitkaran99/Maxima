import fs from 'node:fs'
import path from 'node:path'
import pino, { type Logger as PinoLogger } from 'pino'
import { AsyncLocalStorage } from 'node:async_hooks'
import { config, storagePath } from '@lib/foundation/helpers.js'

type Context = Record<string, unknown>
type DriverFactory = (config: Record<string, any>) => Logger
type Tap = (logger: Logger, config: Record<string, any>) => Logger | void
type Processor = (context: Context) => Context

const sensitive = ['password', 'token', 'authorization', 'cookie', 'secret', 'apiKey']
const contextStorage = new AsyncLocalStorage<Context>()
let sharedContext: Context = {}

export class Logger {
  constructor(private writers: PinoLogger[], private context: Context = {}, private processors: Processor[] = []) {}

  debug(message: string, context: Context = {}) { this.write('debug', message, context) }
  info(message: string, context: Context = {}) { this.write('info', message, context) }
  notice(message: string, context: Context = {}) { this.info(message, context) }
  warn(message: string, context: Context = {}) { this.write('warn', message, context) }
  warning(message: string, context: Context = {}) { this.warn(message, context) }
  error(message: string | Error, context: Context = {}) { this.write('error', message instanceof Error ? message.message : message, serializeError(message, context)) }
  fatal(message: string | Error, context: Context = {}) { this.write('fatal', message instanceof Error ? message.message : message, serializeError(message, context)) }
  critical(message: string, context: Context = {}) { this.error(message, context) }
  alert(message: string, context: Context = {}) { this.error(message, context) }
  emergency(message: string, context: Context = {}) { this.fatal(message, context) }

  withContext(context: Context) {
    return new Logger(this.writers, { ...this.context, ...context }, this.processors)
  }

  pipe(processor: Processor) {
    return new Logger(this.writers, this.context, [...this.processors, processor])
  }

  private write(level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', message: string, context: Context) {
    const merged = { ...sharedContext, ...contextStorage.getStore(), ...this.context, ...context }
    const payload = mask(this.processors.reduce((carry, processor) => processor(carry), merged))
    for (const writer of this.writers) writer[level](payload, message)
  }
}

export class LogManager {
  private channels = new Map<string, Logger>()
  private customDrivers = new Map<string, DriverFactory>()
  private taps = new Map<string, Tap>()
  private processors: Processor[] = []
  private fakeRecords: Array<{ level: string, message: string, context: Context }> | null = null

  channel(name?: string) {
    name ??= config<string>('logging.default', 'console')
    if (this.fakeRecords) return this.fakeLogger()
    if (!this.channels.has(name)) this.channels.set(name, this.createChannel(name))
    return this.channels.get(name)!
  }

  stack(names: string[]) {
    return new Logger(names.flatMap(name => (this.channel(name) as any).writers ?? []), {}, this.processors)
  }

  withContext(context: Context) {
    return this.channel().withContext(context)
  }

  shareContext(context: Context) {
    sharedContext = { ...sharedContext, ...context }
    return this
  }

  flushSharedContext() {
    sharedContext = {}
    return this
  }

  deprecations() {
    return this.channel(config<string>('logging.deprecations.channel', 'deprecations'))
  }

  runWithContext<T>(context: Context, callback: () => T) {
    return contextStorage.run({ ...contextStorage.getStore(), ...context }, callback)
  }

  extend(name: string, factory: DriverFactory) {
    this.customDrivers.set(name, factory)
  }

  tap(name: string, callback: Tap) {
    this.taps.set(name, callback)
    return this
  }

  processor(callback: Processor) {
    this.processors.push(callback)
    this.channels.clear()
    return this
  }

  fake() {
    this.fakeRecords = []
  }

  restore() {
    this.fakeRecords = null
    this.flushSharedContext()
  }

  spy() { this.fake() }

  records() {
    return this.fakeRecords ?? []
  }

  assertLogged(level: string, message: string, predicate?: (context: Context) => boolean) {
    if (!this.fakeRecords?.some(record => record.level === level && record.message.includes(message) && (!predicate || predicate(record.context)))) {
      throw new Error(`Expected log [${level}] containing [${message}] was not recorded.`)
    }
  }

  info(message: string, context?: Context) { this.channel().info(message, context) }
  debug(message: string, context?: Context) { this.channel().debug(message, context) }
  warn(message: string, context?: Context) { this.channel().warn(message, context) }
  warning(message: string, context?: Context) { this.warn(message, context) }
  notice(message: string, context?: Context) { this.channel().notice(message, context) }
  error(message: string | Error, context?: Context) { this.channel().error(message, context) }
  fatal(message: string | Error, context?: Context) { this.channel().fatal(message, context) }
  critical(message: string, context?: Context) { this.channel().critical(message, context) }
  alert(message: string, context?: Context) { this.channel().alert(message, context) }
  emergency(message: string, context?: Context) { this.channel().emergency(message, context) }

  private createChannel(name: string): Logger {
    try {
      const channel = config<Record<string, any>>(`logging.channels.${name}`)
      if (!channel) throw new Error(`Log channel [${name}] is not configured.`)
      let logger = this.resolveChannel(channel)
      const tapNames = Array.isArray(channel.tap) ? channel.tap : (channel.tap ? [channel.tap] : [])
      for (const tapName of tapNames) {
        const tap = typeof tapName === 'function' ? tapName : this.taps.get(String(tapName))
        if (tap) logger = tap(logger, channel) ?? logger
      }
      return logger
    } catch (error) {
      const emergencyPath = storagePath('logs/emergency.log')
      fs.mkdirSync(path.dirname(emergencyPath), { recursive: true })
      const logger = new Logger([pino({ level: 'debug' }, pino.destination(emergencyPath))], {}, this.processors)
      logger.error(error as Error)
      return logger
    }
  }

  private resolveChannel(channel: Record<string, any>) {
    if (this.customDrivers.has(channel.driver)) return this.customDrivers.get(channel.driver)!(channel)
    if (channel.driver === 'stack') return this.stack(channel.channels ?? [])
    if (channel.driver === 'null') return new Logger([pino({ level: 'silent' })], {}, this.processors)
    if (['file', 'daily', 'single'].includes(channel.driver)) {
      fs.mkdirSync(path.dirname(channel.path ?? storagePath('logs/maxima.log')), { recursive: true })
      return new Logger([pino({ level: channel.level ?? 'info' }, pino.destination(channel.path ?? storagePath('logs/maxima.log')))], {}, this.processors)
    }
    if (['slack', 'webhook', 'papertrail', 'syslog', 'errorlog'].includes(channel.driver)) {
      return new Logger([pino({ level: channel.level ?? (channel.driver === 'slack' ? 'critical' : 'error') })], {}, this.processors)
    }
    return new Logger([pino({ level: channel.level ?? 'debug', transport: channel.pretty ? { target: 'pino-pretty' } : undefined })], {}, this.processors)
  }

  private fakeLogger() {
    const records = this.fakeRecords!
    return {
      debug: (message: string, context = {}) => records.push({ level: 'debug', message, context: { ...sharedContext, ...context } }),
      info: (message: string, context = {}) => records.push({ level: 'info', message, context: { ...sharedContext, ...context } }),
      notice: (message: string, context = {}) => records.push({ level: 'info', message, context: { ...sharedContext, ...context } }),
      warn: (message: string, context = {}) => records.push({ level: 'warn', message, context: { ...sharedContext, ...context } }),
      warning: (message: string, context = {}) => records.push({ level: 'warn', message, context: { ...sharedContext, ...context } }),
      error: (message: string | Error, context = {}) => records.push({ level: 'error', message: String(message instanceof Error ? message.message : message), context: message instanceof Error ? serializeError(message, { ...sharedContext, ...context }) : { ...sharedContext, ...context } }),
      critical: (message: string, context = {}) => records.push({ level: 'error', message, context: { ...sharedContext, ...context } }),
      alert: (message: string, context = {}) => records.push({ level: 'error', message, context: { ...sharedContext, ...context } }),
      fatal: (message: string | Error, context = {}) => records.push({ level: 'fatal', message: String(message instanceof Error ? message.message : message), context: message instanceof Error ? serializeError(message, { ...sharedContext, ...context }) : { ...sharedContext, ...context } }),
      emergency: (message: string, context = {}) => records.push({ level: 'fatal', message, context: { ...sharedContext, ...context } }),
      withContext: (context = {}) => ({
        ...(this.fakeLogger() as any),
        debug: (message: string, more = {}) => records.push({ level: 'debug', message, context: { ...sharedContext, ...context, ...more } }),
        info: (message: string, more = {}) => records.push({ level: 'info', message, context: { ...sharedContext, ...context, ...more } }),
        warn: (message: string, more = {}) => records.push({ level: 'warn', message, context: { ...sharedContext, ...context, ...more } }),
        error: (message: string | Error, more = {}) => records.push({ level: 'error', message: String(message instanceof Error ? message.message : message), context: message instanceof Error ? serializeError(message, { ...sharedContext, ...context, ...more }) : { ...sharedContext, ...context, ...more } })
      })
    } as unknown as Logger
  }
}

function mask(value: any): any {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(mask)
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    sensitive.some(item => key.toLowerCase().includes(item)) ? '[REDACTED]' : mask(entry)
  ]))
}

function serializeError(message: string | Error, context: Context) {
  if (!(message instanceof Error)) return context
  return { ...context, message: message.message, stack: message.stack, cause: (message as any).cause }
}

export const Log = new LogManager()
