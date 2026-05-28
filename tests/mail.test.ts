import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { Schema } from '@lib/database/Schema.js'
import { Mail, Mailable, Attachment, Address, Envelope, Content, MarkdownMailMessage } from '@lib/mail/Mail.js'
import { Notifications, Notification, AnonymousNotifiable, MailMessage, SlackMessage, VonageMessage } from '@lib/notifications/Notification.js'
import { ViewFactory } from '@lib/view/ViewFactory.js'
import { Storage } from '@lib/storage/Storage.js'
import { Event } from '@lib/events/Event.js'
import { Broadcast } from '@lib/broadcast/Broadcast.js'

// ============================================================================
// Email System Tests (from original mail.test.ts)
// ============================================================================
class WelcomeMail extends Mailable {
  constructor(private user: { name: string }, private root: string) { super() }
  subject() { return 'Welcome to Maxima' }
  view() { return 'welcome' }
  data() { return { user: this.user } }
  attachments() { return [Attachment.fromPath(path.join(this.root, 'terms.pdf'))] }
}

describe('Email System', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-mail-'))
    await fs.mkdir(path.join(root, 'resources', 'views'), { recursive: true })
    await fs.mkdir(path.join(root, 'resources', 'emails'), { recursive: true })
    await fs.writeFile(path.join(root, 'resources', 'emails', 'welcome.edge'), '<h1>Welcome {{ user.name }}</h1>')
    await fs.writeFile(path.join(root, 'terms.pdf'), 'terms')

    const app = new Application(root)
    setApplication(app)
    app.config.set('mail.default', 'array')
    app.config.set('mail.mailers.array', { transport: 'array' })
    app.config.set('mail.from', { address: 'hello@example.com', name: 'Maxima' })
    app.instance(ViewFactory, new ViewFactory(path.join(root, 'resources')))
    Mail.restore()
  })

  afterEach(async () => {
    Mail.restore()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('renders and sends mailables through the configured transport', async () => {
    const response = await Mail.mailer('array').to('ada@example.com').send(new WelcomeMail({ name: 'Ada' }, root))

    expect(response).toMatchObject({ messageId: expect.any(String) })
  })

  it('fakes sent mail and queued mailables', async () => {
    Mail.fake()

    await Mail.to('grace@example.com').send(new WelcomeMail({ name: 'Grace' }, root))
    await Mail.to('grace@example.com').queue(new WelcomeMail({ name: 'Grace' }, root))
    await Mail.to('grace@example.com').later(500, new WelcomeMail({ name: 'Grace' }, root))

    expect(() => Mail.assertSent('Welcome to Maxima')).not.toThrow()
    expect(() => Mail.assertQueued('Welcome to Maxima')).not.toThrow()
    expect(() => Mail.assertNothingSent()).toThrow()
  })

  it('supports raw, html, and text helpers', async () => {
    Mail.fake()

    await Mail.raw('plain text', { to: 'raw@example.com', subject: 'Raw' })
    await Mail.html('<p>html</p>', { to: 'html@example.com', subject: 'HTML' })
    await Mail.text('text', { to: 'text@example.com', subject: 'Text' })

    expect(() => Mail.assertSent('Raw')).not.toThrow()
    expect(() => Mail.assertSent('HTML')).not.toThrow()
    expect(() => Mail.assertSent('Text')).not.toThrow()
  })

  it('supports cc and bcc recipients', async () => {
    Mail.fake()

    await Mail.to('to@example.com').cc('cc@example.com').bcc('bcc@example.com').send(new WelcomeMail({ name: 'Grace' }, root))

    expect(() => Mail.assertSent('Welcome to Maxima')).not.toThrow()
  })
})

// ============================================================================
// Notification System Tests (from notifications.test.ts)
// ============================================================================
class InvoiceMail extends Mailable {
  subject() { return 'Invoice paid' }
  text() { return 'Invoice paid.' }
}

