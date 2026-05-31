# Maxima Multi-Tenant Plugin

A Laravel-inspired multi-tenancy plugin for the Maxima framework. This plugin adds transparent database and storage isolation for multi-tenant applications using dynamic connection and disk mapping.

---

## Features

- **Dynamic Resolution:** Resolve tenants based on **Subdomain**, **Domain**, custom **Headers**, or **Cookies**.
- **Database Isolation:** Automatically switches the default database connection to a tenant-scoped database (supporting SQLite file separation or PostgreSQL/MySQL database suffixing).
- **Storage Isolation:** Scopes filesystem disks (`local`, `public`, etc.) to the tenant's own storage directory. Remote disks (like S3) are wrapped using a `scoped` driver wrapper.
- **Custom Overrides:** Tenants can specify their own custom database configurations or storage directory overrides.
- **Artisan-Parity CLI Commands:** Run migrations or seeders across all tenants (or a specific tenant) using the command-line interface.

---

## Installation & Setup

### 1. Register the Service Provider

Add `TenantServiceProvider` to the `providers` array in `src/config/app.ts`:

```typescript
import { TenantServiceProvider } from '@plugins/tenant/src/index.js'

export default {
  // ...
  providers: [
    FrameworkServiceProvider,
    TenantServiceProvider, // Register here
    AppServiceProvider
  ]
}
```

### 2. Configure Tenancy Settings

You can define a `tenancy.ts` file in your application's `src/config/` directory to configure settings.

Example `src/config/tenancy.ts`:

```typescript
import { env } from '@lib/index.js'

export default {
  // Mode of tenant identification: 'subdomain', 'domain', 'header', or 'cookie'
  identification: env('TENANCY_IDENTIFICATION', 'subdomain'),

  // The header name to check if identification mode is 'header'
  header_name: env('TENANCY_HEADER_NAME', 'x-tenant-id'),

  // The cookie name to check if identification mode is 'cookie'
  cookie_name: env('TENANCY_COOKIE_NAME', 'tenant_id'),

  // Central domain of the application (used to extract subdomains)
  central_domains: [
    env('CENTRAL_DOMAIN', 'localhost'),
    '127.0.0.1'
  ],

  // Abort request with 404 if tenant is not found (only applies to routes using the 'tenant' middleware)
  abort_on_fail: true,

  // Static list of tenants (for simple configuration-based setups)
  tenants: [
    {
      id: 'tenant-a',
      subdomain: 'tenant-a',
      domain: 'tenant-a.com',
      data: { name: 'Tenant A Co' }
    }
  ]
}
```

---

## Tenant Identification

To identify the active tenant, add the `'tenant'` middleware alias to your routes or route groups in `src/routes/web.ts` or `src/routes/api.ts`:

```typescript
import { Route } from '@lib/http/Route.js'

Route.group({ middleware: ['tenant'] }, () => {
  Route.get('/dashboard', 'DashboardController@index')
  Route.get('/profile', 'ProfileController@show')
})
```

### Automatic Controller & Model Scoping

Once the `tenant` middleware is applied to a route, **the active tenant's context is automatically detected and isolated**. 

You do **not** need to manually pass the tenant ID to your database queries or specify which database connection to use inside your controllers. Maxima's ORM model operations (like `User.all()`, `User.find()`, or `User.where()`) dynamically route to the correct tenant database:

```typescript
// src/app/Http/Controllers/UserController.ts
import { Request } from '@lib/http/Request.js'
import { User } from 'src/app/Models/User.js'

export class UserController {
  async index(request: Request) {
    // Under the hood, this automatically queries the active tenant's isolated database.
    // Standard model and query builder calls are fully transparent.
    const users = await User.all() 
    
    return { data: users }
  }
}
```

---

## How It Works

### Database Isolation

When inside a tenant execution context (e.g. within the middleware route handler), the plugin intercepts the `database.default` connection:
- If a tenant does not define a custom database connection override, it defaults to a separate sqlite database located at `storage/tenants/{tenant-id}/database.sqlite` (it automatically creates the parent folder).
- For non-sqlite databases, the database name is automatically suffixed with `_tenant_{tenant-id}`.
- If a tenant *does* define a `database` object override in its settings, the connection merges those properties directly.

Any calls to `DB.connection()` or `DB.table()` dynamically use the scoped connection.

### Storage Isolation

All filesystems disks requested through `Storage.disk(...)` are mapped to the active tenant's resources:
- For `local` and `public` drivers, the directory root resolves inside `storage/tenants/{tenant-id}/{disk-basename}/`.
- The `public` disk URL is scoped to `http://localhost/storage/tenants/{tenant-id}`.
- For remote drivers (`s3`, `ftp`, SFTP), the disk is wrapped in a `scoped` driver referencing the parent disk with a prefix of `tenants/{tenant-id}/`.

