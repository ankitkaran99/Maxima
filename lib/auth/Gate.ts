import { config } from '@lib/foundation/helpers.js'

type GateCallback = (user: any, ...args: any[]) => AuthorizationDecision | Promise<AuthorizationDecision>
type AuthorizationDecision = boolean | AuthorizationResponse | { allowed: boolean, message?: string, status?: number } | string | null | undefined
type PolicyConstructor = new () => Record<string, any>

export class AuthorizationException extends Error {
  constructor(message = 'This action is unauthorized.', public statusCode = 403) {
    super(message)
    this.name = 'AuthorizationException'
  }
}

export class AuthorizationResponse {
  constructor(
    public allowed: boolean,
    public message = allowed ? 'This action is authorized.' : 'This action is unauthorized.',
    public status = allowed ? 200 : 403
  ) {}

  static allow(message = 'This action is authorized.') {
    return new AuthorizationResponse(true, message, 200)
  }

  static deny(message = 'This action is unauthorized.', status = 403) {
    return new AuthorizationResponse(false, message, status)
  }

  authorize() {
    if (!this.allowed) throw new AuthorizationException(this.message, this.status)
    return true
  }
}

export class GateManager {
  private abilities = new Map<string, GateCallback>()
  private beforeHooks: GateCallback[] = []
  private afterHooks: Array<(user: any, ability: string, result: boolean, args: any[]) => void | Promise<void>> = []
  private policyCache = new Map<string, PolicyConstructor | null>()
  private fakeResult?: boolean

  define(ability: string, callback: GateCallback) { this.abilities.set(ability, callback) }
  before(callback: GateCallback) { this.beforeHooks.push(callback) }
  after(callback: (user: any, ability: string, result: boolean, args: any[]) => void | Promise<void>) { this.afterHooks.push(callback) }
  fake() { this.fakeResult = true }
  allow() { this.fakeResult = true }
  deny() { this.fakeResult = false }
  restore() { this.fakeResult = undefined }
  clear() {
    this.abilities.clear()
    this.beforeHooks = []
    this.afterHooks = []
    this.policyCache.clear()
    this.fakeResult = undefined
  }

  async allows(ability: string, subject?: any, user = currentUser()) {
    return (await this.inspect(ability, subject, user)).allowed
  }

  async denies(ability: string, subject?: any, user = currentUser()) {
    return !(await this.allows(ability, subject, user))
  }

  async authorize(ability: string, subject?: any, user = currentUser(), message?: string) {
    const decision = await this.inspect(ability, subject, user)
    if (!decision.allowed) throw new AuthorizationException(message ?? decision.message, decision.status)
    return true
  }

  allowIf(condition: boolean | ((user: any) => boolean | Promise<boolean>), message?: string) {
    return this.inline(condition, true, message)
  }

  denyIf(condition: boolean | ((user: any) => boolean | Promise<boolean>), message?: string) {
    return this.inline(condition, false, message)
  }

  policy(model: string | Function, policy: PolicyConstructor) {
    this.policyCache.set(typeof model === 'string' ? this.normalizePolicyName(model) : this.normalizePolicyName(model.name), policy)
    return this
  }

  forUser(user: any) {
    return {
      allows: (ability: string, subject?: any) => this.allows(ability, subject, user),
      denies: (ability: string, subject?: any) => this.denies(ability, subject, user),
      authorize: (ability: string, subject?: any, message?: string) => this.authorize(ability, subject, user, message),
      inspect: (ability: string, subject?: any) => this.inspect(ability, subject, user),
      allowIf: (condition: boolean | ((user: any) => boolean | Promise<boolean>), message?: string) => this.inline(condition, true, message, user),
      denyIf: (condition: boolean | ((user: any) => boolean | Promise<boolean>), message?: string) => this.inline(condition, false, message, user)
    }
  }

  async inspect(ability: string, subject?: any, user = currentUser()) {
    if (this.fakeResult !== undefined) {
      return this.fakeResult
        ? AuthorizationResponse.allow()
        : AuthorizationResponse.deny()
    }

    const args = Array.isArray(subject) ? subject : [subject].filter(Boolean)
    for (const hook of this.beforeHooks) {
      const result = await hook(user, ability, ...args)
      if (result !== undefined) return this.normalizeDecision(result)
    }

    const direct = this.abilities.get(ability)
    const decision = direct
      ? this.normalizeDecision(await direct(user, ...args))
      : await this.callPolicy(user, ability, subject)

    for (const hook of this.afterHooks) await hook(user, ability, decision.allowed, args)
    return decision
  }