class InvoicePaid extends Notification {
  constructor(private invoice: { id: number, amount: number, webhookUrl: string }) { super() }
  via() { return ['mail', 'database', 'webhook', 'custom'] }
  toMail() { return new InvoiceMail() }
  toDatabase() { return { invoiceId: this.invoice.id, amount: this.invoice.amount } }
  toWebhook() { return { url: this.invoice.webhookUrl, payload: this.toDatabase() } }
}

describe('Notification System', () => {
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

  it('sends notifications through all configured channels', async () => {
    const invoice = { id: 7, amount: 1250, webhookUrl: 'https://example.com/webhook' }
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
    await Notifications.send(user, new InvoicePaid({ id: 8, amount: 500, webhookUrl: 'https://example.com/webhook' }))

    expect(() => Notifications.assertSent('InvoicePaid', user)).not.toThrow()
    expect(() => Notifications.assertNothingSent()).toThrow()
  })

  it('posts webhook payloads', async () => {
    const fetchSpy = vi.fn(global.fetch)
    global.fetch = fetchSpy as typeof fetch

    await Notifications.send({ id: 3, email: 'linus@example.com' }, new InvoicePaid({ id: 10, amount: 400, webhookUrl: 'https://example.com/hook' }))

    expect(fetchSpy).toHaveBeenCalledWith('https://example.com/hook', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    }))
  })
})

// ============================================================================
// Mail and Notification Parity (from mail-notification-parity.test.ts)
// ============================================================================
class ObjectApiMail extends Mailable {
  envelope() {
    return new Envelope({
      subject: 'Object API',
      tags: ['billing'],
      metadata: { invoice: 'A-1' },
      priority: 'high'
    })
  }

  content() {
    return new Content({ markdown: 'notice', with: { name: 'Ada' } })
  }
}

class RichNotification extends Notification {
  via() { return ['mail', 'database', 'vonage', 'slack'] }
  toMail() { return new MailMessage().subject('Notification mail').greeting('Hello').line('Paid.').action('View', 'https://example.com') }
  toDatabase() { return { ok: true } }
  toVonage() { return new VonageMessage('Paid').from('Maxima').to('+15550001') }
  toSlack() { return new SlackMessage('Paid').header('Invoice').section('*Paid*').button('View', 'https://example.com') }
}

class SkippedNotification extends RichNotification {
  shouldSend(_notifiable: any, channel: string) {
    return channel !== 'slack'
  }
}

