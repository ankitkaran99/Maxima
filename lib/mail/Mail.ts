import nodemailer from 'nodemailer'
import type MailMessage from 'nodemailer/lib/mailer/index.js'
import { config } from '@lib/foundation/helpers.js'
import { ViewFactory } from '@lib/view/ViewFactory.js'
import { app } from '@lib/foundation/helpers.js'
import { Storage } from '@lib/storage/Storage.js'
import { Event } from '@lib/events/Event.js'
import { Telescope, Pulse } from '@lib/observability/Observability.js'

export class Attachment {
  static fromPath(path: string) { return { path } }
  static fromData(data: string | Buffer, filename: string) { return { filename, content: data } }
  static fromStorage(path: string, disk?: string) { return new StorageAttachment(path, disk) }
}

export class StorageAttachment {
  constructor(public path: string, public disk?: string, public options: Record<string, any> = {}) {}
  as(name: string) { this.options.filename = name; return this }
  withMime(mime: string) { this.options.contentType = mime; return this }
}

export class Address {
  constructor(public address: string, public name?: string) {}
}

export class Envelope {
  constructor(public options: MailMessage.Options & { tags?: string[], metadata?: Record<string, any>, priority?: MailMessage.Options['priority'] } = {}) {}
}

export class Content {
  constructor(public options: { view?: string, markdown?: string, html?: string, text?: string, with?: Record<string, unknown>, theme?: string } = {}) {}
}

export class MailSending {
  constructor(public message: MailMessage.Options & { tags?: string[], metadata?: Record<string, any> }, public mailable?: Mailable) {}
}

export class MailSent {
  constructor(public message: MailMessage.Options & { tags?: string[], metadata?: Record<string, any> }, public mailable?: Mailable) {}
}

export class MessageSending extends MailSending {}
export class MessageSent extends MailSent {}

export class MarkdownMailMessage {
  private greetingLine?: string
  private lines: string[] = []
  private actionButton?: { text: string, url: string }
  private salutationLine?: string

  greeting(value: string) { this.greetingLine = value; return this }
  line(value: string) { this.lines.push(value); return this }
  action(text: string, url: string) { this.actionButton = { text, url }; return this }
  salutation(value: string) { this.salutationLine = value; return this }

  render() {
    const parts = [
      this.greetingLine ? `# ${this.greetingLine}` : undefined,
      ...this.lines,
      this.actionButton ? `[${this.actionButton.text}](${this.actionButton.url})` : undefined,
      this.salutationLine
    ].filter(Boolean)
    return parts.join('\n\n')
  }
}

export abstract class Mailable {
  public localeName?: string
  public recipients: Partial<Pick<MailMessage.Options, 'to' | 'cc' | 'bcc' | 'replyTo'>> = {}
  public attachmentList: Array<MailMessage.Attachment | StorageAttachment> = []
  public tagList: string[] = []
  public metadataList: Record<string, any> = {}
  public priorityValue?: MailMessage.Options['priority']

  envelope(): Envelope | undefined { return undefined }
  content(): Content | undefined { return undefined }
  subject(): string { return '' }
  view(): string | undefined { return undefined }
  markdown(): string | MarkdownMailMessage | undefined { return undefined }
  text(): string | undefined { return undefined }
  html(): string | undefined { return undefined }
  data(): Record<string, unknown> { return {} }
  attachments(): Array<MailMessage.Attachment | StorageAttachment> { return this.attachmentList }
  attach(path: string, options: Record<string, any> = {}) { this.attachmentList.push({ path, ...options }); return this }
  attachData(data: string | Buffer, filename: string, options: Record<string, any> = {}) { this.attachmentList.push({ filename, content: data, ...options }); return this }
  attachFromStorage(path: string, disk?: string, options: Record<string, any> = {}) { this.attachmentList.push(new StorageAttachment(path, disk, options)); return this }
  tag(tag: string) { this.tagList.push(tag); return this }
  metadata(key: string, value: any) { this.metadataList[key] = value; return this }
  priority(value: MailMessage.Options['priority']) { this.priorityValue = value; return this }
  locale(locale: string) { this.localeName = locale; return this }
  to(address: string | Address | Array<string | Address>) { this.recipients.to = normalizeAddresses(address); return this }
  cc(address: string | Address | Array<string | Address>) { this.recipients.cc = normalizeAddresses(address); return this }
  bcc(address: string | Address | Array<string | Address>) { this.recipients.bcc = normalizeAddresses(address); return this }
  replyTo(address: string | Address | Array<string | Address>) { this.recipients.replyTo = normalizeAddresses(address); return this }
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
  private globalTo?: string | string[]

