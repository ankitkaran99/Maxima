import { Mailable, Attachment } from '@lib/mail/Mail.js'
import { storagePath } from '@lib/index.js'

export class WelcomeMail extends Mailable {
  constructor(private user) { super() }
  subject() { return 'Welcome to Maxima' }
  view() { return 'welcome' }
  data() { return { user: this.user } }
  attachments() { return [Attachment.fromPath(storagePath('docs/terms.pdf'))] }
}
