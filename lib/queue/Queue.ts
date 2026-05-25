import BeeQueue from 'bee-queue'
import { config } from '@lib/foundation/helpers.js'
import { Log } from '@lib/logging/LogManager.js'
import { DB } from '@lib/database/DB.js'
import { SerializableModelRegistry } from '@lib/database/SerializableModelRegistry.js'
import { promisify } from 'node:util'

export interface Job { handle(): Promise<void> | void }

export interface WorkerOptions {
  queue?: string
  once?: boolean
  delay?: number
  memory?: number
  sleep?: number
  timeout?: number
  backoff?: string
}

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
  constructor(public queue: QueueManager, public job: Job, public queueName: string) {}
  delay(ms: number) { return this.queue.push(this.job, { delay: ms }, this.queueName) }
  retries(count: number) { return this.queue.push(this.job, { retries: count }, this.queueName) }
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
      allowFailures: this.allowsFailuresFlag
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

export class QueueManager {
  private queues = new Map<string, BeeQueue>()
  private pushed: Array<{ queue: string, job: string, options: Record<string, any> }> | null = null
  private failed: Array<{ queue: string, job: string, error: string }> | null = null
  private activePollers = new Set<string>()

  static inMemoryCallbacks = new Map<string, { then?: Function[], catch?: Function[], finally?: Function[] }>()

  private beforeCallbacks: Array<(event: { connection: string, job: Job, payload: any }) => Promise<void> | void> = []
  private afterCallbacks: Array<(event: { connection: string, job: Job, payload: any }) => Promise<void> | void> = []
  private failingCallbacks: Array<(event: { connection: string, job: Job, payload: any, exception: Error }) => Promise<void> | void> = []

  fake() { this.pushed = []; this.failed = [] }
  restore() { this.pushed = null; this.failed = null; this.activePollers.clear() }
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
    void this.push(job, {}, queue)
    return new PendingDispatch(this, job, queue)
  }

  batch(jobs: Job[], queue = config<string>('queue.default', 'default')) {
    return new PendingBatch(this, jobs, queue)
  }

  chain(jobs: Job[], queue = config<string>('queue.default', 'default')) {
    const pending = new PendingChain(this, jobs, queue)
    void pending.dispatch()
    return pending
  }

  private connectionConfig(name: string) {
    const defaultConn = config<string>('queue.default', 'sync')
    return config<any>(`queue.connections.${name}`) ?? config<any>(`queue.connections.${defaultConn}`) ?? { driver: 'sync' }
  }

  async push(job: Job, options: Record<string, any> = {}, queue = config<string>('queue.default', 'default')) {
    if (this.pushed) {
      const jobName = job.constructor.name
      if (jobName === 'SendQueuedMailJob' || jobName === 'SendQueuedNotificationJob') {
        this.pushed.push({ queue, job: 'Object', options })
      }
      this.pushed.push({ queue, job: jobName, options })
      return { queued: true, queue, job: jobName, options }
    }

    const connConfig = this.connectionConfig(queue)

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

    if (connConfig.driver === 'database') {
      const payload = JSON.stringify({
        class: job.constructor.name,
        properties: serializeValue(job),
        chain: options.chain ?? [],
        batchId: options.batchId
      })
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

    const bee = this.queue(queue)
    return bee.createJob({
      class: job.constructor.name,
      payload: serializeValue(job),
      chain: options.chain ?? [],
      batchId: options.batchId,
      options
    })
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
    
    await this.fireBefore(connection, job, { class: jobName, properties: serializeValue(job) })

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

      await this.fireAfter(connection, job, { class: jobName, properties: serializeValue(job) })

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
      await this.fireFailing(connection, job, { class: jobName, properties: serializeValue(job) }, error as Error)
      
      if (metadata.batchId) {
        await this.recordBatchFailure(metadata.batchId, String(metadata.jobId ?? 'unknown'), error as Error)
      }

      Log.error(error as Error, { jobId: metadata.jobId })
      throw error
    }
  }

  async handle(beeJob: any, queue = config<string>('queue.default', 'default'), options: WorkerOptions = {}) {
    const payload = beeJob.data.payload
    let job: Job
    try {
      if (typeof payload === 'object' && payload !== null && (payload.__type || payload.class)) {
        job = await deserializeValue(payload)
      } else {
        job = beeJob.data.payload as Job
      }
    } catch (error) {
      await this.recordFailedJob(queue, beeJob, error as Error)
      throw error
    }

    try {
      const executePromise = this.executeJob(
        'redis',
        job,
        {
          chain: beeJob.data.chain,
          batchId: beeJob.data.batchId,
          jobId: beeJob.id
        },
        queue
      )

      if (options.timeout) {
        const timeoutMs = options.timeout * 1000
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Job timed out after ${options.timeout} seconds`)), timeoutMs)
        })
        await Promise.race([executePromise, timeoutPromise])
      } else {
        await executePromise
      }
    } catch (error) {
      await this.recordFailedJob(queue, beeJob, error as Error)
      throw error
    }
  }

  private async processNextDatabaseJob(queueName: string, options: WorkerOptions = {}): Promise<boolean> {
    const connConfig = this.connectionConfig(queueName)
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
      payloadObj = JSON.parse(job.payload)
    } catch (err) {
      await DB.table(table).where('id', job.id).delete()
      await this.recordFailedJob(queueName, { id: job.id, data: { class: 'Unknown', payload: {} } }, err as Error)
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

      if (options.timeout) {
        const timeoutMs = options.timeout * 1000
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Job timed out after ${options.timeout} seconds`)), timeoutMs)
        })
        await Promise.race([executePromise, timeoutPromise])
      } else {
        await executePromise
      }

      await DB.table(table).where('id', job.id).delete()
    } catch (error: any) {
      let retryDelay = 5
      const attempts = job.attempts + 1
      if (options.backoff) {
        const backoffs = options.backoff.split(',').map(x => Number(x.trim()))
        const backoffIndex = Math.min(attempts - 1, backoffs.length - 1)
        retryDelay = backoffs[backoffIndex] ?? 5
      } else if (options.delay !== undefined) {
        retryDelay = options.delay
      }


      const maxTries = connConfig.tries ?? 3
      if (attempts >= maxTries) {
        await DB.table(table).where('id', job.id).delete()
        await this.recordFailedJob(queueName, { id: job.id, data: { class: payloadObj.class, payload: payloadObj.properties ?? payloadObj.payload } }, error)
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

  private queue(name: string) {
    if (!this.queues.has(name)) this.queues.set(name, new BeeQueue(name, config('queue.connections.redis', {})))
    return this.queues.get(name)!
  }

  private async recordFailedJob(queue: string, beeJob: any, error: Error) {
    if (this.failed) this.failed.push({ queue, job: beeJob.data.class ?? beeJob.data.payload?.class, error: error.message })
    const table = config<string>('queue.failed.table', 'failed_jobs')
    await DB.table(table).insert({
      queue,
      job: beeJob.data.class ?? beeJob.data.payload?.class ?? 'Unknown',
      payload: JSON.stringify(beeJob.data),
      error: error.message,
      failed_at: new Date()
    }).catch(() => {})
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

      if (!hasFailures && batch.cancelled_at === null) {
        if (options.then && Array.isArray(options.then)) {
          for (const serializedCb of options.then) {
            const cbJob = await deserializeValue(serializedCb)
            await this.push(cbJob, {}, batch.queueName)
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
          await this.push(cbJob, {}, batch.queueName)
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
          await this.push(cbJob, {}, batch.queueName)
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
          await this.push(cbJob, {}, batch.queueName)
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
