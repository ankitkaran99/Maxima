import crypto from 'node:crypto'
import { DB } from '@lib/database/DB.js'
import { config } from '@lib/foundation/helpers.js'
import { response, signedUrl } from '@lib/foundation/helpers.js'
import { Gate, setCurrentUserResolver } from '@lib/auth/Gate.js'
import { Event } from '@lib/events/Event.js'
import { Hash } from '@lib/security/Hash.js'
import { Mail } from '@lib/mail/Mail.js'
import { decodeCookie } from '@lib/session/Session.js'
import { EmailVerificationMail, PasswordResetMail } from '@lib/auth/Mailables.js'

export interface UserProvider {
  retrieveById(id: string | number): Promise<any>
  retrieveByCredentials(credentials: Record<string, any>): Promise<any>
}

export class AuthAttempting {
  constructor(public guard: string, public credentials: Record<string, any>, public remember: boolean) {}
}

export class AuthValidated {
  constructor(public guard: string, public user: any) {}
}

export class AuthLogin {
  constructor(public guard: string, public user: any, public remember: boolean) {}
}

export class AuthFailed {
  constructor(public guard: string, public credentials: Record<string, any>) {}
}

export class AuthLogout {
  constructor(public guard: string, public user: any) {}
}

type RequestGuard = (request: any) => any | Promise<any>

export class AuthManager {
  private request?: any
  private reply?: any
  private requestGuards = new Map<string, RequestGuard>()
  private customProviders = new Map<string, (config: any) => UserProvider>()

  setRequest(request: any, reply?: any) {
    this.request = request
    this.reply = reply
    setCurrentUserResolver(() => this.request?.user)
    return this
  }

  async user(guard = config<string>('auth.defaults.guard', 'session')) {
    if (!this.request) return null
    if (this.request.user) return this.request.user

    const resolved = await this.resolveUserFromGuard(guard)
    if (resolved) this.request.user = this.decorateUser(resolved)
    return this.request.user ?? null
  }

  async check(guard?: string) {
    return Boolean(await this.user(guard))
  }

  async attempt(credentials: Record<string, any>, guard = config<string>('auth.defaults.guard', 'session'), remember = Boolean(credentials.remember)) {
    if (!this.request) throw new Error('Auth request context has not been set.')
    if (await this.tooManyLoginAttempts(credentials, guard)) {
      await Event.dispatchAsync(new AuthFailed(guard, credentials))
      return false
    }
    await Event.dispatchAsync(new AuthAttempting(guard, credentials, remember))
    const provider = this.providerForGuard(guard)
    const { remember: _remember, ...loginCredentials } = credentials
    const user = await provider.retrieveByCredentials(loginCredentials)
    if (!user || !(await this.verify(credentials.password, user.password))) {
      await this.hitLoginThrottle(credentials, guard)
      await Event.dispatchAsync(new AuthFailed(guard, loginCredentials))
      return false
    }
    await this.clearLoginThrottle(credentials, guard)
    await Event.dispatchAsync(new AuthValidated(guard, user))
    this.request.user = this.decorateUser(user)
    this.storeSessionUserId(guard, user.id)
    if (remember) await this.rememberUser(user, guard)
    await Event.dispatchAsync(new AuthLogin(guard, user, remember))
    return true
  }

  async logout(guard = config<string>('auth.defaults.guard', 'session')) {
    if (!this.request) return
    const user = this.request.user
    await this.clearRememberedUser()
    this.request.user = null
    this.request.session?.forget?.(this.sessionKey(guard))
    if (guard === 'session') this.request.session?.forget?.('auth_user_id')
    await Event.dispatchAsync(new AuthLogout(guard, user))
  }

  async remember(user: any, guard = config<string>('auth.defaults.guard', 'session')) {
    return this.rememberUser(user, guard)
  }

  async confirmPassword(password: string, guard = config<string>('auth.defaults.guard', 'session')) {
    const user = await this.user(guard)
    if (!user) return false
    if (!(await this.verify(password, user.password))) return false
    this.request?.session?.put?.('_password_confirmed_at', Date.now())
    return true
  }

  passwordConfirmed(timeoutSeconds = Number(config('auth.passwordTimeout', 10800))) {
    const confirmedAt = this.request?.session?.get?.('_password_confirmed_at')
    if (!confirmedAt) return false
    return (Date.now() - Number(confirmedAt)) <= (timeoutSeconds * 1000)
  }

