# CLI

Maxima includes an Artisan-style CLI entrypoint for common project operations, generators, cache management, publishing, storage links, and database inspection.

```bash
npm run maxima -- about
npm run maxima -- --help
npm run maxima -- make:model --help
```

## Application Commands

```bash
npm run maxima -- about
npm run maxima -- env
npm run maxima -- inspire
npm run maxima -- key:generate
npm run maxima -- key:generate --show
npm run maxima -- serve --port 3000
npm run maxima -- test
```

`key:generate` writes `APP_KEY` to the active application `.env` file unless `--show` is passed.

## Cache And Optimization

```bash
npm run maxima -- config:cache
npm run maxima -- config:clear
npm run maxima -- config:show
npm run maxima -- config:show app.env
npm run maxima -- optimize
npm run maxima -- optimize:clear
npm run maxima -- view:cache
npm run maxima -- view:clear
```

`optimize` builds framework caches such as configuration and route cache. `optimize:clear` clears config, route, application cache, and compiled view artifacts. `view:cache` warms compiled Edge templates and `view:clear` removes compiled view artifacts.

## Generators

Generators write into the active `src/` application tree and support `--force` to overwrite existing files or `--preserve` to leave existing files untouched.

```bash
npm run maxima -- make:controller UserController
npm run maxima -- make:model User
npm run maxima -- make:middleware EnsureToken
npm run maxima -- make:request StorePostRequest
npm run maxima -- make:notification InvoicePaid
npm run maxima -- make:mail WelcomeMail
npm run maxima -- make:job ProcessReport
npm run maxima -- make:migration create_posts_table
npm run maxima -- make:policy PostPolicy
npm run maxima -- make:event UserRegistered
npm run maxima -- make:listener SendWelcomeEmail
npm run maxima -- make:resource UserResource
npm run maxima -- make:cast MoneyCast
npm run maxima -- make:command SendReportCommand
npm run maxima -- make:rule Uppercase
npm run maxima -- make:seeder DatabaseSeeder
npm run maxima -- make:factory UserFactory
npm run maxima -- make:channel OrdersChannel
npm run maxima -- make:component AlertBox
npm run maxima -- make:enum OrderStatus
npm run maxima -- make:exception DomainException
npm run maxima -- make:interface Billable
npm run maxima -- make:observer UserObserver
npm run maxima -- make:provider BillingProvider
npm run maxima -- make:test FeatureExample
npm run maxima -- make:trait HasUuid
```

Publish editable generator stubs with:

```bash
npm run maxima -- stub:publish
npm run maxima -- vendor:publish --tag stubs
```

Generated files use matching stubs from `src/stubs/*.stub` when present.

## Events, Storage, And Publishing

```bash
npm run maxima -- event:list
npm run maxima -- event:cache
npm run maxima -- event:clear
npm run maxima -- event:generate
npm run maxima -- storage:link
npm run maxima -- storage:unlink
npm run maxima -- lang:publish
npm run maxima -- vendor:publish
npm run maxima -- horizon:status
npm run maxima -- pulse:show
npm run maxima -- telescope:clear
npm run maxima -- sail:up
npm run maxima -- sail:down
npm run maxima -- valet:link maxima
npm run maxima -- homestead:provision local
```

`storage:link` exposes `src/storage/app/public` at `src/public/storage`. `vendor:publish` accepts `--tag stubs` and `--tag lang`.

## Installers And Database Commands

```bash
npm run maxima -- install:api
npm run maxima -- install:auth
npm run maxima -- install:broadcasting
npm run maxima -- migrate
npm run maxima -- migrate:rollback
npm run maxima -- migrate:reset
npm run maxima -- migrate:refresh
npm run maxima -- migrate:fresh
npm run maxima -- migrate:status
npm run maxima -- migrate:install
npm run maxima -- db:seed
npm run maxima -- db:show
npm run maxima -- db:table users
npm run maxima -- db:monitor
npm run maxima -- db:wipe --force
npm run maxima -- schema:dump
npm run maxima -- cache:table
npm run maxima -- session:table
npm run maxima -- notification:table
npm run maxima -- queue:table
npm run maxima -- queue:work
npm run maxima -- queue:listen
npm run maxima -- queue:restart
npm run maxima -- queue:retry all
npm run maxima -- queue:forget 1
npm run maxima -- queue:failed
npm run maxima -- queue:prune-failed
npm run maxima -- queue:monitor
npm run maxima -- queue:failed-table
npm run maxima -- queue:batches-table
npm run maxima -- queue:flush
npm run maxima -- route:list
```

Custom commands may define Laravel-style signatures with required arguments and options:

```typescript
export default class SendReportCommand {
  signature = 'reports:send {user} {--queue}'

  async handle(options, user: string) {
    // ...
  }
}
```
