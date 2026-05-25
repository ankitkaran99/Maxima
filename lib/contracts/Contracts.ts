import type { Container } from '@lib/container/Container.js'
import type { CacheManager } from '@lib/cache/Cache.js'
import type { QueueManager } from '@lib/queue/Queue.js'
import type { EventManager } from '@lib/events/Event.js'
import type { FilesystemManager } from '@lib/storage/Storage.js'
import type { MailManager } from '@lib/mail/Mail.js'
import type { NotificationManager } from '@lib/notifications/Notification.js'
import type { Validator } from '@lib/validation/Validator.js'
import type { AuthManager } from '@lib/auth/AuthManager.js'
import type { Router } from '@lib/http/Route.js'
import type { LogManager } from '@lib/logging/LogManager.js'

export namespace Contracts {
  export const Container = Symbol.for('maxima.contracts.container')
  export const Cache = Symbol.for('maxima.contracts.cache')
  export const Queue = Symbol.for('maxima.contracts.queue')
  export const Events = Symbol.for('maxima.contracts.events')
  export const Filesystem = Symbol.for('maxima.contracts.filesystem')
  export const Mail = Symbol.for('maxima.contracts.mail')
  export const Notifications = Symbol.for('maxima.contracts.notifications')
  export const Validation = Symbol.for('maxima.contracts.validation')
  export const Auth = Symbol.for('maxima.contracts.auth')
  export const Routing = Symbol.for('maxima.contracts.routing')
  export const Logging = Symbol.for('maxima.contracts.logging')
}

export interface ContainerContract extends Container {}
export interface CacheContract extends CacheManager {}
export interface QueueContract extends QueueManager {}
export interface EventContract extends EventManager {}
export interface FilesystemContract extends FilesystemManager {}
export interface MailContract extends MailManager {}
export interface NotificationContract extends NotificationManager {}
export type ValidationContract = typeof Validator
export interface AuthContract extends AuthManager {}
export interface RoutingContract extends Router {}
export interface LoggingContract extends LogManager {}
