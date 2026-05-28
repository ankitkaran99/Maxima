import BeeQueue from 'bee-queue'
import { config } from '@lib/foundation/helpers.js'
import { Log } from '@lib/logging/LogManager.js'
import { DB } from '@lib/database/DB.js'
import { SerializableModelRegistry } from '@lib/database/SerializableModelRegistry.js'
import { Cache } from '@lib/cache/Cache.js'
import { Crypt } from '@lib/security/Crypt.js'
import { promisify } from 'node:util'
import { Telescope, Pulse } from '@lib/observability/Observability.js'

export interface Job { handle(): Promise<void> | void }

export interface WorkerOptions {
  queue?: string
  once?: boolean
  delay?: number
  memory?: number
  sleep?: number
  timeout?: number
  backoff?: string
  tries?: number
  maxJobs?: number
  maxTime?: number
  stopWhenEmpty?: boolean
  rest?: number
  name?: string
}

type QueueConnectionFactory = (name: string, config: Record<string, any>, manager: QueueManager) => any
type PayloadHook = (connection: string, queue: string, payload: Record<string, any>) => Record<string, any> | void | Promise<Record<string, any> | void>

export class SerializableRegistry {
  private static classes = new Map<string, any>()

  static register(cls: any, name = cls.name) {
    this.classes.set(name, cls)
  }

  static resolve(name: string) {
    const cls = this.classes.get(name)
    if (!cls) throw new Error(`Class [${name}] is not registered in SerializableRegistry.`)
    return cls
  }

  static has(name: string) {
    return this.classes.has(name)
  }
}

export class PendingDispatch {
  private options: Record<string, any> = {}
  private dispatched = false
  private scheduled = false
  private afterResponse = false
  private afterResponsePromise: Promise<any> | null = null

  constructor(public queue: QueueManager, public job: Job, public queueName: string, public connectionName = config<string>('queue.default', 'default')) {}
  onQueue(queue: string) { this.queueName = queue; return this }
  onConnection(connection: string) { this.connectionName = connection; return this }
  delay(ms: number) {
    this.options.delay = ms
    return this.afterResponse ? this.schedule() : this.dispatch()
  }
  retries(count: number) { this.options.retries = count; return this }
  afterCommit() { this.options.afterCommit = true; return this }
  beforeCommit() { this.options.afterCommit = false; return this }
  runAfterResponse() {
    this.afterResponse = true
    return this
  }
  schedule() {
    if (this.scheduled) return this
    this.scheduled = true
    if (this.afterResponse) {
      this.afterResponsePromise = new Promise((resolve, reject) => {
        setImmediate(() => {
          const delay = Number(this.options.delay ?? 0)
          const run = () => { void this.execute().then(resolve, reject) }
          if (delay > 0) {
            setTimeout(run, delay)
          } else {
            run()
          }
        })
      })
      return this
    }
    setImmediate(() => {
      void this.dispatch().catch(error => Log.error(error as Error))
    })
    return this
  }
  dispatch() {
    if (this.afterResponsePromise) {
      return this.afterResponsePromise
    }
    if (!this.dispatched) {
      this.dispatched = true
      if (this.afterResponse) {
        return this.execute()
      }
      return this.queue.push(this.job, this.options, this.queueName, this.connectionName)
    }
    return Promise.resolve({ queued: true, queue: this.queueName, job: this.job.constructor.name, options: this.options })
  }
  private execute() {
    this.dispatched = true
    return this.queue.executeJob(this.connectionName, this.job, {}, this.queueName)
  }
  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ) {
    return this.dispatch().then(onfulfilled, onrejected)
  }
}

export class Batch {
  constructor(
    public id: string,
    public name: string,
    public totalJobs: number,
    public pendingJobs: number,
    public failedJobs: number,
    public failedJobIds: string[],
    public cancelledAt: number | null,
    public createdAt: number,
    public finishedAt: number | null,
    public queueName?: string
  ) {}

  cancelled(): boolean {
    return this.cancelledAt !== null
  }

  hasFailures(): boolean {
    return this.failedJobs > 0
  }

  finished(): boolean {
    return this.finishedAt !== null
  }

  async cancel() {
    this.cancelledAt = Math.floor(Date.now() / 1000)
    await DB.table('job_batches')
      .where('id', this.id)
      .update({ cancelled_at: this.cancelledAt })
  }
}

