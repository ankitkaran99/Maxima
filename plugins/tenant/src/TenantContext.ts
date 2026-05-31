import { AsyncLocalStorage } from 'node:async_hooks'
import { Tenant } from './Tenant.js'

export const tenantStorage = new AsyncLocalStorage<Tenant>()

export function currentTenant(): Tenant | undefined {
  return tenantStorage.getStore()
}

export function runWithTenant<T>(tenant: Tenant, callback: () => T | Promise<T>): T | Promise<T> {
  return tenantStorage.run(tenant, callback)
}
