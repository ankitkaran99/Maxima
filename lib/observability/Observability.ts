type Entry = Record<string, any> & { type: string, timestamp: number }
type FeatureResolver = boolean | ((user?: any) => boolean | Promise<boolean>)

export class Timeline {
  private entries: Entry[] = []

  record(type: string, payload: Record<string, any> = {}) {
    const entry = { type, timestamp: Date.now(), ...payload }
    this.entries.push(entry)
    return entry
  }

  all(type?: string) {
    return type ? this.entries.filter(entry => entry.type === type) : [...this.entries]
  }

  clear() {
    this.entries = []
  }
}

export const Telescope = new Timeline()

export class PulseManager {
  private counters = new Map<string, number>()
  private timings = new Map<string, number[]>()

  increment(name: string, by = 1) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by)
  }

  timing(name: string, milliseconds: number) {
    this.timings.set(name, [...(this.timings.get(name) ?? []), milliseconds])
  }

  snapshot() {
    return {
      counters: Object.fromEntries(this.counters),
      timings: Object.fromEntries([...this.timings.entries()].map(([name, values]) => [
        name,
        { count: values.length, avg: values.reduce((sum, value) => sum + value, 0) / values.length, max: Math.max(...values) }
      ]))
    }
  }

  clear() {
    this.counters.clear()
    this.timings.clear()
  }
}

export const Pulse = new PulseManager()

export class HorizonManager {
  snapshot() {
    const jobs = Telescope.all('job')
    return {
      jobs: jobs.length,
      failed: jobs.filter(job => job.failed).length,
      queues: [...new Set(jobs.map(job => job.queue ?? 'default'))]
    }
  }
}

export const Horizon = new HorizonManager()

export class ScoutManager {
  private indexes = new Map<string, Map<string, any>>()

  import(index: string, records: any[], key = 'id') {
    const bucket = this.indexes.get(index) ?? new Map<string, any>()
    for (const record of records) bucket.set(String(record[key]), record)
    this.indexes.set(index, bucket)
  }

  search(index: string, term: string) {
    const needle = term.toLowerCase()
    return [...(this.indexes.get(index)?.values() ?? [])].filter(record => JSON.stringify(record).toLowerCase().includes(needle))
  }

  flush(index?: string) {
    if (index) this.indexes.delete(index)
    else this.indexes.clear()
  }
}

export const Scout = new ScoutManager()

export class PennantManager {
  private features = new Map<string, FeatureResolver>()

  define(name: string, resolver: FeatureResolver) {
    this.features.set(name, resolver)
  }

  async active(name: string, user?: any) {
    const resolver = this.features.get(name)
    if (typeof resolver === 'function') return Boolean(await resolver(user))
    return Boolean(resolver)
  }

  forget(name?: string) {
    if (name) this.features.delete(name)
    else this.features.clear()
  }
}

export const Pennant = new PennantManager()

export class OctaneManager {
  private booted = false

  start(callback?: () => void | Promise<void>) {
    this.booted = true
    return callback?.()
  }

  reload(callback?: () => void | Promise<void>) {
    return callback?.()
  }

  status() {
    return { running: this.booted }
  }
}

export const Octane = new OctaneManager()

export class SailManager {
  private running = false

  up() {
    this.running = true
    return this.status()
  }

  down() {
    this.running = false
    return this.status()
  }

  status() {
    return { running: this.running }
  }
}

export const Sail = new SailManager()

export class ValetManager {
  private links = new Map<string, string>()
  private parked = new Set<string>()

  link(name: string, directory = process.cwd()) {
    this.links.set(name, directory)
  }

  park(directory = process.cwd()) {
    this.parked.add(directory)
  }

  sites() {
    return {
      links: Object.fromEntries(this.links),
      parked: [...this.parked]
    }
  }
}

export const Valet = new ValetManager()

export class HomesteadManager {
  private machines = new Map<string, Record<string, any>>()

  provision(name: string, options: Record<string, any> = {}) {
    const machine = { name, provisionedAt: new Date().toISOString(), ...options }
    this.machines.set(name, machine)
    return machine
  }

  list() {
    return [...this.machines.values()]
  }
}

export const Homestead = new HomesteadManager()

export class ReverbManager {
  private channels = new Map<string, Set<(event: string, payload: any) => void>>()

  subscribe(channel: string, callback: (event: string, payload: any) => void) {
    const subscribers = this.channels.get(channel) ?? new Set()
    subscribers.add(callback)
    this.channels.set(channel, subscribers)
    return () => subscribers.delete(callback)
  }

  publish(channel: string, event: string, payload: any = {}) {
    for (const callback of this.channels.get(channel) ?? []) callback(event, payload)
    Telescope.record('realtime', { channel, event, payload })
  }
}

export const Reverb = new ReverbManager()

export class BoostManager {
  private tools = new Map<string, (input: any) => any>()

  tool(name: string, callback: (input: any) => any) {
    this.tools.set(name, callback)
  }

  async call(name: string, input: any = {}) {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`Boost tool [${name}] is not registered.`)
    return tool(input)
  }
}

export const Boost = new BoostManager()
