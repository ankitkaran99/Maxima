# Mail & Notifications

Maxima includes expressive APIs for sending emails and routing notifications across multiple channels like Mail, Database, Webhook, Slack, and real-time WebSockets.

---

## Mail

The `Mail` service is built on top of Nodemailer and configures easily with SMTP, arrays (for testing), or console log drivers.

### Configuration & Transports

Set up your mailers inside `src/config/mail.ts`:

```typescript
export default {
  default: 'smtp',

  from: {
    address: 'hello@example.com',
    name: 'Maxima Application'
  },

  mailers: {
    smtp: {
      transport: 'smtp',
      host: 'smtp.mailtrap.io',
      port: 2525,
      auth: {
        user: 'SMTP_USERNAME',
        pass: 'SMTP_PASSWORD'
      }
    },
    ses: {
      transport: 'ses', // requires AWS SDK
      apiVersion: '2010-12-01'
    },
    log: {
      transport: 'log' // prints raw mail body to system logger
    },
    array: {
      transport: 'array' // caches sent mail in memory (perfect for testing)
    },
    failover: {
      transport: 'failover',
      mailers: ['smtp', 'array']
    },
    roundrobin: {
      transport: 'roundrobin',
      mailers: ['smtp', 'array']
    }
  }
};
```

### Defining Mailables

Mailables represent a specific email message. They extend the base `Mailable` class and are stored in `src/app/Mail/`:

```typescript
import { Mailable, Attachment, Content, Envelope } from '@lib/mail/Mail.js';

export class OrderShipped extends Mailable {
  constructor(public order: { id: number; total: number }) {
    super();
  }

  envelope() {
    return new Envelope({
      subject: `Order #${this.order.id} Has Shipped`,
      tags: ['orders'],
      metadata: { order_id: this.order.id },
      priority: 'high'
    });
  }

  content() {
    return new Content({
      markdown: 'orders.shipped',
      with: { orderId: this.order.id, total: this.order.total }
    });
  }

  // Attach files to the email
  attachments() {
    return [
      Attachment.fromPath('storage/invoices/invoice-12.pdf')
    ];
  }
}
```

Mailables also support fluent `attach()`, `attachData()`, `attachFromStorage()`, `tag()`, `metadata()`, `priority()`, `locale()`, `to()`, `cc()`, `bcc()`, and `replyTo()` calls.

### Sending Mail

You can send or queue emails via the `Mail` facade:

```typescript
import { Mail } from '@lib/mail/Mail.js';
import { OrderShipped } from '../Mail/OrderShipped.js';

// Send immediately
await Mail.to('customer@example.com').send(new OrderShipped({ id: 12, total: 99.00 }));

// CC and BCC
await Mail.to('customer@example.com')
  .cc('manager@example.com')
  .bcc('audit@example.com')
  .send(new OrderShipped({ id: 12, total: 99.00 }));

// Use a specific mailer config
await Mail.mailer('ses')
  .to('customer@example.com')
  .send(new OrderShipped({ id: 12, total: 99.00 }));

Mail.alwaysTo('qa@example.com');
await Mail.to('real@example.com').send(new OrderShipped({ id: 12, total: 99.00 }));
Mail.forgetAlwaysTo();
```

Use `Mail.render(mailable)` or `Mail.preview(mailable)` to inspect rendered HTML.

### Queueing Mail

Because sending emails can block HTTP requests, you should queue them. When you call `.queue()` or `.later()`, Maxima automatically serializes the mail properties and dispatches them as a `SendQueuedMailJob` to the background queue:

```typescript
// Pushes the email to your background queue
await Mail.to('customer@example.com').queue(new OrderShipped({ id: 12, total: 99.00 }));

// Send after a delay (e.g. 5 minutes / 300,000 milliseconds)
await Mail.to('customer@example.com').later(300000, new OrderShipped({ id: 12, total: 99.00 }));
```

### Testing Mail

Mock the mailer in tests to assert messages were sent without hitting external SMTP boxes:

```typescript
import { Mail } from '@lib/mail/Mail.js';

Mail.fake();

// Run app logic...
await Mail.to('customer@example.com').send(new OrderShipped({ id: 12, total: 99.00 }));

// Assertions
Mail.assertSent('Order #12 Has Shipped');
Mail.assertQueued('Order #12 Has Shipped');
Mail.assertNothingSent();

Mail.restore();
```

---

## Notifications

Notifications are short, informational messages that notify users of events in your application.

### Creating a Notification

Notifications extend the base `Notification` class and live in `src/app/Notifications/`:

```typescript
import { MailMessage, Notification, SlackMessage, VonageMessage } from '@lib/notifications/Notification.js';