export class PendingBatch {
  private batchName = ''
  private thenCallbacks: any[] = []
  private catchCallbacks: any[] = []
  private finallyCallbacks: any[] = []
  private allowsFailuresFlag = false

  constructor(public queue: QueueManager, public jobs: Job[], public queueName: string) {}

  name(name: string) {
    this.batchName = name
    return this
  }

  then(callback: any) {
    this.thenCallbacks.push(callback)
    return this
  }

  catch(callback: any) {
    this.catchCallbacks.push(callback)
    return this
  }

  finally(callback: any) {
    this.finallyCallbacks.push(callback)
    return this
  }

  allowFailures() {
    this.allowsFailuresFlag = true
    return this
  }

  async dispatch(): Promise<Batch> {
    const { ulid } = await import('ulid')
    const batchId = ulid()
    const totalJobs = this.jobs.length
    const now = Math.floor(Date.now() / 1000)

    const serializedOptions: Record<string, any> = {
      then: [],
      catch: [],
      finally: [],
      allowFailures: this.allowsFailuresFlag,
      queueName: this.queueName
    }

    const inMemory: any = {}

    for (const cb of this.thenCallbacks) {
      if (typeof cb === 'object' && cb !== null && cb.constructor && SerializableRegistry.has(cb.constructor.name)) {
        serializedOptions.then.push(serializeValue(cb))
      } else if (typeof cb === 'function') {
        if (!inMemory.then) inMemory.then = []
        inMemory.then.push(cb)
      }
    }

    for (const cb of this.catchCallbacks) {
      if (typeof cb === 'object' && cb !== null && cb.constructor && SerializableRegistry.has(cb.constructor.name)) {
        serializedOptions.catch.push(serializeValue(cb))
      } else if (typeof cb === 'function') {
        if (!inMemory.catch) inMemory.catch = []
        inMemory.catch.push(cb)
      }
    }

    for (const cb of this.finallyCallbacks) {
      if (typeof cb === 'object' && cb !== null && cb.constructor && SerializableRegistry.has(cb.constructor.name)) {
        serializedOptions.finally.push(serializeValue(cb))
      } else if (typeof cb === 'function') {
        if (!inMemory.finally) inMemory.finally = []
        inMemory.finally.push(cb)
      }
    }

    if (Object.keys(inMemory).length > 0) {
      QueueManager.inMemoryCallbacks.set(batchId, inMemory)
    }

    await DB.table('job_batches').insert({
      id: batchId,
      name: this.batchName || 'batch',
      total_jobs: totalJobs,
      pending_jobs: totalJobs,
      failed_jobs: 0,
      failed_job_ids: JSON.stringify([]),
      options: JSON.stringify(serializedOptions),
      cancelled_at: null,
      created_at: now,
      finished_at: null
    })

    const batch = new Batch(batchId, this.batchName || 'batch', totalJobs, totalJobs, 0, [], null, now, null, this.queueName)

    for (const job of this.jobs) {
      await this.queue.push(job, { batchId }, this.queueName)
    }

    return batch
  }
}

export class PendingChain {
  constructor(public queue: QueueManager, public jobs: Job[], public queueName: string) {}

  async dispatch() {
    if (this.jobs.length === 0) return
    const [firstJob, ...remainingJobs] = this.jobs
    const serializedChain = remainingJobs.map(job => serializeValue(job))
    await this.queue.push(firstJob, { chain: serializedChain }, this.queueName)
  }
}

export class ShouldBeUnique {}
export class ShouldBeUniqueUntilProcessing extends ShouldBeUnique {}

export class CallQueuedClosure implements Job {
  constructor(public callback: () => Promise<void> | void) {}
  async handle() { await this.callback() }
}

async function resolveModelClass(name: string): Promise<any> {
  try {
    return SerializableModelRegistry.resolve(name)
  } catch {}

  const candidates = [
    new URL(`../../src/app/Models/${name}.js`, import.meta.url).href,
    new URL(`../../src/app/Models/${name}.ts`, import.meta.url).href,
    new URL(`../../src/app/Models/${name}Model.js`, import.meta.url).href
  ]

  for (const candidate of candidates) {
    try {
      const imported = await import(candidate)
      const model = imported.default ?? imported[name] ?? Object.values(imported).find(value => typeof value === 'function')
      if (typeof model === 'function') {
        SerializableModelRegistry.register(model, name)
        return model
      }
    } catch (error: any) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'MODULE_NOT_FOUND') throw error
    }
  }

  throw new Error(`Model [${name}] could not be resolved in Queue.`)
}

