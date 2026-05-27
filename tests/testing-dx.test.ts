import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { Route } from '@lib/http/Route.js'
import { HttpKernel } from '@lib/http/Kernel.js'
import { DB } from '@lib/database/DB.js'
import { Cache } from '@lib/cache/Cache.js'
import { Event } from '@lib/events/Event.js'
import { Mail, Mailable } from '@lib/mail/Mail.js'
import { Queue } from '@lib/queue/Queue.js'
import {
  actingAs,
  artisan,
  assertMatchesSnapshot,
  assertViewHas,
  browse,
  expectResponse,
  fakeFramework,
  factory,
  parallelTestingToken,
  refreshDatabase,
  restoreFrameworkFakes,
  seed,
  travel,
  travelBack,
  travelTo,
  withoutExceptionHandling,
  withoutMiddleware,
  assertDatabaseHas,
  assertDatabaseMissing,
  assertDatabaseCount
} from '@lib/support/TestHelpers.js'

class TestMail extends Mailable {
  subject() { return 'Testing Mail' }
  html() { return '<p>Testing</p>' }
}

describe('Testing DX Gaps', () => {
  let app: Application

  beforeEach(async () => {
    app = new Application(process.cwd())
    setApplication(app)
    app.config.set('database.default', 'sqlite')
    app.config.set('database.connections.sqlite', {
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })

    await DB.connection().schema.createTable('dx_test_table', table => {
      table.increments('id')
      table.string('name')
    })
  })

  afterEach(async () => {
    await DB.connection().schema.dropTableIfExists('dx_test_table')
    await DB.close()
  })

  it('runs database assertions successfully', async () => {
    await DB.table('dx_test_table').insert({ name: 'Maxima' })

    await assertDatabaseHas('dx_test_table', { name: 'Maxima' })
    await assertDatabaseMissing('dx_test_table', { name: 'Unknown' })
    await assertDatabaseCount('dx_test_table', 1)
  })

  it('runs HTTP response assertions successfully', () => {
    const mockResponse = {
      statusCode: 200,
      headers: {
        location: '/redirect-here',
        'content-type': 'application/json'
      },
      json() {
        return {
          user: {
            id: 42,
            name: 'Bob'
          }
        }
      }
    }

    expectResponse(mockResponse)
      .assertStatus(200)
      .assertOk()
      .assertJson({ user: { id: 42, name: 'Bob' } })
      .assertJsonPath('user.name', 'Bob')
      .assertHeader('Content-Type', 'application/json')

    const redirectResponse = {
      statusCode: 302,
      headers: {
        location: '/dashboard'
      }
    }

    expectResponse(redirectResponse).assertRedirect('/dashboard')
  })
})

describe('Testing Parity', () => {
  let root: string
  let app: Application

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-testing-'))
    await fs.mkdir(path.join(root, 'resources', 'views'), { recursive: true })
    await fs.writeFile(path.join(root, 'resources', 'views', 'card.edge'), '<h1>{{ title }}</h1>')
    app = new Application(root)
    setApplication(app)
    app.config.set('database.default', 'sqlite')
    app.config.set('database.connections.sqlite', { client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    app.config.set('middleware.aliases', {
      block: class {
        handle(_request: any, reply: any) {
          return reply.code(409).send({ blocked: true })
        }
      }
    })
    app.config.set('middleware.global', [])
    app.config.set('app.key', 'testing-key')
    await DB.connection().schema.createTable('testing_users', table => {
      table.increments('id')
      table.string('name')
    })
    Route.clear()
  })

  afterEach(async () => {
    restoreFrameworkFakes()
    travelBack()
    Route.clear()
    await DB.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('provides broad HTTP response assertions and middleware / exception toggles', async () => {
    Route.get('/blocked', () => ({ ok: true })).middleware('block')
    Route.get('/boom', () => { throw new Error('boom') })

    const firstKernel = new HttpKernel(app)
    await firstKernel.bootstrap({ loadRoutes: false })
    expectResponse(await firstKernel.server.inject({ method: 'GET', url: '/blocked' }))
      .assertStatus(409)
      .assertJsonPath('blocked', true)
      .assertJsonFragment({ blocked: true })
      .assertHeader('content-type')
    await firstKernel.close()

    withoutMiddleware(app)
    withoutExceptionHandling(app)
    const secondKernel = new HttpKernel(app)
    await secondKernel.bootstrap({ loadRoutes: false })
    expectResponse(await secondKernel.server.inject({ method: 'GET', url: '/blocked' })).assertOk().assertJson({ ok: true })
    expectResponse(await secondKernel.server.inject({ method: 'GET', url: '/boom' })).assertServerError().assertSee('boom')
    await secondKernel.close()
  })

  it('provides actingAs, time travel, fake parity, console testing, and browser assertions', async () => {
    const request = actingAs({ id: 10, name: 'Ada' }, 'admin')
    travelTo('2026-05-26T10:00:00Z')
    const start = Date.now()
    travel(1000)

    fakeFramework()
    Event.dispatch('UserLoggedIn', { id: 10 })
    await Queue.push({ handle() {} })
    await Mail.to('ada@example.com').send(new TestMail())
    await Cache.put('key', 'value')

    const output = await artisan(['env'])
    await browse(async browser => {
      await browser.visit('<main>Dashboard</main>')
      browser.assertSee('Dashboard').assertDontSee('Login')
    })

    expect(request.session.get('auth_admin_id')).toBe(10)
    expect(Date.now() - start).toBe(1000)
    expect(() => Event.assertDispatched('UserLoggedIn')).not.toThrow()
    expect(() => Queue.assertPushed('Object')).not.toThrow()
    expect(() => Mail.assertSent('Testing Mail')).not.toThrow()
    output.assertSuccessful()
  })

  it('provides refresh database, seeding, factory, parallel token, snapshot, and view assertions', async () => {
    await seed({ seed: async (knex: any) => knex('testing_users').insert({ name: 'Seeded' }) })
    const made = await factory({ make: (overrides: any) => ({ name: 'Factory', ...overrides }) }, undefined, { role: 'admin' })
    await refreshDatabase(async () => {
      await DB.table('testing_users').insert({ name: 'Temporary' })
      await expect(DB.table('testing_users').where({ name: 'Temporary' }).first()).resolves.toBeDefined()
    })

    const snapshotDir = path.join(root, '__snapshots__')
    await assertMatchesSnapshot('payload', { ok: true }, snapshotDir)
    await assertMatchesSnapshot('payload', { ok: true }, snapshotDir)

    await expect(assertViewHas('card', { title: 'Hello' }, 'title', 'Hello')).resolves.toContain('Hello')
    expect(made).toEqual({ name: 'Factory', role: 'admin' })
    expect(parallelTestingToken()).toBeTruthy()
    await expect(DB.table('testing_users').where({ name: 'Seeded' }).first()).resolves.toBeDefined()
  })
})
