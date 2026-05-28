import { Container, ServiceProvider } from '@lib/container/Container.js'
import { ConfigRepository } from '@lib/config/ConfigRepository.js'
import { EnvRepository } from '@lib/config/Env.js'
import { configPath, basePath, projectRoot } from '@lib/support/paths.js'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export class Application extends Container {
  readonly env = new EnvRepository()
  readonly config = new ConfigRepository()
  private providers: ServiceProvider[] = []
  private bootedProviders = new WeakSet<ServiceProvider>()
  private deferredProviders = new Map<any, new (app: Application) => ServiceProvider>()
  private loadedDeferredProviders = new Set<new (app: Application) => ServiceProvider>()
  private bootingCallbacks: Array<(app: Application) => void | Promise<void>> = []
  private bootedCallbacks: Array<(app: Application) => void | Promise<void>> = []

  constructor(public readonly rootPath = process.cwd()) {
    super()
    process.env.MAXIMA_BASE_PATH = rootPath
    this.instance(Application, this)
    this.instance('app', this)
    this.instance(ConfigRepository, this.config)
    this.instance(EnvRepository, this.env)
  }

  async bootstrap() {
    this.env.load(path.join(projectRoot(), '.env'))
    await this.config.load(configPath())
    
    const { registerGlobalHelpers } = await import('@lib/foundation/helpers.js')
    registerGlobalHelpers()

    await this.registerConfiguredProviders()
    await this.bootProviders()

    const { Event } = await import('@lib/events/Event.js')
    if (this.config.get('events.discover', true)) await Event.discover(this.rootPath)

    // Load and register all database factories
    const { Factory, FactoryRegistry } = await import('@lib/database/Factory.js')
    const { toFileUrl } = await import('@lib/support/paths.js')

    const factoriesPath = basePath('database', 'factories')
    if (fsSync.existsSync(factoriesPath)) {
      try {
        const files = await fs.readdir(factoriesPath)
        for (const file of files) {
          if ((file.endsWith('.ts') || file.endsWith('.js')) && !file.endsWith('.d.ts')) {
            const mod = await import(`${toFileUrl(path.join(factoriesPath, file))}?t=${Date.now()}`)
            for (const key of Object.keys(mod)) {
              const ExportedClass = mod[key]
              if (typeof ExportedClass === 'function' && ExportedClass.prototype instanceof Factory) {
                const instance = new (ExportedClass as any)()
                if (instance.model) {
                  FactoryRegistry.register(instance.model, ExportedClass)
                }
              }
            }
          }
        }
      } catch (err) {
        // Ignore
      }
    }

    return this
  }

  async register(providerClass: new (app: Application) => ServiceProvider) {
    const providerMetadata = providerClass as unknown as typeof ServiceProvider
    if (providerMetadata.deferred) {
      const provides = providerMetadata.provides ?? []
      for (const key of provides) this.deferredProviders.set(key, providerClass)
      return new providerClass(this)
    }

    const provider = new providerClass(this)
    this.providers.push(provider)
    await provider.register()
    return provider
  }

  async bootProviders() {
    for (const callback of this.bootingCallbacks) await callback(this)
    for (const provider of this.providers) {
      if (this.bootedProviders.has(provider)) continue
      await provider.boot()
      this.bootedProviders.add(provider)
    }
    for (const callback of this.bootedCallbacks) await callback(this)
    return this
  }

  booting(callback: (app: Application) => void | Promise<void>) {
    this.bootingCallbacks.push(callback)
    return this
  }

  booted(callback: (app: Application) => void | Promise<void>) {
    this.bootedCallbacks.push(callback)
    return this
  }

  async make<T>(key: any): Promise<T> {
    if (!super.has(key) && this.deferredProviders.has(key)) {
      await this.loadDeferredProvider(this.deferredProviders.get(key)!)
    }
    return super.make<T>(key)
  }

  has(key: any) {
    return super.has(key) || this.deferredProviders.has(key)
  }

  async loadDeferredProvider(providerClass: new (app: Application) => ServiceProvider) {
    if (this.loadedDeferredProviders.has(providerClass)) return
    this.loadedDeferredProviders.add(providerClass)
    const provider = new providerClass(this)
    this.providers.push(provider)
    await provider.register()
    if (this.bootedProviders.has(provider)) return
    await provider.boot()
    this.bootedProviders.add(provider)
  }

  private async registerConfiguredProviders() {
    const providers = [
      ...(await this.discoveredProviders()),
      ...this.config.get<Array<new (app: Application) => ServiceProvider>>('app.providers', [])
    ]
    for (const provider of providers) await this.register(provider)
  }

  private async discoveredProviders() {
    const packagePath = path.join(this.rootPath, 'package.json')
    if (!fsSync.existsSync(packagePath)) return []
    try {
      const pkg = JSON.parse(fsSync.readFileSync(packagePath, 'utf8'))
      const providers: Array<new (app: Application) => ServiceProvider> = []
      for (const entry of pkg.extra?.maxima?.providers ?? []) {
        if (typeof entry !== 'string') continue
        const modulePath = entry.startsWith('.') ? pathToFileURL(path.join(this.rootPath, entry)).href : entry
        const mod = await import(modulePath)
        const Provider = mod.default ?? mod[Object.keys(mod)[0]]
        if (typeof Provider === 'function') providers.push(Provider)
      }
      return providers
    } catch {
      return []
    }
  }
}
