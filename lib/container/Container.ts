export type Constructor<T = unknown> = new (...args: any[]) => T
export type AbstractConstructor<T = unknown> = abstract new (...args: any[]) => T
export type ContainerKey<T = unknown> = string | symbol | Constructor<T> | AbstractConstructor<T>
export type ContainerFactory<T = unknown> = (container: Container) => T | Promise<T>
export type InjectableConstructor<T = unknown> = Constructor<T> & { inject?: ContainerKey[] }

type Binding<T = unknown> = {
  factory: ContainerFactory<T>
  singleton: boolean
  instance?: T
}

export class ContextualBindingBuilder {
  constructor(private container: Container, private concrete: ContainerKey) {}

  needs(abstractKey: ContainerKey) {
    return {
      give: (implementation: any) => {
        this.container.addContextualBinding(this.concrete, abstractKey, implementation)
      }
    }
  }
}

export class Container {
  private bindings = new Map<ContainerKey, Binding>()
  private aliases = new Map<string, ContainerKey>()
  private contextualBindings = new Map<ContainerKey, Map<ContainerKey, any>>()
  private tags = new Map<string, ContainerKey[]>()

  private resolvingCallbacks = new Map<ContainerKey, Function[]>()
  private globalResolvingCallbacks: Function[] = []
  private afterResolvingCallbacks = new Map<ContainerKey, Function[]>()
  private globalAfterResolvingCallbacks: Function[] = []

  bind<T>(key: ContainerKey<T>, factory: ContainerFactory<T>) {
    this.bindings.set(key, { factory, singleton: false })
    return this
  }

  singleton<T>(key: ContainerKey<T>, factory: ContainerFactory<T>) {
    this.bindings.set(key, { factory, singleton: true })
    return this
  }

  instance<T>(key: ContainerKey<T>, value: T) {
    this.bindings.set(key, { factory: () => value, singleton: true, instance: value })
    return this
  }

  alias(alias: string, key: ContainerKey) {
    this.aliases.set(alias, key)
    return this
  }

  private resolveKey(key: ContainerKey): ContainerKey {
    let current = key
    const visited = new Set<ContainerKey>()
    while (typeof current === 'string' && this.aliases.has(current)) {
      if (visited.has(current)) {
        throw new Error(`Circular alias dependency detected for [${current}].`)
      }
      visited.add(current)
      current = this.aliases.get(current)!
    }
    return current
  }

  async make<T>(key: ContainerKey<T>): Promise<T> {
    const resolvedKey = this.resolveKey(key) as ContainerKey<T>
    const binding = this.bindings.get(resolvedKey)

    let value: any

    if (binding) {
      if (binding.singleton && binding.instance !== undefined) return binding.instance as T
      value = await binding.factory(this)
      if (binding.singleton) binding.instance = value
    } else if (typeof resolvedKey === 'function') {
      value = await this.build(resolvedKey as Constructor<T>)
    } else {
      throw new Error(`Container binding [${String(key)}] is not registered.`)
    }

    await this.fireResolvingCallbacks(resolvedKey, value)
    await this.fireAfterResolvingCallbacks(resolvedKey, value)

    return value as T
  }

  resolve<T>(key: ContainerKey<T>) {
    return this.make<T>(key)
  }

  async build<T>(Target: InjectableConstructor<T>, extra: unknown[] = []) {
    const dependencies = await Promise.all(
      (Target.inject ?? []).map(key => this.makeWithContext(key, Target))
    )
    return new Target(...dependencies, ...extra)
  }

  has(key: ContainerKey) {
    const resolvedKey = this.resolveKey(key)
    return this.bindings.has(resolvedKey) || (typeof key === 'string' && this.aliases.has(key))
  }

  // Contextual binding API
  when(concrete: ContainerKey) {
    return new ContextualBindingBuilder(this, concrete)
  }

  addContextualBinding(concrete: ContainerKey, abstractKey: ContainerKey, implementation: any) {
    if (!this.contextualBindings.has(concrete)) {
      this.contextualBindings.set(concrete, new Map())
    }
    this.contextualBindings.get(concrete)!.set(abstractKey, implementation)
  }

  private async makeWithContext<T>(key: ContainerKey<T>, parentConcrete: ContainerKey): Promise<T> {
    const contextual = this.contextualBindings.get(parentConcrete)?.get(key)
    if (contextual !== undefined) {
      if (typeof contextual === 'function' && !this.isConstructor(contextual)) {
        return (contextual as Function)(this)
      }
      if (typeof contextual === 'string' || typeof contextual === 'symbol' || this.isConstructor(contextual)) {
        if (this.has(contextual)) {
          return this.make(contextual)
        }
      }
      return contextual as T
    }
    return this.make(key)
  }

