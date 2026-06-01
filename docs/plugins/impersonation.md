# Maxima Impersonation Plugin

A Laravel-inspired user impersonation plugin for the Maxima framework. This plugin allows administrators to securely log in as another user ("impersonate" or "act as") for support, debugging, or admin operations, without requiring the target user's password.

---

## Features

- **Seamless Session Swapping:** Seamlessly switches the authenticated user context within Maxima's authentication and session systems.
- **Request Macros:** Extends Maxima's `Request` with convenient helper methods: `request.isImpersonating()`, `request.impersonator()`, and `request.impersonatorId()`.
- **Built-in Endpoints:** Provides out-of-the-box `/impersonate/take` and `/impersonate/leave` POST routes with configurable prefixes, paths, and middlewares.
- **Granular Authorization:** Supports customizable callback hooks (`canImpersonate` and `canBeImpersonated`) to restrict who can impersonate and who can be impersonated.
- **Route Protection Middlewares:** Automatically registers `impersonating` and `block_impersonated` middleware aliases to guard sensitive endpoints.

---

## Installation & Setup

### 1. Register the Service Provider

Add `ImpersonateServiceProvider` to the `providers` array in `src/config/app.ts`:

```typescript
import { ImpersonateServiceProvider } from '@plugins/impersonation/src/index.js'

export default {
  // ...
  providers: [
    FrameworkServiceProvider,
    TenantServiceProvider,
    ImpersonateServiceProvider, // Register here
    AppServiceProvider
  ]
}
```

---

## Configuration

You can customize the plugin by defining an `impersonate.ts` file in your application's `src/config/` directory.

Example `src/config/impersonate.ts`:

```typescript
export default {
  // Guard used for authentication (defaults to 'session')
  guard: 'session',

  // Session key used to store the impersonator's user ID
  session_key: 'impersonator_user_id',

  // Configuration for built-in impersonation routes
  routes: {
    enabled: true,                  // Set to false to define your own endpoints
    take_path: '/impersonate/take',
    leave_path: '/impersonate/leave',
    middleware: ['web', 'auth']     // Middleware group/aliases to apply to these endpoints
  }
}
```

---

## Authorization & Security Callbacks

Define who can impersonate and who can be impersonated. You can configure these in your `AppServiceProvider` or a bootstrap file.

### Option A: Using ImpersonateManager Callbacks (Recommended)

```typescript
import { ImpersonateManager } from '@plugins/impersonation/src/index.js'

// 1. Authorize who is allowed to impersonate others
ImpersonateManager.canImpersonate((impersonator, impersonated, request) => {
  return impersonator.is_admin === true || impersonator.role === 'admin';
})

// 2. Prevent specific target users from being impersonated (e.g., other super admins)
ImpersonateManager.canBeImpersonated((impersonated, request) => {
  return impersonated.is_super_admin !== true;
})
```

### Option B: Defining Methods directly on the User Model

Alternatively, you can implement `canImpersonate()` and `canBeImpersonated()` methods directly on your `User` model:

```typescript
// src/app/Models/User.ts
import { Model } from '@lib/database/Model.js'

export class User extends Model {
  // ...
  
  canImpersonate(targetUser: User): boolean {
    return this.is_admin === true;
  }

  canBeImpersonated(): boolean {
    return this.is_super_admin !== true;
  }
}
```

If no callbacks or model methods are defined, the plugin defaults to checking if `impersonator.is_admin` or `impersonator.isAdmin` is truthy.

---

## Usage Guide

### Programmatic Impersonation

You can control impersonation programmatically anywhere in your application:

```typescript
import { ImpersonateManager } from '@plugins/impersonation/src/index.js'
import { Request } from '@lib/http/Request.js'

// Start impersonating
await ImpersonateManager.take(request, adminUser, targetUser)

// Stop impersonating
await ImpersonateManager.leave(request)
```

### Request Macro Helpers

Use these helpers inside controllers or view templates:

```typescript
// Check if current user is impersonated
if (request.isImpersonating()) {
  console.log('Active impersonation session')
}

// Get the original impersonating user object
const admin = await request.impersonator()

// Get the original impersonator's user ID
const adminId = request.impersonatorId()
```

### Route Protection Middlewares

Protect your routes using the pre-registered middleware aliases:

```typescript
import { Route } from '@lib/http/Route.js'

// 1. Only allow impersonators to access this endpoint
Route.get('/admin/support-chat', 'SupportController@chat')
  .middleware(['web', 'impersonating'])

// 2. Prevent actions (like changing passwords or deleting accounts) while impersonating
Route.post('/settings/security/password', 'PasswordController@update')
  .middleware(['web', 'block_impersonated'])
```

---

## API Reference & Method Signatures

### ImpersonateManager

```typescript
type ImpersonationCallback = (impersonator: any, impersonated: any, request?: Request) => boolean | Promise<boolean>
type ImpersonatedCallback = (impersonated: any, request?: Request) => boolean | Promise<boolean>

class ImpersonateManagerClass {
  /** Register callback to check if user can impersonate others */
  canImpersonate(callback: ImpersonationCallback): void;

  /** Register callback to check if user can be impersonated */
  canBeImpersonated(callback: ImpersonatedCallback): void;

  /** Evaluate impersonation logic using callbacks or model helper checks */
  checkTake(impersonator: any, impersonated: any, request?: Request): Promise<boolean>;

  /** Initiate impersonation and switch active session IDs */
  take(request: Request, impersonator: any, impersonated: any, guardName?: string): Promise<void>;

  /** End impersonation session and restore previous authenticated session context */
  leave(request: Request, guardName?: string): Promise<void>;

  /** Check if request session has active impersonator keys */
  isImpersonating(request: Request): boolean;

  /** Retrieve impersonating user model instance */
  impersonator(request: Request, guardName?: string): Promise<any | null>;
}
```

### Request Macro Extensions

These macros are automatically bound to Maxima's standard `Request` objects:

```typescript
interface Request {
  /** Check if the active session is an impersonating session */
  isImpersonating(): boolean;

  /** Get the user object of the original impersonator */
  impersonator(): Promise<any | null>;

  /** Get the ID of the original impersonating user */
  impersonatorId(): any | null;
}
```

---

## Testing

Run the plugin test suite using vitest:

```bash
npx vitest run plugins/impersonation/
```
