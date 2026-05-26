import { Queue, WorkerOptions } from './Queue.js'
import { Log } from '@lib/logging/LogManager.js'
import fs from 'node:fs'
import { storagePath } from '@lib/foundation/helpers.js'

export class QueueWorker {
  private shouldQuit = false
  private processed = 0
  private startedAt = Date.now()
  private lastRestart = this.restartTimestamp()

  constructor(
    public readonly connectionName: string,
    public readonly options: WorkerOptions = {}
  ) {
    this.setupSignalHandlers()
  }

  private setupSignalHandlers() {
    process.on('SIGTERM', () => {
      this.shouldQuit = true
    })
    process.on('SIGINT', () => {
      this.shouldQuit = true
    })
  }

  async run() {
    Log.info(`Worker starting for queue: ${this.connectionName}`)
    
    const connConfig = (Queue as any).connectionConfig(this.connectionName)
    
    if (connConfig.driver === 'database') {
      const interval = this.options.sleep !== undefined ? this.options.sleep * 1000 : (connConfig.poll_interval ?? 1000)
      
      while (!this.shouldQuit) {
        if (this.shouldStop()) break
        this.checkMemory()
        if (this.shouldQuit) break
        this.checkRestart()

        try {
          const processed = await (Queue as any).processNextDatabaseJob(this.connectionName, this.options)
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
      const beeQueue = (Queue as any).queue(this.connectionName)
      
      beeQueue.process(async (beeJob: any) => {
        this.checkMemory()
        if (this.shouldQuit) {
          throw new Error('Worker is shutting down')
        }
        
        await Queue.handle(beeJob, this.connectionName, this.options)
        this.processed++
        
        if (this.options.once) {
          setImmediate(async () => {
            await beeQueue.close()
            process.exit(0)
          })
        }
      })
    } else if (connConfig.driver === 'sync') {
      Log.info('Sync driver doesn\'t support worker polling.')
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

  private restartTimestamp() {
    try {
      const file = storagePath('framework/queue-restart')
      return fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) || 0 : 0
    } catch {
      return 0
    }
  }
}