  async sendPasswordResetLink(email: string) {
    const provider = this.providerForGuard('session')
    const user = await provider.retrieveByCredentials({ email })
    if (!user) return false
    const token = await this.createPasswordResetToken(email)
    const url = this.passwordResetUrl(email, token)
    await Mail.to(user.email).send(new PasswordResetMail(user, url))
    return true
  }

  async createPasswordResetToken(email: string) {
    const token = crypto.randomUUID()
    await this.storePasswordResetToken(email, token)
    return token
  }

  async resetPassword(email: string, token: string, password: string) {
    const record = await this.getPasswordResetToken(email)
    if (!record) return false
    if (!(await this.verifyToken(token, record.token_hash))) return false
    if (record.expires_at && new Date(record.expires_at).getTime() < Date.now()) return false

    const provider = this.providerForGuard('session')
    const user = await provider.retrieveByCredentials({ email })
    if (!user) return false
    await this.updatePassword(user, password)
    await this.deletePasswordResetToken(email)
    return true
  }

  async sendEmailVerification(user: any) {
    if (await this.hasVerifiedEmail(user)) return false
    const url = this.emailVerificationUrl(user)
    await Mail.to(user.email).send(new EmailVerificationMail(user, url))
    return true
  }

  emailVerificationLink(user: any) {
    return this.emailVerificationUrl(user)
  }

  async verifyEmail(userId: string | number, hash: string) {
    const provider = this.providerForGuard('session')
    const user = await provider.retrieveById(userId)
    if (!user) return false
    if (this.emailHash(user.email) !== hash) return false
    await this.markEmailAsVerified(user)
    return true
  }

  async markEmailAsVerified(user: any) {
    await this.upsertVerifiedEmail(user)
    if ('email_verified_at' in user || user.email_verified_at !== undefined) {
      user.email_verified_at = new Date()
    }
    return true
  }

  async hasVerifiedEmail(user: any) {
    if (!user) return false
    if (user.email_verified_at) return true
    return Boolean(await this.getVerifiedEmail(user))
  }

  async issueJwt(user: any, claims: Record<string, any> = {}) {
    return signJwt({
      sub: String(user.id ?? user.sub ?? user.email),
      ...claims
    })
  }

  async verifyJwt(token: string) {
    return verifyJwt(token)
  }

  async hash(value: string) {
    return Hash.make(value)
  }

  async verify(value: string, hashed: string) {
    return Hash.check(value, hashed)
  }

  needsRehash(hashed: string, options: any = {}) {
    return Hash.needsRehash(hashed, options)
  }

  viaRequest(name: string, callback: RequestGuard) {
    this.requestGuards.set(name, callback)
    return this
  }

  providerUsing(name: string, factory: (config: any) => UserProvider) {
    this.customProviders.set(name, factory)
    return this
  }

  async tooManyLoginAttempts(credentials: Record<string, any>, guard = config<string>('auth.defaults.guard', 'session')) {
    const throttle = config<Record<string, any>>('auth.throttle', {})
    if (throttle.enabled === false) return false
    const { Cache } = await import('@lib/cache/Cache.js')
    const record = await Cache.get<{ count: number, resetAt: number }>(this.loginThrottleKey(credentials, guard))
    return Boolean(record && record.resetAt > Date.now() && record.count >= Number(throttle.maxAttempts ?? 5))
  }

  async availableIn(credentials: Record<string, any>, guard = config<string>('auth.defaults.guard', 'session')) {
    const { Cache } = await import('@lib/cache/Cache.js')
    const record = await Cache.get<{ count: number, resetAt: number }>(this.loginThrottleKey(credentials, guard))
    return record ? Math.max(0, Math.ceil((record.resetAt - Date.now()) / 1000)) : 0
  }

  provider(name = config<string>('auth.defaults.provider', 'users')): UserProvider {
    const provider = config<any>(`auth.providers.${name}`)
    if (!provider?.driver) throw new Error(`Auth provider [${name}] is not configured.`)
    if (typeof provider.driver === 'string' && this.customProviders.has(provider.driver)) {
      return this.customProviders.get(provider.driver)!(provider)
    }
    return typeof provider.driver === 'function' ? new provider.driver(provider) : provider.driver
  }

