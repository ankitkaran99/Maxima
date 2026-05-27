# Task Scheduling

Maxima includes an Eloquent-like Task Scheduler that allows you to define command execution schedules directly inside your application code.

---

## Defining Schedules

Schedules are defined in your application's bootstrap phase or within the Scheduler config files. You can schedule CLI commands, background jobs, or custom closures/callbacks.

### Scheduling Closures

```typescript
import { Schedule } from '@lib/scheduler/Schedule.js';

// Schedule a custom callback function
Schedule.call('cleanup-logs', async () => {
  await DB.table('logs').where('created_at', '<', new Date(Date.now() - 30 * 86400000)).delete();
})
.daily();
```

### Scheduling Queued Jobs

You can dispatch a background job on a schedule:

```typescript
import { Schedule } from '@lib/scheduler/Schedule.js';
import { SyncExternalInventory } from '../Jobs/SyncExternalInventory.js';

Schedule.job(new SyncExternalInventory())
  .hourly();
```

### Scheduling CLI Commands

You can run framework Artisan commands:

```typescript
import { Schedule } from '@lib/scheduler/Schedule.js';

Schedule.command('cache:prune')
  .dailyAt('02:00');
```

---

## Schedule Frequency Options

You can combine cron triggers with frequency helpers:

| Method | Interval |
| --- | --- |
| `.everyMinute()` | Run every minute |
| `.everyFiveMinutes()` | Run every 5 minutes |
| `.hourly()` | Run every hour |
| `.twiceDaily(1, 13)` | Run twice daily at 1:00 & 13:00 |
| `.daily()` | Run daily at midnight |
| `.dailyAt('13:30')` | Run daily at 13:30 |
| `.weekdays()` | Run on weekdays (Mon-Fri) |
| `.weekends()` | Run on weekends (Sat-Sun) |
| `.weekly()` | Run weekly on Sunday |
| `.monthly()` | Run monthly on the 1st |
| `.cron('* * * * *')` | Custom raw cron expression |

---

## Advanced Task Configuration

### Timezones

Ensure scheduled tasks run in the correct timezone context:

```typescript
Schedule.call('generate-sales', () => { /* ... */ })
  .daily()
  .timezone('America/New_York');
```

### Preventing Overlaps (`withoutOverlapping`)

By default, scheduled tasks can overlap if the previous run has not completed. You can prevent this using the `withoutOverlapping` method, which utilizes the application's Cache store to set a mutex lock:

```typescript
Schedule.call('slow-processing', () => { /* ... */ })
  .everyFiveMinutes()
  .withoutOverlapping(60); // Expires lock after 60 minutes in case of crashes
```

### Running on One Server

If your application runs across multiple servers, you can limit a task to executing on only a single server per interval using `onOneServer()`:

```typescript
Schedule.command('billing:process')
  .daily()
  .onOneServer();
```

### Environment Checks

Only execute tasks inside specified application environments:

```typescript
Schedule.call('staging-cleanup', () => { /* ... */ })
  .daily()
  .environments('staging', 'local');
```

### Execution Conditions (`when` & `skip`)

Add dynamic checks to determine if the task should execute:

```typescript
Schedule.call('send-digest', () => { /* ... */ })
  .daily()
  .when(async () => {
    // Only run if feature flag is active
    return await FeatureFlag.isActive('digest');
  })
  .skip(async () => {
    // Skip if database is locked/under maintenance
    return await DB.table('settings').where('key', 'maintenance').first() !== null;
  });
```

### Task Outputs & Logs

Redirect or append the stdout output of a task to a log file:

```typescript
Schedule.command('analytics:calculate')
  .daily()
  .sendOutputTo('storage/logs/analytics.log') // Overwrites file
  .appendOutputTo('storage/logs/analytics-history.log'); // Appends to file
```

### Pings & Webhooks

Call webhooks before or after a scheduled task runs (useful for monitoring services like Cronitor, Sentry, or Better Stack):

```typescript
Schedule.command('db:backup')
  .daily()
  .pingBefore('https://nosnch.in/ping-start-id')
  .thenPing('https://nosnch.in/ping-success-id');
```

### Background Tasks

By default, the scheduler runs all commands sequentially. You can instruct Maxima to execute a task as a background process so that slow-running commands do not block subsequent scheduled tasks:

```typescript
Schedule.command('video:encode')
  .hourly()
  .runInBackground(); // Runs as async child process
```

### Maintenance Mode

When your application is in maintenance mode, scheduled tasks are blocked. If you have an essential cleanup task that must execute anyway, chain `.evenInMaintenanceMode()`:

```typescript
Schedule.call('critical-sync', () => { /* ... */ })
  .everyFiveMinutes()
  .evenInMaintenanceMode();
```

---

## Running the Scheduler

To execute scheduled tasks, register a cron entry on your production server to run the scheduler check every single minute:

```cron
* * * * * cd /path-to-your-project && npm run maxima -- schedule:run >> /dev/null 2>&1
```

Or trigger execution programmatically in test suites:
```typescript
import { Schedule } from '@lib/scheduler/Schedule.js';

// Executes all tasks that are currently due
await Schedule.runDue();
```