export function serializeValue(val: any): any {
  if (val === null || val === undefined) return val
  if (typeof val === 'function') return { __type: 'closure', name: val.name || 'anonymous' }
  if (typeof val !== 'object') return val

  if (Array.isArray(val)) {
    return val.map(serializeValue)
  }

  const ctor = val.constructor
  if (ctor && typeof ctor.tableName === 'function') {
    return { __type: 'model', name: ctor.name, id: val.id }
  }

  if (ctor && SerializableRegistry.has(ctor.name)) {
    const props: Record<string, any> = {}
    for (const [key, value] of Object.entries(val)) {
      if (typeof value === 'function') continue
      props[key] = serializeValue(value)
    }
    return { __type: 'class', name: ctor.name, properties: props }
  }

  const plain: Record<string, any> = {}
  for (const [key, value] of Object.entries(val)) {
    if (typeof value === 'function') continue
    plain[key] = serializeValue(value)
  }
  return plain
}

export async function deserializeValue(val: any): Promise<any> {
  if (val === null || val === undefined) return val
  if (typeof val !== 'object') return val

  if (Array.isArray(val)) {
    return Promise.all(val.map(deserializeValue))
  }

  if (val.__type === 'model') {
    const ModelClass = await resolveModelClass(val.name)
    return await ModelClass.find(val.id)
  }

  if (val.__type === 'class') {
    const ClassDef = SerializableRegistry.resolve(val.name)
    const instance = Object.create(ClassDef.prototype)
    for (const [key, value] of Object.entries(val.properties)) {
      instance[key] = await deserializeValue(value)
    }
    return instance
  }

  if (val.__type === 'closure') {
    throw new Error(`Queued closure [${val.name}] cannot be deserialized across processes. Use Bus.dispatchAfterResponse or a registered job class.`)
  }

  const plain: Record<string, any> = {}
  for (const [key, value] of Object.entries(val)) {
    plain[key] = await deserializeValue(value)
  }
  return plain
}

export class SendQueuedMailJob implements Job {
  constructor(public message: any, public mailerName?: string) {}

  async handle() {
    const { Mail } = await import('@lib/mail/Mail.js')
    await Mail.sendRaw(this.message, this.mailerName)
  }
}

export class SendQueuedNotificationJob implements Job {
  constructor(public notifiable: any, public notification: any) {}

  async handle() {
    const { Notifications } = await import('@lib/notifications/Notification.js')
    await Notifications.send(this.notifiable, this.notification)
  }
}

SerializableRegistry.register(SendQueuedMailJob)
SerializableRegistry.register(SendQueuedNotificationJob)
SerializableRegistry.register(CallQueuedClosure)

export class QueueManager {
  private queues = new Map<string, BeeQueue>()
  private pushed: Array<{ queue: string, job: string, options: Record<string, any> }> | null = null
  private failed: Array<{ queue: string, job: string, error: string }> | null = null
  private activePollers = new Set<string>()
  private connectionFactories = new Map<string, QueueConnectionFactory>()
  private payloadHooks: PayloadHook[] = []

  static inMemoryCallbacks = new Map<string, { then?: Function[], catch?: Function[], finally?: Function[] }>()

  private beforeCallbacks: Array<(event: { connection: string, job: Job, payload: any }) => Promise<void> | void> = []
  private afterCallbacks: Array<(event: { connection: string, job: Job, payload: any }) => Promise<void> | void> = []
  private failingCallbacks: Array<(event: { connection: string, job: Job, payload: any, exception: Error }) => Promise<void> | void> = []

  fake() { this.pushed = []; this.failed = [] }
  restore() {
    this.pushed = null
    this.failed = null
    this.activePollers.clear()
    for (const queue of this.queues.values()) {
      try {
        void (queue as any).close?.()
      } catch {}
    }
    this.queues.clear()
    this.connectionFactories.clear()
    this.payloadHooks = []
    this.beforeCallbacks = []
    this.afterCallbacks = []
    this.failingCallbacks = []
    QueueManager.inMemoryCallbacks.clear()
  }
  assertPushed(job: string) {
    if (!this.pushed?.some(entry => entry.job === job)) throw new Error(`Expected job [${job}] was not pushed.`)
  }
  assertFailed(job: string) {
    if (!this.failed?.some(entry => entry.job === job)) throw new Error(`Expected job [${job}] did not fail.`)
  }

