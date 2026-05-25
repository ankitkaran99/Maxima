import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { Mail, Mailable, Attachment } from '@lib/mail/Mail.js'
import { ViewFactory } from '@lib/view/ViewFactory.js'

class WelcomeMail extends Mailable {
  constructor(private user: { name: string }, private root: string) { super() }
  subject() { return 'Welcome to Maxima' }
  view() { return 'welcome' }
  data() { return { user: this.user } }
  attachments() { return [Attachment.fromPath(path.join(this.root, 'terms.pdf'))] }
}

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

describe('Email System', () => {
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
