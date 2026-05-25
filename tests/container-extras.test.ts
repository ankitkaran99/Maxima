import { describe, it, expect } from 'vitest'
import { Container } from '../lib/container/Container.js'

describe('Service Container Upgrades', () => {
  it('supports contextual binding', async () => {
    const container = new Container()

    // Abstract interfaces/classes
    abstract class Writer {
      abstract write(): string
    }

    class FileWriter extends Writer {
      write() { return 'file' }
    }

    class ConsoleWriter extends Writer {
      write() { return 'console' }
    }

    // Concrete classes that inject Writer
    class LogReport {
      static inject = [Writer]
      constructor(public writer: Writer) {}
    }

    class AdminReport {
      static inject = [Writer]
      constructor(public writer: Writer) {}
    }

    // Register default
    container.bind(Writer, () => new ConsoleWriter())

    // Setup contextual bindings
    container.when(LogReport).needs(Writer).give(() => new FileWriter())
    // AdminReport doesn't have a contextual binding, so it should fall back to default ConsoleWriter

    const logReport = await container.make(LogReport)
    const adminReport = await container.make(AdminReport)

    expect(logReport.writer.write()).toBe('file')
    expect(adminReport.writer.write()).toBe('console')
  })

  it('resolves constructors as contextual binding target values', async () => {
    const container = new Container()

    abstract class Database {
      abstract query(): string
    }

    class Sqlite implements Database {
      query() { return 'sqlite' }
    }

    class Postgres implements Database {
      query() { return 'postgres' }
    }

    class AppService {
      static inject = [Database]
      constructor(public db: Database) {}
    }

    // Register implementations
    container.bind(Sqlite, () => new Sqlite())
    container.bind(Postgres, () => new Postgres())

    // Give a class reference
    container.when(AppService).needs(Database).give(Postgres)

    const service = await container.make(AppService)
    expect(service.db.query()).toBe('postgres')
  })

  it('supports resolving hooks', async () => {
    const container = new Container()
    let globalResolvingCount = 0
    let serviceResolvingCount = 0
    let afterResolvingCount = 0

    class DummyService {
      name = 'original'
    }

    container.bind(DummyService, () => new DummyService())

    container.resolving((instance) => {
      globalResolvingCount++
    })

    container.resolving(DummyService, (instance: DummyService) => {
      serviceResolvingCount++
      instance.name = 'resolved'
    })

    container.afterResolving(DummyService, (instance: DummyService) => {
      afterResolvingCount++
      instance.name = 'after-resolved'
    })

    const instance = await container.make(DummyService)
    expect(instance.name).toBe('after-resolved')
    expect(globalResolvingCount).toBe(1)
    expect(serviceResolvingCount).toBe(1)
    expect(afterResolvingCount).toBe(1)
  })

  it('supports binding tagging', async () => {
    const container = new Container()

    class A { val = 'A' }
    class B { val = 'B' }

    container.bind('a', () => new A())
    container.bind('b', () => new B())

    container.tag(['a', 'b'], 'letters')

    const resolved = await container.tagged('letters')
    expect(resolved).toHaveLength(2)
    expect(resolved[0].val).toBe('A')
    expect(resolved[1].val).toBe('B')
  })

  it('supports binding extends/decorators', async () => {
    const container = new Container()

    class Helper {
      val = 'original'
    }

    container.bind(Helper, () => new Helper())

    container.extend(Helper, (instance) => {
      instance.val = 'decorated'
      return instance
    })

    const instance = await container.make(Helper)
    expect(instance.val).toBe('decorated')
  })

  it('decorates unregistered classes when extended', async () => {
    const container = new Container()

    class Unregistered {
      val = 'original'
    }

    container.extend(Unregistered, (instance) => {
      instance.val = 'decorated-unregistered'
      return instance
    })

    const instance = await container.make(Unregistered)
    expect(instance.val).toBe('decorated-unregistered')
  })

  it('decorates already resolved singletons on extend', async () => {
    const container = new Container()

    class Config {
      debug = false
    }

    container.singleton(Config, () => new Config())

    // First resolve
    const configInstance = await container.make(Config)
    expect(configInstance.debug).toBe(false)

    // Extend after resolution
    container.extend(Config, (instance) => {
      instance.debug = true
      return instance
    })

    // Resolve again
    const secondInstance = await container.make(Config)
    expect(secondInstance.debug).toBe(true)
    expect(configInstance).toBe(secondInstance) // Same singleton instance reference
  })
})
