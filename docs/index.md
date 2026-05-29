# Maxima Documentation

This directory contains the framework documentation for Maxima.

## Start Here

- [Getting Started](./getting-started.md): installation, project structure, configuration basics, service providers, and performance benchmarks.
- [Configuration Reference](./configuration-reference.md): all shipped `src/config` files and their major keys.
- [CLI](./cli.md): application commands, generators, cache commands, queues, migrations, and runtime tools.

## HTTP And Application Layer

- [Routing & Middleware](./routing-middleware.md): routes, parameters, groups, signed URLs, middleware, and route caching.
- [Controllers, Requests, & Responses](./controllers-requests-responses.md): controllers, request input, uploaded files, validation state, responses, and exception handling.
- [API Resources](./api-resources.md): JSON resource transformers and resource collections.
- [HTTP Client](./http-client.md): outgoing HTTP requests, middleware, pools, fakes, sequences, and macros.
- [Rate Limiting And Security Middleware](./rate-limiting-security.md): named limiters, manual attempts, CSRF, sessions, cookies, and signed URL middleware.

## Data And State

- [Database & ORM](./database-orm.md): query builder, transactions, models, relationships, factories, seeders, and schema builder.
- [Cache](./cache.md): stores, remember helpers, tags, locks, events, and testing.
- [Session](./configuration-reference.md#session): session configuration. Request and middleware behavior is covered in [Rate Limiting And Security Middleware](./rate-limiting-security.md).
- [File Storage](./storage.md): disks, file operations, streams, URLs, visibility, scoped/read-only disks, and testing.
- [Uploaded Files](./uploaded-files.md): upload metadata and storage helpers.

## Auth, Validation, And Security

- [Authentication & Authorization](./authentication-authorization.md): guards, providers, login flow, throttling, gates, and policies.
- [Validation & Form Requests](./validation.md): schemas, validators, form requests, custom rules, and validated input.
- [Security & Cryptography](./security-cryptography.md): encryption, decryption, hashing, and key rotation.

## Async Work And Runtime

- [Queues & Background Jobs](./queues.md): jobs, dispatching, unique jobs, middleware, failures, workers, and testing.
- [Task Scheduling](./scheduling.md): scheduled closures, jobs, commands, frequencies, constraints, and scheduler runtime.
- [Events](./events.md): events, listeners, queued listeners, subscribers, broadcasting, deferred dispatch, and testing.
- [Broadcasting & WebSockets](./broadcasting.md): broadcastable events, channel auth, presence channels, WebSocket protocol, and drivers.
- [Processes, Context, And Concurrency](./processes-concurrency.md): process execution, fakes, async context, and bounded concurrency.

## User-Facing Output

- [Views And Templating](./views-templating.md): Edge views, Blade-style directives, layouts, composers, fragments, emails, and view cache.
- [Mail & Notifications](./mail-notifications.md): mailables, transports, queues, notification channels, routing, and testing.
- [Localization & Translation](./localization.md): translation files, placeholders, pluralization, scoped locales, vendor translations, and missing-key events.

## Framework Internals And DX

- [Dependency Injection & Container](./dependency-injection-container.md): bindings, aliases, resolution, contextual bindings, tags, extenders, and lifecycle hooks.
- [Facades And Contracts](./facades-contracts.md): facade roots, swaps, fakes, spies, and contract symbols.
- [Helper Functions](./helper-functions.md): global helpers for app services, URLs, requests, responses, views, localization, and paths.
- [Logging](./logging.md): channels, stacks, levels, context, deprecations, taps, processors, custom drivers, and testing.
- [Observability And Runtime Tools](./observability.md): Telescope, Pulse, Horizon, Scout, Pennant, Reverb, Boost, Sail, Valet, Homestead, and Octane.
- [Support Utilities](./support-utilities.md): collections, lazy collections, strings, arrays, objects, URIs, number formatting, and macro registry.
- [Testing](./testing.md): database assertions, response assertions, auth helpers, time travel, fakes, console testing, browser assertions, snapshots, and views.

## Suggested Reading Paths

For building a web API: [Getting Started](./getting-started.md), [Routing & Middleware](./routing-middleware.md), [Controllers, Requests, & Responses](./controllers-requests-responses.md), [Validation & Form Requests](./validation.md), [API Resources](./api-resources.md), and [Database & ORM](./database-orm.md).

For background work: [Queues & Background Jobs](./queues.md), [Task Scheduling](./scheduling.md), [Events](./events.md), [Processes, Context, And Concurrency](./processes-concurrency.md), and [Logging](./logging.md).

For production configuration: [Configuration Reference](./configuration-reference.md), [Security & Cryptography](./security-cryptography.md), [Rate Limiting And Security Middleware](./rate-limiting-security.md), [File Storage](./storage.md), and [Logging](./logging.md).