  before(callback: (event: { connection: string, job: Job, payload: any }) => Promise<void> | void) {
    this.beforeCallbacks.push(callback)
    return this
  }

  after(callback: (event: { connection: string, job: Job, payload: any }) => Promise<void> | void) {
    this.afterCallbacks.push(callback)
    return this
  }

  failing(callback: (event: { connection: string, job: Job, payload: any, exception: Error }) => Promise<void> | void) {
    this.failingCallbacks.push(callback)
    return this
  }

  dispatch(job: Job, queue = config<string>('queue.default', 'default')) {
    return new PendingDispatch(this, job, queue).schedule()
  }

  async dispatchSync(job: Job, queue = config<string>('queue.default', 'default')) {
    await this.executeJob('sync', job, {}, queue)
    return job
  }

  dispatchAfterResponse(job: Job | (() => Promise<void> | void), queue = config<string>('queue.default', 'default')) {
    const queuedJob = typeof job === 'function' ? new CallQueuedClosure(job) : job
    return new PendingDispatch(this, queuedJob, queue).runAfterResponse().schedule()
  }

  createPayloadUsing(callback: PayloadHook) {
    this.payloadHooks.push(callback)
    return () => {
      this.payloadHooks = this.payloadHooks.filter(existing => existing !== callback)
    }
  }

  extend(driver: string, factory: QueueConnectionFactory) {
    this.connectionFactories.set(driver, factory)
  }

  batch(jobs: Job[], queue = config<string>('queue.default', 'default')) {
    return new PendingBatch(this, jobs, queue)
  }

  async chain(jobs: Job[], queue = config<string>('queue.default', 'default')) {
    const pending = new PendingChain(this, jobs, queue)
    await pending.dispatch()
    return pending
  }

  connectionConfig(name: string) {
    const defaultConn = config<string>('queue.default', 'sync')
    return config<any>(`queue.connections.${name}`) ?? config<any>(`queue.connections.${defaultConn}`) ?? { driver: 'sync' }
  }

  async push(job: Job, options: Record<string, any> = {}, queue = config<string>('queue.default', 'default'), connection = queue) {
    if (options.afterCommit) {
      DB.afterCommit(() => { void this.push(job, { ...options, afterCommit: false }, queue, connection) })
      return { queued: true, queue, job: job.constructor.name, options: { ...options, afterCommit: true } }
    }

    if (this.pushed) {
      const jobName = job.constructor.name
      if (jobName === 'SendQueuedMailJob' || jobName === 'SendQueuedNotificationJob' || jobName === 'QueuedClosure') {
        this.pushed.push({ queue, job: 'Object', options })
      }
      this.pushed.push({ queue, job: jobName, options })
      Telescope.record('job', { queue, job: jobName, options, queued: true })
      Pulse.increment('jobs.queued')
      return { queued: true, queue, job: jobName, options }
    }

    const connConfig = this.connectionConfig(connection)
    const uniqueLock = await this.acquireUniqueLock(job)
    if (uniqueLock === false) return { queued: false, queue, job: job.constructor.name, options, reason: 'unique-lock' }

    if (connConfig.driver === 'sync') {
      setImmediate(async () => {
        try {
          await this.executeJob('sync', job, {
            chain: options.chain,
            batchId: options.batchId
          }, queue)
        } catch (error) {
          // Failure recording is handled inside executeJob
        }
      })
      return { queued: true, queue, job: job.constructor.name, options }
    }

    const payloadObject = await this.createPayload(connConfig.driver, queue, job, options)

    if (connConfig.driver === 'database') {
      const payload = JSON.stringify(payloadObject)
      const delay = options.delay ?? 0
      const available_at = Math.floor((Date.now() + delay) / 1000)
      const created_at = Math.floor(Date.now() / 1000)
      const table = connConfig.table ?? 'jobs'

      await DB.table(table).insert({
        queue,
        payload,
        attempts: 0,
        reserved_at: null,
        available_at,
        created_at
      })
      return { queued: true, queue, job: job.constructor.name, options }
    }

    if (this.connectionFactories.has(connConfig.driver)) {
      return this.connectionFactories.get(connConfig.driver)!(connection, connConfig, this).push(job, options, payloadObject)
    }

    const bee = this.queue(queue, connection, connConfig)
    return bee.createJob(payloadObject)
      .retries(options.retries ?? 3)
      .delayUntil(Date.now() + (options.delay ?? 0))
      .save()
  }

