import cron from 'node-cron'
import { Log } from '@lib/logging/LogManager.js'
import { Cache } from '@lib/cache/Cache.js'
import { config, storagePath } from '@lib/foundation/helpers.js'
import fs from 'node:fs/promises'
import path from 'node:path'

type Task = {
  name: string
  expression: string
  callback: () => Promise<void> | void
  timezone?: string
  withoutOverlapping?: boolean
  overlapTtl?: number
  onOneServer?: boolean
  running?: boolean
  between?: [string, string]
  unlessBetween?: [string, string]
  when: Array<() => boolean | Promise<boolean>>
  skip: Array<() => boolean | Promise<boolean>>
  environments?: string[]
  background?: boolean
  evenInMaintenance?: boolean
  outputPath?: string
  appendOutput?: boolean
  emailOutput?: string
  pingBefore?: string
  thenPing?: string
  group?: string
}

class PendingTask {
  constructor(private task: Task) {}
  everyMinute() { this.task.expression = '* * * * *'; return this }
  everyFiveMinutes() { this.task.expression = '*/5 * * * *'; return this }
  hourly() { this.task.expression = '0 * * * *'; return this }
  daily() { this.task.expression = '0 0 * * *'; return this }
  dailyAt(time: string) {
    const [hour, minute] = time.split(':').map(value => String(Number.parseInt(value, 10)))
    this.task.expression = `${minute} ${hour} * * *`
    return this
  }
  twiceDaily(firstHour = 1, secondHour = 13) {
    this.task.expression = `0 ${firstHour},${secondHour} * * *`
    return this
  }
  weekdays() {
    this.task.expression = '0 0 * * 1-5'
    return this
  }
  weekends() {
    this.task.expression = '0 0 * * 0,6'
    return this
  }
  weekly() { this.task.expression = '0 0 * * 0'; return this }
  monthly() { this.task.expression = '0 0 1 * *'; return this }
  cron(expression: string) { this.task.expression = expression; return this }
  timezone(timezone: string) { this.task.timezone = timezone; return this }
  withoutOverlapping(expiresAfterMinutes = 1440) { this.task.withoutOverlapping = true; this.task.overlapTtl = expiresAfterMinutes * 60; return this }
  onOneServer() { this.task.onOneServer = true; return this }
  between(start: string, end: string) { this.task.between = [start, end]; return this }
  unlessBetween(start: string, end: string) { this.task.unlessBetween = [start, end]; return this }
  when(callback: () => boolean | Promise<boolean>) { this.task.when.push(callback); return this }
  skip(callback: () => boolean | Promise<boolean>) { this.task.skip.push(callback); return this }
  environments(...names: string[]) { this.task.environments = names.flat(); return this }
  runInBackground() { this.task.background = true; return this }
  evenInMaintenanceMode() { this.task.evenInMaintenance = true; return this }
  sendOutputTo(file: string) { this.task.outputPath = file; this.task.appendOutput = false; return this }
  appendOutputTo(file: string) { this.task.outputPath = file; this.task.appendOutput = true; return this }
  emailOutputTo(address: string) { this.task.emailOutput = address; return this }
  pingBefore(url: string) { this.task.pingBefore = url; return this }
  thenPing(url: string) { this.task.thenPing = url; return this }
  group(name: string) { this.task.group = name; return this }
}

export class Scheduler {
  private tasks: Task[] = []

  job(job: { handle(): Promise<void> | void }) { return this.add(job.constructor.name, () => job.handle()) }
  command(command: string) { return this.add(command, async () => { const { runCliCommand } = await import('@lib/cli/runCliCommand.js'); await runCliCommand(command.split(' ')) }) }
  call(name: string, callback: () => Promise<void> | void) { return this.add(name, callback) }

  clear() {
    this.tasks = []
  }

  all() {
    return this.tasks.map(task => ({
      name: task.name,
      expression: task.expression,
      timezone: task.timezone,
      withoutOverlapping: task.withoutOverlapping,
      onOneServer: task.onOneServer,
      environments: task.environments ?? [],
      background: task.background ?? false,
      group: task.group,
      running: task.running ?? false
    }))
  }

