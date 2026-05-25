import crypto from 'node:crypto'
import { DB } from '@lib/database/DB.js'
import { config } from '@lib/foundation/helpers.js'

type SessionFlash = { old: Record<string, unknown>, next: Record<string, unknown> }
type SessionRecord = {
  id?: string
  data: Record<string, unknown>
  flash: SessionFlash
}

type CookieOptions = {
  signed?: boolean
  encrypted?: boolean
}

type StoreRecord = {
  payload: SessionRecord
  expiresAt?: number
}

const memoryStores = new Map<string, StoreRecord>()

export class SessionAdapter {
  private dirty = false

  constructor(
    private readonly manager: SessionManager,
    private readonly record: SessionRecord
  ) {}

  get(key: string, defaultValue?: unknown) {
    if (key in this.record.flash.old) return this.record.flash.old[key]
    if (key in this.record.flash.next) return this.record.flash.next[key]
    return this.record.data[key] ?? defaultValue
  }

  put(key: string, value: unknown) {
    this.record.data[key] = value
    this.dirty = true
  }

  forget(key: string) {
    delete this.record.data[key]
    delete this.record.flash.old[key]
    delete this.record.flash.next[key]
    this.dirty = true
  }

  flush() {
    this.record.data = {}
    this.record.flash.old = {}
    this.record.flash.next = {}
    this.dirty = true
  }

  regenerate() {
    this.record.id = crypto.randomUUID()
    this.dirty = true
    return this.record.id
  }

  flash(key: string, value: unknown) {
    this.record.flash.next[key] = value
    this.dirty = true
  }

  reflash() {
    Object.assign(this.record.flash.next, this.record.flash.old)
    this.dirty = true
  }

  keep(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (key in this.record.flash.old) this.record.flash.next[key] = this.record.flash.old[key]
    }
    this.dirty = true
  }

  oldInput() {
    return this.get('_old_input', {})
  }

  flashErrors(errors: Record<string, string[]>, bag = 'default') {
    this.flash('_errors', { ...this.errorBags(), [bag]: errors })
  }

  errors(bag = 'default') {
    return this.errorBags()[bag] ?? {}
  }

  errorBags() {
    return normalizeErrorBags(this.get('_errors', {}))
  }

  all() {
    return { ...this.record.data }
  }

  id() {
    return this.record.id
  }

  isDirty() {
    return this.dirty
  }

  async commit(reply: any) {
    await this.manager.commit(this, reply)
  }

  async destroy(reply: any) {
    await this.manager.destroy(this, reply)
  }

  snapshot() {
    return {
      id: this.record.id,
      data: { ...this.record.data },
      flash: { old: {}, next: { ...this.record.flash.next } }
    } satisfies SessionRecord
  }

  markClean() {
    this.dirty = false
  }
}

export class SessionManager {
  private cookieOptions = config<Record<string, any>>('session.cookie', {
    name: 'maxima_session',
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/'
  })

  private sessionConfig = config<Record<string, any>>('session', {
    driver: 'cookie',
    lifetime: 120
  })

  async start(request: any, reply: any) {
    const record = await this.load(request)
    const session = new SessionAdapter(this, record)
    ;(request.raw ?? request).session = session
    ;(reply as any).session = session
    return session
  }

  async commit(session: SessionAdapter, reply: any) {
    const record = session.snapshot()
    const driver = this.sessionConfig.driver ?? 'cookie'

    if (driver === 'cookie') {
      this.writeCookie(reply, this.cookieOptions.name ?? 'maxima_session', encodeRecord(record), this.cookieOptions)
      session.markClean()
      return
    }

    if (!record.id) record.id = crypto.randomUUID()
    await this.persistRecord(record)
    this.writeCookie(reply, this.cookieOptions.name ?? 'maxima_session', record.id, this.cookieOptions)
    session.markClean()
  }

  async destroy(session: SessionAdapter, reply: any) {
    if (session.id()) {
      memoryStores.delete(session.id()!)
      await DB.table(this.sessionConfig.stores?.database?.table ?? 'sessions').where('id', session.id()).delete().catch(() => {})
    }
    this.writeCookie(reply, this.cookieOptions.name ?? 'maxima_session', '', { ...this.cookieOptions, expires: new Date(0) })
  }

  async load(request: any): Promise<SessionRecord> {
    const driver = this.sessionConfig.driver ?? 'cookie'
    const cookieName = this.cookieOptions.name ?? 'maxima_session'
    const rawCookie = request.raw?.cookies?.[cookieName] ?? request.cookies?.[cookieName]

    if (driver === 'cookie') {
      return promoteFlash(decodeRecord(rawCookie, this.cookieOptions))
    }

    if (driver === 'memory') {
      const entry = rawCookie ? memoryStores.get(rawCookie) : undefined
      return promoteFlash(entry?.payload ?? newRecord(rawCookie))
    }

    if (driver === 'database') {
      const table = this.sessionConfig.stores?.database?.table ?? 'sessions'
      const row = rawCookie ? await DB.table(table).where('id', rawCookie).first().catch(() => null) : null
      return promoteFlash(row ? decodeRecord(row.payload, this.cookieOptions, rawCookie) : newRecord(rawCookie))
    }

    if (driver === 'redis') {
      return promoteFlash(newRecord(rawCookie))
    }

    return promoteFlash(newRecord(rawCookie))
  }

