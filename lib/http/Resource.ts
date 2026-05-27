import { request as requestHelper } from '@lib/foundation/helpers.js'

export class JsonResource {
  [key: string]: any
  static wrap = 'data'

  constructor(protected resource: any) {
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop in target) {
          return Reflect.get(target, prop, receiver)
        }
        if (target.resource && typeof target.resource === 'object' && prop in target.resource) {
          const val = target.resource[prop]
          return typeof val === 'function' ? val.bind(target.resource) : val
        }
        return undefined
      }
    })
  }

  static collection(resource: any) {
    return new AnonymousResourceCollection(resource, this)
  }

  resolve(request?: any): any {
    let req = request
    if (!req) {
      try {
        req = requestHelper()
      } catch {
        // Fallback if request is not available
      }
    }
    const data = this.toArray(req)
    const wrap = (this.constructor as typeof JsonResource).wrap
    return wrap ? { [wrap]: data } : data
  }

  toArray(request: any): any {
    if (this.resource && typeof this.resource.toJSON === 'function') {
      return this.resource.toJSON()
    }
    return this.resource
  }

  toJSON() {
    return this.resolve()
  }
}

export class ResourceCollection extends JsonResource {
  public collection: any[]

  constructor(resource: any, protected resourceClass: any) {
    super(resource)
    const data = Array.isArray(resource) ? resource : (resource?.data ?? [])
    this.collection = data.map((item: any) => new this.resourceClass(item))
  }

  toArray(request: any): any {
    return this.collection.map(item => item.toArray(request))
  }

  resolve(request?: any): any {
    let req = request
    if (!req) {
      try {
        req = requestHelper()
      } catch {
        // Fallback
      }
    }

    const data = this.toArray(req)
    const wrap = this.resourceClass.wrap
    const base = wrap ? { [wrap]: data } : data

    // Handle pagination
    if (this.resource && typeof this.resource === 'object' && 'total' in this.resource) {
      const total = Number(this.resource.total)
      const page = Number(this.resource.page ?? 1)
      const perPage = Number(this.resource.perPage ?? 15)
      const lastPage = Math.ceil(total / perPage)

      return {
        ...base,
        links: {
          first: `/?page=1`,
          last: `/?page=${lastPage}`,
          prev: page > 1 ? `/?page=${page - 1}` : null,
          next: page < lastPage ? `/?page=${page + 1}` : null
        },
        meta: {
          current_page: page,
          from: total > 0 ? (page - 1) * perPage + 1 : null,
          last_page: lastPage,
          per_page: perPage,
          to: total > 0 ? Math.min(page * perPage, total) : null,
          total
        }
      }
    }

    return base
  }
}

class AnonymousResourceCollection extends ResourceCollection {
  constructor(resource: any, resourceClass: any) {
    super(resource, resourceClass)
  }
}