  providerForGuard(guardName = config<string>('auth.defaults.guard', 'session')) {
    const guard = config<any>(`auth.guards.${guardName}`)
    if (!guard) throw new Error(`Auth guard [${guardName}] is not configured.`)
    return this.provider(guard.provider ?? config<string>('auth.defaults.provider', 'users'))
  }

  private async resolveUserFromGuard(guardName: string) {
    const guard = config<any>(`auth.guards.${guardName}`)
    if (!guard) throw new Error(`Auth guard [${guardName}] is not configured.`)
    if (guard.driver === 'request') {
      const resolver = this.requestGuards.get(guard.name ?? guardName)
      if (!resolver) throw new Error(`Request guard [${guardName}] is not registered.`)
      return resolver(this.request)
    }

    const provider = this.provider(guard.provider ?? config<string>('auth.defaults.provider', 'users'))

    if (guard.driver === 'session') {
      const id = this.request?.session?.get?.(this.sessionKey(guardName)) ?? this.request?.session?.get?.('auth_user_id')
      if (id !== undefined && id !== null) return provider.retrieveById(id)
      return this.restoreRememberedUser(guardName)
    }

    if (guard.driver === 'token') {
      const token = this.bearerToken() ?? this.request?.query?.api_token
      if (!token) return null

      try {
        const hashedToken = crypto.createHash('sha256').update(token).digest('hex')
        const { PersonalAccessToken } = await import('@lib/auth/PersonalAccessToken.js')
        const tokenRecord = await PersonalAccessToken.where('token', hashedToken).first()
        if (tokenRecord) {
          if (!tokenRecord.expires_at || new Date(tokenRecord.expires_at) > new Date()) {
            tokenRecord.last_used_at = new Date()
            await tokenRecord.save()

            const user = await tokenRecord.tokenable().first()
            if (user) {
              this.request.currentToken = tokenRecord
              if (typeof user.withAccessToken === 'function') {
                user.withAccessToken(tokenRecord)
              }
              return user
            }
          }
        }
      } catch (err) {
        // Fallback
      }

      const jwt = config<Record<string, any>>('auth.jwt', {})
      if (jwt.enabled) {
        const claims = await verifyJwt(token)
        if (!claims) return null
        if (claims.sub !== undefined) return provider.retrieveById(claims.sub)
        return provider.retrieveByCredentials(claims)
      }
      return provider.retrieveByCredentials({ token })
    }

    throw new Error(`Auth guard driver [${guard.driver}] is not supported.`)
  }

  private bearerToken() {
    const header = this.request?.headers?.authorization
    const value = Array.isArray(header) ? header[0] : header
    const match = /^Bearer\s+(.+)$/i.exec(String(value ?? ''))
    return match?.[1]
  }

  private decorateUser(user: any) {
    if (!user || typeof user !== 'object') return user
    user.can ??= (ability: string, subject?: any) => Gate.allows(ability, subject, user)
    user.cannot ??= async (ability: string, subject?: any) => !(await Gate.allows(ability, subject, user))
    return user
  }

  private async hitLoginThrottle(credentials: Record<string, any>, guard: string) {
    const throttle = config<Record<string, any>>('auth.throttle', {})
    if (throttle.enabled === false) return
    const decaySeconds = Number(throttle.decaySeconds ?? 60)
    const { Cache } = await import('@lib/cache/Cache.js')
    const key = this.loginThrottleKey(credentials, guard)
    const existing = await Cache.get<{ count: number, resetAt: number }>(key)
    const resetAt = existing && existing.resetAt > Date.now() ? existing.resetAt : Date.now() + decaySeconds * 1000
    await Cache.put(key, { count: (existing?.count ?? 0) + 1, resetAt }, decaySeconds)
  }

  private async clearLoginThrottle(credentials: Record<string, any>, guard: string) {
    const { Cache } = await import('@lib/cache/Cache.js')
    await Cache.forget(this.loginThrottleKey(credentials, guard))
  }

  private loginThrottleKey(credentials: Record<string, any>, guard: string) {
    const login = credentials.email ?? credentials.username ?? credentials.login ?? 'guest'
    const ip = this.request?.ip ?? this.request?.headers?.['x-forwarded-for'] ?? 'local'
    return `auth:login:${guard}:${String(login).toLowerCase()}:${ip}`
  }

