# Getting Started with Maxima

Maxima is a Laravel-inspired, enterprise-ready TypeScript framework built on top of Fastify. It brings the elegant syntax, developer experience, and design patterns of Laravel to the Node.js ecosystem, featuring a robust Container, Eloquent-like ORM, powerful Routing, Validation, Queue, Mail, Notifications, and more.

---

## Installation & Setup

To get started with Maxima, ensure you have Node.js (v18+) and npm installed.

### 1. Install Dependencies
Clone the repository and install the dependencies:
```bash
npm install
```

### 2. Configure Environment
Create a `.env` file in the root (or `src/` folder) of your project. Maxima automatically loads and parses environment variables.
```env
APP_NAME=Maxima
APP_ENV=local
APP_KEY=some-random-32-character-key
APP_DEBUG=true
APP_URL=http://localhost:3000

DB_CONNECTION=sqlite
DB_DATABASE=storage/database.sqlite
```

### 3. Start Development Server
Run the local dev server using `tsx`:
```bash
npm run dev
```

### 4. Running Tests
Maxima is fully covered with unit and integration tests using Vitest.
```bash
npm run test
```

---

## Directory Structure

Maxima projects align with a classic MVC architecture organized within a nested `src/` layout. Here is what each directory does:

- `.env`: Environment configuration file in the project root. Maxima automatically parses this file, dynamically casting boolean/numeric values.
- `bin/`: Contains wrapper scripts for the framework's command-line interface (CLI). It executes Artisan-like commands via `npm run maxima`.
- `dist/`: Output folder for compiled JavaScript files generated when building TypeScript files (`npm run build`).
- `docs/`: Markdown documentation files detailing features, configurations, and guides.
- `lib/`: The core framework source code (caches, container, database, foundation, http, mailing, etc.).
- `plugins/`: Folder containing external framework plugins (e.g., `bouncer` for permissions, `imex` for Excel/CSV import/export, `impersonation` for user switching, `litetable` for datatables, `tenant` for multi-tenancy).
- `public/`: Static files served directly by the Fastify web server (images, stylesheets, public files).
- `storage/`: Application storage directory containing logs, local disks, database sqlite files, etc.
- `src/`: The application source code root:
  - `app/`: Contains core application logic:
    - `Casts/`: Custom database attribute casting.
    - `Console/`: Custom CLI commands.
    - `Events/`: Event classes.
    - `Exceptions/`: Exception handler.
    - `Http/`: Controllers, Middleware, Form Requests.
    - `Listeners/`: Event listener classes.
    - `Mail/`: Mailables.
    - `Models/`: Database model entities.
    - `Notifications/`: Notification classes.
    - `Policies/`: Authorization policy classes.
    - `Providers/`: Service Providers.
    - `Services/`: Domain/Application services.
  - `config/`: Configuration files (e.g., `database.ts`, `cache.ts`, `app.ts`).
  - `database/`: Database migrations, seeders, and factories.
  - `resources/`: Views, localization translations, and raw assets.
  - `routes/`: Web, API, and channels routing files.
  - `server.ts`: The web application entrypoint.
- `tests/`: Vitest integration and unit tests.
- `vsc_ext/`: Visual Studio Code extension source code for editor autocomplete and support.

---

## Configuration & Environments

Maxima handles configuration using two repositories: `EnvRepository` and `ConfigRepository`.

### Environment Variables (`EnvRepository`)

The environment helper parses values inside `.env` and casts boolean and numeric representations dynamically:

```typescript
import { Application } from '@lib/foundation/Application.js';

const app = new Application(process.cwd());
await app.bootstrap();

// Retrieves key from environment
const debug = app.env.get('APP_DEBUG', false); // returns true (boolean)
const port = app.env.get('PORT', 3000);         // returns 3000 (number)
const name = app.env.get('APP_NAME');           // returns "Maxima" (string)
```

### Configuration Repository (`ConfigRepository`)

Configurations are placed in files in the `src/config/` directory. Each file exports an object representing that configuration group. The keys are dynamically registered by filename.

For example, a `src/config/database.ts` file:
```typescript
export default {
  default: 'sqlite',
  connections: {
    sqlite: {
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    }
  }
};
```

