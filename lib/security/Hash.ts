import argon2 from 'argon2'

export type HashOptions = argon2.Options & { raw?: false }

export class HashManager {
  private options: HashOptions = {}

  setOptions(options: HashOptions) {
    this.options = { ...options }
    return this
  }

  getOptions() {
    return { ...this.options }
  }

  async make(value: string, options: HashOptions = {}) {
    return argon2.hash(value, { ...this.options, ...options })
  }

  async check(value: string, hashed: string) {
    try {
      return await argon2.verify(hashed, value)
    } catch {
      return false
    }
  }

  needsRehash(hashed: string, options: HashOptions = {}) {
    return argon2.needsRehash(hashed, { ...this.options, ...options })
  }
}

export const Hash = new HashManager()
