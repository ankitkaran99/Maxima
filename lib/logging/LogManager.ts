import fs from 'node:fs'
import path from 'node:path'
import pino, { type Logger as PinoLogger } from 'pino'
import { AsyncLocalStorage } from 'node:async_hooks'
import { config, storagePath } from '@lib/foundation/helpers.js'

type Context = Record<string, unknown>
type DriverFactory = (config: Record<string, any>) => Logger

const sensitive = ['password', 'token', 'authorization', 'cookie', 'secret', 'apiKey']
const contextStorage = new AsyncLocalStorage<Context>()

export class Logger {
  constructor(private writers: PinoLogger[], private context: Context = {}) {}

  debug(message: string, context: Context = {}) { this.write('debug', message, context) }
  info(message: string, context: Context = {}) { this.write('info', message, context) }
  warn(message: string, context: Context = {}) { this.write('warn', message, context) }
  error(message: string | Error, context: Context = {}) { this.write('error', message instanceof Error ? message.message : message, serializeError(message, context)) }
  fatal(message: string | Error, context: Context = {}) { this.write('fatal', message instanceof Error ? message.message : message, serializeError(message, context)) }
  critical(message: string, context: Context = {}) { this.error(message, context) }

  withContext(context: Context) {
    return new Logger(this.writers, { ...this.context, ...context })
  }

  private write(level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', message: string, context: Context) {
    const payload = mask({ ...contextStorage.getStore(), ...this.context, ...context })
    for (const writer of this.writers) writer[level](payload, message)
  }
}

export class LogManager {
  private channels = new Map<string, Logger>()
  private customDrivers = new Map<string, DriverFactory>()
  private fakeRecords: Array<{ level: string, message: string, context: Context }> | null = null

  channel(name?: string) {
    name ??= config<string>('logging.default', 'console')
    if (this.fakeRecords) return this.fakeLogger()
    if (!this.channels.has(name)) this.channels.set(name, this.createChannel(name))
    return this.channels.get(name)!
  }

  stack(names: string[]) {
    return new Logger(names.flatMap(name => (this.channel(name) as any).writers ?? []))
  }

  withContext(context: Context) {
    return this.channel().withContext(context)
  }

  runWithContext<T>(context: Context, callback: () => T) {
    return contextStorage.run({ ...contextStorage.getStore(), ...context }, callback)
  }

  extend(name: string, factory: DriverFactory) {
    this.customDrivers.set(name, factory)
  }

  fake() {
    this.fakeRecords = []
  }

  restore() {
    this.fakeRecords = null
  }

  spy() { this.fake() }

  assertLogged(level: string, message: string) {
    if (!this.fakeRecords?.some(record => record.level === level && record.message.includes(message))) {
      throw new Error(`Expected log [${level}] containing [${message}] was not recorded.`)
    }
  }

  info(message: string, context?: Context) { this.channel().info(message, context) }
  debug(message: string, context?: Context) { this.channel().debug(message, context) }
  warn(message: string, context?: Context) { this.channel().warn(message, context) }
  warning(message: string, context?: Context) { this.warn(message, context) }
  error(message: string | Error, context?: Context) { this.channel().error(message, context) }
  fatal(message: string | Error, context?: Context) { this.channel().fatal(message, context) }
  critical(message: string, context?: Context) { this.channel().critical(message, context) }

  private createChannel(name: string): Logger {
    const channel = config<Record<string, any>>(`logging.channels.${name}`)
    if (!channel) throw new Error(`Log channel [${name}] is not configured.`)
    if (this.customDrivers.has(channel.driver)) return this.customDrivers.get(channel.driver)!(channel)
    if (channel.driver === 'stack') return this.stack(channel.channels)
    if (channel.driver === 'null') return new Logger([pino({ level: 'silent' })])
    if (channel.driver === 'file' || channel.driver === 'daily') {
      fs.mkdirSync(path.dirname(channel.path ?? storagePath('logs/maxima.log')), { recursive: true })
      return new Logger([pino({ level: channel.level ?? 'info' }, pino.destination(channel.path))])
    }
    if (channel.driver === 'webhook') return new Logger([pino({ level: channel.level ?? 'error' })])
    return new Logger([pino({ level: channel.level ?? 'debug', transport: channel.pretty ? { target: 'pino-pretty' } : undefined })])
  }

  private fakeLogger() {
    const records = this.fakeRecords!
    return {
      debug: (message: string, context = {}) => records.push({ level: 'debug', message, context }),
      info: (message: string, context = {}) => records.push({ level: 'info', message, context }),
      warn: (message: string, context = {}) => records.push({ level: 'warn', message, context }),
      error: (message: string | Error, context = {}) => records.push({ level: 'error', message: String(message), context }),
      fatal: (message: string | Error, context = {}) => records.push({ level: 'fatal', message: String(message), context }),
      withContext: () => this.fakeLogger()
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
