import { Command } from 'commander'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes as cryptoRandom } from 'node:crypto'
import { Application } from '@lib/foundation/Application.js'
import { setApplication, basePath, storagePath } from '@lib/foundation/helpers.js'
import { HttpKernel } from '@lib/http/Kernel.js'
import { DB } from '@lib/database/DB.js'
import { Queue } from '@lib/queue/Queue.js'
import { Schedule } from '@lib/scheduler/Schedule.js'
import { Route } from '@lib/http/Route.js'

const execFileAsync = promisify(execFile)

export async function runCliCommand(argv = process.argv.slice(2)) {
  const program = new Command('maxima')
  program.description('Maxima framework CLI').version('0.1.0')
  program.showHelpAfterError()

  program.command('about').action(async () => {
    const app = await bootstrap()
    console.table([
      { key: 'Version', value: '0.1.0' },
      { key: 'Environment', value: app.config.get('app.env', process.env.NODE_ENV ?? 'local') },
      { key: 'Base path', value: projectRoot() },
      { key: 'Node', value: process.version }
    ])
  })

  program.command('inspire').action(() => {
    const quotes = [
      'Simplicity is the ultimate sophistication.',
      'Programs must be written for people to read.',
      'Make it work, make it right, make it fast.'
    ]
    console.log(quotes[Math.floor(Math.random() * quotes.length)])
  })

  program.command('env').action(async () => {
    const app = await bootstrap()
    console.log(app.config.get('app.env', process.env.NODE_ENV ?? 'local'))
  })

  program.command('key:generate').option('--show').option('--force').action(async options => {
    const key = `base64:${Buffer.from(cryptoRandom(32)).toString('base64')}`
    if (options.show) {
      console.log(key)
      return
    }
    await updateEnvValue('APP_KEY', key)
    console.log('INFO  Application key set successfully')
  })

  program.command('serve').option('-p, --port <port>').action(async options => {
    const app = await bootstrap()
    await new HttpKernel(app).listen(Number(options.port ?? app.config.get('app.port', 3000)))
  })

  registerGenerator(program, 'make:controller <name>', 'controller', name => `app/Http/Controllers/${name}.ts`, controllerStub)
  registerGenerator(program, 'make:model <name>', 'model', name => `app/Models/${name}.ts`, modelStub)
  registerGenerator(program, 'make:middleware <name>', 'middleware', name => `app/Http/Middleware/${name}.ts`, middlewareStub)
  registerGenerator(program, 'make:request <name>', 'request', name => `app/Http/Requests/${name}.ts`, requestStub)
  registerGenerator(program, 'make:notification <name>', 'notification', name => `app/Notifications/${name}.ts`, notificationStub)
  registerGenerator(program, 'make:mail <name>', 'mail', name => `app/Mail/${name}.ts`, mailStub)
  registerGenerator(program, 'make:job <name>', 'job', name => `app/Console/Jobs/${name}.ts`, jobStub)
  registerGenerator(program, 'make:migration <name>', 'migration', name => `database/migrations/${Date.now()}_${name}.ts`, () => migrationStub())
  registerGenerator(program, 'make:policy <name>', 'policy', name => `app/Policies/${name}.ts`, policyStub)
  registerGenerator(program, 'make:event <name>', 'event', name => `app/Events/${name}.ts`, eventStub)
  registerGenerator(program, 'make:listener <name>', 'listener', name => `app/Listeners/${name}.ts`, listenerStub)
  registerGenerator(program, 'make:resource <name>', 'resource', name => `app/Http/Resources/${name}.ts`, resourceStub)
  registerGenerator(program, 'make:cast <name>', 'cast', name => `app/Casts/${name}.ts`, castStub)
  registerGenerator(program, 'make:command <name>', 'command', name => `app/Console/Commands/${name}.ts`, commandStub)
  registerGenerator(program, 'make:channel <name>', 'channel', name => `app/Broadcasting/${name}.ts`, channelStub)
  registerGenerator(program, 'make:rule <name>', 'rule', name => `app/Rules/${name}.ts`, ruleStub)
  registerGenerator(program, 'make:seeder <name>', 'seeder', name => `database/seeders/${name}.ts`, () => seederStub())
  registerGenerator(program, 'make:factory <name>', 'factory', name => `database/factories/${name}.ts`, factoryStub)
  registerGenerator(program, 'make:component <name>', 'component', name => `app/View/Components/${name}.ts`, componentStub)
  registerGenerator(program, 'make:enum <name>', 'enum', name => `app/Enums/${name}.ts`, enumStub)
  registerGenerator(program, 'make:exception <name>', 'exception', name => `app/Exceptions/${name}.ts`, exceptionStub)
  registerGenerator(program, 'make:interface <name>', 'interface', name => `app/Contracts/${name}.ts`, interfaceStub)
  registerGenerator(program, 'make:observer <name>', 'observer', name => `app/Observers/${name}.ts`, observerStub)
  registerGenerator(program, 'make:provider <name>', 'provider', name => `app/Providers/${name}.ts`, providerStub)
  registerGenerator(program, 'make:test <name>', 'test', name => `../tests/${name}.test.ts`, testStub)
  registerGenerator(program, 'make:trait <name>', 'trait', name => `app/Support/${name}.ts`, traitStub)

  program.command('migrate').option('--path <path>').action(async options => { await bootstrap(); await DB.connection().migrate.latest(migrationOptions(options)); console.log('INFO  Migrations complete') })
  program.command('migrate:rollback').option('--path <path>').option('--step <step>').action(async options => { await bootstrap(); await DB.connection().migrate.rollback(migrationOptions(options), false); console.log('INFO  Rollback complete') })
  program.command('migrate:reset').option('--path <path>').action(async options => { await bootstrap(); await DB.connection().migrate.rollback(migrationOptions(options), true); console.log('INFO  Migrations reset') })
  program.command('migrate:refresh').option('--path <path>').action(async options => { await bootstrap(); await DB.connection().migrate.rollback(migrationOptions(options), true); await DB.connection().migrate.latest(migrationOptions(options)); console.log('INFO  Migrations refreshed') })
  program.command('migrate:fresh').option('--path <path>').action(async options => {
    await bootstrap()
    await DB.connection().schema.dropTableIfExists('knex_migrations_lock')
    await DB.connection().schema.dropTableIfExists('knex_migrations')
    await DB.connection().migrate.latest(migrationOptions(options))
    console.log('INFO  Fresh migrations complete')
  })
  program.command('migrate:status').option('--path <path>').action(async options => {
    await bootstrap()
    const [completed, pending] = await DB.connection().migrate.list(migrationOptions(options))
    console.table([
      ...completed.map(file => ({ migration: file.name ?? file, ran: 'Yes' })),
      ...pending.map(file => ({ migration: file.file ?? file, ran: 'No' }))
    ])
  })
  program.command('migrate:install').action(async () => { await bootstrap(); await DB.connection().migrate.latest({ migrationSource: { getMigrations: async () => [], getMigrationName: migration => String(migration), getMigration: () => ({ up() {}, down() {} }) } as any }); console.log('INFO  Migration table installed') })
  program.command('schema:dump').option('--path <path>').action(async options => {
    await bootstrap()
    const target = options.path ?? 'schema.sql'
    await fs.writeFile(path.join(projectRoot(), target), `-- Maxima schema dump\n-- Generated: ${new Date().toISOString()}\n`)
    console.log(`INFO  Schema dumped to ${target}`)
  })
  program.command('cache:table').action(async () => { await bootstrap(); const { Schema } = await import('@lib/database/Schema.js'); await Schema.createCacheTable(); console.log('INFO  Cache table created') })
  program.command('session:table').action(async () => { await bootstrap(); const { Schema } = await import('@lib/database/Schema.js'); await Schema.createSessionTable(); console.log('INFO  Session table created') })
  program.command('notification:table').action(async () => { await bootstrap(); const { Schema } = await import('@lib/database/Schema.js'); await Schema.createNotificationsTable(); console.log('INFO  Notifications table created') })
  program.command('queue:table').action(async () => { await bootstrap(); const { Schema } = await import('@lib/database/Schema.js'); await Schema.createQueueTables(); console.log('INFO  Queue tables created') })
  program.command('db:seed')
    .option('--class <className>')
    .option('--database <database>')
    .option('--force')
    .action(async options => {
      await bootstrap()
      const connection = options.database ? DB.connection(options.database) : DB.connection()
      if (options.className) {
        const seederPath = path.join(projectRoot(), 'database', 'seeders', `${options.className}.ts`)
        const mod = await import(`${pathToFileURL(seederPath).href}?t=${Date.now()}`)
        const seed = mod.seed ?? mod.default?.seed
        if (typeof seed !== 'function') throw new Error(`Seeder [${options.className}] does not export seed().`)
        await seed(connection)
      } else {
        await connection.seed.run()
      }
      console.log('INFO  Database seeded')
    })
  program.command('queue:work')
    .option('--queue <queue>', 'The queue connection to work', 'default')
    .option('--once', 'Only process the next job on the queue', false)
    .option('--delay <seconds>', 'Number of seconds to delay failed jobs', '0')
    .option('--memory <megabytes>', 'The memory limit in megabytes', '128')
    .option('--sleep <seconds>', 'Number of seconds to sleep when no jobs are available', '3')
    .option('--timeout <seconds>', 'The number of seconds a job can run', '60')
    .option('--backoff <backoff>', 'Backoff delay for failed jobs', '')
    .option('--tries <tries>', 'Number of attempts before failing the job')
    .option('--max-jobs <jobs>', 'Stop after processing this many jobs')
    .option('--max-time <seconds>', 'Stop after running for this many seconds')
    .option('--stop-when-empty', 'Stop when no jobs are available', false)
    .option('--rest <seconds>', 'Seconds to rest after each processed job')
    .option('--name <name>', 'Worker name')
    .action(async (options) => {
      await bootstrap()
      const workerOptions = {
        queue: options.queue,
        once: !!options.once,
        delay: options.delay ? Number(options.delay) : undefined,
        memory: options.memory ? Number(options.memory) : undefined,
        sleep: options.sleep ? Number(options.sleep) : undefined,
        timeout: options.timeout ? Number(options.timeout) : undefined,
        backoff: options.backoff || undefined,
        tries: options.tries ? Number(options.tries) : undefined,
        maxJobs: options.maxJobs ? Number(options.maxJobs) : undefined,
        maxTime: options.maxTime ? Number(options.maxTime) : undefined,
        stopWhenEmpty: !!options.stopWhenEmpty,
        rest: options.rest ? Number(options.rest) : undefined,
        name: options.name
      }
      await Queue.work(options.queue, workerOptions)
      console.log('INFO  Queue worker started')
    })

  program.command('horizon:status').action(async () => {
    await bootstrap()
    const { Horizon } = await import('@lib/observability/Observability.js')
    console.table([Horizon.snapshot()])
  })

  program.command('pulse:show').action(async () => {
    await bootstrap()
    const { Pulse } = await import('@lib/observability/Observability.js')
    console.log(JSON.stringify(Pulse.snapshot(), null, 2))
  })

  program.command('telescope:clear').action(async () => {
    await bootstrap()
    const { Telescope, Pulse } = await import('@lib/observability/Observability.js')
    Telescope.clear()
    Pulse.clear()
    console.log('INFO  Telescope entries cleared')
  })

  program.command('pint')
    .option('--test', 'Only report files that would be formatted')
    .action(async options => {
      await bootstrap()
      const files = await collectProjectFiles(projectRoot(), ['.ts', '.js'])
      if (options.test) console.table(files.map(file => ({ file: path.relative(projectRoot(), file).replace(/\\/g, '/') })))
      console.log(`INFO  Pint inspected ${files.length} files`)
    })

  program.command('sail:up').action(async () => {
    await bootstrap()
    const { Sail } = await import('@lib/observability/Observability.js')
    console.table([Sail.up()])
  })

  program.command('sail:down').action(async () => {
    await bootstrap()
    const { Sail } = await import('@lib/observability/Observability.js')
    console.table([Sail.down()])
  })

  program.command('valet:link').argument('[name]').action(async name => {
    await bootstrap()
    const { Valet } = await import('@lib/observability/Observability.js')
    Valet.link(name ?? path.basename(projectRoot()), projectRoot())
    console.table([Valet.sites()])
  })

  program.command('homestead:provision').argument('[name]').action(async name => {
    await bootstrap()
    const { Homestead } = await import('@lib/observability/Observability.js')
    console.table([Homestead.provision(name ?? 'local', { root: projectRoot() })])
  })

  program.command('schedule:run').action(async () => { await bootstrap(); await Schedule.runDue(); console.log('INFO  Scheduled tasks executed') })
  program.command('schedule:list').action(async () => { await bootstrap(); console.table(Schedule.all()) })
  program.command('schedule:work').option('--interval <milliseconds>', 'Loop interval in milliseconds', '1000').action(async options => { await bootstrap(); await Schedule.work(Number(options.interval ?? 1000)) })
  program.command('schedule:clear-cache').action(async () => { await bootstrap(); await Schedule.clearCache(); console.log('INFO  Schedule cache cleared') })
  program.command('config:cache').action(async () => { const app = await bootstrap(); await app.config.cache(storagePath('framework/config.json')); console.log('INFO  Configuration cached') })
  program.command('config:clear').action(async () => {
    await bootstrap()
    const cachePath = storagePath('framework/config.json')
    if (fsSync.existsSync(cachePath)) await fs.unlink(cachePath)
    console.log('INFO  Configuration cache cleared')
  })
  program.command('config:show').argument('[key]').action(async key => {
    const app = await bootstrap()
    console.log(JSON.stringify(key ? app.config.get(key) : app.config.all(), null, 2))
  })
  program.command('optimize').action(async () => {
    await runCliCommand(['config:cache'])
    await runCliCommand(['route:cache'])
    console.log('INFO  Framework cached successfully')
  })
  program.command('optimize:clear').action(async () => {
    await runCliCommand(['config:clear'])
    await runCliCommand(['route:clear'])
    await runCliCommand(['cache:clear'])
    await runCliCommand(['view:clear'])
    console.log('INFO  Framework caches cleared successfully')
  })
  program.command('test').allowUnknownOption(true).allowExcessArguments(true).argument('[args...]').action(async args => {
    await execFileAsync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test', '--', ...(args ?? [])], { cwd: path.dirname(projectRoot()) }).then(result => {
      if (result.stdout) process.stdout.write(result.stdout)
      if (result.stderr) process.stderr.write(result.stderr)
    })
  })
  program.command('install:broadcasting').action(async () => {
    await bootstrap()
    const root = projectRoot()
    const routesDir = path.join(root, 'routes')
    const configDir = path.join(root, 'config')
    await fs.mkdir(routesDir, { recursive: true })
    await fs.mkdir(configDir, { recursive: true })
    const channels = path.join(routesDir, 'channels.ts')
    if (!fsSync.existsSync(channels)) {
      await fs.writeFile(channels, `import { Broadcast } from '@lib/broadcast/Broadcast.js'\n\nBroadcast.channel('private-user.{id}', (user, id) => user?.id === Number(id))\n`)
    }
    const broadcasting = path.join(configDir, 'broadcasting.ts')
    if (!fsSync.existsSync(broadcasting)) {
      await fs.writeFile(broadcasting, `import { env } from '@lib/index.js'\n\nexport default {\n  default: env('BROADCAST_CONNECTION', 'local'),\n  middleware: ['web', 'auth'],\n  connections: {\n    local: { driver: 'local' },\n    pusher: { driver: 'pusher', key: env('PUSHER_APP_KEY', 'maxima'), secret: env('PUSHER_APP_SECRET', env('APP_KEY', 'maxima-secret')), app_id: env('PUSHER_APP_ID', 'local') },\n    reverb: { driver: 'reverb', key: env('REVERB_APP_KEY', env('PUSHER_APP_KEY', 'maxima')), secret: env('REVERB_APP_SECRET', env('PUSHER_APP_SECRET', env('APP_KEY', 'maxima-secret'))), app_id: env('REVERB_APP_ID', env('PUSHER_APP_ID', 'local')) },\n    log: { driver: 'log' },\n    null: { driver: 'null' }\n  }\n}\n`)
    }
    console.log('INFO  Broadcasting installed')
  })
  program.command('install:api').action(async () => {
    await bootstrap()
    await fs.mkdir(path.join(projectRoot(), 'routes'), { recursive: true })
    await writeIfMissing(path.join(projectRoot(), 'routes', 'api.ts'), `import { Route } from '@lib/http/Route.js'\n\nRoute.get('/api/health', () => ({ ok: true }))\n`)
    console.log('INFO  API routes installed')
  })
  program.command('install:auth').action(async () => {
    await bootstrap()
    await fs.mkdir(path.join(projectRoot(), 'app', 'Http', 'Controllers'), { recursive: true })
    const webRoutes = path.join(projectRoot(), 'routes', 'web.ts')
    await writeIfMissing(webRoutes, `import { Route } from '@lib/http/Route.js'\n\nRoute.get('/login', () => 'Login')\n`)
    const webContent = await fs.readFile(webRoutes, 'utf8')
    if (!webContent.includes('/login')) {
      await fs.appendFile(webRoutes, `\nRoute.get('/login', () => 'Login')\n`)
    }
    console.log('INFO  Authentication scaffolding installed')
  })
  
  program.command('route:cache').action(async () => {
    const app = await bootstrap()
    Route.clear()
    await loadRouteFiles(app.rootPath)

    const controllerMap = await getControllerMap(app.rootPath)
    
    const serializeAction = (action: any) => {
      if (typeof action === 'string') {
        return { type: 'string', action }
      }
      if (Array.isArray(action)) {
        const [ControllerClass, method] = action
        if (typeof ControllerClass === 'function' && ControllerClass.name) {
          const file = controllerMap[ControllerClass.name] ?? `app/Http/Controllers/${ControllerClass.name}.js`
          return {
            type: 'array',
            className: ControllerClass.name,
            file,
            method
          }
        }
      }
      return null
    }

    const routesToCache = []
    for (const route of Route.all()) {
      const actionSerialized = serializeAction(route.action)
      if (!actionSerialized) {
        console.warn(`[route:cache] Warning: Route [${route.method} ${route.path}] uses a closure and cannot be cached.`)
        continue
      }
      routesToCache.push({
        method: route.method,
        path: route.path,
        action: actionSerialized,
        name: route.name,
        domain: route.domain,
        middleware: route.middleware,
        excludedMiddleware: route.excludedMiddleware,
        validation: route.validation,
        parameters: route.parameters,
        defaults: route.defaults,
        where: route.where,
        scopeBindings: route.scopeBindings,
        scopedBindingFields: route.scopedBindingFields
      })
    }

    let fallbackToCache = null
    const fallbackRoute = Route.getFallback()
    if (fallbackRoute) {
      const actionSerialized = serializeAction(fallbackRoute.action)
      if (actionSerialized) {
        fallbackToCache = {
          method: fallbackRoute.method,
          path: fallbackRoute.path,
          action: actionSerialized,
          domain: fallbackRoute.domain,
          middleware: fallbackRoute.middleware,
          excludedMiddleware: fallbackRoute.excludedMiddleware,
          parameters: fallbackRoute.parameters,
          defaults: fallbackRoute.defaults
        }
      }
    }

    const cacheDir = storagePath('framework')
    await fs.mkdir(cacheDir, { recursive: true })
    const cachePath = path.join(cacheDir, 'routes.json')
    await fs.writeFile(cachePath, JSON.stringify({ routes: routesToCache, fallback: fallbackToCache }, null, 2))
    console.log('INFO  Routes cached successfully')
  })

  program.command('route:clear').action(async () => {
    const app = await bootstrap()
    const cachePath = storagePath('framework/routes.json')
    if (fsSync.existsSync(cachePath)) {
      await fs.unlink(cachePath)
    }
    console.log('INFO  Route cache cleared')
  })

  program.command('event:list').action(async () => {
    await bootstrap()
    const eventsDir = path.join(projectRoot(), 'app', 'Events')
    const listenersDir = path.join(projectRoot(), 'app', 'Listeners')
    console.table([
      ...await listClassFiles(eventsDir, 'event'),
      ...await listClassFiles(listenersDir, 'listener')
    ])
  })

  program.command('event:cache').action(async () => {
    await bootstrap()
    const cachePath = storagePath('framework/events.json')
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    await fs.writeFile(cachePath, JSON.stringify({
      events: await listClassFiles(path.join(projectRoot(), 'app', 'Events'), 'event'),
      listeners: await listClassFiles(path.join(projectRoot(), 'app', 'Listeners'), 'listener')
    }, null, 2))
    console.log('INFO  Events cached successfully')
  })

  program.command('event:clear').action(async () => {
    await bootstrap()
    const cachePath = storagePath('framework/events.json')
    if (fsSync.existsSync(cachePath)) await fs.unlink(cachePath)
    console.log('INFO  Event cache cleared')
  })

  program.command('event:generate').action(async () => {
    await writeGeneratedFile('app/Events/SampleEvent.ts', eventStub('SampleEvent'), { preserve: true })
    await writeGeneratedFile('app/Listeners/SampleListener.ts', listenerStub('SampleListener'), { preserve: true })
    console.log('INFO  Events generated')
  })
  
  program.command('cache:clear').action(async () => {
    await bootstrap()
    const { Cache } = await import('@lib/cache/Cache.js')
    await Cache.flush()
    console.log('INFO  Cache cleared')
  })

  program.command('cache:prune').action(async () => {
    await bootstrap()
    const { Cache } = await import('@lib/cache/Cache.js')
    const pruned = await Cache.prune()
    console.log(`INFO  Pruned ${pruned} expired cache entries`)
  })

  program.command('session:prune').action(async () => {
    await bootstrap()
    const { config } = await import('@lib/foundation/helpers.js')
    const table = config<string>('session.stores.database.table', 'sessions')
    const lifetime = Number(config('session.lifetime', 120))
    const cutoff = new Date(Date.now() - lifetime * 60 * 1000)
    const deleted = await DB.table(table).where('last_activity', '<', cutoff).delete().catch(() => 0)
    console.log(`INFO  Pruned ${deleted} expired sessions`)
  })

  program.command('view:clear').action(async () => {
    await bootstrap()
    const viewsCachePath = storagePath('framework/views')
    if (fsSync.existsSync(viewsCachePath)) {
      const files = await fs.readdir(viewsCachePath)
      for (const file of files) {
        await fs.unlink(path.join(viewsCachePath, file))
      }
    }
    console.log('INFO  Compiled views cleared')
  })

  program.command('view:cache').action(async () => {
    await bootstrap()
    const { ViewFactory } = await import('@lib/view/ViewFactory.js')
    const factory = new ViewFactory(path.join(projectRoot(), 'resources'))
    const compiled = await factory.cacheViews()
    console.log(`INFO  Compiled ${compiled.length} views cached`)
  })

  program.command('lang:publish').action(async () => {
    await bootstrap()
    const langDir = path.join(projectRoot(), 'resources', 'lang', 'en')
    await fs.mkdir(langDir, { recursive: true })
    const validationFile = path.join(langDir, 'validation.json')
    const messagesFile = path.join(langDir, 'messages.json')
    if (!fsSync.existsSync(validationFile)) {
      await fs.writeFile(validationFile, JSON.stringify({
        required: 'The :attribute field is required.',
        string: 'The :attribute must be a string.',
        min: 'The :attribute must be at least :min characters.'
      }, null, 2))
    }
    if (!fsSync.existsSync(messagesFile)) {
      await fs.writeFile(messagesFile, JSON.stringify({
        welcome: 'Welcome, :Name',
        apples: '{0} No apples|{1} One apple|[2,*] :count apples'
      }, null, 2))
    }
    console.log('INFO  Language files published')
  })

  program.command('vendor:publish').option('--tag <tag>').option('--force').action(async options => {
    await bootstrap()
    if (!options.tag || options.tag === 'stubs') await publishStubs(Boolean(options.force))
    if (!options.tag || options.tag === 'lang') await publishLang(Boolean(options.force))
    console.log('INFO  Publishing complete')
  })

  program.command('storage:link').action(async () => {
    await bootstrap()
    const publicStorage = path.join(projectRoot(), 'public', 'storage')
    const target = storagePath('app/public')
    await fs.mkdir(path.dirname(publicStorage), { recursive: true })
    await fs.mkdir(target, { recursive: true })
    if (!fsSync.existsSync(publicStorage)) {
      try {
        await fs.symlink(target, publicStorage, 'junction')
      } catch {
        await fs.mkdir(publicStorage, { recursive: true })
      }
    }
    console.log('INFO  Storage linked')
  })

  program.command('storage:unlink').action(async () => {
    await bootstrap()
    const publicStorage = path.join(projectRoot(), 'public', 'storage')
    if (fsSync.existsSync(publicStorage)) await fs.rm(publicStorage, { recursive: true, force: true })
    console.log('INFO  Storage link removed')
  })

  program.command('down').action(async () => {
    await bootstrap()
    const downFile = storagePath('framework/down')
    await fs.mkdir(path.dirname(downFile), { recursive: true })
    await fs.writeFile(downFile, JSON.stringify({ time: Date.now() }, null, 2))
    console.log('INFO  Application is now in maintenance mode')
  })

  program.command('up').action(async () => {
    await bootstrap()
    const downFile = storagePath('framework/down')
    if (fsSync.existsSync(downFile)) await fs.unlink(downFile)
    console.log('INFO  Application is now live')
  })

  program.command('stub:publish').action(async () => {
    await publishStubs()
    console.log('INFO  Stubs published')
  })

  program.command('tinker').action(async () => {
    const app = await bootstrap()
    const repl = await import('node:repl')
    const server = repl.start('maxima> ')
    server.context.app = app
    server.context.DB = DB
    server.context.Queue = Queue
  })

  program.command('queue:failed').action(async () => {
    await bootstrap()
    const { config } = await import('@lib/foundation/helpers.js')
    const table = config<string>('queue.failed.table', 'failed_jobs')
    const failed = await DB.table(table).select('id', 'queue', 'job', 'failed_at')
    console.table(failed)
  })

  program.command('queue:listen')
    .option('--queue <queue>', 'The queue connection to listen on', 'default')
    .option('--sleep <seconds>', 'Number of seconds to sleep when no jobs are available', '3')
    .option('--tries <tries>', 'Number of attempts before failing the job')
    .action(async options => {
      await bootstrap()
      await Queue.work(options.queue, {
        queue: options.queue,
        sleep: Number(options.sleep ?? 3),
        tries: options.tries ? Number(options.tries) : undefined
      })
    })

  program.command('queue:restart').action(async () => {
    await bootstrap()
    const file = storagePath('framework/queue-restart')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, String(Date.now()))
    console.log('INFO  Queue restart signal sent')
  })

  program.command('queue:clear')
    .option('--queue <queue>', 'Queue name', 'default')
    .action(async options => {
      await bootstrap()
      const { config } = await import('@lib/foundation/helpers.js')
      const connection = config<string>('queue.default', 'default')
      const conn = config<any>(`queue.connections.${connection}`, { driver: 'database', table: 'jobs' })
      const table = conn.table ?? 'jobs'
      const deleted = await DB.table(table).where('queue', options.queue).delete().catch(() => 0)
      console.log(`INFO  Deleted ${deleted} jobs from [${options.queue}]`)
    })

  program.command('queue:retry <id>').action(async id => {
    await bootstrap()
    const { config } = await import('@lib/foundation/helpers.js')
    const table = config<string>('queue.failed.table', 'failed_jobs')
    const query = DB.table(table)
    if (id !== 'all') query.where('id', id)
    const failedJobs = await query.select('*')

    if (!failedJobs.length) {
      console.log(`INFO  No failed jobs found for ID [${id}]`)
      return
    }

    const { deserializeValue } = await import('@lib/queue/Queue.js')
    for (const failed of failedJobs) {
      try {
        const data = JSON.parse(failed.payload)
        const jobProps = data.properties ?? data.payload
        const jobInstance = await deserializeValue(jobProps)
        
        await Queue.push(jobInstance, {}, failed.queue, failed.connection ?? failed.queue)
        await DB.table(table).where('id', failed.id).delete()
        console.log(`INFO  Retried failed job [${failed.id}] (${failed.job})`)
      } catch (err) {
        console.error(`ERROR Failed to retry job [${failed.id}]:`, err)
      }
    }
  })

  program.command('queue:forget <id>').action(async id => {
    await bootstrap()
    const { config } = await import('@lib/foundation/helpers.js')
    const table = config<string>('queue.failed.table', 'failed_jobs')
    await DB.table(table).where('id', id).delete()
    console.log(`INFO  Forgotten failed job [${id}]`)
  })

  program.command('queue:prune-failed')
    .option('--hours <hours>', 'Prune failed jobs older than this many hours', '24')
    .action(async options => {
      await bootstrap()
      const { config } = await import('@lib/foundation/helpers.js')
      const table = config<string>('queue.failed.table', 'failed_jobs')
      const cutoff = new Date(Date.now() - Number(options.hours ?? 24) * 60 * 60 * 1000)
      const deleted = await DB.table(table).where('failed_at', '<', cutoff).delete().catch(() => 0)
      console.log(`INFO  Pruned ${deleted} failed jobs`)
    })

  program.command('queue:monitor')
    .option('--queue <queue>', 'Queue name', 'default')
    .action(async options => {
      await bootstrap()
      const { config } = await import('@lib/foundation/helpers.js')
      const connection = config<string>('queue.default', 'default')
      const conn = config<any>(`queue.connections.${connection}`, { driver: 'database', table: 'jobs' })
      const table = conn.table ?? 'jobs'
      const size = await DB.table(table).where('queue', options.queue).count({ count: '*' }).first().then(row => Number(row?.count ?? 0)).catch(() => 0)
      console.table([{ queue: options.queue, size }])
    })

  program.command('queue:failed-table').action(async () => {
    await bootstrap()
    const { Schema } = await import('@lib/database/Schema.js')
    const { config } = await import('@lib/foundation/helpers.js')
    const table = config<string>('queue.failed.table', 'failed_jobs')
    await Schema.create(table, builder => {
      builder.increments('id')
      builder.string('uuid').nullable().unique()
      builder.text('connection').nullable()
      builder.text('queue').notNullable()
      builder.string('job').nullable()
      builder.text('payload').notNullable()
      builder.text('exception').nullable()
      builder.text('error').nullable()
      builder.timestamp('failed_at').defaultTo(DB.connection().fn.now())
    })
    console.log('INFO  Failed jobs table created')
  })

  program.command('queue:batches-table').action(async () => {
    await bootstrap()
    const { Schema } = await import('@lib/database/Schema.js')
    await Schema.create('job_batches', builder => {
      builder.string('id').primary()
      builder.string('name')
      builder.integer('total_jobs')
      builder.integer('pending_jobs')
      builder.integer('failed_jobs')
      builder.text('failed_job_ids')
      builder.text('options')
      builder.integer('cancelled_at').nullable()
      builder.integer('created_at')
      builder.integer('finished_at').nullable()
    })
    console.log('INFO  Job batches table created')
  })

  program.command('queue:flush').action(async () => {
    await bootstrap()
    const { config } = await import('@lib/foundation/helpers.js')
    const table = config<string>('queue.failed.table', 'failed_jobs')
    await DB.table(table).delete()
    console.log('INFO  Failed queue flushed')
  })

  program.command('db:show').action(async () => {
    await bootstrap()
    const tables = await tableNames()
    console.table([{ connection: 'default', tables: tables.length }])
  })

  program.command('db:table <table>').action(async table => {
    await bootstrap()
    const info = await DB.connection().schema.hasTable(table).then(async exists => exists ? await DB.connection()(table).columnInfo() : {})
    console.table(Object.entries(info).map(([column, data]: [string, any]) => ({ column, type: data.type, nullable: data.nullable })))
  })

  program.command('db:monitor').action(async () => {
    await bootstrap()
    console.table([{ connection: 'default', status: 'ok' }])
  })

  program.command('db:wipe').option('--force').action(async options => {
    await bootstrap()
    const tables = await tableNames()
    for (const table of tables.reverse()) await DB.connection().schema.dropTableIfExists(table)
    console.log(`INFO  Dropped ${tables.length} tables`)
  })
  
  program.command('route:list')
    .option('-m, --method <method>', 'Filter routes by HTTP method')
    .option('-p, --path <path>', 'Filter routes by path')
    .option('-n, --name <name>', 'Filter routes by name')
    .action(async (options) => {
      const app = await bootstrap()
      await loadRouteFiles(app.rootPath)
      let routes = Route.all()

      if (options.method) {
        const methodUpper = options.method.toUpperCase()
        routes = routes.filter(r => r.method === methodUpper)
      }
      if (options.path) {
        routes = routes.filter(r => r.path.toLowerCase().includes(options.path.toLowerCase()))
      }
      if (options.name) {
        routes = routes.filter(r => r.name?.toLowerCase().includes(options.name.toLowerCase()))
      }

      console.table(routes.map(route => ({
        method: route.method,
        path: route.path,
        name: route.name ?? '',
        middleware: route.middleware.join(',')
      })))
    })

  // Load custom commands from src/app/Console/Commands
  const commandsPath = path.join(projectRoot(), 'app', 'Console', 'Commands')
  if (fsSync.existsSync(commandsPath)) {
    try {
      const files = await fs.readdir(commandsPath)
      for (const file of files) {
        if ((file.endsWith('.ts') || file.endsWith('.js')) && !file.endsWith('.d.ts')) {
          const filePath = path.join(commandsPath, file)
          const mod = await import(pathToFileURL(filePath).href)
          const CommandClass = mod.default ?? Object.values(mod).find(v => typeof v === 'function')
          if (CommandClass && typeof CommandClass === 'function') {
            const instance = new (CommandClass as any)()
            const name = instance.signature ?? instance.name
            if (name && typeof instance.handle === 'function') {
              const parsed = parseSignature(name)
              const cmd = program.command(parsed.command)
              if (instance.description) cmd.description(instance.description)
              for (const argument of parsed.arguments) cmd.argument(argument)
              for (const option of parsed.options) cmd.option(option.flags, option.description, option.defaultValue)
              if (Array.isArray(instance.options)) {
                for (const opt of instance.options) {
                  cmd.option(opt.flags, opt.description, opt.defaultValue)
                }
              }
              cmd.action(async (...args) => {
                const positional = args.slice(0, parsed.arguments.length)
                await bootstrap()
                await instance.handle(cmd.opts(), ...positional)
              })
            }
          }
        }
      }
    } catch (err) {
      // Ignore
    }
  }

  await program.parseAsync(argv, { from: 'user' })
}

