import { ServiceProvider } from '@lib/container/Container.js'
import { ViewFactory } from '@lib/view/ViewFactory.js'
import { HttpKernel } from '@lib/http/Kernel.js'
import { ExceptionHandler } from '@lib/http/ExceptionHandler.js'
import { Log } from '@lib/logging/LogManager.js'
import { Cache, CacheManager } from '@lib/cache/Cache.js'
import { Event, EventManager } from '@lib/events/Event.js'
import { Broadcast, BroadcastManager } from '@lib/broadcast/Broadcast.js'
import { SessionManager } from '@lib/session/Session.js'
import { Queue, QueueManager } from '@lib/queue/Queue.js'
import { Storage, FilesystemManager } from '@lib/storage/Storage.js'
import { Mail, MailManager } from '@lib/mail/Mail.js'
import { Notifications, NotificationManager } from '@lib/notifications/Notification.js'
import { Auth, AuthManager } from '@lib/auth/AuthManager.js'
import { Route } from '@lib/http/Route.js'
import { Validator } from '@lib/validation/Validator.js'
import { Contracts } from '@lib/contracts/Contracts.js'

export class FrameworkServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(ViewFactory, () => new ViewFactory())
    this.app.singleton(HttpKernel, () => new HttpKernel(this.app as any))
    this.app.singleton(ExceptionHandler, () => new ExceptionHandler())
    this.app.instance('logger', Log)
    this.app.instance(Contracts.Logging, Log)
    this.app.instance(Contracts.Container, this.app)
    this.app.instance('cache', Cache)
    this.app.instance(Contracts.Cache, Cache)
    this.app.instance(CacheManager, Cache)
    this.app.instance('queue', Queue)
    this.app.instance(Contracts.Queue, Queue)
    this.app.instance(QueueManager, Queue)
    this.app.instance('session', new SessionManager())
    this.app.instance('events', Event)
    this.app.instance(Contracts.Events, Event)
    this.app.instance(EventManager, Event)
    this.app.instance('broadcast', Broadcast)
    this.app.instance(BroadcastManager, Broadcast)
    this.app.instance('filesystem', Storage)
    this.app.instance(Contracts.Filesystem, Storage)
    this.app.instance(FilesystemManager, Storage)
    this.app.instance('mail', Mail)
    this.app.instance(Contracts.Mail, Mail)
    this.app.instance(MailManager, Mail)
    this.app.instance('notifications', Notifications)
    this.app.instance(Contracts.Notifications, Notifications)
    this.app.instance(NotificationManager, Notifications)
    this.app.instance('auth', Auth)
    this.app.instance(Contracts.Auth, Auth)
    this.app.instance(AuthManager, Auth)
    this.app.instance('router', Route)
    this.app.instance(Contracts.Routing, Route)
    this.app.instance('validator', Validator)
    this.app.instance(Contracts.Validation, Validator)
  }

  async boot() {
    const { setDatabaseRuleResolver } = await import('@lib/validation/schema.js')
    const { DB } = await import('@lib/database/DB.js')

    setDatabaseRuleResolver(async (type, table, column, field, data) => {
      const value = field.includes('.')
        ? field.split('.').reduce((current, segment) => current?.[segment], data)
        : data[field]
      if (value === undefined || value === null || value === '') {
        return type === 'unique'
      }
      try {
        const row = await DB.table(table).where(column, value).first()
        return type === 'exists' ? !!row : !row
      } catch (err) {
        return false
      }
    })
  }
}
