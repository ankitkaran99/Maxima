# Broadcasting & WebSockets

Maxima features a built-in WebSocket server and a real-time event broadcasting system. It allows you to share server-side events with client-side applications in real-time over persistent WebSocket connections.

---

## Installation

Scaffold the default broadcasting config and channel routes:

```bash
maxima install:broadcasting
```

This creates `config/broadcasting.ts` and `routes/channels.ts`. Channel route files are loaded with the normal route bootstrap.

---

## Defining Broadcastable Events

To indicate that an event should be broadcasted over WebSockets, implement the `BroadcastableEvent` interface on your Event class:

```typescript
import { PrivateChannel, type BroadcastableEvent } from '@lib/broadcast/Broadcast.js';

export class OrderShipped implements BroadcastableEvent {
  constructor(public order: { id: number; status: string }) {}

  // 1. Specify which channels to broadcast this event on
  broadcastOn() {
    return ['public-channel', new PrivateChannel(`user.${this.order.userId}`)];
  }

  // 2. Specify the name under which the event is broadcasted
  broadcastAs() {
    return 'OrderShippedEvent';
  }

  // 3. Define the payload data sent to subscribers
  broadcastWith() {
    return {
      orderId: this.order.id,
      status: this.order.status
    };
  }

  broadcastConnection() {
    return 'local';
  }

  broadcastQueue() {
    return 'broadcasts';
  }
}
```

When you dispatch this event using `Event.dispatch()`, Maxima automatically forwards the broadcast payload to matching WebSocket subscribers:

```typescript
import { Event } from '@lib/events/Event.js';
import { OrderShipped } from '../Events/OrderShipped.js';

// Dispatches internally to listeners AND broadcasts over websockets
await Event.dispatch(new OrderShipped(order));
```

Use `Broadcast.event(event).toOthers().dispatch()` when you need Laravel-style `toOthers()` socket exclusion. `Channel`, `PrivateChannel`, `PresenceChannel`, and `EncryptedPrivateChannel` objects are supported.

Events may implement `broadcastWhen()` to skip broadcasts conditionally. If an event exposes `shouldQueue = true`, Maxima dispatches the broadcast through the queue unless `shouldBroadcastNow` or `broadcastNow` is set.

---

## Defining Channels & Authorization

By default, any client can subscribe to public channels. Private channels require authentication checking.

### Registering Channel Authorizers

Define authorization logic in `routes/channels.ts` using `Broadcast.channel()`:

```typescript
import { Broadcast } from '@lib/broadcast/Broadcast.js';

// 1. Private Channel with parameter placeholders
Broadcast.channel('private-user.{id}', (user, id) => {
  // Return boolean to authorize subscription
  return user && user.id === Number(id);
});

// 2. Presence Channel
Broadcast.channel('presence-room.{roomId}', (user, roomId) => {
  // Ensure user exists and has permission
  return Boolean(user && user.hasRoomAccess(roomId));
});
```

### Checking Authorization Programmatically

```typescript
const allowed = await Broadcast.authorize(user, 'private-user.15'); // returns boolean
```

The HTTP authorization endpoint is available at `POST /broadcasting/auth` and returns Pusher/Reverb-compatible `{ auth, channel_data? }` responses. Configure endpoint middleware in `broadcasting.middleware`.

---

## Presence Channels

Presence channels build on the security of private channels while exposing who is currently active in the channel.

```typescript
import { Broadcast } from '@lib/broadcast/Broadcast.js';

// Join a presence channel
Broadcast.joinPresence('presence-room.1', { id: 10, name: 'Ada' });

// Get all active members inside a presence channel
const members = Broadcast.members('presence-room.1'); // [{ id: 10, name: 'Ada' }]

// Leave a presence channel
Broadcast.leavePresence('presence-room.1', { id: 10 });
```

---

## WebSocket Client Subscription Protocol

Maxima runs WebSocket endpoints at `/ws`, `/broadcasting`, and Pusher/Reverb-style `/app/{key}`. Clients may use Maxima's simple protocol or Pusher-style events.

### 1. Connecting
```javascript
const socket = new WebSocket('ws://localhost:3000/ws');
const pusherCompatible = new WebSocket('ws://localhost:3000/app/my-key');
```

### 2. Subscribing to Public Channels
```javascript
socket.send(JSON.stringify({
  event: 'subscribe',
  channel: 'public-channel'
}));

socket.send(JSON.stringify({
  event: 'pusher:subscribe',
  data: { channel: 'public-channel' }
}));
```

### 3. Subscribing to Private/Presence Channels
To subscribe to private channels, the client must send an `auth` field containing stringified user credential data:

```javascript
socket.send(JSON.stringify({
  event: 'subscribe',
  channel: 'private-user.42',
  auth: JSON.stringify({ id: 42 }) // matches private-user.{id} authorizer requirements
}));
```

Pusher-style private and presence subscriptions may send `data.auth` and `data.channel_data`. Client events beginning with `client-` are forwarded to other subscribers on the same channel.

### 4. Receiving Messages
The client receives a `subscription_succeeded` message confirmation, followed by any broadcasted events:

```javascript
socket.onmessage = (message) => {
  const data = JSON.parse(message.data);

  if (data.event === 'subscription_succeeded') {
    console.log(`Subscribed to ${data.channel}`);
  }

  // Handle custom broadcasted event
  if (data.event === 'OrderShippedEvent') {
    console.log(`Order status: ${data.data.status}`); // "shipped"
  }
};
```

---

## Model Broadcasting

Set `static broadcastsEvents = true` on a model to broadcast created, updated, and deleted lifecycle events. By default Maxima broadcasts to `private-{Model}.{id}` and sends the model JSON payload:

```typescript
export class Post extends Model {
  static broadcastsEvents = true;
}
```

Override `broadcastOn(event)` on the model when you need custom channels.

---

## Broadcaster Drivers

`config/broadcasting.ts` supports `local`, `pusher`, `reverb`, `log`, and `null` connection names. You may add custom drivers with:

```typescript
Broadcast.extend('custom', async payload => {
  await sendSomewhere(payload);
});
```