  private async callPolicy(user: any, ability: string, subject: any) {
    if (!subject) return AuthorizationResponse.deny()
    const modelName = this.policyNameFor(subject)
    const Policy = await this.resolvePolicy(modelName)
    if (!Policy) return AuthorizationResponse.deny()
    const policy = new Policy()
    const handler = policy[ability]
    if (typeof handler !== 'function') return AuthorizationResponse.deny()
    return this.normalizeDecision(await handler.call(policy, user, subject))
  }

  private normalizeDecision(result: AuthorizationDecision): AuthorizationResponse {
    if (result instanceof AuthorizationResponse) return result
    if (typeof result === 'object' && result !== null && 'allowed' in result) {
      return new AuthorizationResponse(Boolean(result.allowed), result.message, result.status)
    }
    if (typeof result === 'string') {
      return AuthorizationResponse.deny(result)
    }
    return result ? AuthorizationResponse.allow() : AuthorizationResponse.deny()
  }

  private async inline(condition: boolean | ((user: any) => boolean | Promise<boolean>), shouldAllow: boolean, message?: string, user = currentUser()) {
    const passes = typeof condition === 'function' ? await condition(user) : condition
    const allowed = shouldAllow ? Boolean(passes) : !passes
    const response = allowed ? AuthorizationResponse.allow() : AuthorizationResponse.deny(message)
    response.authorize()
    return true
  }

  private policyNameFor(subject: any) {
    if (typeof subject === 'string') return this.normalizePolicyName(subject)
    return this.normalizePolicyName(subject?.constructor?.name ?? String(subject))
  }

  private normalizePolicyName(name: string) {
    return name.replace(/Policy$/, '')
  }

  private async resolvePolicy(modelName: string) {
    if (this.policyCache.has(modelName)) return this.policyCache.get(modelName)

    const policies = config<Record<string, any>>('auth.policies', {})
    const configured = policies[modelName] ?? policies[modelName.charAt(0).toUpperCase() + modelName.slice(1)] ?? policies[modelName.toLowerCase()]
    const resolved = await this.resolvePolicyConstructor(configured, modelName)
    this.policyCache.set(modelName, resolved)
    return resolved
  }

  private async resolvePolicyConstructor(candidate: any, modelName: string) {
    if (typeof candidate === 'function') return candidate as PolicyConstructor
    if (typeof candidate === 'string') {
      const imported = await import(candidate)
      return (imported.default ?? Object.values(imported).find(value => typeof value === 'function')) as PolicyConstructor | undefined
    }

    const { pathToFileURL } = await import('node:url')
    const { basePath } = await import('@lib/support/paths.js')

    const moduleNames = [
      pathToFileURL(basePath('app', 'Policies', `${modelName}Policy.js`)).href,
      pathToFileURL(basePath('app', 'Policies', `${modelName}.js`)).href,
      pathToFileURL(basePath('src', 'app', 'Policies', `${modelName}Policy.js`)).href,
      pathToFileURL(basePath('src', 'app', 'Policies', `${modelName}.js`)).href
    ]

    for (const moduleName of moduleNames) {
      try {
        const imported = await import(moduleName)
        const resolved = imported.default ?? Object.values(imported).find(value => typeof value === 'function')
        if (typeof resolved === 'function') return resolved as PolicyConstructor
      } catch (error: any) {
        if (
          error?.code !== 'ERR_MODULE_NOT_FOUND' &&
          error?.code !== 'MODULE_NOT_FOUND' &&
          !error?.message?.includes('Cannot find module') &&
          !error?.message?.includes('Failed to load url')
        ) {
          throw error
        }
      }
    }

    return null
  }
}

let currentUserResolver: () => any = () => undefined
export function setCurrentUserResolver(resolver: () => any) { currentUserResolver = resolver }
export function currentUser() { return currentUserResolver() }
export const Gate = new GateManager()
export const authorize = Gate.authorize.bind(Gate)
