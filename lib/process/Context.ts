import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage<Record<string, any>>()

export class ContextManager {
  get<T = any>(key: string, defaultValue?: T): T {
    return storage.getStore()?.[key] ?? defaultValue
  }

  set(key: string, value: any) {
    const store = storage.getStore()
    if (store) store[key] = value
    return this
  }

  all() {
    return { ...storage.getStore() }
  }

  run<T>(values: Record<string, any>, callback: () => T) {
    return storage.run({ ...storage.getStore(), ...values }, callback)
  }

  forget(key: string) {
    const store = storage.getStore()
    if (store) delete store[key]
  }
}

export const Context = new ContextManager()