  async work(queue = config<string>('queue.default', 'default'), options: WorkerOptions = {}) {
    const { QueueWorker } = await import('./QueueWorker.js')
    const worker = new QueueWorker(queue, options)
    await worker.run()
  }

  async executeJob(
    connection: string,
    job: Job,
    metadata: { chain?: any[], batchId?: string, jobId?: string | number },
    queueName: string
  ) {
    const start = performance.now()
    const jobName = job.constructor.name
    
    await this.releaseUniqueLock(job, 'processing')
    await this.fireBefore(connection, job, { class: jobName, properties: serializeValue(job), tags: this.jobTags(job) })

    if (metadata.batchId) {
      const batchRow = await DB.table('job_batches').where('id', metadata.batchId).first()
      if (batchRow && batchRow.cancelled_at !== null) {
        await this.decrementPendingBatch(metadata.batchId, false)
        return
      }
    }

    try {
      const middleware = (job as any).middleware
        ? (typeof (job as any).middleware === 'function' ? (job as any).middleware() : (job as any).middleware)
        : []

      const runPipeline = async (index: number): Promise<void> => {
        if (index >= middleware.length) {
          await job.handle()
          return
        }
        const mw = middleware[index]
        if (typeof mw === 'function') {
          await mw(job, () => runPipeline(index + 1))
        } else if (mw && typeof mw.handle === 'function') {
          await mw.handle(job, () => runPipeline(index + 1))
        } else {
          await runPipeline(index + 1)
        }
      }

      await runPipeline(0)

      await this.fireAfter(connection, job, { class: jobName, properties: serializeValue(job), tags: this.jobTags(job) })
      Telescope.record('job', { connection, queue: queueName, job: jobName, completed: true, durationMs: Math.round(performance.now() - start) })
      Pulse.increment('jobs.completed')

      if (metadata.batchId) {
        await this.decrementPendingBatch(metadata.batchId, true)
      }

      if (metadata.chain && metadata.chain.length > 0) {
        const nextSerialized = metadata.chain[0]
        const nextJob = await deserializeValue(nextSerialized)
        await this.push(nextJob, { chain: metadata.chain.slice(1) }, queueName)
      }

      Log.info('Queue job completed', { jobId: metadata.jobId, durationMs: Math.round(performance.now() - start) })
    } catch (error) {
      if (typeof (job as any).failed === 'function') {
        try { await (job as any).failed(error) } catch (failedError) { Log.error(failedError as Error) }
      }
      await this.fireFailing(connection, job, { class: jobName, properties: serializeValue(job), tags: this.jobTags(job) }, error as Error)
      Telescope.record('job', { connection, queue: queueName, job: jobName, failed: true, error: (error as Error).message })
      Pulse.increment('jobs.failed')
      
      if (metadata.batchId) {
        await this.recordBatchFailure(metadata.batchId, String(metadata.jobId ?? 'unknown'), error as Error)
      }

      Log.error(error as Error, { jobId: metadata.jobId })
      throw error
    } finally {
      await this.releaseUniqueLock(job, 'finished')
    }
  }

  async handle(beeJob: any, connection = config<string>('queue.default', 'default'), options: WorkerOptions = {}, queueName = connection) {
    const data = await this.decodePayload(beeJob.data)
    const payload = data.payload ?? data.properties
    let job: Job
    try {
      if (typeof payload === 'object' && payload !== null && (payload.__type || payload.class)) {
        job = await deserializeValue(payload)
      } else {
        job = beeJob.data.payload as Job
      }
    } catch (error) {
      await this.recordFailedJob(connection, queueName, beeJob, error as Error)
      throw error
    }

    try {
      const executePromise = this.executeJob(
        connection,
        job,
        {
          chain: data.chain,
          batchId: data.batchId,
          jobId: beeJob.id
        },
        queueName
      )

      await this.runWithTimeout(executePromise, options.timeout)
    } catch (error) {
      await this.recordFailedJob(connection, queueName, { ...beeJob, data }, error as Error)
      throw error
    }
  }

