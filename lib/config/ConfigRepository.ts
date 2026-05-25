import fs from 'node:fs/promises'
import path from 'node:path'
import { toFileUrl } from '@lib/support/paths.js'

export class ConfigRepository {
  private items: Record<string, any> = {}

  async load(directory: string) {
    const cached = path.join(directory, '..', 'bootstrap', 'cache', 'config.json')
    try {
      this.items = JSON.parse(await fs.readFile(cached, 'utf8'))
      return
    } catch {}

    this.items = {}
    const files = await fs.readdir(directory).catch(() => [])
    for (const file of files.filter(file => file.endsWith('.js') || file.endsWith('.ts'))) {
      const key = path.basename(file).replace(/\.(js|ts)$/, '')
      const mod = await import(`${toFileUrl(path.join(directory, file))}?t=${Date.now()}`)
      this.items[key] = mod.default ?? mod
    }
  }

  get<T = unknown>(key: string, defaultValue?: T): T {
    const value = key.split('.').reduce<any>((current, segment) => current?.[segment], this.items)
    return value === undefined ? defaultValue as T : value as T
  }

  set(key: string, value: unknown) {
    const parts = key.split('.')
    let current = this.items
    while (parts.length > 1) {
      current = current[parts.shift()!] ??= {}
    }
    current[parts[0]] = value
  }

  has(key: string) {
    return this.get(key) !== undefined
  }

  all() {
    return this.items
  }

  async cache(target: string) {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, JSON.stringify(this.items, null, 2))
  }
}
