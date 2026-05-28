# Logging

Maxima logging is powered by Pino and configured through `src/config/logging.ts`.

```typescript
import { Log } from '@lib/index.js';

Log.info('User signed in', { userId: 1 });
Log.warning('Slow query', { durationMs: 240 });
Log.error(new Error('Payment failed'), { orderId: 10 });
```

## Channels

Use `Log.channel()` to write to a configured channel, or let Maxima use `logging.default`.

```typescript
Log.channel('single').info('Written to the single channel');
Log.channel('error').error('Written to the error channel');
```

> [!NOTE]
> If the `console` channel is requested or set as the default, but is not explicitly defined in the logging configurations, Maxima will automatically define and instantiate a fallback console channel with a level of `debug` and pretty formatting enabled. This ensures that application processes and tests print output gracefully to stdout rather than throwing configuration errors.

Supported channel drivers include `console`, `single`, `file`, `daily`, `stack`, `null`, `slack`, `webhook`, `papertrail`, `syslog`, and `errorlog`.

Stacks combine multiple channels:

```typescript
Log.stack(['console', 'file']).info('Written to both channels');
```

## Log Levels

The logger exposes common severity methods:

```typescript
Log.debug('debug');
Log.info('info');
Log.notice('notice');
Log.warn('warn');
Log.warning('warning');
Log.error('error');
Log.critical('critical');
Log.alert('alert');
Log.fatal('fatal');
Log.emergency('emergency');
```

`notice()` writes at info level, `warning()` writes at warn level, `critical()` and `alert()` write at error level, and `emergency()` writes at fatal level.

## Context

Attach context to one logger, share it globally, or scope it to an async callback.

```typescript
Log.withContext({ requestId: 'req-1' }).info('Scoped logger');

Log.shareContext({ app: 'maxima' });
Log.info('Includes shared context');
Log.flushSharedContext();

await Log.runWithContext({ requestId: 'req-2' }, async () => {
  Log.info('Includes async-local context');
});
```

Sensitive context keys containing `password`, `token`, `authorization`, `cookie`, `secret`, or `apiKey` are redacted before writing.

## Deprecations

Use the configured deprecations channel for old API warnings:

```typescript
Log.deprecations().warning('Old API used');
```

## Taps, Processors, And Custom Drivers

Taps can alter a configured channel before use:

```typescript
Log.tap('tenant', logger => logger.withContext({ tenant: 'acme' }));
```

Processors transform context before records are written:

```typescript
Log.processor(context => ({
  ...context,
  processed: true
}));
```

Register custom drivers with `extend()`:

```typescript
Log.extend('custom', config => {
  return Log.channel('console').withContext({ driver: config.driver });
});
```

## Testing Logs

Use `fake()` or `spy()` to capture logs in memory:

```typescript
Log.fake();

Log.info('hello world', { requestId: 'abc123' });
Log.error(new Error('boom'));

Log.assertLogged('info', 'hello world', context => context.requestId === 'abc123');
Log.assertLogged('error', 'boom', context => typeof context.stack === 'string');

const records = Log.records();
Log.restore();
```

When channel creation fails, Maxima writes to `storage/logs/emergency.log`.
