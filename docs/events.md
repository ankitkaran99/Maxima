# Events

Maxima's event dispatcher provides a simple observer implementation, allowing you to subscribe and listen for various events that occur in your application.

---

## Defining Events

An event is simply a class that holds data related to that event. It does not need to inherit from any special base class.

```typescript
export class UserRegistered {
  // Store details to pass to listeners
  constructor(public user: { id: number; name: string; email: string }) {}
}
```

---

## Defining Listeners

Listeners receive the event instance in their `handle()` method and perform their logic.

### Standard Listeners

```typescript
import { UserRegistered } from '../Events/UserRegistered.js';

export class SendWelcomeNotification {
  async handle(event: UserRegistered) {
    console.log(`Sending welcome email to ${event.user.name}...`);
    // perform action...
  }
}
```

---

## Registering Events & Listeners

You can bind events to their listeners in your application's Service Providers:

```typescript
import { Event } from '@lib/events/Event.js';
import { UserRegistered } from '../Events/UserRegistered.js';
import { SendWelcomeNotification } from '../Listeners/SendWelcomeNotification.js';

// Bind listener to event
Event.listen(UserRegistered, SendWelcomeNotification);

// You can also bind string event names and closures:
Event.listen('user.registered', (user: any) => {
  console.log(`User logged: ${user.name}`);
});
```

---

## Queued Listeners

If a listener needs to perform a slow operation (like calling an external API or sending an email), you can queue the listener by adding `queue = true` on the listener class. Maxima will automatically dispatch it as a background job:

```typescript
import { UserRegistered } from '../Events/UserRegistered.js';

export class SendSlackAlert {
  // 1. Mark the listener to run in the background queue
  queue = true;

  // Optional: Custom connection or queue settings
  connection = 'redis';
  queueName = 'alerts';
  delay = 5000; // milliseconds
  tries = 3;

  async handle(event: UserRegistered) {
    // This executes asynchronously in the queue worker thread
    await fetch('https://slack-webhook-url', {
      method: 'POST',
      body: JSON.stringify({ text: `New user registered: ${event.user.name}` })
    });
  }
}
```

---

## Event Subscribers

Subscribers are classes that allow you to subscribe to multiple events from within the subscriber class itself. This is useful for grouping related event handlers.

### Creating a Subscriber

```typescript
import { EventManager } from '@lib/events/Event.js';
import { UserRegistered } from '../Events/UserRegistered.js';

export class UserEventSubscriber {
  async onUserRegistration(event: UserRegistered) {
    console.log(`Subscriber registered: ${event.user.email}`);
  }

  async onUserLogin(event: any) {
    console.log(`Subscriber login: ${event.user.id}`);
  }

  // Register all listeners inside the subscribe method
  subscribe(events: EventManager) {
    events.listen(UserRegistered, [UserEventSubscriber, 'onUserRegistration']);
    events.listen('user.login', [UserEventSubscriber, 'onUserLogin']);
  }
}
```

### Registering Subscribers

Register the subscriber globally:

```typescript
import { Event } from '@lib/events/Event.js';
import { UserEventSubscriber } from '../Subscribers/UserEventSubscriber.js';

Event.subscribe(UserEventSubscriber);
```

---

## Model Broadcasting / WebSocket Events

If an event class implements the `BroadcastableEvent` interface, Maxima will automatically broadcast it over WebSockets after it is dispatched:

```typescript
import { type BroadcastableEvent } from '@lib/broadcast/Broadcast.js';

export class OrderShipped implements BroadcastableEvent {
  constructor(public orderId: number) {}

  // Name of WebSocket channels to broadcast on
  broadcastOn() {
    return `orders.${this.orderId}`;
  }

  // Name of the broadcast event
  broadcastAs() {
    return 'shipped';
  }

  // Data to broadcast to client
  broadcastWith() {
    return { orderId: this.orderId, status: 'shipped' };
  }
}
```

---

## Database Transaction-Deferred Events

Sometimes you want to dispatch an event, but *only* execute its listeners after the active database transaction commits successfully. For example, if you register a user inside a transaction, you don't want to dispatch a `UserRegistered` event unless the transaction commits successfully.

To defer event listeners, configure your event class with a `shouldDispatchAfterCommit` property:

```typescript
export class UserRegistered {
  // 1. Prevent dispatching listeners until the transaction commits
  shouldDispatchAfterCommit = true;

  constructor(public user: any) {}
}
```
If you dispatch this event inside a `DB.transaction(async () => { ... })` callback, Maxima automatically holds the event until the transaction has successfully saved to the database.

---

## Testing Events

Mock events in tests to make sure they are dispatched under the correct conditions:

```typescript
import { Event } from '@lib/events/Event.js';
import { UserRegistered } from '../Events/UserRegistered.js';

// 1. Fake events
Event.fake();

// 2. Perform actions
Event.dispatch(new UserRegistered({ id: 1, name: 'Ada', email: 'ada@example.com' }));

// 3. Make assertions
Event.assertDispatched(UserRegistered);

// Callback validation
Event.assertDispatched(UserRegistered, (event) => {
  return event.user.email === 'ada@example.com';
});

Event.assertNotDispatched(SomeOtherEvent);

// Restore original dispatcher
Event.restore();
```
