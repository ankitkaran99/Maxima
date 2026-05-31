import type { Request } from '@lib/http/Request.js'
import { Tenant, type TenantConfig } from './Tenant.js'
import { runWithTenant } from './TenantContext.js'
import { config } from '@lib/foundation/helpers.js'

export type TenantResolver = (identifier: string, type: 'id' | 'domain' | 'subdomain' | 'request', request?: Request) => Tenant | Promise<Tenant | undefined> | undefined
export type TenantLister = () => Tenant[] | Promise<Tenant[]>

export class TenantManagerClass {
  private customResolver?: TenantResolver
  private customLister?: TenantLister
  private tenantsList = new Map<string, Tenant>()

  resolveTenantUsing(resolver: TenantResolver) {
    this.customResolver = resolver
  }

  listTenantsUsing(lister: TenantLister) {
    this.customLister = lister
  }

  reset() {
    this.tenantsList.clear()
    this.customResolver = undefined
    this.customLister = undefined
  }

  registerTenant(tenantConfig: TenantConfig) {
    const tenant = new Tenant(tenantConfig)
    this.tenantsList.set(tenant.id, tenant)
    return tenant
  }

  async resolveById(id: string): Promise<Tenant | undefined> {
    if (this.tenantsList.has(id)) {
      return this.tenantsList.get(id)
    }

    // Try custom resolver
    if (this.customResolver) {
      const result = await this.customResolver(id, 'id')
      if (result) return result
    }

    // Fallback to searching configured list
    const configured = config<TenantConfig[]>('tenancy.tenants', [])
    const found = configured.find(t => t.id === id)
    if (found) {
      return this.registerTenant(found)
    }

    return undefined
  }

  async resolveFromRequest(request: Request): Promise<Tenant | undefined> {
    const identificationMode = config<string>('tenancy.identification', 'subdomain')

    if (this.customResolver) {
      const tenant = await this.customResolver('', 'request', request)
      if (tenant) return tenant
    }

    if (identificationMode === 'header') {
      const headerName = config<string>('tenancy.header_name', 'x-tenant-id')
      const headerValue = request.header(headerName)
      if (headerValue && typeof headerValue === 'string') {
        return this.resolveById(headerValue)
      }
    }

    if (identificationMode === 'cookie') {
      const cookieName = config<string>('tenancy.cookie_name', 'tenant_id')
      const cookieValue = request.cookies()[cookieName]
      if (cookieValue) {
        return this.resolveById(cookieValue)
      }
    }

    const host = request.hostname()
    if (!host) return undefined

    if (identificationMode === 'domain') {
      // Find tenant by matching domain
      const tenant = await this.resolveByDomain(host)
      if (tenant) return tenant
    }

    if (identificationMode === 'subdomain') {
      // Extract subdomain
      const subdomain = this.extractSubdomain(host)
      if (subdomain) {
        const tenant = await this.resolveBySubdomain(subdomain)
        if (tenant) return tenant
      }
    }

    return undefined
  }

  async resolveByDomain(domain: string): Promise<Tenant | undefined> {
    // Check local map
    for (const tenant of this.tenantsList.values()) {
      if (tenant.domain === domain) return tenant
    }

    // Try custom resolver
    if (this.customResolver) {
      const result = await this.customResolver(domain, 'domain')
      if (result) return result
    }

    // Try config
    const configured = config<TenantConfig[]>('tenancy.tenants', [])
    const found = configured.find(t => t.domain === domain)
    if (found) {
      return this.registerTenant(found)
    }

    return undefined
  }

  async resolveBySubdomain(subdomain: string): Promise<Tenant | undefined> {
    // Check local map
    for (const tenant of this.tenantsList.values()) {
      if (tenant.subdomain === subdomain) return tenant
    }

    // Try custom resolver
    if (this.customResolver) {
      const result = await this.customResolver(subdomain, 'subdomain')
      if (result) return result
    }

    // Try config
    const configured = config<TenantConfig[]>('tenancy.tenants', [])
    const found = configured.find(t => t.subdomain === subdomain)
    if (found) {
      return this.registerTenant(found)
    }

    return undefined
  }

  async all(): Promise<Tenant[]> {
    const list: Tenant[] = []

    // Add programmatically registered
    for (const tenant of this.tenantsList.values()) {
      list.push(tenant)
    }

    // Add configured
    const configured = config<TenantConfig[]>('tenancy.tenants', [])
    for (const conf of configured) {
      if (!list.some(t => t.id === conf.id)) {
        list.push(new Tenant(conf))
      }
    }

    // Add from custom lister
    if (this.customLister) {
      const custom = await this.customLister()
      for (const t of custom) {
        if (!list.some(x => x.id === t.id)) {
          list.push(t)
        }
      }
    }

    return list
  }

  async run<T>(tenantId: string, callback: () => T | Promise<T>): Promise<T> {
    const tenant = await this.resolveById(tenantId)
    if (!tenant) {
      throw new Error(`Tenant [${tenantId}] not found.`)
    }
    return runWithTenant(tenant, callback) as Promise<T>
  }

  private extractSubdomain(host: string): string | undefined {
    const centralDomains = config<string[]>('tenancy.central_domains', ['localhost', '127.0.0.1'])
    
    // Normalize host (remove port)
    const hostname = host.split(':')[0].toLowerCase()

    for (const centralDomain of centralDomains) {
      const central = centralDomain.toLowerCase()
      if (hostname === central) return undefined
      if (hostname.endsWith('.' + central)) {
        return hostname.substring(0, hostname.length - central.length - 1)
      }
    }

    // If host has at least 3 parts, assume first part is subdomain
    const parts = hostname.split('.')
    if (parts.length > 2) {
      return parts[0]
    }

    return undefined
  }
}

export const TenantManager = new TenantManagerClass()
