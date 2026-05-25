import type { Application } from '@lib/foundation/Application.js'

type Accessor = string | symbol | Function

export abstract class Facade {
  protected static app?: Application
  private static resolvedInstances = new Map<Accessor, unknown>()

  static setApplication(app: Application) {
    Facade.app = app
  }

  static clearResolvedInstance(accessor?: Accessor) {
    if (accessor) {
      Facade.resolvedInstances.delete(accessor)
    } else {
      Facade.resolvedInstances.clear()
    }
  }

  static getFacadeRoot<T = unknown>(): Promise<T> {
    return this.resolveFacadeInstance<T>(this.getFacadeAccessor())
  }

  static swap(instance: unknown) {
    const accessor = this.getFacadeAccessor()
    Facade.resolvedInstances.set(accessor, instance)
    Facade.app?.instance(accessor as any, instance as any)
    return instance
  }

  static fake<T extends object = Record<string, unknown>>(implementation: T = {} as T) {
    return this.swap(implementation) as T
  }

  static spy<T extends object = Record<string, unknown>>(implementation: T = {} as T) {
    const calls: Array<{ method: string, args: unknown[] }> = []
    const proxy = new Proxy(implementation, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          calls.push({ method: String(property), args })
          return value.apply(target, args)
        }
      }
    }) as T & { calls: typeof calls }
    ;(proxy as any).calls = calls
    return this.swap(proxy) as T & { calls: typeof calls }
  }

  protected static getFacadeAccessor(): Accessor {
    throw new Error('Facade does not implement getFacadeAccessor().')
  }

  protected static async resolveFacadeInstance<T = unknown>(accessor: Accessor): Promise<T> {
    if (Facade.resolvedInstances.has(accessor)) return Facade.resolvedInstances.get(accessor) as T
    if (!Facade.app) throw new Error('Facade application has not been set.')
    const instance = await Facade.app.make<T>(accessor as any)
    Facade.resolvedInstances.set(accessor, instance)
    return instance
  }
}
