# Queues & Background Jobs

Maxima features an advanced, Laravel-like queue system to run heavy compute tasks in the background asynchronously.

---

## Configuration

Configure your queues in `src/config/queue.ts`:

```typescript
export default {
  default: 'database',

  connections: {
    sync: {
      driver: 'sync'
    },
    database: {
      driver: 'database',
      table: 'jobs',
      tries: 2,
      retry_after: 60, // seconds
      poll_interval: 5 // seconds
    },
    redis: {
      // Powered by BullMQ
      driver: 'redis',
      redis: { url: 'redis://127.0.0.1:6379' }
    }
  },

  failed: {
    table: 'failed_jobs'
  }
};
```

---

## Creating Jobs

Jobs are classes that implement the `Job` interface. They must define a constructor to accept data and an `async handle()` method that performs the work:

```typescript
import { type Job } from '@lib/queue/Queue.js';
import { Mail } from '@lib/mail/Mail.js';

export class SendWelcomeEmail implements Job {
  // 1. Accepts constructor arguments
  constructor(public email: string, public name: string) {}

  // 2. Contains async execution logic
  async handle() {
    await Mail.raw(`Hello ${this.name}! Welcome aboard.`, {
      to: this.email,
      subject: 'Welcome to Maxima'
    });
  }
}
```

### Serializable Registry

Because Maxima stores jobs as text payloads in the database or Redis, it needs a way to map class name strings back to their constructor instances. You must register your job classes with the `SerializableRegistry`:

```typescript
import { SerializableRegistry } from '@lib/index.js';
import { SendWelcomeEmail } from './Jobs/SendWelcomeEmail.js';

// Register job class for serialization mapping
SerializableRegistry.register(SendWelcomeEmail);
```

---

## Dispatching Jobs

You can dispatch jobs using the `Queue` or `Bus` facade.

### Pushing to Queue

```typescript
import { Queue } from '@lib/queue/Queue.js';
import { SendWelcomeEmail } from '../Jobs/SendWelcomeEmail.js';

// Simple dispatch
await Queue.dispatch(new SendWelcomeEmail('ada@example.com', 'Ada'));

// Alternatively
await Queue.push(new SendWelcomeEmail('ada@example.com', 'Ada'));
```

### Delaying and Retrying

You can chain options on the returned job builder before pushing it to the backend:

```typescript
// Delay dispatching by 5 seconds (5000 milliseconds)
await Queue.dispatch(new SendWelcomeEmail('ada@example.com', 'Ada'))
  .delay(5000);

// Set maximum retry count for this job execution
await Queue.dispatch(new SendWelcomeEmail('ada@example.com', 'Ada'))
  .retries(5);
```

### Custom Payload Hooks

You can define hooks to append global tracking metadata or contextual parameters into all dispatched job payloads:

```typescript
// Registers a payload generator hook
const unsubscribe = Queue.createPayloadUsing(() => {
  return {
    dispatchedAt: Date.now(),
    tenantId: Context.getTenantId()
  };
});

// Remove hook
unsubscribe();
```

---

## Advanced Job Features

### Sync Dispatching (`Bus`)

If you want to execute a job immediately in the current thread/process synchronously, use the `Bus` facade:

```typescript
import { Bus } from '@lib/queue/Bus.js';

// Executes handle() sync immediately
await Bus.dispatchSync(new SendWelcomeEmail('ada@example.com', 'Ada'));

// Runs after response is sent back to user (non-blocking)
Bus.dispatchAfterResponse(() => {
  // heavy task runs async after response finishes
});
```

### Unique Jobs

To ensure only one instance of a specific job exists in the queue at any time, extend `ShouldBeUnique` or `ShouldBeUniqueUntilProcessing`:

```typescript
import { ShouldBeUnique } from '@lib/index.js';

export class UpdateMetricsReport extends ShouldBeUnique implements Job {
  constructor(public tenantId: number) {
    super();
  }

  // Returns a unique identifier key to lock
  uniqueId() {
    return `tenant:${this.tenantId}`;
  }

  async handle() {
    // metrics generation...
  }
}
```

### Encryption, Retries, and Backoff

```typescript
export class SecureJob implements Job {
  // Encrypt the job payload before storage
  encrypted = true;

  // Max exceptions before failing
  maxExceptions = 3;

  // Retries backoff seconds sequence
  backoff() {
    return [5, 10, 30]; // retry after 5s, then 10s, then 30s
  }

  // Assign tags to the job payload for categorization
  tags() {
    return ['tenant:1', 'billing'];
  }

  async handle() {
    // ...
  }
}
```

### Job Middleware

Queue middleware allows you to wrap custom behaviors around the execution of queued jobs.

```typescript
import { WithoutOverlapping, ThrottlesExceptions } from '@lib/index.js';

export class ProcessReport implements Job {
  middleware() {
    return [
      // Prevent overlapping runs for the same key; expires lock in 10 minutes
      new WithoutOverlapping('report-lock-key').expireAfter(600),

      // Throttle attempts if exception is thrown; maximum 2 fails in 60s
      new ThrottlesExceptions(2, 60).backoff(10)
    ];
  }

  async handle() {
    // ...
  }
}
```

### Handling Failures & Failed Database Schema

If a job fails all its retry attempts, the `failed` hook is called (if defined) before the job is recorded in the failed database table:

```typescript
export class FailingJob implements Job {
  async handle() {
    throw new Error('Something went wrong!');
  }

  // Executed upon final failure
  async failed(error: Error) {
    console.error(`Job failed: ${error.message}`);
  }
}
```

#### Failed Jobs Database Table Schema
Ensure your migrations create a `failed_jobs` table matching this specification:

```typescript
import { Schema } from '@lib/database/Schema.js';

await Schema.create('failed_jobs', (table) => {
  table.increments('id');
  table.string('uuid').nullable().unique();
  table.text('connection').nullable();
  table.text('queue').notNullable();
  table.string('job').nullable();
  table.text('payload').notNullable();
  table.text('exception').nullable();
  table.text('error').nullable();
  table.timestamp('failed_at').defaultTo(DB.connection().fn.now());
});
```

---

## Running Queue Workers

To process queued jobs, run the worker CLI command:

```bash
# Processes jobs on the default connection
npm run maxima -- queue:work
```

Or programmatically in TypeScript:
```typescript
import { Queue } from '@lib/queue/Queue.js';

await Queue.work('database', {
  tries: 3,
  stopWhenEmpty: true,
  sleep: 3, // sleep seconds when empty
  timeout: 60 // execution timeout in seconds
});
```

---

## Testing Queues

You can mock the Queue manager to assert jobs were pushed correctly without invoking handlers:

```typescript
import { Queue } from '@lib/queue/Queue.js';

// 1. Fake the Queue
Queue.fake();

// 2. Perform action
await Queue.dispatch(new SendWelcomeEmail('ada@example.com', 'Ada'));

// 3. Make assertions
Queue.assertPushed('SendWelcomeEmail');

// Restore original behavior
Queue.restore();
```
