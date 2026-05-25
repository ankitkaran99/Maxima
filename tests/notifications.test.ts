import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { Mail, Mailable } from '@lib/mail/Mail.js'
import { Notifications, Notification } from '@lib/notifications/Notification.js'
import { ViewFactory } from '@lib/view/ViewFactory.js'

class InvoiceMail extends Mailable {
  subject() { return 'Invoice paid' }
  text() { return 'Invoice paid.' }
}

class InvoicePaid extends Notification {
  constructor(private invoice: { id: number, amount: number, webhookUrl: string, sms: string }) { super() }
  via() { return ['mail', 'database', 'webhook', 'sms', 'custom'] }
  toMail() { return new InvoiceMail() }
  toSms() { return { to: this.invoice.sms, body: `Invoice ${this.invoice.id} paid.` } }
  toDatabase() { return { invoiceId: this.invoice.id, amount: this.invoice.amount } }
  toWebhook() { return { url: this.invoice.webhookUrl, payload: this.toDatabase() } }
}

let originalFetch: typeof fetch | undefined

beforeEach(async () => {
  const app = new Application(process.cwd())
  setApplication(app)
  app.config.set('database.default', 'sqlite')
  app.config.set('database.connections.sqlite', {
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  })
  app.config.set('mail.default', 'array')
  app.config.set('mail.mailers.array', { transport: 'array' })
  app.config.set('mail.from', { address: 'hello@example.com', name: 'Maxima' })
  app.config.set('sms.default', 'null')
  app.config.set('sms.from', 'Maxima')
  app.config.set('sms.channels.null', { driver: 'null' })
  app.instance(ViewFactory, new ViewFactory())

  Mail.restore()
  Mail.fake()
  Notifications.restore()
  Notifications.fake()

  await DB.close()
  await DB.connection().schema.createTable('notifications', table => {
    table.increments('id')
    table.integer('notifiable_id')
    table.string('type')
    table.text('data')
    table.timestamp('created_at')
  })

  originalFetch = global.fetch
  global.fetch = (async () => ({ ok: true })) as unknown as typeof fetch

  Notifications.extend('custom', async () => {})
})

afterEach(async () => {
  Notifications.restore()
  Mail.restore()
  if (originalFetch) global.fetch = originalFetch
  await DB.close()
})

describe('Notification System', () => {
  it('sends notifications through all configured channels', async () => {
    const invoice = { id: 7, amount: 1250, webhookUrl: 'https://example.com/webhook', sms: '+15550001' }
    const user = { id: 1, email: 'ada@example.com' }
    const custom = vi.fn()
    Notifications.extend('custom', async (notifiable, notification) => { custom(notifiable, notification) })

    await Notifications.send(user, new InvoicePaid(invoice))

    expect(() => Notifications.assertSent('InvoicePaid', user)).not.toThrow()
    expect(() => Mail.assertSent('Invoice paid')).not.toThrow()
    await expect(DB.table('notifications').first()).resolves.toMatchObject({
      notifiable_id: 1,
      type: 'InvoicePaid'
    })
    expect(custom).toHaveBeenCalledTimes(1)
  })

  it('tracks faked notifications and supports assertion helpers', async () => {
    const user = { id: 2, email: 'grace@example.com' }
    await Notifications.send(user, new InvoicePaid({ id: 8, amount: 500, webhookUrl: 'https://example.com/webhook', sms: '+15550002' }))

    expect(() => Notifications.assertSent('InvoicePaid', user)).not.toThrow()
    expect(() => Notifications.assertNothingSent()).toThrow()
  })

  it('supports sms placeholder channel without throwing', async () => {
    const notification = new InvoicePaid({ id: 9, amount: 250, webhookUrl: 'https://example.com/webhook', sms: '+15550003' })
    expect(notification.toSms()).toEqual({ to: '+15550003', body: 'Invoice 9 paid.' })
  })

  it('posts webhook payloads', async () => {
    const fetchSpy = vi.fn(global.fetch)
    global.fetch = fetchSpy as typeof fetch

    await Notifications.send({ id: 3, email: 'linus@example.com' }, new InvoicePaid({ id: 10, amount: 400, webhookUrl: 'https://example.com/hook', sms: '+15550004' }))

    expect(fetchSpy).toHaveBeenCalledWith('https://example.com/hook', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    }))
  })
})
