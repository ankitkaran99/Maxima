# Bouncer Permission Plugin for Maxima

A Laravel-inspired role and ability authorization plugin for Maxima. It provides a simple, clean, and fluent API to manage user roles and abilities while integrating seamlessly with Maxima's authorization Gate system.

---

## Features

- **Role Management**: Assign and retract roles from users.
- **Abilities**: Allow or disallow permissions directly on users or roles.
- **Forbidden Abilities**: Explicitly forbid abilities on users or roles, overriding any matching allow permissions.
- **Model & Instance Specific Abilities**: Limit abilities to a model class or to a specific model instance.
- **Ownership Checks**: Define ownership permissions (e.g. allow a user to update only their own posts).
- **Seamless Gate Integration**: Integrates directly with Maxima's built-in `Gate` authorization mechanism.
- **Prototype Extensions**: Helper methods automatically registered on the `Model` prototype.

---

## Installation

### 1. Register the Service Provider
Add the `BouncerServiceProvider` to your application providers array in `src/config/app.ts` (or boot it within your application bootstrap file):

```typescript
import { BouncerServiceProvider } from 'plugins/bouncer/src/index.js'

export default {
  // ...
  providers: [
    BouncerServiceProvider,
  ]
}
```

### 2. Install Database Tables
Run the command below using the Maxima CLI to create the necessary roles, abilities, and mapping tables:

```bash
npm run maxima -- bouncer:install
```

If you ever need to re-create the tables (losing existing data), pass the `--force` flag:

```bash
npm run maxima -- bouncer:install --force
```

---

## Usage Guide

### Role Management

#### Assigning Roles
Assign a role to a user. If the role does not exist in the database, it will be automatically created:

```typescript
import { BouncerManager } from 'plugins/bouncer/src/index.js'

// Using the manager
await BouncerManager.assign('admin').to(user)

// Or using the user model prototype helper
await user.assign('editor')
```

#### Retracting Roles
Retract a role from a user:

```typescript
await BouncerManager.retract('admin').from(user)

// Or using the user model prototype helper
await user.retract('editor')
```

#### Checking Roles
Check whether a user has a specific role using fluent syntax:

```typescript
// Check if user has a role
const isAdmin = await BouncerManager.is(user).a('admin') // or .an('admin')

// Check if user doesn't have a role
const isNotEditor = await BouncerManager.is(user).notA('editor')

// Using model prototype helpers
const isAuthor = await user.isA('author')
const isNotAdmin = await user.isNotAn('admin')
```

---

### Ability & Permission Management

#### Granting Abilities
You can grant permissions to both users and roles:

```typescript
// Allow a user to edit profile
await BouncerManager.allow(user).to('edit-profile')
await user.allow('edit-profile')

// Allow a role to publish articles
await BouncerManager.allow('editor').to('publish-articles')
```

#### Removing Abilities
Remove a previously granted permission:

```typescript
await BouncerManager.disallow(user).to('edit-profile')
await user.disallow('edit-profile')

await BouncerManager.disallow('editor').to('publish-articles')
```

#### Forbidden Abilities
Explicitly forbid a permission on a user or role. Forbidden constraints **always take precedence** over allows (e.g. if a user has a role that allows an action, but is explicitly forbidden from that action directly, the action is denied).

```typescript
// Forbid a user from deleting records
await BouncerManager.forbid(user).to('delete-records')
await user.forbid('delete-records')

// Lift the forbidden constraint
await BouncerManager.unforbid(user).to('delete-records')
await user.unforbid('delete-records')
```

---

### Model-Specific Abilities

You can scope abilities to specific model classes or specific instances of a model.

#### Class-level Abilities
Allow a user or role to perform an action on any instance of a model class:

```typescript
import { Post } from 'app/Models/Post.js'

// Allow editing any Post
await BouncerManager.allow(user).to('edit', Post)
await user.allow('edit', Post)
```

#### Instance-level Abilities
Allow a user or role to perform an action on a specific model instance:

```typescript
const post = await Post.find(1)

// Allow editing only this specific post
await BouncerManager.allow(user).to('edit', post)
await user.allow('edit', post)
```

---

### Ownership Constraints

