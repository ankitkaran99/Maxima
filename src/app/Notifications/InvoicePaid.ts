import { Notification } from '@lib/notifications/Notification.js'

export class InvoicePaid extends Notification {
  constructor(private invoice) { super() }
  via() { return ['database', 'webhook'] }
  toDatabase() { return { invoiceId: this.invoice.id, amount: this.invoice.amount } }
  toWebhook() { return { url: this.invoice.webhookUrl, payload: this.toDatabase() } }
}
