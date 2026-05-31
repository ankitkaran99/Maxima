import type { Request } from '@lib/http/Request.js'
import { config } from '@lib/foundation/helpers.js'

export type ImpersonationCallback = (impersonator: any, impersonated: any, request?: Request) => boolean | Promise<boolean>
export type ImpersonatedCallback = (impersonated: any, request?: Request) => boolean | Promise<boolean>

export class ImpersonateManagerClass {
  private canImpersonateCallback?: ImpersonationCallback
  private canBeImpersonatedCallback?: ImpersonatedCallback

  /**
   * Define the callback to check if a user can impersonate.
   */
  canImpersonate(callback: ImpersonationCallback) {
    this.canImpersonateCallback = callback
  }

  /**
   * Define the callback to check if a user can be impersonated.
   */
  canBeImpersonated(callback: ImpersonatedCallback) {
    this.canBeImpersonatedCallback = callback
  }

  /**
   * Check if the impersonator is authorized to impersonate the target user.
   */
  async checkTake(impersonator: any, impersonated: any, request?: Request): Promise<boolean> {
    if (this.canImpersonateCallback) {
      const allowed = await this.canImpersonateCallback(impersonator, impersonated, request)
      if (!allowed) return false
    } else if (typeof impersonator.canImpersonate === 'function') {
      const allowed = await impersonator.canImpersonate(impersonated, request)
      if (!allowed) return false
    } else {
      const isAdmin = impersonator.is_admin || impersonator.isAdmin
      if (!isAdmin) return false
    }

    if (this.canBeImpersonatedCallback) {
      const allowed = await this.canBeImpersonatedCallback(impersonated, request)
      if (!allowed) return false
    } else if (typeof impersonated.canBeImpersonated === 'function') {
      const allowed = await impersonated.canBeImpersonated(request)
      if (!allowed) return false
    }

    return true
  }

  /**
   * Start impersonating.
   */
  async take(request: Request, impersonator: any, impersonated: any, guardName?: string): Promise<void> {
    const guard = guardName ?? config<string>('impersonate.guard', 'session')
    const sessionKey = config<string>('impersonate.session_key', 'impersonator_user_id')

    // Store original user ID in session as the impersonator
    request.session?.put(sessionKey, impersonator.id)

    // Store impersonated user ID as the active auth user ID
    request.session?.put(this.authSessionKey(guard), impersonated.id)
    if (guard === 'session') {
      request.session?.put('auth_user_id', impersonated.id)
    }

    // Update the request context cache
    const rawRequest = request.raw as any
    rawRequest.user = impersonated
    
    // Update Auth context if active
    const { Auth } = await import('@lib/auth/AuthManager.js')
    if ((Auth as any).request === request.raw) {
      (Auth as any).request.user = impersonated
    }
  }

  /**
   * Stop impersonating and restore the original impersonator.
   */
  async leave(request: Request, guardName?: string): Promise<void> {
    const guard = guardName ?? config<string>('impersonate.guard', 'session')
    const sessionKey = config<string>('impersonate.session_key', 'impersonator_user_id')
    const originalUserId = request.session?.get(sessionKey)

    if (originalUserId !== undefined && originalUserId !== null) {
      // Restore the original user ID as active auth user ID
      request.session?.put(this.authSessionKey(guard), originalUserId)
      if (guard === 'session') {
        request.session?.put('auth_user_id', originalUserId)
      }
    } else {
      // If no original user ID, just forget auth
      request.session?.forget(this.authSessionKey(guard))
      if (guard === 'session') {
        request.session?.forget('auth_user_id')
      }
    }

    // Forget impersonator key
    request.session?.forget(sessionKey)

    // Clear request user cache to trigger reload
    const rawRequest = request.raw as any
    rawRequest.user = null
    const { Auth } = await import('@lib/auth/AuthManager.js')
    if ((Auth as any).request === request.raw) {
      (Auth as any).request.user = null
    }
  }

  /**
   * Check if impersonation is active.
   */
  isImpersonating(request: Request): boolean {
    const sessionKey = config<string>('impersonate.session_key', 'impersonator_user_id')
    return Boolean(request.session?.has(sessionKey))
  }

  /**
   * Get the original impersonating user.
   */
  async impersonator(request: Request, guardName?: string): Promise<any | null> {
    const sessionKey = config<string>('impersonate.session_key', 'impersonator_user_id')
    const id = request.session?.get(sessionKey)
    if (id === undefined || id === null) return null

    const guard = guardName ?? config<string>('impersonate.guard', 'session')
    const { Auth } = await import('@lib/auth/AuthManager.js')
    const provider = Auth.providerForGuard(guard)
    return provider.retrieveById(id)
  }

  private authSessionKey(guard: string) {
    return `auth_${guard}_user_id`
  }

  reset() {
    this.canImpersonateCallback = undefined
    this.canBeImpersonatedCallback = undefined
  }
}

export const ImpersonateManager = new ImpersonateManagerClass()