  private async persistRecord(record: SessionRecord) {
    const driver = this.sessionConfig.driver ?? 'cookie'
    const expiresAt = Date.now() + ((Number(this.sessionConfig.lifetime ?? 120) * 60 * 1000))

    if (driver === 'memory') {
      memoryStores.set(record.id!, { payload: record, expiresAt })
      return
    }

    if (driver === 'database') {
      const table = this.sessionConfig.stores?.database?.table ?? 'sessions'
      const payload = JSON.stringify(encodeRecord(record))
      const row = { id: record.id, payload, last_activity: new Date() }
      const exists = await DB.table(table).where('id', record.id).first().catch(() => null)
      if (exists) {
        await DB.table(table).where('id', record.id).update(row)
      } else {
        await DB.table(table).insert(row)
      }
      return
    }

    if (driver === 'redis') return
  }

  private writeCookie(reply: any, name: string, value: string, options: Record<string, any>) {
    if (typeof reply?.setCookie === 'function') {
      reply.setCookie(name, value, cookieOptions(options))
      return
    }

    const current = reply.getHeader?.('Set-Cookie')
    const serialized = serializeCookie(name, value, options)
    if (!current) {
      reply.header?.('Set-Cookie', serialized)
      return
    }
    reply.header?.('Set-Cookie', Array.isArray(current) ? [...current, serialized] : [current, serialized])
  }
}

export function encodeCookie(value: unknown, options: CookieOptions = {}) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value)
  if (options.encrypted) {
    return `enc:${encrypt(payload)}`
  }
  if (options.signed) {
    return `sig:${payload}.${sign(payload)}`
  }
  return payload
}

export function decodeCookie(value: string | undefined, options: CookieOptions = {}) {
  if (!value) return undefined
  value = decodeCookieValue(value)
  if (options.encrypted && value.startsWith('enc:')) return decrypt(value.slice(4))
  if (options.signed && value.startsWith('sig:')) {
    const payload = value.slice(4)
    const separator = payload.lastIndexOf('.')
    if (separator === -1) return undefined
    const raw = payload.slice(0, separator)
    const digest = payload.slice(separator + 1)
    if (digest !== sign(raw)) return undefined
    return raw
  }
  return value
}

function decodeCookieValue(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function encodeRecord(record: SessionRecord) {
  return encodeCookie(JSON.stringify(record), { encrypted: true })
}

function decodeRecord(value: string | undefined, options: CookieOptions, id?: string): SessionRecord {
  if (!value) return newRecord(id)
  const normalized = decodeCookieValue(value)
  const decoded = normalized.startsWith('enc:')
    ? decodeCookie(normalized, { encrypted: true })
    : options.encrypted ? decodeCookie(normalized, { encrypted: true }) : normalized
  try {
    const record = JSON.parse(String(decoded)) as SessionRecord
    return {
      id: record.id ?? id,
      data: record.data ?? {},
      flash: { old: record.flash?.old ?? {}, next: record.flash?.next ?? {} }
    }
  } catch {
    return newRecord(id)
  }
}

function promoteFlash(record: SessionRecord) {
  return {
    id: record.id,
    data: record.data ?? {},
    flash: {
      old: { ...(record.flash?.old ?? {}), ...(record.flash?.next ?? {}) },
      next: {}
    }
  }
}

function newRecord(id?: string): SessionRecord {
  return {
    id,
    data: {},
    flash: { old: {}, next: {} }
  }
}

function sign(value: string) {
  return crypto.createHmac('sha256', cookieSecret()).update(value).digest('hex')
}

function encrypt(value: string) {
  const key = crypto.createHash('sha256').update(cookieSecret()).digest()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64url')
}

function decrypt(value: string) {
  const raw = Buffer.from(value, 'base64url')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const encrypted = raw.subarray(28)
  const key = crypto.createHash('sha256').update(cookieSecret()).digest()
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

function cookieSecret() {
  return String(config('app.key', 'maxima-secret'))
}

function cookieOptions(options: Record<string, any>) {
  return {
    path: options.path ?? '/',
    httpOnly: options.httpOnly ?? true,
    secure: options.secure ?? false,
    sameSite: options.sameSite ?? 'lax',
    expires: options.expires,
    signed: false
  }
}

function serializeCookie(name: string, value: string, options: Record<string, any>) {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  if (options.expires) parts.push(`Expires=${new Date(options.expires).toUTCString()}`)
  if (options.maxAge) parts.push(`Max-Age=${Math.floor(Number(options.maxAge))}`)
  if (options.path) parts.push(`Path=${options.path}`)
  if (options.httpOnly !== false) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  if (options.sameSite) parts.push(`SameSite=${String(options.sameSite).charAt(0).toUpperCase()}${String(options.sameSite).slice(1)}`)
  return parts.join('; ')
}

function normalizeErrorBags(value: unknown) {
  if (!value || typeof value !== 'object') return {}
  const source = value as Record<string, any>
  if (!Object.keys(source).length) return {}
  const looksLikeMessageBag = Object.values(source).every(entry => Array.isArray(entry))
  return looksLikeMessageBag ? { default: source } : source
}
