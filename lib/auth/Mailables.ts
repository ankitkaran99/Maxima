import { Mailable } from '@lib/mail/Mail.js'

export class PasswordResetMail extends Mailable {
  constructor(private user: { name?: string, email: string }, private url: string) {
    super()
  }

  subject() {
    return 'Reset your password'
  }

  text() {
    return `Hello ${this.user.name ?? this.user.email}, reset your password here: ${this.url}`
  }

  html() {
    return `<p>Hello ${escapeHtml(this.user.name ?? this.user.email)},</p><p>Reset your password here:</p><p><a href="${this.url}">${this.url}</a></p>`
  }
}

export class EmailVerificationMail extends Mailable {
  constructor(private user: { name?: string, email: string }, private url: string) {
    super()
  }

  subject() {
    return 'Verify your email address'
  }

  text() {
    return `Hello ${this.user.name ?? this.user.email}, verify your email here: ${this.url}`
  }

  html() {
    return `<p>Hello ${escapeHtml(this.user.name ?? this.user.email)},</p><p>Verify your email here:</p><p><a href="${this.url}">${this.url}</a></p>`
  }
}

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
