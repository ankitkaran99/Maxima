export interface TenantConfig {
  id: string
  domain?: string
  subdomain?: string
  database?: Record<string, any> // custom DB configuration override
  storage?: {
    disks?: Record<string, Record<string, any>> // custom disk settings
  }
  data?: Record<string, any> // arbitrary custom data
}

export class Tenant {
  constructor(public readonly config: TenantConfig) {}

  get id(): string {
    return this.config.id
  }

  get domain(): string | undefined {
    return this.config.domain
  }

  get subdomain(): string | undefined {
    return this.config.subdomain
  }

  get(key: string, defaultValue?: any): any {
    const parts = key.split('.')
    const data = this.config.data ?? {}
    const value = parts.reduce<any>((current, segment) => current?.[segment], data)
    return value === undefined ? defaultValue : value
  }
}
