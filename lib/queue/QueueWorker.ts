import { Queue, WorkerOptions } from './Queue.js'
import { Log } from '@lib/logging/LogManager.js'
import fs from 'node:fs'
import { storagePath } from '@lib/foundation/helpers.js'
import { Worker as BullWorker } from 'bullmq'

export class QueueWorker {
  private static instances = new Set<QueueWorker>()
  private static signalHandlersInstalled = false
  private static restartCache = { path: '', mtimeMs: 0, value: 0 }

  private shouldQuit = false
  private processed = 0
  private startedAt = Date.now()
  private lastRestart = this.restartTimestamp()
  private workerInstance?: any

  constructor(
    public readonly connectionName: string,
    public readonly options: WorkerOptions = {}
  ) {
    QueueWorker.instances.add(this)
    QueueWorker.setupSignalHandlers()
  }

  private static setupSignalHandlers() {
    if (this.signalHandlersInstalled) return
    const markWorkersForShutdown = () => {
      for (const worker of this.instances) worker.shouldQuit = true
    }
    process.on('SIGTERM', markWorkersForShutdown)
    process.on('SIGINT', markWorkersForShutdown)
    this.signalHandlersInstalled = true
  }

  async run() {
    let shouldDeregister = true
    try {
      Log.info(`Worker starting for queue: ${this.connectionName}`)

      const connConfig = (Queue as any).connectionConfig(this.connectionName)
      const queueName = this.options.queue ?? this.connectionName

      if (connConfig.driver === 'database') {
        const interval = this.options.sleep !== undefined ? this.options.sleep * 1000 : (connConfig.poll_interval ?? 1000)

        while (!this.shouldQuit) {
          if (this.shouldStop()) break
          this.checkMemory()
          if (this.shouldQuit) break
          this.checkRestart()

          try {
            const processed = await (Queue as any).processNextDatabaseJob(this.connectionName, this.options, queueName)
            if (processed) this.processed++

            if (processed && this.options.rest) {
              await new Promise(resolve => setTimeout(resolve, this.options.rest! * 1000))
            }

            if (processed && this.options.once) {
              break
            }

            if (!processed) {
              if (this.options.stopWhenEmpty) break
              await new Promise(resolve => setTimeout(resolve, interval))
            }
          } catch (error) {
            Log.error(error as Error, { context: 'Database Queue Poller' })
            await new Promise(resolve => setTimeout(resolve, interval))
          }
        }
        Log.info(`Worker stopped for queue: ${this.connectionName}`)
      } else if (connConfig.driver === 'redis') {
        shouldDeregister = false
        const connectionOpts = (Queue as any).getBullMQConnection(connConfig)

        const worker = new BullWorker(queueName, async (bullJob: any) => {
          this.checkMemory()
          if (this.shouldQuit) {
            throw new Error('Worker is shutting down')
          }

          await Queue.handle(bullJob, this.connectionName, this.options, queueName)
          this.processed++

          if (this.options.once || this.shouldStop()) {
            await this.stopRedisWorker()
          }
        }, {
          connection: connectionOpts,
          concurrency: 1
        })

        this.workerInstance = worker
      } else if (connConfig.driver === 'sync') {
        Log.info('Sync driver doesn\'t support worker polling.')
      }
    } finally {
      if (shouldDeregister) QueueWorker.instances.delete(this)
    }
  }

  private checkMemory() {
    const memoryLimit = this.options.memory ?? 128
    const rss = process.memoryUsage().rss / 1024 / 1024
    if (rss > memoryLimit) {
      Log.warning(`Worker memory limit of ${memoryLimit}MB exceeded (${rss.toFixed(2)}MB). Exiting...`)
      this.shouldQuit = true
    }
  }

  private shouldStop() {
    if (this.options.maxJobs && this.processed >= this.options.maxJobs) return true
    if (this.options.maxTime && Date.now() - this.startedAt >= this.options.maxTime * 1000) return true
    return false
  }

  private checkRestart() {
    const current = this.restartTimestamp()
    if (current > this.lastRestart) {
      Log.info('Queue worker restart requested', { worker: this.options.name ?? this.connectionName })
      this.shouldQuit = true
    }
  }

  private async stopRedisWorker() {
    this.shouldQuit = true
    try {
      await this.workerInstance?.close()
    } finally {
      QueueWorker.instances.delete(this)
    }
  }

  private restartTimestamp() {
    try {
      const file = storagePath('framework/queue-restart')
      if (!fs.existsSync(file)) {
        QueueWorker.restartCache = { path: file, mtimeMs: 0, value: 0 }
        return 0
      }

      const stat = fs.statSync(file)
      const cached = QueueWorker.restartCache
      if (cached.path === file && cached.mtimeMs === stat.mtimeMs) {
        return cached.value
      }

      const value = Number(fs.readFileSync(file, 'utf8')) || 0
      QueueWorker.restartCache = { path: file, mtimeMs: stat.mtimeMs, value }
      return value
    } catch {
      return 0
    }
  }
}
