import { Model } from '@lib/database/Model.js'
import { PersonalAccessToken } from '@lib/auth/PersonalAccessToken.js'
import crypto from 'node:crypto'

export class HasApiTokens extends Model {
  declare id: string | number
  public _accessToken: any = null

  get accessToken() {
    return this._accessToken
  }

  withAccessToken(token: any) {
    this._accessToken = token
    return this
  }

  tokenCan(ability: string) {
    if (!this._accessToken) return true
    return this._accessToken.can(ability)
  }

  tokens() {
    return this.morphMany(PersonalAccessToken, 'tokenable')
  }

  async createToken(name: string, abilities: string[] = ['*'], expiresAt?: Date): Promise<{ accessToken: PersonalAccessToken, plainTextToken: string }> {
    const plainTextToken = crypto.randomBytes(40).toString('hex')
    const hashedToken = crypto.createHash('sha256').update(plainTextToken).digest('hex')

    const token = await PersonalAccessToken.create({
      tokenable_type: this.constructor.name,
      tokenable_id: (this as any).id,
      name,
      token: hashedToken,
      abilities,
      expires_at: expiresAt
    })

    return {
      accessToken: token,
      plainTextToken: plainTextToken
    }
  }
}
