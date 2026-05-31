import { DB } from '@lib/database/DB.js'
import { config } from '@lib/foundation/helpers.js'
import { Role } from './Models/Role.js'

export type SuperAdminCallback = (user: any) => boolean | Promise<boolean>

export class BouncerManagerClass {
  private superAdminCallback?: SuperAdminCallback

  /**
   * Define a custom super admin detection check.
   */
  isSuperAdmin(callback: SuperAdminCallback) {
    this.superAdminCallback = callback
  }

  /**
   * Assign a role to a user.
   */
  assign(roleNameOrInstance: string | Role) {
    return {
      to: async (user: any) => {
        if (!user || !user.id) return
        const role = await this.getOrCreateRole(roleNameOrInstance)
        
        const exists = await DB.table('user_roles')
          .where('user_id', user.id)
          .where('role_id', role.id)
          .first()
          
        if (!exists) {
          await DB.table('user_roles').insert({
            user_id: user.id,
            role_id: role.id
          })
        }
      }
    }
  }

  /**
   * Retract a role from a user.
   */
  retract(roleNameOrInstance: string | Role) {
    return {
      from: async (user: any) => {
        if (!user || !user.id) return
        const role = typeof roleNameOrInstance === 'string'
          ? await DB.table('roles').where('name', roleNameOrInstance).first()
          : roleNameOrInstance
          
        if (role && role.id) {
          await DB.table('user_roles')
            .where('user_id', user.id)
            .where('role_id', role.id)
            .delete()
        }
      }
    }
  }

  /**
   * Grant an ability to a user or role.
   */
  allow(userOrRoleOrName: any) {
    return {
      to: async (abilityName: string | string[], subject?: any) => {
        await this.grant(userOrRoleOrName, abilityName, subject, false, false)
      },
      toOwn: (modelClass: any) => {
        return {
          to: async (abilityName: string | string[]) => {
            await this.grant(userOrRoleOrName, abilityName, modelClass, false, true)
          }
        }
      }
    }
  }

  /**
   * Remove a granted ability from a user or role.
   */
  disallow(userOrRoleOrName: any) {
    return {
      to: async (abilityName: string | string[], subject?: any) => {
        await this.remove(userOrRoleOrName, abilityName, subject, false, false)
      },
      toOwn: (modelClass: any) => {
        return {
          to: async (abilityName: string | string[]) => {
            await this.remove(userOrRoleOrName, abilityName, modelClass, false, true)
          }
        }
      }
    }
  }

  /**
   * Forbid an ability to a user or role.
   */
  forbid(userOrRoleOrName: any) {
    return {
      to: async (abilityName: string | string[], subject?: any) => {
        await this.grant(userOrRoleOrName, abilityName, subject, true, false)
      },
      toOwn: (modelClass: any) => {
        return {
          to: async (abilityName: string | string[]) => {
            await this.grant(userOrRoleOrName, abilityName, modelClass, true, true)
          }
        }
      }
    }
  }

  /**
   * Remove a forbidden ability from a user or role.
   */
  unforbid(userOrRoleOrName: any) {
    return {
      to: async (abilityName: string | string[], subject?: any) => {
        await this.remove(userOrRoleOrName, abilityName, subject, true, false)
      },
      toOwn: (modelClass: any) => {
        return {
          to: async (abilityName: string | string[]) => {
            await this.remove(userOrRoleOrName, abilityName, modelClass, true, true)
          }
        }
      }
    }
  }

  /**
   * Check if a user has a specific ability.
   */
  async can(user: any, ability: string, subject?: any): Promise<boolean> {
    const result = await this.determine(user, ability, subject)
    return result === true
  }

