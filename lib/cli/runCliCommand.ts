import { Command } from 'commander'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Application } from '@lib/foundation/Application.js'
import { setApplication, basePath, storagePath } from '@lib/foundation/helpers.js'
import { HttpKernel } from '@lib/http/Kernel.js'
import { DB } from '@lib/database/DB.js'
import { Queue } from '@lib/queue/Queue.js'
import { Schedule } from '@lib/scheduler/Schedule.js'
import { Route } from '@lib/http/Route.js'

export async function runCliCommand(argv = process.argv.slice(2)) {
  const program = new Command('maxima')
  program.description('Maxima framework CLI').version('0.1.0')

  program.command('serve').option('-p, --port <port>').action(async options => {
    const app = await bootstrap()
    await new HttpKernel(app).listen(Number(options.port ?? app.config.get('app.port', 3000)))
  })

  program.command('make:controller <name>').action(name => makeFile(`app/Http/Controllers/${name}.ts`, controllerStub(name)))
  program.command('make:model <name>').action(name => makeFile(`app/Models/${name}.ts`, modelStub(name)))
  program.command('make:middleware <name>').action(name => makeFile(`app/Http/Middleware/${name}.ts`, middlewareStub(name)))
  program.command('make:request <name>').action(name => makeFile(`app/Http/Requests/${name}.ts`, requestStub(name)))
  program.command('make:notification <name>').action(name => makeFile(`app/Notifications/${name}.ts`, notificationStub(name)))
  program.command('make:mail <name>').action(name => makeFile(`app/Mail/${name}.ts`, mailStub(name)))
  program.command('make:job <name>').action(name => makeFile(`app/Console/Jobs/${name}.ts`, jobStub(name)))
  program.command('make:migration <name>').action(name => makeFile(`database/migrations/${Date.now()}_${name}.ts`, migrationStub()))
  program.command('make:policy <name>').action(name => makeFile(`app/Policies/${name}.ts`, policyStub(name)))
  program.command('make:event <name>').action(name => makeFile(`app/Events/${name}.ts`, eventStub(name)))
  program.command('make:listener <name>').action(name => makeFile(`app/Listeners/${name}.ts`, listenerStub(name)))
  program.command('make:resource <name>').action(name => makeFile(`app/Http/Resources/${name}.ts`, resourceStub(name)))
  program.command('make:cast <name>').action(name => makeFile(`app/Casts/${name}.ts`, castStub(name)))
  program.command('make:command <name>').action(name => makeFile(`app/Console/Commands/${name}.ts`, commandStub(name)))
  program.command('make:rule <name>').action(name => makeFile(`app/Rules/${name}.ts`, ruleStub(name)))
  program.command('make:seeder <name>').action(name => makeFile(`database/seeders/${name}.ts`, seederStub()))
  program.command('make:factory <name>').action(name => makeFile(`database/factories/${name}.ts`, factoryStub(name)))

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
    await fs.writeFile(path.join(projectRoot(), target), '')
    console.log(`INFO  Schema dumped to ${target}`)
  })
  program.command('cache:table').action(async () => { await bootstrap(); const { Schema } = await import('@lib/database/Schema.js'); await Schema.createCacheTable(); console.log('INFO  Cache table created') })
  program.command('session:table').action(async () => { await bootstrap(); const { Schema } = await import('@lib/database/Schema.js'); await Schema.createSessionTable(); console.log('INFO  Session table created') })
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

  program.command('schedule:run').action(async () => { await bootstrap(); await Schedule.runDue(); console.log('INFO  Scheduled tasks executed') })
  program.command('schedule:list').action(async () => { await bootstrap(); console.table(Schedule.all()) })
  program.command('schedule:work').option('--interval <milliseconds>', 'Loop interval in milliseconds', '1000').action(async options => { await bootstrap(); await Schedule.work(Number(options.interval ?? 1000)) })
  program.command('schedule:clear-cache').action(async () => { await bootstrap(); await Schedule.clearCache(); console.log('INFO  Schedule cache cleared') })
  program.command('config:cache').action(async () => { const app = await bootstrap(); await app.config.cache(storagePath('framework/config.json')); console.log('INFO  Configuration cached') })
  
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
  
  program.command('cache:clear').action(async () => {
    await bootstrap()
    const { Cache } = await import('@lib/cache/Cache.js')
    await Cache.flush()
    console.log('INFO  Cache cleared')
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
    const root = projectRoot()
    const stubsDir = path.join(root, 'stubs')
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
      'rule.stub': ruleStub('{{ name }}'),
      'seeder.stub': seederStub(),
      'factory.stub': factoryStub('{{ name }}')
    }
    for (const [file, content] of Object.entries(stubs)) {
      const target = path.join(stubsDir, file)
      if (!fsSync.existsSync(target)) await fs.writeFile(target, content)
    }
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
        
        await Queue.push(jobInstance, {}, failed.queue)
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
              const cmd = program.command(name)
              if (instance.description) cmd.description(instance.description)
              if (Array.isArray(instance.options)) {
                for (const opt of instance.options) {
                  cmd.option(opt.flags, opt.description, opt.defaultValue)
                }
              }
              cmd.action(async (options) => {
                await bootstrap()
                await instance.handle(options)
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
  for (const file of ['routes/web.ts', 'routes/api.ts', 'routes/web.js', 'routes/api.js']) {
    const target = path.join(root, file)
    if (fsSync.existsSync(target)) await import(`${pathToFileURL(target).href}?t=${Date.now()}`)
  }
}

function migrationOptions(options: Record<string, any> = {}) {
  return options.path ? { directory: path.isAbsolute(options.path) ? options.path : path.join(projectRoot(), options.path) } : undefined
}

async function makeFile(relative: string, content: string) {
  const target = path.join(projectRoot(), relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content, { flag: 'wx' })
  console.log(`INFO  Created ${relative}`)
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
const notificationStub = (name: string) => `import { Notification } from '@lib/notifications/Notification.js'

export default class ${name} extends Notification {}
`
const mailStub = (name: string) => `import { Mailable } from '@lib/mail/Mail.js'

export default class ${name} extends Mailable {
  subject() { return '${name}' }
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