  run() {
    for (const task of this.tasks) {
      cron.schedule(task.expression, () => this.execute(task), { timezone: task.timezone })
    }
  }

  async runDue() {
    await Promise.all(this.tasks.map(task => this.execute(task)))
  }

  async work(intervalMs = 1000) {
    while (true) {
      await this.runDue()
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }
  }

  async clearCache() {
    for (const task of this.tasks) {
      await Cache.lock(`schedule:${task.name}`).forceRelease()
      await Cache.lock(`schedule:server:${task.name}`).forceRelease()
    }
  }

  private add(name: string, callback: () => Promise<void> | void) {
    const task = { name, expression: '* * * * *', callback, when: [], skip: [] } satisfies Task
    this.tasks.push(task)
    return new PendingTask(task)
  }

  private async execute(task: Task) {
    if (!await this.shouldRun(task)) return
    const locks = []
    if (task.withoutOverlapping) locks.push(Cache.lock(`schedule:${task.name}`, task.overlapTtl ?? 86400))
    if (task.onOneServer) locks.push(Cache.lock(`schedule:server:${task.name}`, task.overlapTtl ?? 86400))

    for (const lock of locks) {
      if (!await lock.get()) return Log.warn('Scheduled task skipped because a mutex is held', { task: task.name })
    }

    if (task.withoutOverlapping && task.running) return Log.warn('Scheduled task skipped because it is already running', { task: task.name })
    task.running = true
    const start = performance.now()
    try {
      Log.info('Scheduled task started', { task: task.name })
      const runner = async () => {
        await this.ping(task.pingBefore)
        await task.callback()
        await this.writeOutput(task, `Task [${task.name}] completed at ${new Date().toISOString()}\n`)
        await this.emailOutput(task)
        await this.ping(task.thenPing)
      }
      if (task.background) void runner().catch(error => Log.error(error as Error, { task: task.name }))
      else await runner()
      Log.info('Scheduled task completed', { task: task.name, durationMs: Math.round(performance.now() - start) })
    } catch (error) {
      Log.error(error as Error, { task: task.name })
    } finally {
      task.running = false
      for (const lock of locks) await lock.release()
    }
  }

  private async shouldRun(task: Task) {
    if (!task.evenInMaintenance) {
      try { await fs.access(storagePath('framework/down')); return false } catch {}
    }
    const env = config<string>('app.env', process.env.NODE_ENV ?? 'local')
    if (task.environments?.length && !task.environments.includes(env)) return false
    if (task.between && !inTimeWindow(task.between[0], task.between[1])) return false
    if (task.unlessBetween && inTimeWindow(task.unlessBetween[0], task.unlessBetween[1])) return false
    for (const cb of task.when) if (!await cb()) return false
    for (const cb of task.skip) if (await cb()) return false
    return true
  }

  private async writeOutput(task: Task, output: string) {
    if (!task.outputPath) return
    await fs.mkdir(path.dirname(task.outputPath), { recursive: true })
    if (task.appendOutput) await fs.appendFile(task.outputPath, output)
    else await fs.writeFile(task.outputPath, output)
  }

  private async emailOutput(task: Task) {
    if (!task.emailOutput || !task.outputPath) return
    const { Mail } = await import('@lib/mail/Mail.js')
    const output = await fs.readFile(task.outputPath, 'utf8').catch(() => '')
    await Mail.raw(output, { to: task.emailOutput, subject: `Scheduled task output: ${task.name}` })
  }

  private async ping(url?: string) {
    if (!url) return
    await fetch(url).catch(error => Log.error(error as Error))
  }
}

export const Schedule = new Scheduler()

function inTimeWindow(start: string, end: string) {
  const now = new Date()
  const current = now.getHours() * 60 + now.getMinutes()
  const startValue = parseTime(start)
  const endValue = parseTime(end)
  if (startValue <= endValue) return current >= startValue && current <= endValue
  return current >= startValue || current <= endValue
}

function parseTime(time: string) {
  const [hour, minute = '0'] = time.split(':')
  return Number(hour) * 60 + Number(minute)
}