  /**
   * Determine the authorization decision: true (allowed), false (forbidden), undefined (not defined in Bouncer).
   */
  async determine(user: any, abilityName: string, subject?: any): Promise<boolean | undefined> {
    if (!user || !user.id) return undefined

    // 1. Check custom super admin check
    if (this.superAdminCallback) {
      const isSuper = await this.superAdminCallback(user)
      if (isSuper) return true
    } else {
      // Default: Check if user is in 'admin' role
      const bouncerConfig = config<Record<string, any>>('bouncer', {})
      if (bouncerConfig.super_admin?.enabled ?? true) {
        const superAdminRole = bouncerConfig.super_admin?.role ?? 'admin'
        if (await this.hasRole(user, superAdminRole)) {
          return true
        }
      }
    }

    // 2. Parse subject details
    const { entity_type, entity_id } = this.parseSubject(subject)
    const isOwner = subject && typeof subject === 'object' && this.getOwnerId(subject) === user.id

    // 3. Fetch user roles
    const roleIds = (await DB.table('user_roles')
      .where('user_id', user.id)
      .select('role_id')).map(r => r.role_id)

    // 4. Query matching user abilities
    const userAbilities = await DB.table('user_abilities')
      .join('abilities', 'user_abilities.ability_id', 'abilities.id')
      .where('user_abilities.user_id', user.id)
      .where('abilities.name', abilityName)
      .where(function() {
        this.whereNull('abilities.entity_type')
        if (entity_type) {
          this.orWhere(function() {
            this.where('abilities.entity_type', entity_type)
            this.where(function() {
              this.whereNull('abilities.entity_id')
              if (entity_id) {
                this.orWhere('abilities.entity_id', entity_id)
              }
            })
          })
        }
      })
      .select('abilities.*', 'user_abilities.forbidden')

    // 5. Query matching role abilities
    let roleAbilities: any[] = []
    if (roleIds.length > 0) {
      roleAbilities = await DB.table('role_abilities')
        .join('abilities', 'role_abilities.ability_id', 'abilities.id')
        .whereIn('role_abilities.role_id', roleIds)
        .where('abilities.name', abilityName)
        .where(function() {
          this.whereNull('abilities.entity_type')
          if (entity_type) {
            this.orWhere(function() {
              this.where('abilities.entity_type', entity_type)
              this.where(function() {
                this.whereNull('abilities.entity_id')
                if (entity_id) {
                  this.orWhere('abilities.entity_id', entity_id)
                }
              })
            })
          }
        })
        .select('abilities.*', 'role_abilities.forbidden')
    }

    const matches = [
      ...userAbilities,
      ...roleAbilities
    ]

    // 6. Filter by ownership if ability requires it
    const activeMatches = matches.filter(ability => {
      if (ability.only_owned) {
        return isOwner
      }
      return true
    })

    if (activeMatches.length === 0) {
      return undefined
    }

    // Forbidden takes precedence
    const hasForbidden = activeMatches.some(a => a.forbidden === 1 || a.forbidden === true)
    if (hasForbidden) {
      return false
    }

    const hasAllowed = activeMatches.some(a => a.forbidden === 0 || a.forbidden === false)
    if (hasAllowed) {
      return true
    }

    return undefined
  }

  /**
   * Check if a user has a role.
   */
  async hasRole(user: any, roleName: string): Promise<boolean> {
    if (!user || !user.id) return false
    
    const role = await DB.table('user_roles')
      .join('roles', 'user_roles.role_id', 'roles.id')
      .where('user_roles.user_id', user.id)
      .where('roles.name', roleName)
      .first()
      
    return Boolean(role)
  }

  /**
   * Fluent role checking API.
   */
  is(user: any) {
    return {
      a: (roleName: string) => this.hasRole(user, roleName),
      an: (roleName: string) => this.hasRole(user, roleName),
      notA: async (roleName: string) => !(await this.hasRole(user, roleName)),
      notAn: async (roleName: string) => !(await this.hasRole(user, roleName))
    }
  }

  private parseSubject(subject: any): { entity_type: string | null; entity_id: string | null } {
    if (!subject) {
      return { entity_type: null, entity_id: null }
    }

    if (typeof subject === 'string') {
      return { entity_type: subject, entity_id: null }
    }

    if (typeof subject === 'function') {
      return { entity_type: subject.name, entity_id: null }
    }

    if (typeof subject === 'object' && subject !== null) {
      const entity_type = subject.constructor.name
      const entity_id = subject.id !== undefined ? String(subject.id) : null
      return { entity_type, entity_id }
    }

    return { entity_type: null, entity_id: null }
  }

  private getOwnerId(subject: any): any {
    if (typeof subject.getOwnerId === 'function') {
      return subject.getOwnerId()
    }
    return subject.user_id ?? subject.userId
  }

  private async grant(userOrRoleOrName: any, abilityName: string | string[], subject: any, forbidden: boolean, onlyOwned: boolean) {
    const abilities = Array.isArray(abilityName) ? abilityName : [abilityName]
    const { entity_type, entity_id } = this.parseSubject(subject)

    for (const name of abilities) {
      const ability = await this.getOrCreateAbility(name, entity_type, entity_id, onlyOwned)

      if (userOrRoleOrName instanceof Role) {
        await this.linkRoleAbility(userOrRoleOrName.id, ability.id, forbidden)
      } else if (typeof userOrRoleOrName === 'string') {
        const role = await this.getOrCreateRole(userOrRoleOrName)
        await this.linkRoleAbility(role.id, ability.id, forbidden)
      } else if (userOrRoleOrName && userOrRoleOrName.id) {
        await this.linkUserAbility(userOrRoleOrName.id, ability.id, forbidden)
      }
    }
  }