---

## Running Scoped Callbacks

You can execute arbitrary code inside a specific tenant's execution context programmatically using `TenantManager.run()`:

```typescript
import { TenantManager } from '@plugins/tenant/src/index.js'
import { DB } from '@lib/database/DB.js'

await TenantManager.run('tenant-a', async () => {
  // Inside this block, DB and Storage operate on tenant-a's isolated connections
  const users = await DB.table('users').select()
  console.log(`Tenant has ${users.length} users`)
})
```

---

## Registering Custom Resolvers

If you store your tenants in a central database, you can configure `TenantManager` with a custom resolver and lister inside your `AppServiceProvider` or a bootstrap file:

```typescript
import { TenantManager, Tenant } from '@plugins/tenant/src/index.js'
import { DB } from '@lib/database/DB.js'

// 1. Resolve tenants dynamically
TenantManager.resolveTenantUsing(async (identifier, type) => {
  // identifier could be ID, subdomain, or domain depending on the type
  const data = await DB.connection('central')
    .table('tenants')
    .where('id', identifier)
    .orWhere('subdomain', identifier)
    .first()

  if (data) {
    return new Tenant({
      id: data.id,
      subdomain: data.subdomain,
      domain: data.domain,
      database: data.db_config ? JSON.parse(data.db_config) : undefined
    })
  }
})

// 2. Define lister so CLI commands know how to find all tenants for migrations
TenantManager.listTenantsUsing(async () => {
  const list = await DB.connection('central').table('tenants').select()
  return list.map(t => new Tenant({ id: t.id }))
})
```

---

## API Reference & Method Signatures

### Context Config Interfaces & Models

```typescript
interface TenantConfig {
  id: string;
  domain?: string;
  subdomain?: string;
  database?: Record<string, any>;
  storage?: {
    disks?: Record<string, Record<string, any>>;
  };
  data?: Record<string, any>;
}

class Tenant {
  constructor(config: TenantConfig);
  readonly id: string;
  readonly domain?: string;
  readonly subdomain?: string;
  get(key: string, defaultValue?: any): any;
}
```

### TenantManager

```typescript
type TenantResolver = (
  identifier: string,
  type: 'id' | 'domain' | 'subdomain' | 'request',
  request?: Request
) => Tenant | Promise<Tenant | undefined> | undefined;

type TenantLister = () => Tenant[] | Promise<Tenant[]>;

class TenantManagerClass {
  /** Register custom resolver callback */
  resolveTenantUsing(resolver: TenantResolver): void;

  /** Register custom lister callback to fetch all active tenants */
  listTenantsUsing(lister: TenantLister): void;

  /** Programmatically register a tenant */
  registerTenant(tenantConfig: TenantConfig): Tenant;

  /** Resolve tenant by ID */
  resolveById(id: string): Promise<Tenant | undefined>;

  /** Resolve tenant dynamically from HTTP Request hostname, subdomain, headers, or cookies */
  resolveFromRequest(request: Request): Promise<Tenant | undefined>;

  /** Resolve tenant by domain */
  resolveByDomain(domain: string): Promise<Tenant | undefined>;

  /** Resolve tenant by subdomain */
  resolveBySubdomain(subdomain: string): Promise<Tenant | undefined>;

  /** List all tenants (combines memory, configuration, and custom listers) */
  all(): Promise<Tenant[]>;

  /** Run a callback function within a designated tenant context */
  run<T>(tenantId: string, callback: () => T | Promise<T>): Promise<T>;
}
```

### Context Helpers

These context utilities manage AsyncLocalStorage scoping under the hood:

```typescript
/** Retrieve active tenant in the current execution scope */
function currentTenant(): Tenant | null;

/** Run callback wrapped in the tenant AsyncLocalStorage block */
function runWithTenant<T>(tenant: Tenant, callback: () => T | Promise<T>): T;
```

---

## Command Line Interface (CLI)

The plugin registers custom console commands automatically with the Maxima CLI:

### Migrate Tenant Databases

Migrate all tenant databases:

```bash
npm run maxima -- tenant:migrate
```

Migrate a specific tenant database:

```bash
npm run maxima -- tenant:migrate --tenant=tenant-a
```

Specify a custom path to migrations:

```bash
npm run maxima -- tenant:migrate --path=custom/migrations/path
```

### Seed Tenant Databases

Seed all tenant databases:

```bash
npm run maxima -- tenant:seed
```

Seed a specific tenant database with a specific seeder class:

```bash
npm run maxima -- tenant:seed --tenant=tenant-a --class=TenantUserSeeder
```

---

## Testing

Run the tenant plugin test suite using vitest:

```bash
npx vitest run plugins/tenant/
```
