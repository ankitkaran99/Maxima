import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, vi } from 'vitest'
import { DB } from '@lib/database/DB.js'
import { Auth } from '@lib/auth/AuthManager.js'
import { Event } from '@lib/events/Event.js'
import { Queue } from '@lib/queue/Queue.js'
import { Bus } from '@lib/queue/Bus.js'
import { Mail } from '@lib/mail/Mail.js'
import { Notifications } from '@lib/notifications/Notification.js'
import { Storage } from '@lib/storage/Storage.js'
import { Cache } from '@lib/cache/Cache.js'
import { Log } from '@lib/logging/LogManager.js'
import { Http } from '@lib/http/HttpClient.js'
import { Process } from '@lib/process/Process.js'
import { runCliCommand } from '@lib/cli/runCliCommand.js'
import { app } from '@lib/foundation/helpers.js'
import { ViewFactory } from '@lib/view/ViewFactory.js'
import type { Application } from '@lib/foundation/Application.js'

export async function assertDatabaseHas(table: string, criteria: Record<string, any>) {
  const record = await DB.table(table).where(criteria).first()
  expect(record).toBeDefined()
}

export async function assertDatabaseMissing(table: string, criteria: Record<string, any>) {
  const record = await DB.table(table).where(criteria).first()
  expect(record).toBeUndefined()
}

export async function assertDatabaseCount(table: string, expectedCount: number) {
  const row = await DB.table(table).count({ count: '*' }).first()
  const actualCount = Number(row?.count ?? 0)
  expect(actualCount).toBe(expectedCount)
}

export function expectResponse(response: any) {
  return new TestResponse(response)
}

export class TestResponse {
  constructor(public response: any) {}

  get statusCode() { return this.response.statusCode ?? this.response.status }
  get headers() { return normalizeHeaders(this.response.headers ?? {}) }
  body() { return this.response.body ?? this.response.payload ?? this.response.text?.() ?? '' }
  json() { return typeof this.response.json === 'function' ? this.response.json() : JSON.parse(this.body() || 'null') }

  assertStatus(status: number) { expect(this.statusCode).toBe(status); return this }
  assertOk() { return this.assertStatus(200) }
  assertCreated() { return this.assertStatus(201) }
  assertNoContent(status = 204) { this.assertStatus(status); expect(String(this.body() ?? '')).toBe(''); return this }
  assertForbidden() { return this.assertStatus(403) }
  assertNotFound() { return this.assertStatus(404) }
  assertUnauthorized() { return this.assertStatus(401) }
  assertUnprocessable() { return this.assertStatus(422) }
  assertSuccessful() { expect(this.statusCode).toBeGreaterThanOrEqual(200); expect(this.statusCode).toBeLessThan(300); return this }
  assertServerError() { expect(this.statusCode).toBeGreaterThanOrEqual(500); return this }
  assertJson(expected: any) { expect(this.json()).toEqual(expected); return this }
  assertJsonFragment(fragment: Record<string, any>) { expect(JSON.stringify(this.json())).toContain(JSON.stringify(fragment).slice(1, -1)); return this }
  assertJsonMissing(fragment: Record<string, any>) { expect(JSON.stringify(this.json())).not.toContain(JSON.stringify(fragment).slice(1, -1)); return this }
  assertJsonPath(path: string, expected: any) { expect(dataGet(this.json(), path)).toEqual(expected); return this }
  assertJsonCount(count: number, path = '') {
    const value = path ? dataGet(this.json(), path) : this.json()
    expect(Array.isArray(value) ? value.length : Object.keys(value ?? {}).length).toBe(count)
    return this
  }
  assertSee(value: string) { expect(String(this.body())).toContain(value); return this }
  assertDontSee(value: string) { expect(String(this.body())).not.toContain(value); return this }
  assertRedirect(expectedUrl?: string) {
    expect([301, 302, 303, 307, 308]).toContain(this.statusCode)
    if (expectedUrl) expect(this.headers.location).toBe(expectedUrl)
    return this
  }
  assertHeader(name: string, value?: string) {
    const actual = this.headers[name.toLowerCase()]
    value === undefined ? expect(actual).toBeDefined() : expect(actual).toBe(value)
    return this
  }
  assertHeaderMissing(name: string) { expect(this.headers[name.toLowerCase()]).toBeUndefined(); return this }
  assertCookie(name: string) { expect(this.headers['set-cookie'] ?? '').toContain(`${name}=`); return this }
  assertCookieMissing(name: string) { expect(this.headers['set-cookie'] ?? '').not.toContain(`${name}=`); return this }
}