  private async remove(userOrRoleOrName: any, abilityName: string | string[], subject: any, forbidden: boolean, onlyOwned: boolean) {
    const abilities = Array.isArray(abilityName) ? abilityName : [abilityName]
    const { entity_type, entity_id } = this.parseSubject(subject)

    for (const name of abilities) {
      let query = DB.table('abilities').where('name', name)
      if (entity_type) {
        query = query.where('entity_type', entity_type)
      } else {
        query = query.whereNull('entity_type')
      }
      if (entity_id) {
        query = query.where('entity_id', entity_id)
      } else {
        query = query.whereNull('entity_id')
      }
      query = query.where('only_owned', onlyOwned)

      const ability = await query.first()
      if (!ability) continue

      if (userOrRoleOrName instanceof Role) {
        await DB.table('role_abilities')
          .where('role_id', userOrRoleOrName.id)
          .where('ability_id', ability.id)
          .where('forbidden', forbidden)
          .delete()
      } else if (typeof userOrRoleOrName === 'string') {
        const role = await DB.table('roles').where('name', userOrRoleOrName).first()
        if (role) {
          await DB.table('role_abilities')
            .where('role_id', role.id)
            .where('ability_id', ability.id)
            .where('forbidden', forbidden)
            .delete()
        }
      } else if (userOrRoleOrName && userOrRoleOrName.id) {
        await DB.table('user_abilities')
          .where('user_id', userOrRoleOrName.id)
          .where('ability_id', ability.id)
          .where('forbidden', forbidden)
          .delete()
      }
    }
  }

  private async linkUserAbility(userId: number | string, abilityId: number | string, forbidden: boolean) {
    const exists = await DB.table('user_abilities')
      .where('user_id', userId)
      .where('ability_id', abilityId)
      .first()

    if (exists) {
      await DB.table('user_abilities')
        .where('user_id', userId)
        .where('ability_id', abilityId)
        .update({ forbidden })
    } else {
      await DB.table('user_abilities').insert({
        user_id: userId,
        ability_id: abilityId,
        forbidden
      })
    }
  }

  private async linkRoleAbility(roleId: number | string, abilityId: number | string, forbidden: boolean) {
    const exists = await DB.table('role_abilities')
      .where('role_id', roleId)
      .where('ability_id', abilityId)
      .first()

    if (exists) {
      await DB.table('role_abilities')
        .where('role_id', roleId)
        .where('ability_id', abilityId)
        .update({ forbidden })
    } else {
      await DB.table('role_abilities').insert({
        role_id: roleId,
        ability_id: abilityId,
        forbidden
      })
    }
  }

  private async getOrCreateAbility(name: string, entity_type: string | null, entity_id: string | null, onlyOwned: boolean): Promise<any> {
    let query = DB.table('abilities').where('name', name)

    if (entity_type) {
      query = query.where('entity_type', entity_type)
    } else {
      query = query.whereNull('entity_type')
    }

    if (entity_id) {
      query = query.where('entity_id', entity_id)
    } else {
      query = query.whereNull('entity_id')
    }

    query = query.where('only_owned', onlyOwned)

    let ability = await query.first()
    if (!ability) {
      const [id] = await DB.table('abilities').insert({
        name,
        entity_type,
        entity_id,
        only_owned: onlyOwned,
        created_at: new Date(),
        updated_at: new Date()
      })
      ability = { id, name, entity_type, entity_id, only_owned: onlyOwned ? 1 : 0 }
    }
    return ability
  }

  private async getOrCreateRole(roleNameOrInstance: string | Role): Promise<any> {
    if (roleNameOrInstance instanceof Role) {
      return roleNameOrInstance
    }
    
    let role = await DB.table('roles').where('name', roleNameOrInstance).first()
    if (!role) {
      const [id] = await DB.table('roles').insert({
        name: roleNameOrInstance,
        created_at: new Date(),
        updated_at: new Date()
      })
      role = { id, name: roleNameOrInstance }
    }
    return role
  }

  reset() {
    this.superAdminCallback = undefined
  }
}

export const BouncerManager = new BouncerManagerClass()