Define ownership checks to dynamically allow operations on instances owned by the user. Bouncer matches the user's ID against the instance's `user_id` or `userId` attribute (or a custom `getOwnerId()` method if defined on the instance).

```typescript
// Allow a user to edit only their own posts
await BouncerManager.allow(user).toOwn(Post).to('edit')

// Forbid editing owned posts
await BouncerManager.forbid(user).toOwn(Post).to('edit')
```

---

### Checking Gate Authorization
Bouncer registers itself directly in Maxima's authorization `Gate` pipeline. Any standard authorization checks will automatically respect Bouncer roles and abilities:

```typescript
import { Gate } from '@lib/auth/Gate.js'

// Check using the standard Gate API
if (await Gate.allows('edit-profile')) {
  // ...
}

if (await Gate.allows('edit', post)) {
  // ...
}

// Or check via user model helpers
if (await user.can('edit', post)) {
  // ...
}
```

#### Super Admin Custom Bypass
By default, users with the `'admin'` role are treated as Super Admins and granted all abilities. You can configure this default role, or define a custom check programmatically:

```typescript
// Define custom Super Admin check (e.g. bypass validation for specific emails)
BouncerManager.isSuperAdmin((user) => user.email === 'super@mycompany.com')
```

---

## API Reference & Method Signatures

### BouncerManager

```typescript
class BouncerManagerClass {
  /** Custom Super Admin checks */
  isSuperAdmin(callback: (user: any) => boolean | Promise<boolean>): void;

  /** Assign a role */
  assign(roleNameOrInstance: string | Role): {
    to: (user: any) => Promise<void>;
  };

  /** Retract a role */
  retract(roleNameOrInstance: string | Role): {
    from: (user: any) => Promise<void>;
  };

  /** Grant an ability / permission */
  allow(userOrRoleOrName: any): {
    to: (abilityName: string | string[], subject?: any) => Promise<void>;
    toOwn: (modelClass: any) => {
      to: (abilityName: string | string[]) => Promise<void>;
    };
  };

  /** Remove a granted ability */
  disallow(userOrRoleOrName: any): {
    to: (abilityName: string | string[], subject?: any) => Promise<void>;
    toOwn: (modelClass: any) => {
      to: (abilityName: string | string[]) => Promise<void>;
    };
  };

  /** Forbid an ability */
  forbid(userOrRoleOrName: any): {
    to: (abilityName: string | string[], subject?: any) => Promise<void>;
    toOwn: (modelClass: any) => {
      to: (abilityName: string | string[]) => Promise<void>;
    };
  };

  /** Lift a forbidden ability */
  unforbid(userOrRoleOrName: any): {
    to: (abilityName: string | string[], subject?: any) => Promise<void>;
    toOwn: (modelClass: any) => {
      to: (abilityName: string | string[]) => Promise<void>;
    };
  };

  /** High-level capability check (integrated with standard Gate) */
  can(user: any, ability: string, subject?: any): Promise<boolean>;

  /**
   * Raw authorization decision evaluator.
   * Returns true (allowed), false (forbidden), or undefined (not specified).
   */
  determine(user: any, abilityName: string, subject?: any): Promise<boolean | undefined>;

  /** Check if user possesses a role */
  hasRole(user: any, roleName: string): Promise<boolean>;

  /** Fluent check interface */
  is(user: any): {
    a: (roleName: string) => Promise<boolean>;
    an: (roleName: string) => Promise<boolean>;
    notA: (roleName: string) => Promise<boolean>;
    notAn: (roleName: string) => Promise<boolean>;
  };
}
```

### Model Prototype Extensions

These methods are automatically mixed into all subclasses of `Model`:

```typescript
interface Model {
  isAn(roleName: string): Promise<boolean>;
  isA(roleName: string): Promise<boolean>;
  isNotAn(roleName: string): Promise<boolean>;
  isNotA(roleName: string): Promise<boolean>;
  allow(ability: string | string[], subject?: any): Promise<void>;
  disallow(ability: string | string[], subject?: any): Promise<void>;
  forbid(ability: string | string[], subject?: any): Promise<void>;
  unforbid(ability: string | string[], subject?: any): Promise<void>;
  assign(role: string): Promise<void>;
  retract(role: string): Promise<void>;
}
```