  private storeSessionUserId(guard: string, userId: string | number) {
    const driver = config<string>(`auth.guards.${guard}.driver`, guard)
    if (driver !== 'session') return
    this.request?.session?.put?.(this.sessionKey(guard), userId)
    if (guard === 'session') this.request?.session?.put?.('auth_user_id', userId)
  }

  private sessionKey(guard: string) {
    return `auth_${guard}_user_id`
  }

  private async rememberUser(user: any, guard: string) {
    if (!this.request) return false
    const configRemember = config<Record<string, any>>('auth.remember', {})
    const token = crypto.randomUUID()
    const cookieName = this.rememberCookieName(guard, configRemember)
    const payload = { userId: user.id, guard, token }
    try {
      await DB.table(configRemember.table ?? 'remember_tokens').where({ user_id: user.id, guard }).delete().catch(() => {})
      await DB.table(configRemember.table ?? 'remember_tokens').insert({
        user_id: user.id,
        guard,
        token_hash: hashToken(token),
        created_at: new Date()
      })
    } catch {}

    const responseTarget = this.reply ?? safeResponse()
    try {
      responseTarget?.cookie?.(cookieName, payload, {
        encrypted: true,
        signed: true,
        maxAge: (Number(configRemember.lifetimeDays ?? 30) * 24 * 60 * 60),
        path: '/',
        httpOnly: true,
        sameSite: 'lax'
      })
    } catch {}

    return true
  }

  private async restoreRememberedUser(guard: string) {
    const configRemember = config<Record<string, any>>('auth.remember', {})
    const cookieName = this.rememberCookieName(guard, configRemember)
    const raw = this.request?.cookies?.[cookieName] ?? this.request?.raw?.cookies?.[cookieName]
    const decoded = decodeCookie(raw, { encrypted: true, signed: true })
    if (!decoded) return null

    let payload: { userId: string | number, guard?: string, token: string } | undefined
    try {
      payload = JSON.parse(decoded)
    } catch {
      return null
    }

    if (!payload || payload.guard !== guard) return null
    const row = await this.getRememberToken(payload.userId, guard)
    if (!row) return null
    if (!await this.verifyToken(payload.token, row.token_hash)) return null

    const provider = this.provider(config<string>('auth.defaults.provider', 'users'))
    const user = await provider.retrieveById(payload.userId)
    if (user) {
      this.request.session?.put?.(this.sessionKey(guard), user.id)
      if (guard === 'session') this.request.session?.put?.('auth_user_id', user.id)
    }
    return user ? this.decorateUser(user) : null
  }

  private async clearRememberedUser() {
    const configRemember = config<Record<string, any>>('auth.remember', {})
    const defaultGuard = config<string>('auth.defaults.guard', 'session')
    const cookieName = this.rememberCookieName(defaultGuard, configRemember)
    const raw = this.request?.cookies?.[cookieName] ?? this.request?.raw?.cookies?.[cookieName]
    const decoded = decodeCookie(raw, { encrypted: true, signed: true })
    if (decoded) {
      try {
        const payload = JSON.parse(decoded) as { userId: string | number, guard?: string }
        await DB.table(configRemember.table ?? 'remember_tokens').where({ user_id: payload.userId, guard: payload.guard ?? 'session' }).delete().catch(() => {})
      } catch {}
    }
    try {
      const responseTarget = this.reply ?? safeResponse()
      responseTarget?.clearCookie?.(cookieName, { path: '/' })
    } catch {}
  }

  private passwordResetUrl(email: string, token: string) {
    return signedUrl('/reset-password', { email, token }, new Date(Date.now() + (Number(config('auth.passwords.expires', 60)) * 60 * 1000)))
  }

  private emailVerificationUrl(user: any) {
    return signedUrl('/email/verify', { id: user.id, hash: this.emailHash(user.email) }, new Date(Date.now() + (Number(config('auth.verification.expires', 60)) * 60 * 1000)))
  }

  private emailHash(email: string) {
    return crypto.createHash('sha1').update(String(email)).digest('hex')
  }