  private async processNextDatabaseJob(connectionName: string, options: WorkerOptions = {}, queueName = connectionName): Promise<boolean> {
    const connConfig = this.connectionConfig(connectionName)
    const table = connConfig.table ?? 'jobs'
    const retryAfter = connConfig.retry_after ?? 90
    const now = Math.floor(Date.now() / 1000)

    const job = await DB.table(table)
      .where('queue', queueName)
      .where('available_at', '<=', now)
      .andWhere(function() {
        this.whereNull('reserved_at').orWhere('reserved_at', '<', now - retryAfter)
      })
      .orderBy('id', 'asc')
      .first()

    if (!job) return false

    const updatedCount = await DB.table(table)
      .where('id', job.id)
      .where('attempts', job.attempts)
      .andWhere(function() {
        this.whereNull('reserved_at').orWhere('reserved_at', job.reserved_at)
      })
      .update({
        reserved_at: now,
        attempts: job.attempts + 1
      })

    if (updatedCount === 0) return true

    let payloadObj: any
    try {
      payloadObj = await this.decodePayload(JSON.parse(job.payload))
    } catch (err) {
      await DB.table(table).where('id', job.id).delete()
      await this.recordFailedJob(connectionName, queueName, { id: job.id, data: { class: 'Unknown', payload: {} } }, err as Error)
      return true
    }

    Log.info('Queue job started (db)', { jobId: job.id, job: payloadObj.class })

    try {
      const jobInstance = await deserializeValue(payloadObj.properties ?? payloadObj.payload)
      
      const executePromise = this.executeJob(
        'database',
        jobInstance,
        {
          chain: payloadObj.chain,
          batchId: payloadObj.batchId,
          jobId: job.id
        },
        queueName
      )

      await this.runWithTimeout(executePromise, options.timeout)

      await DB.table(table).where('id', job.id).delete()
    } catch (error: any) {
      let retryDelay = this.jobBackoff(payloadObj, options, job.attempts + 1)
      const attempts = job.attempts + 1
      const maxTries = Number(options.tries ?? payloadObj.maxTries ?? connConfig.tries ?? 3)
      const maxExceptions = Number(payloadObj.maxExceptions ?? Number.POSITIVE_INFINITY)
      const expired = payloadObj.retryUntil ? now >= Number(payloadObj.retryUntil) : false
      if (attempts >= maxTries || attempts >= maxExceptions || expired) {
        await DB.table(table).where('id', job.id).delete()
        await this.recordFailedJob(connectionName, queueName, { id: job.id, data: { class: payloadObj.class, payload: payloadObj.properties ?? payloadObj.payload } }, error)
      } else {
        await DB.table(table)
          .where('id', job.id)
          .update({
            reserved_at: null,
            available_at: now + retryDelay
          })
      }
    }

    return true
  }

  private queue(name: string, connection: string, connectionConfig = config('queue.connections.redis', {})) {
    const cacheKey = `${connection}:${name}`
    if (!this.queues.has(cacheKey)) this.queues.set(cacheKey, new BeeQueue(name, connectionConfig))
    return this.queues.get(cacheKey)!
  }

  private async createPayload(connection: string, queue: string, job: Job, options: Record<string, any>) {
    const serializedJob = serializeValue(job)
    let payload: Record<string, any> = {
      class: job.constructor.name,
      properties: serializedJob,
      payload: serializedJob,
      chain: options.chain ?? [],
      batchId: options.batchId,
      options,
      tags: this.jobTags(job),
      maxTries: this.valueFromJob(job, 'tries'),
      maxExceptions: this.valueFromJob(job, 'maxExceptions'),
      retryUntil: this.retryUntil(job),
      backoff: this.valueFromJob(job, 'backoff')
    }

    for (const hook of this.payloadHooks) {
      const merged = await hook(connection, queue, payload)
      if (merged) payload = { ...payload, ...merged }
    }

    if ((job as any).encrypted || (job as any).shouldBeEncrypted) {
      return {
        class: job.constructor.name,
        encrypted: true,
        payload: Crypt.encrypt(payload),
        tags: payload.tags,
        options
      }
    }

    return payload
  }

  private async decodePayload(payload: any) {
    if (payload?.encrypted && typeof payload.payload === 'string') {
      return Crypt.decrypt<Record<string, any>>(payload.payload)
    }
    return payload
  }

