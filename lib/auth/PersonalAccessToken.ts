import { Model } from '@lib/database/Model.js'
import { SerializableModelRegistry } from '@lib/database/SerializableModelRegistry.js'

export class PersonalAccessToken extends Model {
  declare tokenable_type: string
  declare tokenable_id: number
  declare name: string
  declare token: string
  declare abilities: string[]
  declare last_used_at: Date | null
  declare expires_at: Date | string | null

  static table = 'personal_access_tokens'
  static fillable = [
    'tokenable_type',
    'tokenable_id',
    'name',
    'token',
    'abilities',
    'last_used_at',
    'expires_at'
  ]
  static casts = {
    abilities: 'json',
    last_used_at: 'date',
    expires_at: 'date'
  }

  tokenable() {
    return this.morphTo('tokenable')
  }

  cant(ability: string) {
    return !this.can(ability)
  }

  can(ability: string) {
    const abilities = (this as any).abilities || []
    if (abilities.includes('*')) return true
    return abilities.includes(ability)
  }
}

SerializableModelRegistry.register(PersonalAccessToken, 'PersonalAccessToken')
