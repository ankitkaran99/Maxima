import fs from 'node:fs'
import dotenv from 'dotenv'

export class EnvRepository {
  private values: Record<string, string> = {}

  load(file = '.env') {
    if (fs.existsSync(file)) {
      this.values = { ...dotenv.parse(fs.readFileSync(file)), ...process.env } as Record<string, string>
    } else {
      this.values = process.env as Record<string, string>
    }
  }

  get<T = string>(key: string, defaultValue?: T): T | string | boolean | number | undefined {
    const raw = this.values[key]
    if (raw === undefined || raw === '') return defaultValue
    if (raw === 'true') return true
    if (raw === 'false') return false
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
    return raw
  }
}