export class InvoicePaid extends Notification {
  constructor(public invoice: { id: number; amount: number }) {
    super();
  }

  // 1. Declare the active notification channels
  via(notifiable: any): string[] {
    return ['mail', 'database', 'vonage', 'webhook', 'slack', 'broadcast'];
  }

  // 2. Mail payload builder
  toMail(notifiable: any) {
    return new MailMessage()
      .subject('Invoice paid')
      .greeting('Hello')
      .line(`Invoice #${this.invoice.id} has been paid.`)
      .action('View invoice', `https://example.com/invoices/${this.invoice.id}`);
  }

  toVonage(notifiable: any) {
    return new VonageMessage(`Invoice #${this.invoice.id} paid.`);
  }

  // 3. Database table storage payload
  toDatabase(notifiable: any) {
    return {
      invoiceId: this.invoice.id,
      amount: this.invoice.amount
    };
  }

  // 4. Webhook payload builder
  toWebhook(notifiable: any) {
    return {
      url: 'https://api.external.com/webhooks',
      payload: { event: 'invoice.paid', id: this.invoice.id }
    };
  }

  // 5. Slack channel builder
  toSlack(notifiable: any) {
    return new SlackMessage('Invoice paid')
      .header('Invoice paid')
      .section(`Invoice #${this.invoice.id} for $${this.invoice.amount} has been paid.`);
  }

  // 6. Broadcast payload builder
  toBroadcast(notifiable: any) {
    return {
      invoiceId: this.invoice.id,
      amount: this.invoice.amount
    };
  }
}
```

Notifications support `locale()`, `tag()`, channel delay maps, `onConnection()`, `onQueue()`, middleware metadata, and `shouldSend(notifiable, channel)`.

### Sending Notifications

Use the `Notifications` facade to dispatch:

```typescript
import { Notifications } from '@lib/notifications/Notification.js';
import { InvoicePaid } from '../Notifications/InvoicePaid.js';

const user = { id: 1, email: 'ada@example.com', slack_webhook_url: 'https://hooks.slack.com/services/...' };

// Send notification
await Notifications.send(user, new InvoicePaid({ id: 45, amount: 250 }));

await Notifications
  .locale('fr')
  .send(user, new InvoicePaid({ id: 45, amount: 250 }));

await Notifications
  .route('mail', 'external@example.com')
  .route('slack', 'https://hooks.slack.com/services/...')
  .send(new InvoicePaid({ id: 45, amount: 250 }));
```

---

## Notification Routing & Customization

### Customized Channel Routing on the Notifiable

You can customize where a notification is routed by defining a `routeNotificationFor` method on the user/notifiable model:

```typescript
export class User extends Model {
  // Routes channels dynamically based on user record configurations
  routeNotificationFor(driver: string, notification: Notification) {
    if (driver === 'mail') return this.email;
    if (driver === 'webhook') return this.webhook_callback_url;
    if (driver === 'slack') return this.slack_channel_webhook;
    return undefined;
  }

  // Customize the real-time websocket channel name for broadcast notifications
  receivesBroadcastNotificationsOn(notification: Notification) {
    return `private-user.${this.id}`;
  }
}
```

### Database Notifications

Create the notifications table with:

```bash
maxima notification:table
```

You can also call `Schema.createNotificationsTable()` from migrations/tests.

### Slack Webhook Payloads

When notifying via `slack`, Maxima accepts plain `{ text }` payloads, strings, or `SlackMessage` Block Kit builders. Ensure the target URL returned from `routeNotificationFor('slack')` or model property `slack_webhook_url` is a valid Slack Incoming Webhook URL.

### Extending Custom Channels

Add custom notification channels (like Telegram or other provider-specific integrations) using `Notifications.extend`:

```typescript
import { Notifications } from '@lib/notifications/Notification.js';

// Extend notification channel
Notifications.extend('telegram', async (notifiable, notification: any) => {
  const payload = notification.toTelegram(notifiable);
  // Execute external provider request...
  await telegramProvider.send(payload.chatId, payload.text);
});
```

---

## Testing Notifications

Mock notifications inside tests:

```typescript
import { Notifications } from '@lib/notifications/Notification.js';

Notifications.fake();

// Run app logic...
await Notifications.send(user, new InvoicePaid({ id: 45, amount: 250 }));

// Assertions
Notifications.assertSent('InvoicePaid', user);
Notifications.assertSentTo(user, 'InvoicePaid');
Notifications.assertNotSentTo(user, 'OtherNotification');
Notifications.assertNothingSent();

Notifications.restore();
```
