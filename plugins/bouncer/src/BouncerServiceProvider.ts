import { ServiceProvider } from '@lib/container/Container.js'
import { Model } from '@lib/database/Model.js'
import { BouncerManager } from './BouncerManager.js'

declare module '@lib/database/Model.js' {
  interface Model {
    isAn(roleName: string): Promise<boolean>
    isA(roleName: string): Promise<boolean>
    isNotAn(roleName: string): Promise<boolean>
    isNotA(roleName: string): Promise<boolean>
    allow(ability: string | string[], subject?: any): Promise<void>
    disallow(ability: string | string[], subject?: any): Promise<void>
    forbid(ability: string | string[], subject?: any): Promise<void>
    unforbid(ability: string | string[], subject?: any): Promise<void>
    assign(role: string): Promise<void>
    retract(role: string): Promise<void>
  }
}

export class BouncerServiceProvider extends ServiceProvider {
  register() {
    // 1. Bind to app
    this.app.singleton('bouncer', () => BouncerManager)

    // 2. Set default configuration
    const configRepo = (this.app as any).config
    if (!configRepo.has('bouncer')) {
      configRepo.set('bouncer', {
        super_admin: {
          enabled: true,
          role: 'admin'
        }
      })
    }

    // 3. Register model prototype methods
    Model.prototype.isAn = function (this: Model, roleName: string) {
      return BouncerManager.is(this).an(roleName)
    }

    Model.prototype.isA = function (this: Model, roleName: string) {
      return BouncerManager.is(this).a(roleName)
    }

    Model.prototype.isNotAn = function (this: Model, roleName: string) {
      return BouncerManager.is(this).notAn(roleName)
    }

    Model.prototype.isNotA = function (this: Model, roleName: string) {
      return BouncerManager.is(this).notA(roleName)
    }

    Model.prototype.allow = function (this: Model, ability: string | string[], subject?: any) {
      return BouncerManager.allow(this).to(ability, subject)
    }

    Model.prototype.disallow = function (this: Model, ability: string | string[], subject?: any) {
      return BouncerManager.disallow(this).to(ability, subject)
    }

    Model.prototype.forbid = function (this: Model, ability: string | string[], subject?: any) {
      return BouncerManager.forbid(this).to(ability, subject)
    }

    Model.prototype.unforbid = function (this: Model, ability: string | string[], subject?: any) {
      return BouncerManager.unforbid(this).to(ability, subject)
    }

    Model.prototype.assign = function (this: Model, role: string) {
      return BouncerManager.assign(role).to(this)
    }

    Model.prototype.retract = function (this: Model, role: string) {
      return BouncerManager.retract(role).from(this)
    }
  }

  async boot() {
    const { Gate } = await import('@lib/auth/Gate.js')
    Gate.before(async (user, ability, ...args) => {
      if (user) {
        const subject = args[0]
        const result = await BouncerManager.determine(user, ability, subject)
        if (result !== undefined) {
          return result
        }
      }
      return undefined
    })
  }
}
