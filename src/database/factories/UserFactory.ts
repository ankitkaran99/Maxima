import { Factory } from '@lib/database/Factory.js'
import { User } from '@app/Models/User.js'

export class UserFactory extends Factory<typeof User> {
  model = User
  definition() {
    return { name: 'Test User', email: `user-${Date.now()}@example.com`, password: 'secret' }
  }
}
