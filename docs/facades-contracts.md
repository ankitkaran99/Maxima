# Facades And Contracts

Maxima includes a base `Facade` class for static-style access to container bindings, and a `Contracts` namespace for common service tokens.

## Facades

Create a facade by extending `Facade` and returning a container accessor.

```typescript
import { Facade } from '@lib/index.js';
import { BillingService } from './BillingService.js';

export class Billing extends Facade {
  protected static getFacadeAccessor() {
    return BillingService;
  }
}
```

Resolve the underlying instance with `getFacadeRoot()`:

```typescript
const billing = await Billing.getFacadeRoot<BillingService>();
await billing.charge(order);
```

`setApplication()` is called automatically when the application is bootstrapped through `setApplication(app)`.

## Swaps, Fakes, And Spies

Facades can replace their resolved instance for tests.

```typescript
const fake = Billing.fake({
  charge: async () => ({ ok: true })
});
```

Use `swap()` to provide a concrete instance:

```typescript
Billing.swap(new FakeBillingService());
```

Use `spy()` to record method calls while preserving the provided implementation:

```typescript
const spy = Billing.spy({
  charge: async () => ({ ok: true })
});

await spy.charge(order);
spy.calls; // [{ method: "charge", args: [order] }]
```

Clear cached facade roots with:

```typescript
Billing.clearResolvedInstance();
```

Pass an accessor to clear only one resolved instance.

## Contracts

The `Contracts` namespace exposes symbols for common framework services:

```typescript
import { Contracts } from '@lib/index.js';

app().singleton(Contracts.Cache, () => customCacheManager);
const cache = await app(Contracts.Cache);
```

Available contract tokens:

- `Contracts.Container`
- `Contracts.Cache`
- `Contracts.Queue`
- `Contracts.Events`
- `Contracts.Filesystem`
- `Contracts.Mail`
- `Contracts.Notifications`
- `Contracts.Validation`
- `Contracts.Auth`
- `Contracts.Routing`
- `Contracts.Logging`

The exported contract interfaces are TypeScript conveniences over the framework managers, such as `CacheContract`, `QueueContract`, `EventContract`, `FilesystemContract`, `MailContract`, `NotificationContract`, `AuthContract`, `RoutingContract`, and `LoggingContract`.