  to(address: string | string[]) { return new PendingMail(this).to(address) }
  mailer(name: string) { return new PendingMail(this, name) }
  fake() { this.sent = []; this.queued = [] }
  restore() { this.sent = null; this.queued = null }
  alwaysTo(address: string | string[]) { this.globalTo = address; return this }
  forgetAlwaysTo() { this.globalTo = undefined; return this }
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
    const message = await this.buildMessage(mailable, options)
    Event.dispatch(new MessageSending(message, mailable))
    Event.dispatch(new MailSending(message, mailable))
    if (this.sent) {
      this.sent.push({ ...message, mailable: mailable.constructor.name })
      Telescope.record('mail', { subject: message.subject, to: message.to, mailable: mailable.constructor.name })
      Pulse.increment('mail.sent')
      Event.dispatch(new MessageSent(message, mailable))
      Event.dispatch(new MailSent(message, mailable))
      return message
    }
    const result = await this.transport(mailerName).sendMail(message)
    Telescope.record('mail', { subject: message.subject, to: message.to, mailable: mailable.constructor.name })
    Pulse.increment('mail.sent')
    Event.dispatch(new MessageSent(message, mailable))
    Event.dispatch(new MailSent(message, mailable))
    return result
  }

  async sendRaw(message: MailMessage.Options, mailerName?: string) {
    message = this.applyAlwaysTo(message)
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
      Telescope.record('mail', { subject: message.subject, to: message.to, mailable: mailable.constructor.name, queued: true })
      Pulse.increment('mail.queued')
      return { queued: true, message }
    }
    const { Queue, SendQueuedMailJob } = await import('@lib/queue/Queue.js')
    const dispatch = Queue.dispatch(new SendQueuedMailJob(message, mailerName))
    return delay ? dispatch.delay(delay) : dispatch
  }

  async render(mailable: Mailable) {
    return (await this.buildMessage(mailable)).html ?? ''
  }

  async preview(mailable: Mailable) {
    return this.render(mailable)
  }

  private transport(name = config<string>('mail.default', 'smtp')) {
    const mailer = config<any>(`mail.mailers.${name}`)
    if (mailer?.transport === 'failover') return this.failoverTransport(mailer.mailers ?? [])
    if (mailer?.transport === 'roundrobin' || mailer?.transport === 'round_robin') return this.roundRobinTransport(name, mailer.mailers ?? [])
    if (!this.transports.has(name)) {
      if (mailer.transport === 'array' || mailer.transport === 'log') this.transports.set(name, nodemailer.createTransport({ jsonTransport: true }))
      else this.transports.set(name, nodemailer.createTransport(mailer))
    }
    return this.transports.get(name)!
  }

  private async buildMessage(mailable: Mailable, options: MailMessage.Options = {}) {
    const from = config<any>('mail.from')
    const view = await app<any>(ViewFactory)
    const envelope = mailable.envelope()?.options ?? {}
    const content = mailable.content()?.options ?? {}
    const data = { ...mailable.data(), ...(content.with ?? {}) }
    const markdown = mailable.markdown() ?? content.markdown
    const html = mailable.html()
      ?? content.html
      ?? (markdown instanceof MarkdownMailMessage ? markdownToHtml(markdown.render()) : undefined)
      ?? (typeof markdown === 'string' ? await view.renderEmail(markdown, data) : undefined)
      ?? (content.view || mailable.view() ? await view.renderEmail((content.view ?? mailable.view())!, data) : undefined)
    const message = {
      from,
      subject: envelope.subject ?? mailable.subject(),
      html,
      text: content.text ?? mailable.text() ?? (markdown instanceof MarkdownMailMessage ? markdown.render() : undefined),
      attachments: await resolveAttachments(mailable.attachments()),
      priority: mailable.priorityValue ?? envelope.priority,
      ...mailable.recipients,
      ...envelope,
      ...options,
      tags: [...new Set([...(envelope as any).tags ?? [], ...mailable.tagList])],
      metadata: { ...(envelope as any).metadata ?? {}, ...mailable.metadataList },
      locale: mailable.localeName
    } as MailMessage.Options & { tags?: string[], metadata?: Record<string, any>, locale?: string }
    return this.applyAlwaysTo(message)
  }

  private async sendMessage(message: MailMessage.Options) {
    message = this.applyAlwaysTo(message)
    if (this.sent) {
      this.sent.push(message)
      return message
    }
    return this.transport().sendMail(message)
  }

  private applyAlwaysTo<T extends MailMessage.Options>(message: T): T {
    if (!this.globalTo) return message
    return { ...message, to: this.globalTo, cc: undefined, bcc: undefined }
  }

  private failoverTransport(names: string[]) {
    return {
      sendMail: async (message: MailMessage.Options) => {
        let lastError: unknown
        for (const name of names) {
          try {
            return await this.transport(name).sendMail(message)
          } catch (error) {
            lastError = error
          }
        }
        throw lastError ?? new Error('No failover mailers configured.')
      }
    } as nodemailer.Transporter
  }

  private roundRobinTransport(name: string, names: string[]) {
    const indexKey = `__${name}_round_robin_index`
    ;(this as any)[indexKey] = ((this as any)[indexKey] ?? 0) + 1
    const selected = names[((this as any)[indexKey] - 1) % names.length]
    return this.transport(selected)
  }
}

export const Mail = new MailManager()

async function resolveAttachments(attachments: Array<MailMessage.Attachment | StorageAttachment>) {
  const resolved: MailMessage.Attachment[] = []
  for (const attachment of attachments) {
    if (attachment instanceof StorageAttachment) {
      const disk = attachment.disk ? Storage.disk(attachment.disk) : Storage
      resolved.push({
        filename: attachment.options.filename ?? attachment.path.split(/[\\/]/).pop(),
        content: await disk.get(attachment.path),
        ...attachment.options
      })
    } else {
      resolved.push(attachment)
    }
  }
  return resolved
}

function normalizeAddresses(address: string | Address | Array<string | Address>) {
  const values = Array.isArray(address) ? address : [address]
  return values.map(value => value instanceof Address ? value.name ? `${value.name} <${value.address}>` : value.address : value)
}

function markdownToHtml(markdown: string) {
  return markdown
    .split(/\n{2,}/)
    .map(block => block.startsWith('# ') ? `<h1>${escapeHtml(block.slice(2))}</h1>` : `<p>${escapeHtml(block)}</p>`)
    .join('\n')
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]!))
}