You can retrieve these using dot-notation:
```typescript
// Access configuration via ConfigRepository
const defaultDriver = app.config.get('database.default'); // "sqlite"
const connectionConfig = app.config.get('database.connections.sqlite');

// Dynamically set configurations at runtime
app.config.set('database.connections.sqlite.connection.filename', 'storage/db.sqlite');

// Check if config exists
if (app.config.has('database.default')) {
  // ...
}
```

### Configuration Caching
For production speed, you can cache configuration to a static JSON file:
```typescript
await app.config.cache('storage/framework/config.json');
```
If this JSON file exists, Maxima bypasses dynamically loading files from `src/config/` and loads directly from the JSON payload.

The same cache can be managed from the CLI:

```bash
npm run maxima -- config:cache
npm run maxima -- optimize
npm run maxima -- optimize:clear
```

See [CLI](./cli.md) for generator, publishing, database, storage link, and custom command signature support. See the [documentation index](./index.md) for the full topic list.

---

## Service Providers & Lifecycle Hooks

Service Providers are the central place to configure and bootstrap your application. All of your application's services are bound to the Container within these classes.

### Defining a Service Provider

```typescript
import { ServiceProvider } from '@lib/container/Container.js';
import { BillingService } from '../Services/BillingService.js';

export class BillingServiceProvider extends ServiceProvider {
  // 1. Register bindings in the container
  async register() {
    this.app.singleton(BillingService, () => new BillingService(this.app.make('config')));
  }

  // 2. Boot services (called after all providers are registered)
  async boot() {
    // perform booting operations, event listeners setup, routing defaults, etc.
  }
}
```

### Deferred Service Providers

If your provider is *only* registering bindings in the service container, you can choose to defer its registration until one of those bindings is actually requested by the application. This improves performance since it avoids loading files and instantiating providers on every request.

To defer a provider, set the static `deferred` property to `true` and define a static `provides` list:

```typescript
export class DeferredBillingServiceProvider extends ServiceProvider {
  // Mark as deferred
  static deferred = true;

  // Specify which bindings this provider provides
  static provides = [BillingService];

  async register() {
    this.app.singleton(BillingService, () => new BillingService(this.app.make('config')));
  }
}
```

### Application Booting Lifecycle Hooks

You can hook into the application's boot flow dynamically:

```typescript
// Registers a callback to run before service providers boot
app.booting((app) => {
  console.log('App is starting up...');
});

// Registers a callback to run after all service providers have booted
app.booted((app) => {
  console.log('App has booted and is ready to accept traffic.');
});
```

---

## Performance & Benchmarks

Maxima is built on top of Fastify, offering high-throughput and low-latency performance.

### Autocannon Benchmark

Running a 30-second test against a local Maxima instance (`autocannon -c 100 -d 30 -p 10 http://127.0.0.1:3000`):

```
Running 30s test @ http://127.0.0.1:3000
100 connections with 10 pipelining factor

┌─────────┬────────┬────────┬─────────┬─────────┬──────────┬──────────┬─────────┐
│ Stat    │ 2.5%   │ 50%    │ 97.5%   │ 99%     │ Avg      │ Stdev    │ Max     │
├─────────┼────────┼────────┼─────────┼─────────┼──────────┼──────────┼─────────┤
│ Latency │ 801 ms │ 951 ms │ 1107 ms │ 1126 ms │ 952.4 ms │ 92.54 ms │ 1158 ms │
└─────────┴────────┴────────┴─────────┴─────────┴──────────┴──────────┴─────────┘
┌───────────┬─────┬──────┬─────────┬─────────┬──────────┬─────────┬─────────┐
│ Stat      │ 1%  │ 2.5% │ 50%     │ 97.5%   │ Avg      │ Stdev   │ Min     │
├───────────┼─────┼──────┼─────────┼─────────┼──────────┼─────────┼─────────┤
│ Req/Sec   │ 0   │ 0    │ 1,000   │ 2,000   │ 1,033.34 │ 461.81  │ 1       │
├───────────┼─────┼──────┼─────────┼─────────┼──────────┼─────────┼─────────┤
│ Bytes/Sec │ 0 B │ 0 B  │ 6.59 MB │ 13.2 MB │ 6.8 MB   │ 3.04 MB │ 6.58 kB │
└───────────┴─────┴──────┴─────────┴─────────┴──────────┴─────────┴─────────┘

Req/Bytes counts sampled once per second.
# of samples: 30

32k requests in 30.29s, 204 MB read
```

