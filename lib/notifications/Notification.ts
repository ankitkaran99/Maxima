import crypto from 'node:crypto'
import { Mail, Mailable } from '@lib/mail/Mail.js'
import { DB } from '@lib/database/DB.js'
import { Event } from '@lib/events/Event.js'
import { Queue, SendQueuedNotificationJob } from '@lib/queue/Queue.js'

export abstract class Notification {
  public localeName?: string
  public tagsList: string[] = []
  public delayMap: Record<string, number> = {}
  public connectionMap: Record<string, string> = {}
  public queueMap: Record<string, string> = {}
  public middlewareMap: Record<string, any[]> = {}

  via(_notifiable: any): string[] { return ['mail'] }
  toMail(_notifiable: any): Mailable | undefined { return undefined }
  toVonage?(_notifiable: any): VonageMessage | string | Record<string, any> | undefined
  toDatabase(_notifiable: any): Record<string, any> { return {} }
  toWebhook(_notifiable: any): { url: string, payload: unknown } | string | undefined { return undefined }
  toSlack?(_notifiable: any): SlackMessage | { text: string } | string | undefined
  toBroadcast?(_notifiable: any): Record<string, any> | undefined
  shouldSend(_notifiable: any, _channel: string): boolean | Promise<boolean> { return true }
  locale(locale: string) { this.localeName = locale; return this }
  tag(tag: string) { this.tagsList.push(tag); return this }
  delay(channels: number | Record<string, number>) {
    if (typeof channels === 'number') this.delayMap['*'] = channels
    else Object.assign(this.delayMap, channels)
    return this
  }
  onConnection(connection: string, channel = '*') { this.connectionMap[channel] = connection; return this }
  onQueue(queue: string, channel = '*') { this.queueMap[channel] = queue; return this }
  through(middleware: any[], channel = '*') { this.middlewareMap[channel] = middleware; return this }
}

export class MailMessage extends Mailable {
  private subjectLine = ''
  private greetingLine?: string
  private lines: string[] = []
  private actionButton?: { text: string, url: string }
  private salutationLine?: string

  override subject(): string
  subject(value: string): this
  subject(value?: string) {
    if (value === undefined) return this.subjectLine
    this.subjectLine = value
    return this
  }
  greeting(value: string) { this.greetingLine = value; return this }
  line(value: string) { this.lines.push(value); return this }
  action(text: string, url: string) { this.actionButton = { text, url }; return this }
  salutation(value: string) { this.salutationLine = value; return this }
  error() { this.tag('error'); return this }
  level(value: string) { this.tag(value); return this }
  override html() {
    const parts = [
      this.greetingLine ? `<h1>${escapeHtml(this.greetingLine)}</h1>` : '',
      ...this.lines.map(line => `<p>${escapeHtml(line)}</p>`),
      this.actionButton ? `<p><a href="${escapeHtml(this.actionButton.url)}">${escapeHtml(this.actionButton.text)}</a></p>` : '',
      this.salutationLine ? `<p>${escapeHtml(this.salutationLine)}</p>` : ''
    ]
    return parts.join('\n')
  }
  override text() {
    return [this.greetingLine, ...this.lines, this.actionButton ? `${this.actionButton.text}: ${this.actionButton.url}` : undefined, this.salutationLine].filter(Boolean).join('\n\n')
  }
}

export class VonageMessage {
  public fromValue?: string
  constructor(public content: string = '', public toValue?: string) {}
  contentText(value: string) { this.content = value; return this }
  from(value: string) { this.fromValue = value; return this }
  to(value: string) { this.toValue = value; return this }
}

export class SlackMessage {
  public blocks: any[] = []
  public attachments: any[] = []
  constructor(public text: string = '') {}
  content(value: string) { this.text = value; return this }
  header(text: string) { this.blocks.push({ type: 'header', text: { type: 'plain_text', text } }); return this }
  section(text: string) { this.blocks.push({ type: 'section', text: { type: 'mrkdwn', text } }); return this }
  context(elements: any[]) { this.blocks.push({ type: 'context', elements }); return this }
  button(text: string, url: string, actionId = 'button') {
    this.blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text }, url, action_id: actionId }] })
    return this
  }
  toPayload() {
    return {
      text: this.text,
      ...(this.blocks.length ? { blocks: this.blocks } : {}),
      ...(this.attachments.length ? { attachments: this.attachments } : {})
    }
  }
}

export class AnonymousNotifiable {
  constructor(private routes: Record<string, any> = {}) {}
  route(channel: string, route: any) { this.routes[channel] = route; return this }
  routeNotificationFor(channel: string) { return this.routes[channel] }
  notify(notification: Notification) { return Notifications.send(this, notification) }
  send(notification: Notification) { return this.notify(notification) }
}

export class NotificationSending {
  constructor(public notifiable: any, public notification: Notification, public channel: string) {}
}

export class NotificationSent extends NotificationSending {
  constructor(notifiable: any, notification: Notification, channel: string, public response?: any) { super(notifiable, notification, channel) }
}

export class NotificationFailed extends NotificationSending {
  constructor(notifiable: any, notification: Notification, channel: string, public error: unknown) { super(notifiable, notification, channel) }
}

export class NotificationManager {
  private custom = new Map<string, (notifiable: any, notification: Notification) => Promise<void>>()
  private sent: Array<{ notifiable: any, notification: Notification, channels: string[] }> | null = null