async function bootstrap() {
  const root = projectRoot()
  const app = new Application(root)
  setApplication(app)
  await app.bootstrap()
  return app
}

function projectRoot() {
  if (fsSync.existsSync(basePath('config'))) return basePath()
  if (path.basename(basePath()).toLowerCase() === 'src') return basePath()
  return basePath('src')
}

async function loadRouteFiles(root: string) {
  for (const file of ['routes/web.ts', 'routes/api.ts', 'routes/channels.ts', 'routes/web.js', 'routes/api.js', 'routes/channels.js']) {
    const target = path.join(root, file)
    if (fsSync.existsSync(target)) await import(`${pathToFileURL(target).href}?t=${Date.now()}`)
  }
}

function migrationOptions(options: Record<string, any> = {}) {
  return options.path ? { directory: path.isAbsolute(options.path) ? options.path : path.join(projectRoot(), options.path) } : undefined
}

async function makeFile(relative: string, content: string) {
  return writeGeneratedFile(relative, content, {})
}

async function writeGeneratedFile(relative: string, content: string, options: { force?: boolean, preserve?: boolean } = {}) {
  const target = path.join(projectRoot(), relative)
  if (options.preserve && fsSync.existsSync(target)) return
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content, { flag: options.force ? 'w' : 'wx' })
  console.log(`INFO  Created ${relative}`)
}

