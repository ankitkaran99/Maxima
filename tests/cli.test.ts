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

describe('CLI Core', () => {
  const originalBasePath = process.env.MAXIMA_BASE_PATH
  let root = ''
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-cli-'))
    process.env.MAXIMA_BASE_PATH = root
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    logSpy.mockRestore()
    if (originalBasePath) {
      process.env.MAXIMA_BASE_PATH = originalBasePath
    } else {
      delete process.env.MAXIMA_BASE_PATH
    }
    await fs.rm(root, { recursive: true, force: true })
  })

  it('creates framework files in the project source tree', async () => {
    await runCliCommand(['make:model', 'User'])
    await runCliCommand(['make:controller', 'UserController'])

    const model = await fs.readFile(path.join(root, 'src', 'app', 'Models', 'User.ts'), 'utf8')
    const controller = await fs.readFile(path.join(root, 'src', 'app', 'Http', 'Controllers', 'UserController.ts'), 'utf8')

    expect(model).toContain('export default class User extends Model')
    expect(controller).toContain('export default class UserController extends Controller')
  })
})

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
    if (originalBasePath) {
      process.env.MAXIMA_BASE_PATH = originalBasePath
    } else {
      delete process.env.MAXIMA_BASE_PATH
    }
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

  it('queue:restart writes the restart signal file', async () => {
    const restartFile = path.join(root, 'src', 'storage', 'framework', 'queue-restart')

    await runCliCommand(['queue:restart'])

    expect(fsSync.existsSync(restartFile)).toBe(true)
    await expect(fs.readFile(restartFile, 'utf8')).resolves.not.toBe('')
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

describe('CLI Generators', () => {
  const root = path.join(process.cwd(), 'src')

  beforeEach(async () => {
    delete process.env.MAXIMA_BASE_PATH
    // Clean up any test generated files if they exist
    for (const file of [
      'app/Policies/TestPolicy.ts',
      'app/Events/TestEvent.ts',
      'app/Listeners/TestListener.ts',
      'app/Http/Resources/TestResource.ts',
      'app/Casts/TestCast.ts',
      'app/Console/Commands/TestCommand.ts',
      'database/seeders/TestSeeder.ts',
      'database/factories/TestFactory.ts'
    ]) {
      await fs.rm(path.join(root, file), { force: true })
    }
  })

  afterEach(async () => {
    delete process.env.MAXIMA_BASE_PATH
    for (const file of [
      'app/Policies/TestPolicy.ts',
      'app/Events/TestEvent.ts',
      'app/Listeners/TestListener.ts',
      'app/Http/Resources/TestResource.ts',
      'app/Casts/TestCast.ts',
      'app/Console/Commands/TestCommand.ts',
      'database/seeders/TestSeeder.ts',
      'database/factories/TestFactory.ts'
    ]) {
      await fs.rm(path.join(root, file), { force: true })
    }
  })

  it('generates policy, event, listener, resource, cast, and custom command files', async () => {
    // Generate policy
    await runCliCommand(['make:policy', 'TestPolicy'])
    expect(fsSync.existsSync(path.join(root, 'app/Policies/TestPolicy.ts'))).toBe(true)
    const policyContent = await fs.readFile(path.join(root, 'app/Policies/TestPolicy.ts'), 'utf8')
    expect(policyContent).toContain('class TestPolicy')

    // Generate event
    await runCliCommand(['make:event', 'TestEvent'])
    expect(fsSync.existsSync(path.join(root, 'app/Events/TestEvent.ts'))).toBe(true)
    const eventContent = await fs.readFile(path.join(root, 'app/Events/TestEvent.ts'), 'utf8')
    expect(eventContent).toContain('class TestEvent')

    // Generate listener
    await runCliCommand(['make:listener', 'TestListener'])
    expect(fsSync.existsSync(path.join(root, 'app/Listeners/TestListener.ts'))).toBe(true)
    const listenerContent = await fs.readFile(path.join(root, 'app/Listeners/TestListener.ts'), 'utf8')
    expect(listenerContent).toContain('class TestListener')

    // Generate resource
    await runCliCommand(['make:resource', 'TestResource'])
    expect(fsSync.existsSync(path.join(root, 'app/Http/Resources/TestResource.ts'))).toBe(true)
    const resourceContent = await fs.readFile(path.join(root, 'app/Http/Resources/TestResource.ts'), 'utf8')
    expect(resourceContent).toContain('class TestResource extends JsonResource')

    // Generate cast
    await runCliCommand(['make:cast', 'TestCast'])
    expect(fsSync.existsSync(path.join(root, 'app/Casts/TestCast.ts'))).toBe(true)
    const castContent = await fs.readFile(path.join(root, 'app/Casts/TestCast.ts'), 'utf8')
    expect(castContent).toContain('class TestCast implements CastsAttributes')

    // Generate custom command
    await runCliCommand(['make:command', 'TestCommand'])
    expect(fsSync.existsSync(path.join(root, 'app/Console/Commands/TestCommand.ts'))).toBe(true)
    const commandContent = await fs.readFile(path.join(root, 'app/Console/Commands/TestCommand.ts'), 'utf8')
    expect(commandContent).toContain('class TestCommand')

    // Generate seeder
    await runCliCommand(['make:seeder', 'TestSeeder'])
    expect(fsSync.existsSync(path.join(root, 'database/seeders/TestSeeder.ts'))).toBe(true)
    const seederContent = await fs.readFile(path.join(root, 'database/seeders/TestSeeder.ts'), 'utf8')
    expect(seederContent).toContain('export async function seed')

    // Generate factory
    await runCliCommand(['make:factory', 'TestFactory'])
    expect(fsSync.existsSync(path.join(root, 'database/factories/TestFactory.ts'))).toBe(true)
    const factoryContent = await fs.readFile(path.join(root, 'database/factories/TestFactory.ts'), 'utf8')
    expect(factoryContent).toContain('class TestFactory')
  })
})

describe('Artisan parity commands', () => {
  const originalBasePath = process.env.MAXIMA_BASE_PATH
  let root = ''
  let src = ''
  let logSpy: ReturnType<typeof vi.spyOn>
  let tableSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-artisan-'))
    src = path.join(root, 'src')
    process.env.MAXIMA_BASE_PATH = root
    await writeConfig(src)
    await DB.close()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    tableSpy = vi.spyOn(console, 'table').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    logSpy.mockRestore()
    tableSpy.mockRestore()
    process.env.MAXIMA_BASE_PATH = originalBasePath
    await DB.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('reports application metadata, environment, and generated keys', async () => {
    await runCliCommand(['about'])
    await runCliCommand(['env'])
    await runCliCommand(['key:generate', '--show'])
    await runCliCommand(['key:generate'])

    expect(tableSpy).toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith('testing')
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^base64:/))
    expect(await fs.readFile(path.join(src, '.env'), 'utf8')).toMatch(/^APP_KEY=base64:/m)
  })

  it('caches, shows, optimizes, and clears framework cache files', async () => {
    await runCliCommand(['config:cache'])
    expect(fsSync.existsSync(path.join(src, 'storage', 'framework', 'config.json'))).toBe(true)

    await runCliCommand(['config:show', 'app.env'])
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify('testing', null, 2))

    await runCliCommand(['optimize'])
    expect(fsSync.existsSync(path.join(src, 'storage', 'framework', 'config.json'))).toBe(true)
    expect(fsSync.existsSync(path.join(src, 'storage', 'framework', 'routes.json'))).toBe(true)

    await runCliCommand(['optimize:clear'])
    expect(fsSync.existsSync(path.join(src, 'storage', 'framework', 'config.json'))).toBe(false)
    expect(fsSync.existsSync(path.join(src, 'storage', 'framework', 'routes.json'))).toBe(false)
  })

  it('publishes event cache, lists events, clears cache, and generates defaults', async () => {
    await fs.mkdir(path.join(src, 'app', 'Events'), { recursive: true })
    await fs.mkdir(path.join(src, 'app', 'Listeners'), { recursive: true })
    await fs.writeFile(path.join(src, 'app', 'Events', 'OrderPlaced.ts'), 'export default class OrderPlaced {}\n')
    await fs.writeFile(path.join(src, 'app', 'Listeners', 'SendOrderMail.ts'), 'export default class SendOrderMail {}\n')

    await runCliCommand(['event:list'])
    expect(tableSpy).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ type: 'event', name: 'OrderPlaced' }),
      expect.objectContaining({ type: 'listener', name: 'SendOrderMail' })
    ]))

    await runCliCommand(['event:cache'])
    const eventCache = path.join(src, 'storage', 'framework', 'events.json')
    expect(JSON.parse(await fs.readFile(eventCache, 'utf8')).events[0].name).toBe('OrderPlaced')

    await runCliCommand(['event:clear'])
    expect(fsSync.existsSync(eventCache)).toBe(false)

    await runCliCommand(['event:generate'])
    expect(fsSync.existsSync(path.join(src, 'app', 'Events', 'SampleEvent.ts'))).toBe(true)
    expect(fsSync.existsSync(path.join(src, 'app', 'Listeners', 'SampleListener.ts'))).toBe(true)
  })

  it('links storage, publishes vendor assets, and uses customized generator stubs', async () => {
    await runCliCommand(['storage:link'])
    expect(fsSync.existsSync(path.join(src, 'public', 'storage'))).toBe(true)
    await runCliCommand(['storage:unlink'])
    expect(fsSync.existsSync(path.join(src, 'public', 'storage'))).toBe(false)

    await runCliCommand(['vendor:publish', '--tag', 'stubs'])
    await runCliCommand(['stub:publish'])
    for (const file of ['component.stub', 'enum.stub', 'exception.stub', 'interface.stub', 'observer.stub', 'provider.stub', 'test.stub', 'trait.stub']) {
      expect(fsSync.existsSync(path.join(src, 'stubs', file))).toBe(true)
    }

    const modelStub = path.join(src, 'stubs', 'model.stub')
    await fs.writeFile(modelStub, 'export default class {{ class }} { custom = true }\n')
    await runCliCommand(['make:model', 'Article'])
    expect(await fs.readFile(path.join(src, 'app', 'Models', 'Article.ts'), 'utf8')).toContain('custom = true')

    await fs.writeFile(path.join(src, 'app', 'Models', 'Article.ts'), 'preserved\n')
    await runCliCommand(['make:model', 'Article', '--preserve'])
    expect(await fs.readFile(path.join(src, 'app', 'Models', 'Article.ts'), 'utf8')).toBe('preserved\n')

    await runCliCommand(['make:model', 'Article', '--force'])
    expect(await fs.readFile(path.join(src, 'app', 'Models', 'Article.ts'), 'utf8')).toContain('custom = true')
  })

  it('generates the additional Laravel-style file types', async () => {
    const commands = [
      ['make:channel', 'OrdersChannel', 'app/Broadcasting/OrdersChannel.ts'],
      ['make:component', 'AlertBox', 'app/View/Components/AlertBox.ts'],
      ['make:enum', 'OrderStatus', 'app/Enums/OrderStatus.ts'],
      ['make:exception', 'DomainException', 'app/Exceptions/DomainException.ts'],
      ['make:interface', 'Billable', 'app/Contracts/Billable.ts'],
      ['make:observer', 'UserObserver', 'app/Observers/UserObserver.ts'],
      ['make:provider', 'BillingProvider', 'app/Providers/BillingProvider.ts'],
      ['make:test', 'FeatureExample', '../tests/FeatureExample.test.ts'],
      ['make:trait', 'HasUuid', 'app/Support/HasUuid.ts']
    ] as const

    for (const [command, name, file] of commands) {
      await runCliCommand([command, name])
      expect(fsSync.existsSync(path.join(src, file))).toBe(true)
    }
  })

  it('installs API and auth scaffolding', async () => {
    await runCliCommand(['install:api'])
    await runCliCommand(['install:auth'])

    expect(await fs.readFile(path.join(src, 'routes', 'api.ts'), 'utf8')).toContain('/api/health')
    expect(await fs.readFile(path.join(src, 'routes', 'web.ts'), 'utf8')).toContain('/login')
  })

  it('shows, inspects, monitors, and wipes database tables', async () => {
    await runCliCommand(['db:show'])
    await DB.connection().schema.createTable('widgets', table => {
      table.increments('id')
      table.string('name')
    })

    await runCliCommand(['db:table', 'widgets'])
    expect(tableSpy).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ column: 'id' }),
      expect.objectContaining({ column: 'name' })
    ]))

    await runCliCommand(['db:monitor'])
    expect(tableSpy).toHaveBeenCalledWith([expect.objectContaining({ status: 'ok' })])

    await runCliCommand(['db:wipe', '--force'])
    expect(await DB.connection().schema.hasTable('widgets')).toBe(false)
  })

  it('parses custom command signatures with arguments and options', async () => {
    await fs.mkdir(path.join(src, 'app', 'Console', 'Commands'), { recursive: true })
    await fs.writeFile(path.join(src, 'app', 'Console', 'Commands', 'DemoCommand.ts'), `
export default class DemoCommand {
  signature = 'demo:run {name} {--loud}'

  async handle(options, name) {
    console.log(options.loud ? name.toUpperCase() : name)
  }
}
`)

    await runCliCommand(['demo:run', 'taylor', '--loud'])
    expect(logSpy).toHaveBeenCalledWith('TAYLOR')
  })
})