export function actingAs(user: any, guard = 'session', request: any = createTestRequest()) {
  request.user = user
  request.session.put(`auth_${guard}_id`, user.id)
  if (guard === 'session') request.session.put('auth_user_id', user.id)
  Auth.setRequest(request, createTestReply())
  return request
}

export function be(user: any, guard?: string, request?: any) {
  return actingAs(user, guard, request)
}

export function withoutMiddleware(appOrMiddleware?: Application | string | string[], middleware?: string | string[]) {
  const targetApp = typeof appOrMiddleware === 'object' && appOrMiddleware && 'config' in appOrMiddleware ? appOrMiddleware as Application : undefined
  const values = targetApp ? middleware : appOrMiddleware
  const appInstance = targetApp ?? app() as Application
  appInstance.config.set('__testing.withoutMiddleware', values ? arrayWrap(values) : ['*'])
  return () => appInstance.config.set('__testing.withoutMiddleware', [])
}

export function withoutExceptionHandling(appOrHandler?: Application) {
  const appInstance = appOrHandler ?? app() as Application
  appInstance.config.set('__testing.withoutExceptionHandling', true)
  return () => appInstance.config.set('__testing.withoutExceptionHandling', false)
}

export function travelTo(date: Date | string | number) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(date))
}

export function travel(milliseconds: number) {
  vi.advanceTimersByTime(milliseconds)
}

export function travelBack() {
  vi.useRealTimers()
}

export function fakeFramework(options: { storageDisk?: string, cacheStore?: string } = {}) {
  Event.fake()
  Queue.fake()
  Bus.fake()
  Mail.fake()
  Notifications.fake()
  Storage.fake(options.storageDisk ?? 'local')
  Cache.fake(options.cacheStore as any)
  Log.fake()
  Http.fake()
  Process.fake()
}

export function restoreFrameworkFakes() {
  Event.restore()
  Queue.restore()
  Bus.restore()
  Mail.restore()
  Notifications.restore()
  Cache.restore?.()
  Log.restore()
  Http.restore()
  Process.restore()
}

export async function artisan(args: string[]) {
  const lines: string[] = []
  const errors: string[] = []
  const originalLog = console.log
  const originalTable = console.table
  const originalError = console.error
  console.log = (...values: any[]) => { lines.push(values.join(' ')) }
  console.table = (value: any) => { lines.push(JSON.stringify(value)) }
  console.error = (...values: any[]) => { errors.push(values.join(' ')) }
  try {
    await runCliCommand(args)
    return new ConsoleResult(0, lines.join('\n'), errors.join('\n'))
  } catch (error: any) {
    return new ConsoleResult(1, lines.join('\n'), errors.concat(error.message).join('\n'))
  } finally {
    console.log = originalLog
    console.table = originalTable
    console.error = originalError
  }
}

export class ConsoleResult {
  constructor(public exitCode: number, public stdout = '', public stderr = '') {}
  assertExitCode(code: number) { expect(this.exitCode).toBe(code); return this }
  assertSuccessful() { return this.assertExitCode(0) }
  assertFailed() { expect(this.exitCode).not.toBe(0); return this }
  expectsOutput(value: string) { expect(this.stdout).toContain(value); return this }
  doesntExpectOutput(value: string) { expect(this.stdout).not.toContain(value); return this }
}

export class Browser {
  private html = ''
  async visit(urlOrHtml: string) {
    this.html = urlOrHtml.startsWith('<') ? urlOrHtml : ''
    return this
  }
  assertSee(value: string) { expect(this.html).toContain(value); return this }
  assertDontSee(value: string) { expect(this.html).not.toContain(value); return this }
  assertSourceHas(value: string) { return this.assertSee(value) }
}

