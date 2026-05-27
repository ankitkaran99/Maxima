# Dependency Injection & Container

The Maxima Service Container is a powerful tool for managing class dependencies and performing dependency injection. Dependency injection is a fancy phrase that essentially means: class dependencies are "injected" into the class via the constructor or methods.

---

## Basic Bindings

Almost all of your service container bindings will be registered within **Service Providers**.

### Simple Bindings

Register a basic transient binding (instantiated fresh on every resolution):

```typescript
this.app.bind(BillingService, async (container) => {
  const config = container.make('config');
  return new BillingService(config);
});
```

### Singleton Bindings

Singletons are resolved once, and the same instance is returned on subsequent container queries:

```typescript
this.app.singleton(BillingService, async (container) => {
  return new BillingService(container.make('config'));
});
```

### Instance Bindings

If you already have a pre-existing object instance, you can bind it directly:

```typescript
const service = new BillingService(config);

this.app.instance(BillingService, service);
```

### Registering Aliases

You can map a string shortcut alias to any class or token:

```typescript
this.app.alias('billing', BillingService);

// Resolves to BillingService
const billing = await this.app.make('billing');
```

---

## Resolving Instances

Retrieve instances from the container using the `make()` or `resolve()` methods:

```typescript
// Resolve using class constructor reference
const billingService = await app.make(BillingService);

// Resolve using string alias
const billingService = await app.make('billing');
```

### Constructor Dependency Injection

When resolving a class that has not been explicitly bound, the container will automatically build it by inspecting its constructor signatures. To tell the container what dependencies to inject, add a static `inject` property:

```typescript
import { DatabaseManager } from '@lib/database/DB.js';

export class UserService {
  // Define dependencies to inject
  static inject = [DatabaseManager];

  constructor(private db: DatabaseManager) {}

  async getUser(id: number) {
    return await this.db.table('users').where('id', id).first();
  }
}

// Resolves UserService and automatically injects DatabaseManager!
const userService = await app.make(UserService);
```

---

## Contextual Bindings

Sometimes you may have two classes that utilize the same interface, but you want to inject different concrete implementations into different classes. You can configure this contextually:

```typescript
// When PhotoController is resolved, inject LocalDisk
this.app.when(PhotoController)
  .needs(Disk)
  .give(LocalDisk);

// When VideoController is resolved, inject S3Disk
this.app.when(VideoController)
  .needs(Disk)
  .give(S3Disk);
```

---

## Tagging Services

If you have multiple related bindings (such as several custom report generators), you can tag them together:

```typescript
this.app.bind(SalesReport, () => new SalesReport());
this.app.bind(RefundsReport, () => new RefundsReport());

// Tag the reports
this.app.tag([SalesReport, RefundsReport], 'reports');

// Resolve all tagged services at once
const reportGenerators = await this.app.tagged('reports'); // returns [SalesReport, RefundsReport]
```

---

## Extenders (Decorators)

The `extend` method allows you to modify or decorate resolved instances before they are returned:

```typescript
this.app.extend(BillingService, async (service, container) => {
  // Wrap or configure instance
  service.enableLogger(container.make('log'));
  return service;
});
```

---

## Container Lifecycle Hooks

You can define callbacks that fire when a service is resolved by the container:

### Resolving Callbacks

Fires right before returning the instance:

```typescript
// Callback for a specific class
this.app.resolving(BillingService, (instance, container) => {
  console.log('BillingService is being resolved');
});

// Global callback for any class
this.app.resolving((instance, container) => {
  console.log('Some object resolved');
});
```

### After Resolving Callbacks

Fires after the instance has been completely built and initialized:

```typescript
this.app.afterResolving(BillingService, (instance, container) => {
  // Post-resolving config...
});
```
