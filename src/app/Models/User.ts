import { Model } from '@lib/database/Model.js'
import { Notifications, type Notification } from '@lib/notifications/Notification.js'

export class User extends Model {
  static table = 'users'
  static fillable = ['name', 'email', 'password']
  static hidden = ['password']

  posts() {
    return this.hasMany('Post', 'user_id')
  }

  notify(notification: Notification) {
    return Notifications.send(this, notification)
  }

  async can(ability: string, subject?: unknown) {
    const { Gate } = await import('@lib/auth/Gate.js')
    return Gate.forUser(this).allows(ability, subject)
  }

  hasVerifiedEmail() {
    return Boolean((this as any).email_verified_at)
  }

  markEmailAsVerified() {
    ;(this as any).email_verified_at = new Date()
    return this
  }
}
