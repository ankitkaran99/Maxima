# Observability And Runtime Tools

Maxima exposes small in-process equivalents for several Laravel ecosystem runtime tools. They are intentionally lightweight and useful for development, testing, and local instrumentation.

```typescript
import {
  Boost,
  Horizon,
  Homestead,
  Octane,
  Pennant,
  Pulse,
  Reverb,
  Sail,
  Scout,
  Telescope,
  Valet
} from '@lib/index.js';
```

## Telescope Timeline

`Telescope` records timestamped entries from framework components and application code.

```typescript
Telescope.record('request', { method: 'GET', url: '/health' });
Telescope.record('job', { queue: 'default', job: 'ImportUsers', failed: true });

const allEntries = Telescope.all();
const requestEntries = Telescope.all('request');

Telescope.clear();
```

Cache, database, mail, queue, request logging, and realtime broadcasting integrations also write entries to this timeline.

## Pulse Metrics

`Pulse` stores counters and timing samples.

```typescript
Pulse.increment('requests');
Pulse.increment('cache.hit', 2);
Pulse.timing('requests.duration', 12);

const snapshot = Pulse.snapshot();
Pulse.clear();
```

The snapshot returns counters and timing summaries with count, average, and max values.

## Horizon Queue Snapshot

`Horizon.snapshot()` summarizes job entries recorded in Telescope.

```typescript
const snapshot = Horizon.snapshot();
// { jobs: 3, failed: 1, queues: ["default"] }
```

## Scout Search

`Scout` provides an in-memory search index.

```typescript
Scout.import('posts', [
  { id: 1, title: 'Maxima HTTP client' },
  { id: 2, title: 'Queue workers' }
]);

const results = Scout.search('posts', 'http');
Scout.flush('posts');
Scout.flush();
```

Pass a custom key name as the third `import()` argument when records do not use `id`.

## Pennant Features

`Pennant` defines and checks feature flags.

```typescript
Pennant.define('new-dashboard', user => user?.plan === 'pro');

if (await Pennant.active('new-dashboard', currentUser)) {
  // ...
}

Pennant.forget('new-dashboard');
Pennant.forget();
```

Feature definitions may be booleans or resolver functions.

## Reverb Realtime

`Reverb` offers an in-process publish/subscribe bus.

```typescript
const unsubscribe = Reverb.subscribe('orders.1', (event, payload) => {
  console.log(event, payload);
});

Reverb.publish('orders.1', 'updated', { id: 1 });
unsubscribe();
```

Publishing also records a `realtime` entry in Telescope.

## Boost Tools

`Boost` registers named tools and invokes them by name.

```typescript
Boost.tool('echo', input => ({ input }));

const result = await Boost.call('echo', { ok: true });
```

Calling an unregistered tool throws an error.

## Local Runtime Managers

`Octane`, `Sail`, `Valet`, and `Homestead` expose local state managers:

```typescript
await Octane.start();
await Octane.reload();
Octane.status();

Sail.up();
Sail.down();
Sail.status();

Valet.link('maxima', process.cwd());
Valet.park(process.cwd());
Valet.sites();

Homestead.provision('local', { node: true });
Homestead.list();
```

## CLI Commands

The CLI includes matching observability/runtime commands:

```bash
npm run maxima -- horizon:status
npm run maxima -- pulse:show
npm run maxima -- telescope:clear
npm run maxima -- sail:up
npm run maxima -- sail:down
npm run maxima -- valet:link maxima
npm run maxima -- homestead:provision local
```
