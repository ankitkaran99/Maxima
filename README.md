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

- [Documentation Index](./docs/index.md)

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

