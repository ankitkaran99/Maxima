import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { Notification, Notifications } from '@lib/notifications/Notification.js'
import { Broadcast } from '@lib/broadcast/Broadcast.js'
import { Mail, Mailable } from '@lib/mail/Mail.js'

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
    // Expect the broadcast to be sent to private-notif-channel
    expect(Broadcast.broadcasted().length).toBe(1)
    const broadcastedPayload = Broadcast.broadcasted()[0]
    expect(broadcastedPayload.name).toBe('NotificationSent')
    expect(broadcastedPayload.channels).toBe('private-notif-channel')
    expect(broadcastedPayload.payload.data).toEqual({ info: 'broadcast data' })
  })
})
