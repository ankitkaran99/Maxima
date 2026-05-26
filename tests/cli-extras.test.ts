import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCliCommand } from '@lib/cli/runCliCommand.js'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { Schema } from '@lib/database/Schema.js'
import { Cache } from '@lib/cache/Cache.js'
import { SerializableRegistry } from '@lib/queue/Queue.js'

class TestSyncJob {
  constructor(public val: string = '') {}
  async handle() {
    // Success - no-op to prevent exceptions
  }
}
SerializableRegistry.register(TestSyncJob)

describe('CLI Extras', () => {
  const originalBasePath = process.env.MAXIMA_BASE_PATH
  let root = ''
  let logSpy: ReturnType<typeof vi.spyOn>
  let tableSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-cli-extras-'))
    process.env.MAXIMA_BASE_PATH = root
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    tableSpy = vi.spyOn(console, 'table').mockImplementation(() => undefined)

    await DB.close()
    const app = new Application(root)
    setApplication(app)
    app.config.set('database.default', 'sqlite')
    app.config.set('database.connections.sqlite', {
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    app.config.set('logging', {
      default: 'console',
      channels: {
        console: { driver: 'null' }
      }
    })
    app.config.set('cache', {
      default: 'memory',
      stores: {
        memory: { driver: 'memory', prefix: 'cli_extras_test' }
      }
    })
    app.config.set('queue', {
      default: 'sync',
      connections: {
        sync: { driver: 'sync' }
      },
      failed: { table: 'failed_jobs' }
    })
  })

  afterEach(async () => {
    logSpy.mockRestore()
    tableSpy.mockRestore()
    process.env.MAXIMA_BASE_PATH = originalBasePath
    await DB.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('make:rule creates a custom rule class', async () => {
    await runCliCommand(['make:rule', 'UppercaseRule'])

    const fileContent = await fs.readFile(path.join(root, 'src', 'app', 'Rules', 'UppercaseRule.ts'), 'utf8')
    expect(fileContent).toContain('export default class UppercaseRule')
    expect(fileContent).toContain('async validate(value: any, ctx: RuleContext)')
  })

  it('cache:clear clears the cache store', async () => {
    await Cache.put('test_key', 'test_value')
    expect(await Cache.has('test_key')).toBe(true)

    await runCliCommand(['cache:clear'])
    expect(await Cache.has('test_key')).toBe(false)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Cache cleared'))
  })

  it('view:clear clears compiled template files in storage', async () => {
    const viewsDir = path.join(root, 'src', 'storage', 'framework', 'views')
    await fs.mkdir(viewsDir, { recursive: true })
    await fs.writeFile(path.join(viewsDir, 'compiled-template.js'), 'console.log("compiled")')

    expect(fsSync.existsSync(path.join(viewsDir, 'compiled-template.js'))).toBe(true)

    await runCliCommand(['view:clear'])
    expect(fsSync.existsSync(path.join(viewsDir, 'compiled-template.js'))).toBe(false)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Compiled views cleared'))
  })

  it('view:cache compiles view files into src storage', async () => {
    const viewsDir = path.join(root, 'src', 'resources', 'views')
    await fs.mkdir(viewsDir, { recursive: true })
    await fs.writeFile(path.join(viewsDir, 'home.edge'), '<h1>{{ title }}</h1>')

    await runCliCommand(['view:cache'])

    const cacheDir = path.join(root, 'src', 'storage', 'framework', 'views')
    expect((await fs.readdir(cacheDir)).length).toBeGreaterThan(0)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('views cached'))
  })

  it('down and up toggle maintenance mode in src storage', async () => {
    await runCliCommand(['down'])
    const downFile = path.join(root, 'src', 'storage', 'framework', 'down')
    expect(fsSync.existsSync(downFile)).toBe(true)

    await runCliCommand(['up'])
    expect(fsSync.existsSync(downFile)).toBe(false)
  })

  it('stub:publish publishes editable generator stubs', async () => {
    await runCliCommand(['stub:publish'])
    for (const file of [
      'controller.stub',
      'model.stub',
      'middleware.stub',
      'request.stub',
      'notification.stub',
      'mail.stub',
      'job.stub',
      'migration.stub',
      'policy.stub',
      'listener.stub',
      'event.stub',
      'resource.stub',
      'cast.stub',
      'command.stub',
      'rule.stub',
      'seeder.stub',
      'factory.stub'
    ]) {
      expect(fsSync.existsSync(path.join(root, 'src', 'stubs', file))).toBe(true)
    }
  })

  it('queue:failed and queue:retry commands display and retry failed jobs', async () => {
    await Schema.create('failed_jobs', table => {
      table.increments('id')
      table.string('queue')
      table.string('job')
      table.text('payload')
      table.text('error')
      table.timestamp('failed_at')
    })

    await Schema.create('jobs', table => {
      table.increments('id')
      table.string('queue')
      table.text('payload')
      table.integer('attempts')
      table.integer('reserved_at').nullable()
      table.integer('available_at')
      table.integer('created_at')
    })

    const payload = JSON.stringify({
      class: 'TestSyncJob',
      properties: {
        __type: 'class',
        name: 'TestSyncJob',
        properties: { val: 'retry-test-val' }
      }
    })
    await DB.table('failed_jobs').insert({
      queue: 'default',
      job: 'TestSyncJob',
      payload,
      error: 'test_error',
      failed_at: new Date()
    })

    await runCliCommand(['queue:failed'])
    expect(tableSpy).toHaveBeenCalled()

    await runCliCommand(['queue:retry', '1'])
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Retried failed job [1]'))

    const failedAfter = await DB.table('failed_jobs').where('id', 1).first()
    expect(failedAfter).toBeUndefined()
  })

  it('queue:flush clears all failed jobs', async () => {
    await Schema.create('failed_jobs', table => {
      table.increments('id')
      table.string('queue')
      table.string('job')
      table.text('payload')
      table.text('error')
      table.timestamp('failed_at')
    })

    await DB.table('failed_jobs').insert({
      queue: 'default',
      job: 'TestSyncJob',
      payload: '{}',
      error: 'test_error',
      failed_at: new Date()
    })

    expect(await DB.table('failed_jobs').count({ count: '*' }).first().then(r => Number(r?.count ?? 0))).toBe(1)

    await runCliCommand(['queue:flush'])
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Failed queue flushed'))

    expect(await DB.table('failed_jobs').count({ count: '*' }).first().then(r => Number(r?.count ?? 0))).toBe(0)
  })
})