  private jobTags(job: Job): string[] {
    const tags = typeof (job as any).tags === 'function' ? (job as any).tags() : (job as any).tags
    return Array.isArray(tags) ? tags.map(String) : []
  }

  private valueFromJob(job: Job, key: string) {
    const value = (job as any)[key]
    return typeof value === 'function' ? value.call(job) : value
  }

  private retryUntil(job: Job) {
    const value = this.valueFromJob(job, 'retryUntil')
    if (!value) return undefined
    if (value instanceof Date) return Math.floor(value.getTime() / 1000)
    return Number(value)
  }

  private jobBackoff(payload: any, options: WorkerOptions, attempts: number) {
    const configured = payload.backoff ?? options.backoff ?? options.delay
    if (configured === undefined || configured === '') return 5
    const values = Array.isArray(configured) ? configured : String(configured).split(',')
    const index = Math.min(attempts - 1, values.length - 1)
    return Number(values[index] ?? values[0] ?? 5)
  }

  private async runWithTimeout<T>(promise: Promise<T>, timeout?: number) {
    if (!timeout) return promise

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Job timed out after ${timeout} seconds`)), timeout * 1000)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private uniqueKey(job: Job) {
    const marker = job instanceof ShouldBeUnique || job instanceof ShouldBeUniqueUntilProcessing || (job as any).shouldBeUnique
    if (!marker) return null
    const id = typeof (job as any).uniqueId === 'function' ? (job as any).uniqueId() : ((job as any).uniqueId ?? JSON.stringify(serializeValue(job)))
    return `queue:unique:${job.constructor.name}:${id}`
  }

  private uniqueFor(job: Job) {
    const value = typeof (job as any).uniqueFor === 'function' ? (job as any).uniqueFor() : (job as any).uniqueFor
    return Number(value ?? 3600)
  }

  private async acquireUniqueLock(job: Job) {
    const key = this.uniqueKey(job)
    if (!key) return true
    return await Cache.lock(key, this.uniqueFor(job)).get()
  }

  private async releaseUniqueLock(job: Job, phase: 'processing' | 'finished') {
    const key = this.uniqueKey(job)
    if (!key) return
    const untilProcessing = job instanceof ShouldBeUniqueUntilProcessing || (job as any).uniqueUntilProcessing
    if ((untilProcessing && phase === 'processing') || (!untilProcessing && phase === 'finished')) {
      await Cache.lock(key).forceRelease()
    }
  }

  private async recordFailedJob(connection: string, queue: string, beeJob: any, error: Error) {
    const exception = error instanceof Error
      ? error
      : (error && typeof error === 'object' && 'message' in error
          ? error as Error
          : new Error(typeof error === 'string' ? error : String(error || 'Unknown error')))

    if (this.failed) this.failed.push({ queue, job: beeJob.data.class ?? beeJob.data.payload?.class, error: exception.message })
    const table = config<string>('queue.failed.table', 'failed_jobs')
    const row = {
      connection,
      queue,
      job: beeJob.data.class ?? beeJob.data.payload?.class ?? 'Unknown',
      payload: JSON.stringify(beeJob.data),
      exception: exception.stack ?? exception.message,
      error: exception.message,
      failed_at: new Date()
    }
    await DB.table(table).insert(row).catch(async () => {
      await DB.table(table).insert({
        queue: row.queue,
        job: row.job,
        payload: row.payload,
        error: row.error,
        failed_at: row.failed_at
      }).catch(() => {})
    })
  }

  private async fireBefore(connection: string, job: Job, payload: any) {
    for (const cb of this.beforeCallbacks) {
      try { await cb({ connection, job, payload }) } catch (err) { Log.error(err as Error) }
    }
  }

  private async fireAfter(connection: string, job: Job, payload: any) {
    for (const cb of this.afterCallbacks) {
      try { await cb({ connection, job, payload }) } catch (err) { Log.error(err as Error) }
    }
  }

  private async fireFailing(connection: string, job: Job, payload: any, exception: Error) {
    for (const cb of this.failingCallbacks) {
      try { await cb({ connection, job, payload, exception }) } catch (err) { Log.error(err as Error) }
    }
  }

  private async decrementPendingBatch(batchId: string, success: boolean) {
    const batch = await DB.table('job_batches').where('id', batchId).first()
    if (!batch) return

    const pending = batch.pending_jobs - 1
    const finishedAt = pending <= 0 ? Math.floor(Date.now() / 1000) : null

    await DB.table('job_batches')
      .where('id', batchId)
      .update({
        pending_jobs: pending,
        finished_at: finishedAt
      })

    if (pending <= 0) {
      const options = JSON.parse(batch.options || '{}')
      const hasFailures = batch.failed_jobs > 0
      const callbackQueue = options.queueName ?? batch.queueName

      if (!hasFailures && batch.cancelled_at === null) {
        if (options.then && Array.isArray(options.then)) {
          for (const serializedCb of options.then) {
            const cbJob = await deserializeValue(serializedCb)
            await this.push(cbJob, {}, callbackQueue)
          }
        }
        const inMem = QueueManager.inMemoryCallbacks.get(batchId)
        if (inMem?.then) {
          for (const cb of inMem.then) {
            try { await cb(new Batch(batchId, batch.name, batch.total_jobs, pending, batch.failed_jobs, JSON.parse(batch.failed_job_ids || '[]'), batch.cancelled_at, batch.created_at, finishedAt)) } catch (e) { Log.error(e as Error) }
          }
        }
      }

      if (options.finally && Array.isArray(options.finally)) {
        for (const serializedCb of options.finally) {
          const cbJob = await deserializeValue(serializedCb)
          await this.push(cbJob, {}, callbackQueue)
        }
      }
      const inMem = QueueManager.inMemoryCallbacks.get(batchId)
      if (inMem?.finally) {
        for (const cb of inMem.finally) {
          try { await cb(new Batch(batchId, batch.name, batch.total_jobs, pending, batch.failed_jobs, JSON.parse(batch.failed_job_ids || '[]'), batch.cancelled_at, batch.created_at, finishedAt)) } catch (e) { Log.error(e as Error) }
        }
      }

      QueueManager.inMemoryCallbacks.delete(batchId)
    }
  }

  private async recordBatchFailure(batchId: string, jobId: string, error: Error) {
    const batch = await DB.table('job_batches').where('id', batchId).first()
    if (!batch) return

    const failedJobIds = JSON.parse(batch.failed_job_ids || '[]')
    failedJobIds.push(jobId)

    const failedCount = batch.failed_jobs + 1
    const pending = batch.pending_jobs - 1
    const finishedAt = pending <= 0 ? Math.floor(Date.now() / 1000) : null

    const updateData: Record<string, any> = {
      failed_jobs: failedCount,
      failed_job_ids: JSON.stringify(failedJobIds),
      pending_jobs: pending,
      finished_at: finishedAt
    }

    const options = JSON.parse(batch.options || '{}')
    const allowFailures = options.allowFailures ?? false
    const callbackQueue = options.queueName ?? batch.queueName
    if (!allowFailures && batch.cancelled_at === null) {
      updateData.cancelled_at = Math.floor(Date.now() / 1000)
    }

    await DB.table('job_batches')
      .where('id', batchId)
      .update(updateData)

    if (failedCount === 1) {
      if (options.catch && Array.isArray(options.catch)) {
        for (const serializedCb of options.catch) {
          const cbJob = await deserializeValue(serializedCb)
          await this.push(cbJob, {}, callbackQueue)
        }
      }
      const inMem = QueueManager.inMemoryCallbacks.get(batchId)
      if (inMem?.catch) {
        for (const cb of inMem.catch) {
          try { await cb(new Batch(batchId, batch.name, batch.total_jobs, pending, failedCount, failedJobIds, updateData.cancelled_at || batch.cancelled_at, batch.created_at, finishedAt), error) } catch (e) { Log.error(e as Error) }
        }
      }
    }

    if (pending <= 0) {
      if (options.finally && Array.isArray(options.finally)) {
        for (const serializedCb of options.finally) {
          const cbJob = await deserializeValue(serializedCb)
          await this.push(cbJob, {}, callbackQueue)
        }
      }
      const inMem = QueueManager.inMemoryCallbacks.get(batchId)
      if (inMem?.finally) {
        for (const cb of inMem.finally) {
          try { await cb(new Batch(batchId, batch.name, batch.total_jobs, pending, failedCount, failedJobIds, updateData.cancelled_at || batch.cancelled_at, batch.created_at, finishedAt)) } catch (e) { Log.error(e as Error) }
        }
      }
      QueueManager.inMemoryCallbacks.delete(batchId)
    }
  }
}

export const Queue = new QueueManager()
