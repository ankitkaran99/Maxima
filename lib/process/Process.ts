import { spawn } from 'node:child_process'
import { Context } from '@lib/process/Context.js'

type FakeHandler = ProcessResult | ((command: string, args: string[], options: Record<string, any>) => ProcessResult | Promise<ProcessResult>)

export class ProcessResult {
  constructor(public command: string, public exitCode: number, public stdout = '', public stderr = '') {}
  successful() { return this.exitCode === 0 }
  failed() { return !this.successful() }
  throw() { if (this.failed()) throw new Error(this.stderr || `Process [${this.command}] failed with exit code ${this.exitCode}.`); return this }
}

export class PendingProcess {
  private options: Record<string, any> = {}
  constructor(private manager: ProcessManager, private command: string, private args: string[] = []) {}
  path(cwd: string) { this.options.cwd = cwd; return this }
  env(values: Record<string, string>) { this.options.env = { ...this.options.env, ...values }; return this }
  timeout(seconds: number) { this.options.timeout = seconds * 1000; return this }
  input(value: string) { this.options.input = value; return this }
  async run() { return this.manager.run(this.command, this.args, this.options) }
  async throw() { return (await this.run()).throw() }
}

export class ProcessPool {
  private processes: PendingProcess[] = []
  constructor(private manager: ProcessManager) {}
  command(command: string, args: string[] = []) { const pending = this.manager.command(command, args); this.processes.push(pending); return pending }
  async run() { return Promise.all(this.processes.map(process => process.run())) }
}

export class ProcessManager {
  private fakeHandler: FakeHandler | null = null
  private records: Array<{ command: string, args: string[], options: Record<string, any> }> = []

  command(command: string, args: string[] = []) { return new PendingProcess(this, command, args) }
  async run(command: string, args: string[] = [], options: Record<string, any> = {}) {
    this.records.push({ command, args, options })
    if (this.fakeHandler) {
      const result = typeof this.fakeHandler === 'function' ? await this.fakeHandler(command, args, options) : this.fakeHandler
      return result instanceof ProcessResult ? result : new ProcessResult(command, (result as any).exitCode ?? 0, (result as any).stdout ?? '', (result as any).stderr ?? '')
    }

    return new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, shell: process.platform === 'win32' })
      let stdout = ''
      let stderr = ''
      let timer: NodeJS.Timeout | undefined
      if (options.timeout) timer = setTimeout(() => child.kill(), options.timeout)
      child.stdout?.on('data', chunk => { stdout += chunk })
      child.stderr?.on('data', chunk => { stderr += chunk })
      child.on('error', reject)
      child.on('close', code => {
        if (timer) clearTimeout(timer)
        resolve(new ProcessResult(command, code ?? 0, stdout, stderr))
      })
      if (options.input) child.stdin?.end(options.input)
    })
  }

  pool(callback: (pool: ProcessPool) => void) {
    const pool = new ProcessPool(this)
    callback(pool)
    return pool.run()
  }

  fake(handler: FakeHandler = new ProcessResult('fake', 0)) {
    this.fakeHandler = handler
    this.records = []
  }

  restore() { this.fakeHandler = null; this.records = [] }
  assertRan(command: string) {
    if (!this.records.some(record => record.command.includes(command))) throw new Error(`Expected process [${command}] to run.`)
  }
  recorded() { return [...this.records] }
}

export class ConcurrencyManager {
  async run<T>(tasks: Array<() => T | Promise<T>>, limit = tasks.length): Promise<T[]> {
    const results: T[] = []
    let index = 0
    async function worker() {
      while (index < tasks.length) {
        const current = index++
        results[current] = await tasks[current]()
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
    return results
  }

  async defer<T>(task: () => T | Promise<T>, values = Context.all()) {
    return Promise.resolve().then(() => Context.run(values, task))
  }
}

export const Process = new ProcessManager()
export const Concurrency = new ConcurrencyManager()
