import { AuthorizationException, Gate } from '@lib/auth/Gate.js'

export class Controller {
  async authorize(ability: string, subject?: unknown, message?: string) {
    if (message) {
      await Gate.authorize(ability, subject, undefined, message)
      return
    }
    const allowed = await Gate.allows(ability, subject)
    if (!allowed) throw new AuthorizationException(`This action is unauthorized: ${ability}`)
  }
}
