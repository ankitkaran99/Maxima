# Maxima

Maxima is a Laravel-inspired TypeScript framework built on Fastify. It includes routing, controllers, middleware, dependency injection, validation, database and ORM tools, queues, mail, notifications, caching, storage, events, broadcasting, scheduling, logging, testing helpers, and a CLI.

## Quick Start

```bash
npm install
npm run dev
```

Run tests:

```bash
npm test
```

Use the CLI:

```bash
npm run maxima -- --help
npm run maxima -- about
npm run maxima -- make:controller UserController
```

## Documentation

Start with the documentation index:

- [Documentation Index](./docs/README.md)
- [Getting Started](./docs/getting-started.md)
- [Configuration Reference](./docs/configuration-reference.md)
- [CLI](./docs/cli.md)

## Project Layout

- `src/`: application code, routes, configuration, resources, database files, public assets, and storage.
- `lib/`: core framework source.
- `tests/`: Vitest test suite.
- `docs/`: framework documentation.
