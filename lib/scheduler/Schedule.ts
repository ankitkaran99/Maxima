import cron from 'node-cron'
import { Log } from '@lib/logging/LogManager.js'

type Task = { name: string, expression: string, callback: () => Promise<void> | void, timezone?: string, withoutOverlapping?: boolean, running?: boolean }

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
  withoutOverlapping() { this.task.withoutOverlapping = true; return this }
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

  private add(name: string, callback: () => Promise<void> | void) {
    const task = { name, expression: '* * * * *', callback } satisfies Task
    this.tasks.push(task)
    return new PendingTask(task)
  }

  private async execute(task: Task) {
    if (task.withoutOverlapping && task.running) return Log.warn('Scheduled task skipped because it is already running', { task: task.name })
    task.running = true
    const start = performance.now()
    try {
      Log.info('Scheduled task started', { task: task.name })
      await task.callback()
      Log.info('Scheduled task completed', { task: task.name, durationMs: Math.round(performance.now() - start) })
    } catch (error) {
      Log.error(error as Error, { task: task.name })
    } finally {
      task.running = false
    }
  }
}

export const Schedule = new Scheduler()