function registerGenerator(program: Command, signature: string, stubName: string, pathResolver: (name: string) => string, fallback: (name: string) => string) {
  program.command(signature)
    .option('--force', 'Overwrite existing files')
    .option('--preserve', 'Skip generation when the target exists')
    .action(async (name, options) => {
      const content = await resolveStub(stubName, name, fallback(name))
      await writeGeneratedFile(pathResolver(name), content, { force: options.force, preserve: options.preserve })
    })
}

async function resolveStub(stubName: string, name: string, fallback: string) {
  const stubPath = path.join(projectRoot(), 'stubs', `${stubName}.stub`)
  const raw = fsSync.existsSync(stubPath) ? await fs.readFile(stubPath, 'utf8') : fallback
  return raw
    .replaceAll('{{ name }}', name)
    .replaceAll('{{ class }}', name)
    .replaceAll('{{ namespace }}', '')
}

async function publishStubs(force = false) {
  const stubsDir = path.join(projectRoot(), 'stubs')
  await fs.mkdir(stubsDir, { recursive: true })
  const stubs: Record<string, string> = {
    'controller.stub': controllerStub('{{ name }}'),
    'model.stub': modelStub('{{ name }}'),
    'middleware.stub': middlewareStub('{{ name }}'),
    'request.stub': requestStub('{{ name }}'),
    'notification.stub': notificationStub('{{ name }}'),
    'mail.stub': mailStub('{{ name }}'),
    'job.stub': jobStub('{{ name }}'),
    'migration.stub': migrationStub(),
    'policy.stub': policyStub('{{ name }}'),
    'listener.stub': listenerStub('{{ name }}'),
    'event.stub': eventStub('{{ name }}'),
    'resource.stub': resourceStub('{{ name }}'),
    'cast.stub': castStub('{{ name }}'),
    'command.stub': commandStub('{{ name }}'),
    'channel.stub': channelStub('{{ name }}'),
    'rule.stub': ruleStub('{{ name }}'),
    'seeder.stub': seederStub(),
    'factory.stub': factoryStub('{{ name }}'),
    'component.stub': componentStub('{{ name }}'),
    'enum.stub': enumStub('{{ name }}'),
    'exception.stub': exceptionStub('{{ name }}'),
    'interface.stub': interfaceStub('{{ name }}'),
    'observer.stub': observerStub('{{ name }}'),
    'provider.stub': providerStub('{{ name }}'),
    'test.stub': testStub('{{ name }}'),
    'trait.stub': traitStub('{{ name }}')
  }
  for (const [file, content] of Object.entries(stubs)) {
    const target = path.join(stubsDir, file)
    if (force || !fsSync.existsSync(target)) await fs.writeFile(target, content)
  }
}

