import nodemailer from 'nodemailer'
import type MailMessage from 'nodemailer/lib/mailer/index.js'
import { config } from '@lib/foundation/helpers.js'
import { ViewFactory } from '@lib/view/ViewFactory.js'
import { app } from '@lib/foundation/helpers.js'

export class Attachment {
  static fromPath(path: string) { return { path } }
}

export abstract class Mailable {
  subject(): string { return '' }
  view(): string | undefined { return undefined }
  text(): string | undefined { return undefined }
  html(): string | undefined { return undefined }
  data(): Record<string, unknown> { return {} }
  attachments(): MailMessage.Attachment[] { return [] }
}

class PendingMail {
  private message: MailMessage.Options = {}
  constructor(private manager: MailManager, private mailerName?: string) {}
  to(address: string | string[]) { this.message.to = address; return this }
  cc(address: string | string[]) { this.message.cc = address; return this }
  bcc(address: string | string[]) { this.message.bcc = address; return this }
  async send(mailable: Mailable) { return this.manager.send(mailable, this.message, this.mailerName) }
  async queue(mailable: Mailable) { return this.manager.queue(mailable, this.message, this.mailerName) }
  async later(delay: number, mailable: Mailable) { return this.manager.queue(mailable, this.message, this.mailerName, delay) }
}

export class MailManager {
  private sent: Array<MailMessage.Options & { mailable?: string }> | null = null
  private queued: Array<{ mailable: string, message: MailMessage.Options, mailer?: string, delay?: number }> | null = null
  private transports = new Map<string, nodemailer.Transporter>()

  to(address: string | string[]) { return new PendingMail(this).to(address) }
  mailer(name: string) { return new PendingMail(this, name) }
  fake() { this.sent = []; this.queued = [] }
  restore() { this.sent = null; this.queued = null }
  sentMails() { return this.sent ?? [] }
  assertSent(subject: string) { if (!this.sent?.some(mail => mail.subject === subject)) throw new Error(`Expected mail [${subject}] was not sent.`) }
  assertQueued(subject?: string) {
    if (!this.queued?.length) throw new Error('Expected mail to be queued.')
    if (subject && !this.queued.some(mail => mail.message.subject === subject)) throw new Error(`Expected mail [${subject}] was not queued.`)
  }
  assertNothingSent() { if (this.sent?.length) throw new Error('Expected no mail to be sent.') }
  async raw(text: string, options: MailMessage.Options) { return this.sendMessage({ ...options, text }) }
  async html(html: string, options: MailMessage.Options) { return this.sendMessage({ ...options, html }) }
  async text(text: string, options: MailMessage.Options) { return this.sendMessage({ ...options, text }) }

  async send(mailable: Mailable, options: MailMessage.Options = {}, mailerName?: string) {
    const from = config<any>('mail.from')
    const view = await app<any>(ViewFactory)
    const message: MailMessage.Options = {
      from,
      subject: mailable.subject(),
      html: mailable.html() ?? (mailable.view() ? await view.renderEmail(mailable.view()!, mailable.data()) : undefined),
      text: mailable.text(),
      attachments: mailable.attachments(),
      ...options
    }
    if (this.sent) {
      this.sent.push({ ...message, mailable: mailable.constructor.name })
      return message
    }
    return this.transport(mailerName).sendMail(message)
  }

  async sendRaw(message: MailMessage.Options, mailerName?: string) {
    if (this.sent) {
      this.sent.push({ ...message })
      return message
    }
    return this.transport(mailerName).sendMail(message)
  }

  async queue(mailable: Mailable, options: MailMessage.Options = {}, mailerName?: string, delay?: number) {
    const message = await this.buildMessage(mailable, options)
    if (this.queued) {
      this.queued.push({ mailable: mailable.constructor.name, message, mailer: mailerName, delay })
      return { queued: true, message }
    }
    const { Queue, SendQueuedMailJob } = await import('@lib/queue/Queue.js')
    const dispatch = Queue.dispatch(new SendQueuedMailJob(message, mailerName))
    return delay ? dispatch.delay(delay) : dispatch
  }

  private transport(name = config<string>('mail.default', 'smtp')) {
    if (!this.transports.has(name)) {
      const mailer = config<any>(`mail.mailers.${name}`)
      if (mailer.transport === 'array' || mailer.transport === 'log') this.transports.set(name, nodemailer.createTransport({ jsonTransport: true }))
      else this.transports.set(name, nodemailer.createTransport(mailer))
    }
    return this.transports.get(name)!
  }

  private async buildMessage(mailable: Mailable, options: MailMessage.Options = {}) {
    const from = config<any>('mail.from')
    const view = await app<any>(ViewFactory)
    return {
      from,
      subject: mailable.subject(),
      html: mailable.html() ?? (mailable.view() ? await view.renderEmail(mailable.view()!, mailable.data()) : undefined),
      text: mailable.text(),
      attachments: mailable.attachments(),
      ...options
    }
  }

  private async sendMessage(message: MailMessage.Options) {
    if (this.sent) {
      this.sent.push(message)
      return message
    }
    return this.transport().sendMail(message)
  }
}

export const Mail = new MailManager()