export async function browse(callback: (browser: Browser) => unknown | Promise<unknown>) {
  const browser = new Browser()
  await callback(browser)
  return browser
}

export function parallelTestingToken() {
  return process.env.TEST_TOKEN ?? process.env.VITEST_POOL_ID ?? 'default'
}

export async function withParallelIsolation<T>(callback: (token: string) => T | Promise<T>) {
  return callback(parallelTestingToken())
}

export class RefreshDatabase {
  private snapshots = new Map<string, any[]>()
  async begin() {
    this.snapshots.clear()
    for (const table of await tableNames()) this.snapshots.set(table, await DB.table(table).select('*'))
    return this
  }
  async rollback() {
    for (const [table, rows] of this.snapshots) {
      await DB.table(table).delete()
      if (rows.length) await DB.table(table).insert(rows)
    }
    this.snapshots.clear()
  }
  async run<T>(callback: () => T | Promise<T>) {
    await this.begin()
    try { return await callback() } finally { await this.rollback() }
  }
}

export async function refreshDatabase<T>(callback: () => T | Promise<T>) {
  return new RefreshDatabase().run(callback)
}

export async function seed(seeder: any, connection = DB.connection()) {
  const instance = typeof seeder === 'function' ? new seeder() : seeder
  if (typeof instance.seed === 'function') return instance.seed(connection)
  if (typeof seeder.seed === 'function') return seeder.seed(connection)
  if (typeof seeder === 'function') return seeder(connection)
}

export async function factory(factoryClass: any, count?: number, overrides: Record<string, any> = {}) {
  const instance = typeof factoryClass === 'function' ? new factoryClass() : factoryClass
  const configured = count !== undefined && typeof instance.count === 'function' ? instance.count(count) : instance
  return configured.make ? configured.make(overrides) : configured.create(overrides)
}

export async function assertMatchesSnapshot(name: string, value: any, directory = path.join(process.cwd(), '__snapshots__')) {
  await fs.mkdir(directory, { recursive: true })
  const target = path.join(directory, `${name}.snap`)
  const serialized = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  try {
    expect(await fs.readFile(target, 'utf8')).toBe(serialized)
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error
    await fs.writeFile(target, serialized)
  }
}

export async function assertViewIs(template: string, data: Record<string, unknown> = {}, expected?: string) {
  const factory = await app<any>(ViewFactory)
  const rendered = await factory.render(template, data)
  if (expected !== undefined) expect(rendered).toContain(expected)
  return rendered
}

export async function assertViewHas(template: string, data: Record<string, unknown>, key: string, expected?: any) {
  expect(data).toHaveProperty(key)
  if (arguments.length >= 4) expect(dataGet(data, key)).toEqual(expected)
  return assertViewIs(template, data)
}

export function createTestRequest() {
  const values = new Map<string, any>()
  return {
    user: null,
    session: {
      put: (key: string, value: any) => values.set(key, value),
      get: (key: string, defaultValue?: any) => values.get(key) ?? defaultValue,
      forget: (key: string) => values.delete(key),
      all: () => Object.fromEntries(values)
    }
  }
}

export function createTestReply() {
  return { header() {}, code() { return this }, send() { return this } }
}

function normalizeHeaders(headers: Record<string, any>) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join('; ') : value]))
}

function dataGet(source: any, key: string) {
  if (!key) return source
  return key.split('.').reduce((carry, segment) => carry?.[segment], source)
}

function arrayWrap<T>(value: T | T[]) {
  return Array.isArray(value) ? value : [value]
}

async function tableNames() {
  const client = DB.connection().client.config.client
  if (String(client).includes('sqlite')) {
    const rows = await DB.connection().select('name').from('sqlite_master').where('type', 'table').whereNot('name', 'like', 'sqlite_%')
    return rows.map((row: any) => row.name).filter((name: string) => !name.startsWith('knex_'))
  }
  return []
}