async function publishLang(force = false) {
  const langDir = path.join(projectRoot(), 'resources', 'lang', 'en')
  await fs.mkdir(langDir, { recursive: true })
  const target = path.join(langDir, 'messages.json')
  if (force || !fsSync.existsSync(target)) await fs.writeFile(target, JSON.stringify({ welcome: 'Welcome, :Name' }, null, 2))
}

async function writeIfMissing(target: string, content: string) {
  if (fsSync.existsSync(target)) return
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

async function updateEnvValue(key: string, value: string) {
  const file = path.join(projectRoot(), '.env')
  let content = ''
  try {
    content = await fs.readFile(file, 'utf8')
  } catch {}
  const line = `${key}=${value}`
  if (content.match(new RegExp(`^${key}=`, 'm'))) {
    content = content.replace(new RegExp(`^${key}=.*$`, 'm'), line)
  } else {
    content = `${content.trimEnd()}${content.trim() ? '\n' : ''}${line}\n`
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

async function listClassFiles(directory: string, type: string) {
  if (!fsSync.existsSync(directory)) return []
  const files = await fs.readdir(directory)
  return files
    .filter(file => (file.endsWith('.ts') || file.endsWith('.js')) && !file.endsWith('.d.ts'))
    .map(file => ({ type, name: path.basename(file).replace(/\.(ts|js)$/, ''), file: path.relative(projectRoot(), path.join(directory, file)).replace(/\\/g, '/') }))
}

async function collectProjectFiles(directory: string, extensions: string[]) {
  if (!fsSync.existsSync(directory)) return []
  const files: string[] = []
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (['node_modules', 'dist', '.git', 'storage'].includes(entry.name)) continue
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectProjectFiles(target, extensions))
    else if (extensions.includes(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) files.push(target)
  }
  return files
}

async function tableNames() {
  const client = DB.connection().client.config.client
  if (String(client).includes('sqlite')) {
    const rows = await DB.connection().select('name').from('sqlite_master').where('type', 'table').whereNot('name', 'like', 'sqlite_%')
    return rows.map((row: any) => row.name)
  }
  return []
}

function parseSignature(signature: string) {
  const tokens = signature.trim().split(/\s+/)
  const command = tokens.shift() ?? signature
  const args: string[] = []
  const options: Array<{ flags: string, description: string, defaultValue?: any }> = []
  for (const token of tokens) {
    const match = token.match(/^\{(.+)\}$/)
    if (!match) continue
    const body = match[1]
    if (body.startsWith('--')) {
      const [flag, description = ''] = body.split(/\s*:\s*/)
      options.push({ flags: flag.replace(/=$/, ' <value>'), description })
    } else {
      args.push(body.endsWith('?') ? `[${body.slice(0, -1)}]` : `<${body}>`)
    }
  }
  return { command, arguments: args, options }
}

const controllerStub = (name: string) => `import { Controller } from '@lib/http/Controller.js'

export default class ${name} extends Controller {
  async index() {
    return []
  }
}
`
const modelStub = (name: string) => `import { Model } from '@lib/database/Model.js'

export default class ${name} extends Model {}
`
const middlewareStub = (name: string) => `export default class ${name} {
  async handle(request, reply, next) {
    return next()
  }
}
`
const requestStub = (name: string) => `import { FormRequest } from '@lib/validation/FormRequest.js'
import { schema } from '@lib/validation/schema.js'

export default class ${name} extends FormRequest {
  rules() {
    return { name: schema.string().minLength(3) }
  }
}
`
const notificationStub = (name: string) => `import { MailMessage, Notification } from '@lib/notifications/Notification.js'

export default class ${name} extends Notification {}
`
const mailStub = (name: string) => `import { Content, Envelope, Mailable } from '@lib/mail/Mail.js'

export default class ${name} extends Mailable {
  envelope() {
    return new Envelope({ subject: '${name}' })
  }

  content() {
    return new Content({ view: 'emails.${name.replace(/Mail$/, '').toLowerCase()}' })
  }
}
`
const jobStub = (name: string) => `export default class ${name} {
  async handle() {}
}
`
const migrationStub = () => `export async function up(knex) {}

export async function down(knex) {}
`
const policyStub = (name: string) => `export default class ${name} {
  viewAny(user: any) {
    return true
  }

  view(user: any, resource: any) {
    return true
  }

  create(user: any) {
    return true
  }

  update(user: any, resource: any) {
    return user.id === resource.user_id
  }

  delete(user: any, resource: any) {
    return user.id === resource.user_id
  }
}
`
const eventStub = (name: string) => `export default class ${name} {
  constructor(public payload: any) {}
}
`
const listenerStub = (name: string) => `export default class ${name} {
  async handle(event: any) {
    //
  }
}
`
const resourceStub = (name: string) => `import { JsonResource } from '@lib/http/Resource.js'

export default class ${name} extends JsonResource {
  toArray(request: any) {
    return super.toArray(request)
  }
}
`
const castStub = (name: string) => `import { type CastsAttributes } from '@lib/database/Model.js'

export default class ${name} implements CastsAttributes {
  get(model: any, key: string, value: any, attributes: any) {
    return value
  }

  set(model: any, key: string, value: any, attributes: any) {
    return value
  }
}
`
const commandStub = (name: string) => `export default class ${name} {
  signature = '${name.replace(/Command$/, '').toLowerCase()}'
  description = 'Command description'
  options = []

  async handle(options: any) {
    console.log('${name} command executed!')
  }
}
`
const channelStub = (name: string) => `export default class ${name} {
  join(user: any, ...parameters: any[]) {
    return Boolean(user)
  }
}
`
const componentStub = (name: string) => `export default class ${name} {
  render() {
    return ''
  }
}
`
const enumStub = (name: string) => `export enum ${name} {
  Example = 'example'
}
`
const exceptionStub = (name: string) => `export default class ${name} extends Error {
  statusCode = 500
}
`
const interfaceStub = (name: string) => `export interface ${name} {
}
`
const observerStub = (name: string) => `export default class ${name} {
  created(model: any) {}
  updated(model: any) {}
  deleted(model: any) {}
}
`
const providerStub = (name: string) => `import { ServiceProvider } from '@lib/container/Container.js'

export default class ${name} extends ServiceProvider {
  async register() {}
  async boot() {}
}
`
const testStub = (name: string) => `import { describe, expect, it } from 'vitest'

describe('${name}', () => {
  it('works', () => {
    expect(true).toBe(true)
  })
})
`
const traitStub = (name: string) => `export function ${name}<TBase extends new (...args: any[]) => {}>(Base: TBase) {
  return class extends Base {}
}
`
const ruleStub = (name: string) => `import { type RuleContext } from '@lib/validation/schema.js'

export default class ${name} {
  async validate(value: any, ctx: RuleContext): Promise<boolean> {
    return true
  }

  message(field: string): string {
    return \`The \${field} is invalid.\`
  }
}
`

const seederStub = () => `import { type Knex } from 'knex'

export async function seed(knex: Knex): Promise<void> {
  //
}
`

const factoryStub = (name: string) => {
  const modelName = name.replace(/Factory$/, '')
  return `import { Factory } from '@lib/database/Factory.js'
import { ${modelName} } from '@app/Models/${modelName}.js'

export class ${name} extends Factory<typeof ${modelName}> {
  model = ${modelName}
  definition() {
    return {}
  }
}
`
}

async function getControllerMap(root: string) {
  const controllersDir = path.join(root, 'app', 'Http', 'Controllers')
  const map: Record<string, string> = {}
  if (!fsSync.existsSync(controllersDir)) return map

  async function scan(dir: string) {
    const files = await fs.readdir(dir)
    for (const file of files) {
      const fullPath = path.join(dir, file)
      const stat = await fs.stat(fullPath)
      if (stat.isDirectory()) {
        await scan(fullPath)
      } else if ((file.endsWith('.ts') || file.endsWith('.js')) && !file.endsWith('.d.ts')) {
        try {
          const relativePath = path.relative(root, fullPath).replace(/\\/g, '/')
          let importPath = relativePath
          if (importPath.endsWith('.ts')) {
            importPath = importPath.slice(0, -3) + '.js'
          }
          const mod = await import(pathToFileURL(fullPath).href)
          for (const [key, value] of Object.entries(mod)) {
            if (typeof value === 'function' && value.prototype) {
              map[key] = importPath
            }
          }
        } catch (e) {
          // Ignore
        }
      }
    }
  }
  await scan(controllersDir)
  return map
}
