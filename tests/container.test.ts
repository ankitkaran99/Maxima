import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { Container, ServiceProvider } from '@lib/container/Container.js'
import { Contracts } from '@lib/contracts/Contracts.js'
import { Facade } from '@lib/support/Facade.js'
import { FrameworkServiceProvider } from '@lib/providers/FrameworkServiceProvider.js'

class Dependency {
  value = 'resolved'
}

class ServiceWithDependency {
  static inject = [Dependency]

  constructor(public dependency: Dependency) {}
}

class ConfiguredProvider extends ServiceProvider {
  register() {
    this.app.singleton('configured.value', () => ({ ready: true }))
  }

  boot() {
    this.app.instance('configured.booted', true)
  }
}

class DeferredValueProvider extends ServiceProvider {
  static deferred = true
  static provides = ['deferred.value']
  static registered = 0
  static booted = 0

  register() {
    DeferredValueProvider.registered++
    this.app.instance('deferred.value', { loaded: true })
  }

  boot() {
    DeferredValueProvider.booted++
  }
}

class PublishableProvider extends ServiceProvider {
  register() {
    this.publishes({ '/package/config.php': '/app/config/package.php' }, 'config')
  }
}

class ValueFacade extends Facade {
  protected static getFacadeAccessor() {
    return 'facade.value'
  }
}

describe('Container', () => {
  it('resolves singleton bindings once', async () => {
    const container = new Container()
    let count = 0
    container.singleton('value', () => ({ count: ++count }))

    expect(await container.make('value')).toEqual({ count: 1 })
    expect(await container.make('value')).toEqual({ count: 1 })
  })

  it('resolves transient bindings each time', async () => {
    const container = new Container()
    let count = 0
    container.bind('value', () => ({ count: ++count }))

    expect(await container.make('value')).toEqual({ count: 1 })
    expect(await container.make('value')).toEqual({ count: 2 })
  })

  it('resolves aliases to their target bindings', async () => {
    const container = new Container()
    container.instance('database.connection', { name: 'primary' })
    container.alias('db', 'database.connection')

    expect(container.has('db')).toBe(true)
    expect(await container.make('db')).toEqual({ name: 'primary' })
  })

  it('resolves recursive aliases and handles circular dependencies', async () => {
    const container = new Container()
    container.instance('database.connection', { name: 'primary' })
    container.alias('db', 'database.connection')
    container.alias('db-alias', 'db')
    container.alias('db-alias-alias', 'db-alias')

    expect(container.has('db-alias-alias')).toBe(true)
    expect(await container.make('db-alias-alias')).toEqual({ name: 'primary' })

    container.alias('circular-1', 'circular-2')
    container.alias('circular-2', 'circular-1')

    await expect(container.make('circular-1')).rejects.toThrow('Circular alias dependency detected')
  })

  it('builds classes with declared constructor dependencies', async () => {
    const container = new Container()
    container.singleton(Dependency, () => new Dependency())

    const service = await container.make(ServiceWithDependency)

    expect(service).toBeInstanceOf(ServiceWithDependency)
    expect(service.dependency.value).toBe('resolved')
  })

  it('runs service provider register and boot lifecycle hooks', async () => {
    const app = new Application()

    await app.register(ConfiguredProvider)
    await app.bootProviders()

    expect(await app.make('configured.value')).toEqual({ ready: true })
    expect(await app.make('configured.booted')).toBe(true)
  })

  it('runs application booting and booted callbacks', async () => {
    const app = new Application()
    const events: string[] = []

    app.booting(() => { events.push('booting') })
    app.booted(() => { events.push('booted') })
    await app.register(ConfiguredProvider)
    await app.bootProviders()

    expect(events).toEqual(['booting', 'booted'])
  })

  it('loads deferred providers when a provided binding is requested', async () => {
    DeferredValueProvider.registered = 0
    DeferredValueProvider.booted = 0
    const app = new Application()

    await app.register(DeferredValueProvider)

    expect(app.has('deferred.value')).toBe(true)
    expect(DeferredValueProvider.registered).toBe(0)
    expect(await app.make('deferred.value')).toEqual({ loaded: true })
    expect(DeferredValueProvider.registered).toBe(1)
    expect(DeferredValueProvider.booted).toBe(1)
  })

  it('tracks publish paths and groups from service providers', async () => {
    const app = new Application()

    await app.register(PublishableProvider)

    expect(ServiceProvider.pathsToPublish(PublishableProvider)).toEqual({
      '/package/config.php': '/app/config/package.php'
    })
    expect(ServiceProvider.pathsToPublish(undefined, 'config')).toEqual({
      '/package/config.php': '/app/config/package.php'
    })
    expect(ServiceProvider.publishGroups()).toHaveProperty('config')
  })

  it('binds documented framework contract tokens', async () => {
    const app = new Application()
    setApplication(app)

    await app.register(FrameworkServiceProvider)

    expect(await app.make(Contracts.Container)).toBe(app)
    expect(await app.make(Contracts.Cache)).toBe(await app.make('cache'))
    expect(await app.make(Contracts.Routing)).toBe(await app.make('router'))
    expect(await app.make(Contracts.Logging)).toBe(await app.make('logger'))
  })

  it('supports facade roots, swapping, fakes, and spies', async () => {
    const app = new Application()
    setApplication(app)
    app.instance('facade.value', { name: () => 'real' })

    expect((await ValueFacade.getFacadeRoot<any>()).name()).toBe('real')
    ValueFacade.swap({ name: () => 'swapped' })
    expect((await app.make<any>('facade.value')).name()).toBe('swapped')
    expect((await ValueFacade.getFacadeRoot<any>()).name()).toBe('swapped')

    ValueFacade.fake({ name: () => 'fake' })
    expect((await ValueFacade.getFacadeRoot<any>()).name()).toBe('fake')

    const spy = ValueFacade.spy({ name: () => 'spy' })
    expect((await ValueFacade.getFacadeRoot<any>()).name()).toBe('spy')
    expect(spy.calls).toEqual([{ method: 'name', args: [] }])
  })

  it('discovers package providers from package metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-provider-discovery-'))
    const providerPath = path.join(root, 'DiscoveredProvider.ts')
    await fs.writeFile(providerPath, `
      import { ServiceProvider } from '@lib/container/Container.js'
      export default class DiscoveredProvider extends ServiceProvider {
        register() { this.app.instance('discovered.value', true) }
      }
    `)
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      extra: { maxima: { providers: ['./DiscoveredProvider.ts'] } }
    }))

    const app = new Application(root)
    await app.bootstrap()

    expect(await app.make('discovered.value')).toBe(true)
    await fs.rm(root, { recursive: true, force: true })
  })
})

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
