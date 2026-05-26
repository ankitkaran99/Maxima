import crypto from 'node:crypto'
import { config } from '@lib/foundation/helpers.js'

export class DecryptException extends Error {
  constructor(message = 'The payload could not be decrypted.') {
    super(message)
    this.name = 'DecryptException'
  }
}

export class Encrypter {
  constructor(private keyResolver: () => string = () => String(config('app.key', 'maxima-secret'))) {}

  encrypt(value: unknown) {
    return this.encryptString(JSON.stringify(value))
  }

  decrypt<T = unknown>(payload: string) {
    return JSON.parse(this.decryptString(payload)) as T
  }

  encryptString(value: string) {
    const iv = crypto.randomBytes(12)
    const key = this.key(this.keyResolver())
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, encrypted]).toString('base64url')
  }

  decryptString(payload: string) {
    const keys = [
      this.keyResolver(),
      ...String(config('app.previous_keys', '')).split(',').map(key => key.trim()).filter(Boolean)
    ]

    for (const candidate of keys) {
      try {
        const raw = Buffer.from(payload, 'base64url')
        const iv = raw.subarray(0, 12)
        const tag = raw.subarray(12, 28)
        const encrypted = raw.subarray(28)
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.key(candidate), iv)
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
      } catch {}
    }

    throw new DecryptException()
  }

  private key(secret: string) {
    const normalized = secret.startsWith('base64:') ? Buffer.from(secret.slice(7), 'base64') : Buffer.from(secret)
    return normalized.length === 32 ? normalized : crypto.createHash('sha256').update(normalized).digest()
  }
}

export const Crypt = new Encrypter()