  private async storePasswordResetToken(email: string, token: string) {
    const table = config<string>('auth.passwords.table', 'password_reset_tokens')
    await DB.table(table).where({ email }).delete().catch(() => {})
    await DB.table(table).insert({
      email,
      token_hash: hashToken(token),
      created_at: new Date(),
      expires_at: new Date(Date.now() + (Number(config('auth.passwords.expires', 60)) * 60 * 1000))
    }).catch(() => {})
  }

  private async getPasswordResetToken(email: string) {
    const table = config<string>('auth.passwords.table', 'password_reset_tokens')
    return DB.table(table).where({ email }).first().catch(() => null)
  }

  private async deletePasswordResetToken(email: string) {
    const table = config<string>('auth.passwords.table', 'password_reset_tokens')
    await DB.table(table).where({ email }).delete().catch(() => {})
  }

  private async getRememberToken(userId: string | number, guard: string) {
    const table = config<string>('auth.remember.table', 'remember_tokens')
    return DB.table(table).where({ user_id: userId, guard }).first().catch(() => null)
  }

  private rememberCookieName(guard: string, rememberConfig: Record<string, any> = {}) {
    if (rememberConfig.cookie) return String(rememberConfig.cookie)
    const appName = config<string>('app.name', 'Maxima')
    const slug = String(appName)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'maxima'
    return `${slug}_remember_${guard}`
  }

  private async getVerifiedEmail(user: any) {
    const table = config<string>('auth.verification.table', 'email_verifications')
    return DB.table(table).where({ user_id: user.id }).first().catch(() => null)
  }

  private async upsertVerifiedEmail(user: any) {
    const table = config<string>('auth.verification.table', 'email_verifications')
    const record = {
      user_id: user.id,
      email: user.email,
      verified_at: new Date()
    }
    const existing = await DB.table(table).where({ user_id: user.id }).first().catch(() => null)
    if (existing) return DB.table(table).where({ user_id: user.id }).update(record).catch(() => {})
    return DB.table(table).insert(record).catch(() => {})
  }

  private async updatePassword(user: any, password: string) {
    const hashed = await this.hash(password)
    if (typeof user.update === 'function') {
      try {
        return await user.update({ password: hashed })
      } catch {}
    }
    user.password = hashed
    if (typeof user.save === 'function') {
      try {
        return await user.save()
      } catch {}
    }
    return user
  }

  private async verifyToken(token: string, hashed: string) {
    return crypto.timingSafeEqual(Buffer.from(hashToken(token)), Buffer.from(String(hashed)))
  }
}

export const Auth = new AuthManager()

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function signJwt(payload: Record<string, any>) {
  const configJwt = config<Record<string, any>>('auth.jwt', {})
  const header = { alg: 'HS256', typ: 'JWT' }
  const body = {
    iss: configJwt.issuer ?? 'maxima',
    aud: configJwt.audience ?? 'maxima',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + Number(configJwt.ttl ?? 3600),
    ...payload
  }
  const input = `${base64url(header)}.${base64url(body)}`
  const signature = crypto.createHmac('sha256', jwtSecret()).update(input).digest('base64url')
  return `${input}.${signature}`
}

async function verifyJwt(token: string) {
  const [headerPart, bodyPart, signature] = String(token).split('.')
  if (!headerPart || !bodyPart || !signature) return null
  const input = `${headerPart}.${bodyPart}`
  const expected = crypto.createHmac('sha256', jwtSecret()).update(input).digest('base64url')
  if (!timingSafeEqual(signature, expected)) return null
  try {
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'))
    const claims = JSON.parse(Buffer.from(bodyPart, 'base64url').toString('utf8'))
    if (header.alg !== 'HS256') return null
    if (claims.exp && Number(claims.exp) < Math.floor(Date.now() / 1000)) return null
    const configJwt = config<Record<string, any>>('auth.jwt', {})
    if (configJwt.issuer && claims.iss !== configJwt.issuer) return null
    if (configJwt.audience && claims.aud !== configJwt.audience) return null
    return claims
  } catch {
    return null
  }
}

function base64url(value: Record<string, any>) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function timingSafeEqual(a: string, b: string) {
  const aa = Buffer.from(a)
  const bb = Buffer.from(b)
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb)
}

function jwtSecret() {
  const configJwt = config<Record<string, any>>('auth.jwt', {})
  return String(configJwt.secret ?? config('app.key', 'maxima-secret'))
}

function safeResponse() {
  try {
    return response<any>()
  } catch {
    return undefined
  }
}
