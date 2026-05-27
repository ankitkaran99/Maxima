# Processes, Context, And Concurrency

Maxima provides lightweight process execution, async context propagation, and bounded concurrency utilities.

```typescript
import { Concurrency, Context, Process } from '@lib/index.js';
```

## Running Processes

Use `Process.command()` for fluent process configuration or `Process.run()` for direct execution.

```typescript
const result = await Process
  .command('node', ['--version'])
  .path(process.cwd())
  .env({ NODE_ENV: 'test' })
  .timeout(5)
  .run();

if (result.successful()) {
  console.log(result.stdout);
}
```

`ProcessResult` exposes `command`, `exitCode`, `stdout`, `stderr`, `successful()`, `failed()`, and `throw()`.

```typescript
await Process.command('npm', ['test']).throw();
```

`input()` writes to stdin:

```typescript
const result = await Process
  .command('node', ['script.js'])
  .input(JSON.stringify({ run: true }))
  .run();
```

## Process Pools

Use `Process.pool()` to run multiple configured processes concurrently:

```typescript
const [node, npm] = await Process.pool(pool => {
  pool.command('node', ['--version']);
  pool.command('npm', ['--version']);
});
```

## Process Fakes

Fakes replace process execution and record attempted commands.

```typescript
import { Process, ProcessResult } from '@lib/index.js';

Process.fake((command, args) => {
  return new ProcessResult(command, 0, `${command}:${args.join(',')}`);
});

await Process.command('node', ['--version']).run();
Process.assertRan('node');

const records = Process.recorded();
Process.restore();
```

## Context

`Context` stores async-local values for the current execution flow.

```typescript
await Context.run({ requestId: 'req-123' }, async () => {
  Context.get('requestId'); // "req-123"
  Context.set('tenant', 'acme');
  Context.all(); // { requestId: "req-123", tenant: "acme" }
  Context.forget('tenant');
});
```

Values are scoped to the callback passed to `run()`.

## Concurrency

`Concurrency.run()` executes task functions with an optional concurrency limit while preserving result order.

```typescript
const results = await Concurrency.run([
  () => fetchUser(1),
  () => fetchUser(2),
  () => fetchUser(3)
], 2);
```

`Concurrency.defer()` schedules a task into a promise and carries the current `Context` values into that task.

```typescript
await Context.run({ requestId: 'req-123' }, async () => {
  const value = await Concurrency.defer(() => Context.get('requestId'));
  // value === "req-123"
});
```