  extend(name: string, handler: (notifiable: any, notification: Notification) => Promise<void>) {
    this.custom.set(name, handler)
    return this
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

  assertSentTo(notifiable: any, type: string) {
    return this.assertSent(type, notifiable)
  }

  assertNotSentTo(notifiable: any, type: string) {
    if (this.sent?.some(entry => entry.notification.constructor.name === type && entry.notifiable === notifiable)) {
      throw new Error(`Expected notification [${type}] was sent.`)
    }
  }

  assertNothingSent() {
    if (this.sent?.length) throw new Error('Expected no notifications to be sent.')
  }

  route(channel: string, route: any) {
    return new AnonymousNotifiable().route(channel, route)
  }

  locale(locale: string) {
    return {
      send: (notifiable: any, notification: Notification) => this.send(notifiable, notification.locale(locale)),
      queue: (notifiable: any, notification: Notification, queueName?: string) => this.queue(notifiable, notification.locale(locale), queueName)
    }
  }

  async send(notifiable: any, notification: Notification) {
    const channels = notification.via(notifiable)
    if (this.sent) this.sent.push({ notifiable, notification, channels })
    for (const channel of channels) {
      if (!(await notification.shouldSend(notifiable, channel))) continue
      Event.dispatch(new NotificationSending(notifiable, notification, channel))
      try {
      let response: any
      if (channel === 'mail') {
        const mail = notification.toMail(notifiable)
        const email = this.resolveRoute(notifiable, 'mail', notification, notifiable.email)
        if (mail && email) response = await Mail.to(email).send(notification.localeName ? mail.locale(notification.localeName) : mail)
      } else if (channel === 'database') {
        response = await this.storeDatabaseNotification(notifiable, notification)
      } else if (channel === 'vonage') {
        response = this.buildVonagePayload(notifiable, notification, notification.toVonage?.(notifiable))
      } else if (channel === 'webhook') {
        const webhook = (typeof notifiable.routeNotificationFor === 'function'
          ? notifiable.routeNotificationFor('webhook', notification)
          : undefined) ?? notification.toWebhook(notifiable)
        if (webhook) {
          const url = typeof webhook === 'string' ? webhook : webhook.url
          const payload = typeof webhook === 'string' ? {} : (webhook.payload ?? webhook.data ?? {})
          response = await fetch(url, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: { 'content-type': 'application/json' }
          })
        }
      } else if (channel === 'slack') {
        const slackMessage = typeof notification.toSlack === 'function'
          ? notification.toSlack(notifiable)
          : undefined
        const slackUrl = this.resolveRoute(notifiable, 'slack', notification, notifiable.slack_webhook_url)
        if (slackMessage && slackUrl) {
          const payload = slackMessage instanceof SlackMessage ? slackMessage.toPayload() : typeof slackMessage === 'string' ? { text: slackMessage } : slackMessage
          response = await fetch(slackUrl, {
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
        response = await Broadcast.broadcast({
          broadcastOn() { return channelName },
          broadcastAs() { return 'NotificationSent' },
          broadcastWith() { return { id: crypto.randomUUID(), type: notification.constructor.name, data } }
        })
      } else if (this.custom.has(channel)) {
        response = await this.custom.get(channel)!(notifiable, notification)
      }
      Event.dispatch(new NotificationSent(notifiable, notification, channel, response))
      } catch (error) {
        Event.dispatch(new NotificationFailed(notifiable, notification, channel, error))
        throw error
      }
    }
  }

  queue(notifiable: any, notification: Notification, queueName?: string) {
    return Queue.dispatch(new SendQueuedNotificationJob(notifiable, notification), queueName)
  }

  async later(delay: number, notifiable: any, notification: Notification, queueName?: string) {
    return this.queue(notifiable, notification, queueName).delay(delay)
  }

  private buildVonagePayload(notifiable: any, notification: Notification, message: VonageMessage | string | Record<string, any> | undefined) {
    if (!message) return
    const route = this.resolveRoute(notifiable, 'vonage', notification, notifiable.phone)
    const payload = typeof message === 'string'
      ? { to: route, body: message }
      : message instanceof VonageMessage
        ? { to: message.toValue ?? route, from: message.fromValue, body: message.content }
        : { to: message.to ?? route, from: message.from, body: message.body ?? message.content }
    return payload
  }

  private resolveRoute(notifiable: any, channel: string, notification: Notification, fallback: any) {
    if (typeof notifiable.routeNotificationFor !== 'function') return fallback
    return notifiable.routeNotificationFor(channel, notification) ?? fallback
  }

  private async storeDatabaseNotification(notifiable: any, notification: Notification) {
    const table = 'notifications'
    const hasNotifiableType = await DB.connection().schema.hasColumn(table, 'notifiable_type').catch(() => false)
    const base: Record<string, any> = {
      ...(hasNotifiableType ? { id: crypto.randomUUID() } : {}),
      type: notification.constructor.name,
      notifiable_type: notifiable.constructor?.name ?? 'AnonymousNotifiable',
      notifiable_id: notifiable.id ?? null,
      data: JSON.stringify(notification.toDatabase(notifiable)),
      read_at: null,
      created_at: new Date(),
      updated_at: new Date()
    }
    const columns = await Promise.all(Object.keys(base).map(async column => [
      column,
      await DB.connection().schema.hasColumn(table, column).catch(() => true)
    ] as const))
    const row = Object.fromEntries(columns.filter(([, exists]) => exists).map(([column]) => [column, base[column]]))
    return DB.table(table).insert(row)
  }
}

export const Notifications = new NotificationManager()

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]!))
}
