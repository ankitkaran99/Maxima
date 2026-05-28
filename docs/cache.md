# Cache

Maxima provides a unified API for various caching backends. Caching is key to improving application performance by storing database queries or intensive calculations in memory or fast files.

---

## Configuration

Configure cache stores in `src/config/cache.ts`:

```typescript
export default {
  default: 'memory',

  stores: {
    memory: {
      driver: 'memory',
      prefix: 'maxima_cache'
    },
    file: {
      driver: 'file',
      prefix: 'maxima_cache',
      path: 'storage/framework/cache/data'
    },
    redis: {
      driver: 'redis',
      prefix: 'maxima_cache',
      connection: 'default' // Reference from database connections
    },
    database: {
      driver: 'database',
      table: 'cache',
      prefix: 'maxima_cache'
    },
    null: {
      driver: 'null'
    },
    memo: {
      driver: 'memo',
      prefix: 'maxima_cache'
    },
    memcached: {
      driver: 'memcached',
      prefix: 'maxima_cache'
    },
    dynamodb: {
      driver: 'dynamodb',
      prefix: 'maxima_cache'
    }
  }
};
```

---

## Basic Cache Usage

Access cache drivers using the `Cache` facade:

```typescript
import { Cache } from '@lib/cache/Cache.js';

// Retrieve item
const user = await Cache.get('user:profile'); // returns undefined if missing
const fallback = await Cache.get('missing', 'default');

// Check if item exists
if (await Cache.has('user:profile')) {
  // ...
}

// Store item with TTL (in seconds)
await Cache.put('key', 'value', 300); // Expires in 5 minutes

// Store item indefinitely
await Cache.forever('key', 'value');

// Remove item
await Cache.forget('key');
const value = await Cache.pull('key');

// Clear all items in the current cache store
await Cache.flush();

// Store only if the key is missing (concurrency-safe and atomic in Redis and Database stores)
const success = await Cache.add('key', 'value', 300); // returns boolean

// Check for absence
await Cache.missing('key');
```

> [!TIP]
> The `add()` method is atomic in `database` and `redis` drivers. In the `database` store, unique constraints on the primary key are checked directly to safely return `false` without throwing constraint violations. In the `redis` store, it is built on Redis's native atomic `SET ... NX` command.


### Retrieving & Storing: The `remember` Helper

If you want to fetch an item but also store a default value if it doesn't exist, use `remember()`:

```typescript
const users = await Cache.remember('all_users', 60, async () => {
  return await DB.table('users').get();
});
```

You can also store items forever using `rememberForever()`:
```typescript
const settings = await Cache.rememberForever('site_settings', async () => {
  return await DB.table('settings').first();
});

const config = await Cache.sear('site_config', async () => {
  return await loadConfig();
});
```

### Flexible Stale-While-Revalidate

`flexible()` stores a value with a fresh window and a stale window. Maxima returns stale data during the stale window and recomputes once it has expired.

```typescript
const report = await Cache.flexible('report', [60, 300], async () => {
  return await buildReport();
});
```

### Incrementing & Decrementing Values

Modify integer values directly in the cache:

```typescript
// Increment key by 1 (or specific amount)
await Cache.increment('page_views');
await Cache.increment('downloads', 5);

// Decrement key
await Cache.decrement('credits');
```

### Batch Operations

```typescript
// Fetch multiple keys
const values = await Cache.many(['key1', 'key2']); // { key1: 'val1', key2: 'val2' }
const sameValues = await Cache.getMultiple(['key1', 'key2']);

// Store multiple keys (TTL optional)
await Cache.putMany({
  key1: 'val1',
  key2: 'val2'
}, 600);
await Cache.setMultiple(new Map([['key3', 'val3']]), 600);
```

---

## Cache Tags

Cache tags allow you to group related cache entries together and invalidate them all with a single call.

> [!NOTE]
> Cache tags are supported on tagged-compatible drivers. Use `store.supportsTags()` when code needs to branch per store. The database driver exposes the tag API through Maxima's cache facade; external databases should use the generated cache table helpers before storing tagged values.

```typescript
// Store items under tags
const tagged = Cache.tags('reports', 'annual');
await tagged.put('sales', { total: 1000 }, 3600);

// Retrieve tagged item (must specify exact matching tags context)
const salesReport = await Cache.tags('reports', 'annual').get('sales');

// Flush all items associated with one or more tags
await Cache.tags('reports').flush(); // invalidates the 'sales' key
```

---

## Atomic Cache Locks

Locks prevent concurrent execution of the same action. This is useful to avoid race conditions or double actions.

```typescript
// Acquire lock for 10 seconds
const lock = Cache.lock('generate-report', 10);

if (await lock.get()) {
  try {
    // Perform intensive task exclusively...
  } finally {
    // Release lock
    await lock.release();
  }
} else {
  // Could not acquire lock, handle error/throttle...
}

// Restore a lock in another process when you have the owner token
await Cache.restoreLock('generate-report', lock.ownerToken()).release();
```

### Maintenance Commands

```bash
maxima cache:clear
maxima cache:prune
maxima cache:table
maxima session:table
maxima session:prune
```

---

## Cache Lifecycle Events & Hooks

Maxima dispatches events when interacting with the cache, enabling you to inspect operations or monitor hits/misses:

- **`CacheHit`**: Dispatched when a key exists in cache and is returned.
- **`CacheMiss`**: Dispatched when a requested key is missing or expired.
- **`KeyWritten`**: Dispatched when a new value is stored.
- **`KeyForgotten`**: Dispatched when a key is deleted.
- **`CacheCleared`**: Dispatched when the entire cache store is flushed.

```typescript
import { Event } from '@lib/events/Event.js';
import { CacheHit, CacheMiss } from '@lib/cache/Cache.js';

// Count hits/misses
Event.listen(CacheHit, (event) => {
  console.log(`Cache HIT on key: ${event.key}`);
});

Event.listen(CacheMiss, (event) => {
  console.log(`Cache MISS on key: ${event.key}`);
});
```

### Cache Invalidation Hooks

You can monitor cache item invalidation events (expired, forgotten, or flushed) globally:

```typescript
// Subscribe to invalidation reports
const unsubscribe = Cache.onInvalidated(({ key, reason }) => {
  console.log(`Cache key [${key}] was invalidated. Reason: ${reason}`); // "expired", "forgot", "flushed"
});

// Unsubscribe
unsubscribe();
```

---

## Testing Cache

You can fake caching during testing to verify cache calls without interacting with physical storage or memory leaks:

```typescript
import { Cache } from '@lib/cache/Cache.js';

// 1. Fake the cache store
Cache.fake();

// 2. Perform operations in code
await Cache.put('reports', 'data', 60);

// 3. Make assertions
Cache.assertHas('reports');
Cache.assertHas('reports', 'data'); // asset key AND matching value
Cache.assertMissing('missing-key');
Cache.assertNothingStored(); // throws if any keys are in the cache

// Restore original cache driver
Cache.restore();
```