  private isConstructor(value: any): boolean {
    return typeof value === 'function' && !!value.prototype && value.prototype.constructor === value
  }

  // Resolving Hooks API
  resolving(key: ContainerKey | Function, callback?: Function) {
    if (typeof key === 'function' && callback === undefined) {
      this.globalResolvingCallbacks.push(key)
    } else {
      const bucket = this.resolvingCallbacks.get(key as ContainerKey) ?? []
      bucket.push(callback!)
      this.resolvingCallbacks.set(key as ContainerKey, bucket)
    }
    return this
  }

  afterResolving(key: ContainerKey | Function, callback?: Function) {
    if (typeof key === 'function' && callback === undefined) {
      this.globalAfterResolvingCallbacks.push(key)
    } else {
      const bucket = this.afterResolvingCallbacks.get(key as ContainerKey) ?? []
      bucket.push(callback!)
      this.afterResolvingCallbacks.set(key as ContainerKey, bucket)
    }
    return this
  }

  private async fireResolvingCallbacks(key: ContainerKey, instance: any) {
    for (const callback of this.globalResolvingCallbacks) {
      await Promise.resolve(callback(instance, this))
    }
    const keyCallbacks = this.resolvingCallbacks.get(key)
    if (keyCallbacks) {
      for (const callback of keyCallbacks) {
        await Promise.resolve(callback(instance, this))
      }
    }
  }

  private async fireAfterResolvingCallbacks(key: ContainerKey, instance: any) {
    for (const callback of this.globalAfterResolvingCallbacks) {
      await Promise.resolve(callback(instance, this))
    }
    const keyCallbacks = this.afterResolvingCallbacks.get(key)
    if (keyCallbacks) {
      for (const callback of keyCallbacks) {
        await Promise.resolve(callback(instance, this))
      }
    }
  }

  // Tagging API
  tag(keys: ContainerKey | ContainerKey[], tag: string) {
    const array = Array.isArray(keys) ? keys : [keys]
    const existing = this.tags.get(tag) ?? []
    this.tags.set(tag, [...existing, ...array])
  }

  async tagged(tag: string): Promise<any[]> {
    const keys = this.tags.get(tag) ?? []
    return Promise.all(keys.map(key => this.make(key)))
  }

  // Extends/Decorators API
  extend<T>(key: ContainerKey<T>, decorator: (instance: T, container: Container) => T | Promise<T>) {
    const resolvedKey = this.resolveKey(key) as ContainerKey<T>
    const binding = this.bindings.get(resolvedKey)

    if (!binding) {
      if (typeof resolvedKey === 'function') {
        this.bind(resolvedKey, async (c) => {
          const instance = await c.build(resolvedKey as Constructor<T>)
          return decorator(instance, c)
        })
        return this
      }
      throw new Error(`Cannot extend [${String(key)}] because it is not bound in the container.`)
    }

    const originalFactory = binding.factory
    binding.factory = async (container) => {
      const instance = await originalFactory(container) as T
      return decorator(instance, container)
    }

    if (binding.singleton && binding.instance !== undefined) {
      const decorated = decorator(binding.instance as T, this)
      if (decorated instanceof Promise) {
        throw new Error(`Cannot extend already-resolved singleton [${String(key)}] with an asynchronous decorator.`)
      }
      binding.instance = decorated
    }

    return this
  }
}

export abstract class ServiceProvider {
  static deferred = false
  static provides: ContainerKey[] = []
  private static publishedPaths = new Map<Function, Record<string, string>>()
  private static publishedGroups = new Map<string, Record<string, string>>()

  constructor(protected app: Container) {}
  register(): void | Promise<void> {}
  boot(): void | Promise<void> {}

  protected publishes(paths: Record<string, string>, group?: string) {
    const Provider = this.constructor
    ServiceProvider.publishedPaths.set(Provider, {
      ...(ServiceProvider.publishedPaths.get(Provider) ?? {}),
      ...paths
    })
    if (group) {
      ServiceProvider.publishedGroups.set(group, {
        ...(ServiceProvider.publishedGroups.get(group) ?? {}),
        ...paths
      })
    }
  }

  static pathsToPublish(provider?: Function, group?: string) {
    if (group) return this.publishedGroups.get(group) ?? {}
    if (provider) return this.publishedPaths.get(provider) ?? {}
    return Object.assign({}, ...this.publishedPaths.values())
  }

  static publishGroups() {
    return Object.fromEntries(this.publishedGroups)
  }
}