async function writeConfig(src: string) {
  await fs.mkdir(path.join(src, 'config'), { recursive: true })
  await fs.mkdir(path.join(src, 'routes'), { recursive: true })
  await fs.writeFile(path.join(src, 'routes', 'web.ts'), `import { Route } from '@lib/http/Route.js'\n\nRoute.get('/home', 'HomeController@index').name('home')\n`)
  await fs.writeFile(path.join(src, 'config', 'app.ts'), `export default { env: 'testing', key: 'base64:test', url: 'http://localhost', providers: [] }\n`)
  await fs.writeFile(path.join(src, 'config', 'cache.ts'), `export default { default: 'memory', stores: { memory: { driver: 'memory', prefix: 'artisan_test' } } }\n`)
  await fs.writeFile(path.join(src, 'config', 'database.ts'), `export default { default: 'sqlite', connections: { sqlite: { client: 'sqlite3', connection: { filename: ${JSON.stringify(path.join(src, 'database.sqlite'))} }, useNullAsDefault: true } } }\n`)
  await fs.writeFile(path.join(src, 'config', 'events.ts'), `export default { discover: false }\n`)
  await fs.writeFile(path.join(src, 'config', 'logging.ts'), `export default { default: 'console', channels: { console: { driver: 'null' } } }\n`)
}