describe('Mail and Notification Parity', () => {
  let root = ''
  let originalFetch: typeof fetch

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-mail-notification-parity-'))
    await fs.mkdir(path.join(root, 'resources', 'emails'), { recursive: true })
    await fs.writeFile(path.join(root, 'resources', 'emails', 'notice.edge'), '# Hello {{ name }}')

    const app = new Application(root)
    setApplication(app)
    app.config.set('mail.default', 'array')
    app.config.set('mail.mailers.array', { transport: 'array' })
    app.config.set('mail.mailers.failover', { transport: 'failover', mailers: ['array'] })
    app.config.set('mail.mailers.roundrobin', { transport: 'roundrobin', mailers: ['array'] })
    app.config.set('mail.from', { address: 'hello@example.com', name: 'Maxima' })
    app.config.set('filesystems.default', 'local')
    app.config.set('filesystems.disks.local', { driver: 'local', root })
    app.config.set('database.default', 'sqlite')
    app.config.set('database.connections.sqlite', {
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    app.instance(ViewFactory, new ViewFactory(path.join(root, 'resources')))

    await DB.close()
    await Schema.createNotificationsTable()
    await Storage.put('report.txt', 'report')
    Mail.fake()
    Notifications.fake()
    Event.fake()
    originalFetch = global.fetch
    global.fetch = vi.fn(async () => new Response(null, { status: 200 })) as any
  })

  afterEach(async () => {
    Mail.restore()
    Notifications.restore()
    Storage.restore()
    Event.restore()
    global.fetch = originalFetch
    await DB.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('builds object-api mailables with markdown, attachments, tags, metadata, locale, and alwaysTo', async () => {
    const mail = new ObjectApiMail()
      .to(new Address('real@example.com', 'Real User'))
      .attachData('inline', 'inline.txt', { contentType: 'text/plain' })
      .attachFromStorage('report.txt', 'local')
      .locale('fr')

    Mail.alwaysTo('sink@example.com')
    await Mail.mailer('failover').to('ignored@example.com').send(mail)
    Mail.forgetAlwaysTo()

    const sent = Mail.sentMails()[0] as any
    expect(sent.to).toBe('sink@example.com')
    expect(sent.subject).toBe('Object API')
    expect(sent.html).toContain('Ada')
    expect(sent.attachments).toHaveLength(2)
    expect(sent.tags).toEqual(['billing'])
    expect(sent.metadata).toEqual({ invoice: 'A-1' })
    expect(sent.priority).toBe('high')
    expect(sent.locale).toBe('fr')
    Event.assertDispatched('MailSent')
  })

  it('renders MarkdownMailMessage previews', async () => {
    class PreviewMail extends Mailable {
      envelope() { return new Envelope({ subject: 'Preview' }) }
      markdown() { return new MarkdownMailMessage().greeting('Welcome').line('Ready') }
    }

    await expect(Mail.preview(new PreviewMail())).resolves.toContain('Welcome')
  })

  it('sends database, Vonage, Slack Block Kit, anonymous, locale, and event notifications', async () => {
    const notifiable = new AnonymousNotifiable()
      .route('mail', 'person@example.com')
      .route('vonage', '+15550001')
      .route('slack', 'https://slack.example.com/hook')

    await Notifications.locale('de').send(notifiable, new RichNotification().tag('invoice').delay({ mail: 10 }).onQueue('mail', 'mail'))

    expect(() => Notifications.assertSent('RichNotification', notifiable)).not.toThrow()
    expect(() => Notifications.assertSentTo(notifiable, 'RichNotification')).not.toThrow()
    expect(await DB.table('notifications').first()).toMatchObject({ type: 'RichNotification' })
    expect(global.fetch).toHaveBeenCalledWith('https://slack.example.com/hook', expect.objectContaining({
      body: expect.stringContaining('"blocks"')
    }))
    Event.assertDispatched('NotificationSent')
  })

  it('honors shouldSend and negative assertions', async () => {
    const notifiable = new AnonymousNotifiable()
      .route('mail', 'person@example.com')
      .route('vonage', '+15550001')
      .route('slack', 'https://slack.example.com/hook')

    await Notifications.send(notifiable, new SkippedNotification())

    const slackCalls = (global.fetch as any).mock.calls.filter((call: any[]) => call[0] === 'https://slack.example.com/hook')
    expect(slackCalls).toHaveLength(0)
    expect(() => Notifications.assertNotSentTo(notifiable, 'OtherNotification')).not.toThrow()
  })
})

// ============================================================================
// Notification Channels & Routing (from notification-channels.test.ts)
// ============================================================================
class MockNotifiable {
  constructor(public id: number, public name: string, public email: string) {}
  
  routeNotificationFor(driver: string) {
    if (driver === 'slack') return 'https://slack.com/webhook/test'
    if (driver === 'webhook') return 'https://webhook.com/test'
    if (driver === 'mail') return 'routed@example.com'
    return null
  }

  receivesBroadcastNotificationsOn() {
    return 'private-notif-channel'
  }
}

class PartialRouteNotifiable {
  public phone = '+15550001'
  public slack_webhook_url = 'https://slack.example.com/fallback'

  constructor(public id: number, public email: string) {}

  routeNotificationFor(driver: string) {
    if (driver === 'mail') return 'routed@example.com'
    return undefined
  }

  receivesBroadcastNotificationsOn() {
    return 'private-partial-route'
  }
}

class PartialRouteNotification extends Notification {
  via() { return ['mail', 'webhook', 'vonage', 'slack'] }
  toMail() { return new TestMail() }
  toWebhook() { return { url: 'https://webhook.example.com/fallback', payload: { ok: true } } }
  toVonage() { return new VonageMessage('Fallback Vonage').from('Maxima') }
  toSlack() { return 'Fallback Slack!' }
}

class MailFallbackNotifiable {
  public slack_webhook_url = 'https://slack.example.com/fallback-mail'
  constructor(public id: number, public email: string) {}
  routeNotificationFor(driver: string) {
    if (driver === 'mail') return undefined
    return null
  }
}

class MailFallbackNotification extends Notification {
  via() { return ['mail'] }
  toMail() { return new TestMail() }
}

class TestMail extends Mailable {
  subject() { return 'Mail Subject' }
}

class TestSlackAndBroadcastNotification extends Notification {
  via(notifiable: any) {
    return ['slack', 'broadcast', 'mail', 'webhook']
  }
  toMail(notifiable: any) {
    return new TestMail()
  }
  toSlack(notifiable: any) {
    return 'Hello Slack!'
  }
  toBroadcast(notifiable: any) {
    return { info: 'broadcast data' }
  }
}

describe('Notification Channels & Routing', () => {
  beforeEach(() => {
    const app = new Application(process.cwd())
    setApplication(app)
    app.config.set('mail.default', 'log')
    Broadcast.fake()
    Mail.fake()
  })

  afterEach(() => {
    Broadcast.restore()
    Mail.restore()
    Event.restore()
    vi.restoreAllMocks()
  })

  it('routes notifications dynamically and triggers slack and broadcast channels', async () => {
    const notifiable = new MockNotifiable(1, 'Alice', 'alice@example.com')
    const notification = new TestSlackAndBroadcastNotification()

    // Intercept fetch calls for slack and webhook
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response())

    await Notifications.send(notifiable, notification)

    // 1. Mail Routing Check
    const sentMails = Mail.sentMails()
    expect(sentMails.length).toBe(1)
    expect(sentMails[0].to).toBe('routed@example.com') // Routed dynamically

    // 2. Slack and Webhook Fetch Checks
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    
    // Slack call checks
    const slackCall = fetchSpy.mock.calls.find(c => c[0] === 'https://slack.com/webhook/test')
    expect(slackCall).toBeDefined()
    expect(JSON.parse(slackCall![1]!.body as string)).toEqual({ text: 'Hello Slack!' })

    // Webhook call checks
    const webhookCall = fetchSpy.mock.calls.find(c => c[0] === 'https://webhook.com/test')
    expect(webhookCall).toBeDefined()

    // 3. Broadcast Channel Checks
    expect(Broadcast.broadcasted().length).toBe(1)
    const broadcastedPayload = Broadcast.broadcasted()[0]
    expect(broadcastedPayload.name).toBe('NotificationSent')
    expect(broadcastedPayload.channels).toBe('private-notif-channel')
    expect(broadcastedPayload.payload.data).toEqual({ info: 'broadcast data' })
  })

  it('falls back to notification and model routes when routeNotificationFor returns undefined', async () => {
    const notifiable = new PartialRouteNotifiable(2, 'partial@example.com')
    const notification = new PartialRouteNotification()

    Event.fake()

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response())

    await Notifications.send(notifiable, notification)

    expect(fetchSpy).toHaveBeenCalledWith('https://webhook.example.com/fallback', expect.objectContaining({ method: 'POST' }))
    expect(fetchSpy).toHaveBeenCalledWith('https://slack.example.com/fallback', expect.objectContaining({ method: 'POST' }))
    Event.assertDispatched('NotificationSent', event => event.channel === 'vonage' && event.response?.to === '+15550001')
  })

  it('falls back to the notifiable email when the mail route is undefined', async () => {
    const notifiable = new MailFallbackNotifiable(3, 'fallback@example.com')

    await Notifications.send(notifiable, new MailFallbackNotification())

    expect(Mail.sentMails()).toHaveLength(1)
    expect(Mail.sentMails()[0].to).toBe('fallback@example.com')
  })
})
