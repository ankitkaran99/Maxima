import crypto from 'node:crypto'
import { Mail, type Mailable } from '@lib/mail/Mail.js'
import { DB } from '@lib/database/DB.js'

export abstract class Notification {
  via(_notifiable: any): string[] { return ['mail'] }
  toMail(_notifiable: any): Mailable | undefined { return undefined }
  toDatabase(_notifiable: any): Record<string, any> { return {} }
  toWebhook(_notifiable: any): { url: string, payload: unknown } | string | undefined { return undefined }
  toSlack?(_notifiable: any): { text: string } | string | undefined
  toBroadcast?(_notifiable: any): Record<string, any> | undefined
}

export class NotificationManager {
  private custom = new Map<string, (notifiable: any, notification: Notification) => Promise<void>>()
  private sent: Array<{ notifiable: any, notification: Notification, channels: string[] }> | null = null

  extend(name: string, handler: (notifiable: any, notification: Notification) => Promise<void>) {
    this.custom.set(name, handler)
  }

  fake() {
    this.sent = []
  }

  restore() {
    this.sent = null
  }

  assertSent(type: string, notifiable?: any) {
    if (!this.sent?.some(entry => entry.notification.constructor.name === type && (notifiable === undefined || entry.notifiable === notifiable))) {
      throw new Error(`Expected notification [${type}] was not sent.`)
    }
  }

  assertNothingSent() {
    if (this.sent?.length) throw new Error('Expected no notifications to be sent.')
  }

  async send(notifiable: any, notification: Notification) {
    const channels = notification.via(notifiable)
    if (this.sent) this.sent.push({ notifiable, notification, channels })
    for (const channel of channels) {
      if (channel === 'mail') {
        const mail = notification.toMail(notifiable)
        const email = typeof notifiable.routeNotificationFor === 'function'
          ? notifiable.routeNotificationFor('mail', notification)
          : notifiable.email
        if (mail && email) await Mail.to(email).send(mail)
      } else if (channel === 'database') {
        await DB.table('notifications').insert({
          notifiable_id: notifiable.id,
          type: notification.constructor.name,
          data: JSON.stringify(notification.toDatabase(notifiable)),
          created_at: new Date()
        })
      } else if (channel === 'webhook') {
        const webhook = typeof notifiable.routeNotificationFor === 'function'
          ? notifiable.routeNotificationFor('webhook', notification)
          : notification.toWebhook(notifiable)
        if (webhook) {
          const url = typeof webhook === 'string' ? webhook : webhook.url
          const payload = typeof webhook === 'string' ? {} : (webhook.payload ?? webhook.data ?? {})
          await fetch(url, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: { 'content-type': 'application/json' }
          })
        }
      } else if (channel === 'slack') {
        const slackMessage = typeof notification.toSlack === 'function'
          ? notification.toSlack(notifiable)
          : undefined
        const slackUrl = typeof notifiable.routeNotificationFor === 'function'
          ? notifiable.routeNotificationFor('slack', notification)
          : notifiable.slack_webhook_url
        if (slackMessage && slackUrl) {
          const payload = typeof slackMessage === 'string' ? { text: slackMessage } : slackMessage
          await fetch(slackUrl, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: { 'content-type': 'application/json' }
          })
        }
      } else if (channel === 'broadcast') {
        const data = typeof notification.toBroadcast === 'function'
          ? notification.toBroadcast(notifiable)
          : notification.toDatabase(notifiable)
        const channelName = typeof notifiable.receivesBroadcastNotificationsOn === 'function'
          ? notifiable.receivesBroadcastNotificationsOn(notification)
          : `private-${notifiable.constructor.name}.${notifiable.id}`
        
        const { Broadcast } = await import('@lib/broadcast/Broadcast.js')
        await Broadcast.broadcast({
          broadcastOn() { return channelName },
          broadcastAs() { return 'NotificationSent' },
          broadcastWith() { return { id: crypto.randomUUID(), type: notification.constructor.name, data } }
        })
      } else if (this.custom.has(channel)) {
        await this.custom.get(channel)!(notifiable, notification)
      }
    }
  }

  async queue(notifiable: any, notification: Notification, queueName?: string) {
    const { Queue, SendQueuedNotificationJob } = await import('@lib/queue/Queue.js')
    return Queue.dispatch(new SendQueuedNotificationJob(notifiable, notification), queueName)
  }

  async later(delay: number, notifiable: any, notification: Notification, queueName?: string) {
    return (await this.queue(notifiable, notification, queueName)).delay(delay)
  }
}

export const Notifications = new NotificationManager()
