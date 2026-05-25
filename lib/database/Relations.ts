import type { Model } from '@lib/database/Model.js'
import { SerializableModelRegistry } from '@lib/database/SerializableModelRegistry.js'
import { DB } from '@lib/database/DB.js'

type ModelReference<T extends typeof Model> = T | string | (() => T | Promise<T>)

export class Relation<T extends typeof Model> {
  private resolvedRelated?: T

  constructor(
    protected parent: Model,
    protected Related: ModelReference<T>,
    protected foreignKey?: string,
    protected ownerKey = 'id'
  ) {}

  protected async related() {
    if (this.resolvedRelated) return this.resolvedRelated
    const Related = await resolveModel(this.Related)
    this.resolvedRelated = Related
    return Related
  }

  // Abstract base signature for bulk eager loading
  async eagerLoad(relationName: string, models: Model[], callback?: (query: any) => void): Promise<void> {
    throw new Error('Eager loading is not implemented for this relation.')
  }
}

export class HasMany<T extends typeof Model> extends Relation<T> {
  private oneOfMany?: { column: string, aggregate: 'max' | 'min' }

  latestOfMany(column = 'id') {
    return this.ofMany(column, 'max')
  }

  oldestOfMany(column = 'id') {
    return this.ofMany(column, 'min')
  }

  ofMany(column = 'id', aggregate: 'max' | 'min' = 'max') {
    this.oneOfMany = { column, aggregate }
    return this
  }

  async get() {
    const Related = await this.related()
    const foreignKey = this.foreignKey ?? `${this.parent.constructor.name.toLowerCase()}_id`
    const query = Related.where(foreignKey, (this.parent as any)[this.ownerKey])
    if (this.oneOfMany) {
      query.orderBy(this.oneOfMany.column, this.oneOfMany.aggregate === 'max' ? 'desc' : 'asc').limit(1)
    }
    return query.get()
  }

  async first() {
    const results = await this.get()
    return results[0] ?? null
  }

  async eagerLoad(relationName: string, models: Model[], callback?: (query: any) => void) {
    const Related = await this.related()
    const foreignKey = this.foreignKey ?? `${this.parent.constructor.name.toLowerCase()}_id`
    const ownerKey = this.ownerKey

    const parentKeys = models.map(model => (model as any)[ownerKey]).filter(val => val !== undefined && val !== null)
    if (!parentKeys.length) {
      for (const model of models) (model as any)[relationName] = []
      return
    }

    const query = Related.query().whereIn(foreignKey, parentKeys)
    if (callback) callback(query)
    const results = await query.get()

    for (const model of models) {
      const parentKey = (model as any)[ownerKey]
      const related = results.filter((child: any) => String(child[foreignKey]) === String(parentKey))
      if (this.oneOfMany) {
        related.sort((a: any, b: any) => {
          const left = a[this.oneOfMany!.column]
          const right = b[this.oneOfMany!.column]
          const comparison = left > right ? 1 : left < right ? -1 : 0
          return this.oneOfMany!.aggregate === 'max' ? -comparison : comparison
        })
        ;(model as any)[relationName] = related[0] ?? null
      } else {
        ;(model as any)[relationName] = related
      }
    }
  }
}

export class HasOne<T extends typeof Model> extends Relation<T> {
  private defaultAttributes?: Record<string, any> | (() => Record<string, any>)

  withDefault(attributes: Record<string, any> | (() => Record<string, any>) = {}) {
    this.defaultAttributes = attributes
    return this
  }

  async first() {
    const Related = await this.related()
    const foreignKey = this.foreignKey ?? `${this.parent.constructor.name.toLowerCase()}_id`
    const model = await Related.where(foreignKey, (this.parent as any)[this.ownerKey]).first()
    if (model || this.defaultAttributes === undefined) return model
    const attributes = typeof this.defaultAttributes === 'function' ? this.defaultAttributes() : this.defaultAttributes
    return new Related(attributes, { force: true })
  }

  async eagerLoad(relationName: string, models: Model[], callback?: (query: any) => void) {
    const Related = await this.related()
    const foreignKey = this.foreignKey ?? `${this.parent.constructor.name.toLowerCase()}_id`
    const ownerKey = this.ownerKey

    const parentKeys = models.map(model => (model as any)[ownerKey]).filter(val => val !== undefined && val !== null)
    if (!parentKeys.length) {
      for (const model of models) (model as any)[relationName] = null
      return
    }

    const query = Related.query().whereIn(foreignKey, parentKeys)
    if (callback) callback(query)
    const results = await query.get()

    for (const model of models) {
      const parentKey = (model as any)[ownerKey]
      const related = results.find((child: any) => String(child[foreignKey]) === String(parentKey))
      if (related) {
        ;(model as any)[relationName] = related
      } else if (this.defaultAttributes !== undefined) {
        const attributes = typeof this.defaultAttributes === 'function' ? this.defaultAttributes() : this.defaultAttributes
        ;(model as any)[relationName] = new Related(attributes, { force: true })
      } else {
        ;(model as any)[relationName] = null
      }
    }
  }
}

export class BelongsTo<T extends typeof Model> extends Relation<T> {
  private defaultAttributes?: Record<string, any> | (() => Record<string, any>)

  withDefault(attributes: Record<string, any> | (() => Record<string, any>) = {}) {
    this.defaultAttributes = attributes
    return this
  }

  async first() {
    const Related = await this.related()
    const foreignKey = this.foreignKey ?? `${Related.name.toLowerCase()}_id`
    const foreignValue = (this.parent as any)[foreignKey]
    if (foreignValue === undefined || foreignValue === null) {
      if (this.defaultAttributes === undefined) return null
      const attributes = typeof this.defaultAttributes === 'function' ? this.defaultAttributes() : this.defaultAttributes
      return new Related(attributes, { force: true })
    }
    const model = await Related.where(this.ownerKey, foreignValue).first()
    if (model || this.defaultAttributes === undefined) return model
    const attributes = typeof this.defaultAttributes === 'function' ? this.defaultAttributes() : this.defaultAttributes
    return new Related(attributes, { force: true })
  }

  async eagerLoad(relationName: string, models: Model[], callback?: (query: any) => void) {
    const Related = await this.related()
    const foreignKey = this.foreignKey ?? `${Related.name.toLowerCase()}_id`
    const ownerKey = this.ownerKey

    const relatedKeys = models.map(model => (model as any)[foreignKey]).filter(val => val !== undefined && val !== null)
    if (!relatedKeys.length) {
      for (const model of models) (model as any)[relationName] = null
      return
    }

    const query = Related.query().whereIn(ownerKey, relatedKeys)
    if (callback) callback(query)
    const results = await query.get()

    for (const model of models) {
      const fk = (model as any)[foreignKey]
      const related = results.find((child: any) => String(child[ownerKey]) === String(fk))
      if (related) {
        ;(model as any)[relationName] = related
      } else if (this.defaultAttributes !== undefined) {
        const attributes = typeof this.defaultAttributes === 'function' ? this.defaultAttributes() : this.defaultAttributes
        ;(model as any)[relationName] = new Related(attributes, { force: true })
      } else {
        ;(model as any)[relationName] = null
      }
    }
  }
}

export class BelongsToMany<T extends typeof Model> extends Relation<T> {
  private resolvedRelatedPivotKey?: string

  constructor(
    parent: Model,
    Related: ModelReference<T>,
    protected pivotTable: string,
    protected foreignPivotKey: string,
    protected relatedPivotKey?: string
  ) {
    super(parent, Related, foreignPivotKey)
  }

  protected async getRelatedPivotKey() {
    if (this.resolvedRelatedPivotKey) return this.resolvedRelatedPivotKey
    if (this.relatedPivotKey) {
      this.resolvedRelatedPivotKey = this.relatedPivotKey
      return this.relatedPivotKey
    }
    const Related = await this.related()
    this.resolvedRelatedPivotKey = `${Related.name.toLowerCase()}_id`
    return this.resolvedRelatedPivotKey
  }

  protected async extraPivotAttributes(): Promise<Record<string, any>> {
    return {}
  }

  protected async addPivotConstraints(query: any): Promise<any> {
    return query
  }

  async get() {
    const Related = await this.related()
    const rKey = await this.getRelatedPivotKey()
    const query = Related.query()
      .join(this.pivotTable, `${Related.tableName()}.id`, `${this.pivotTable}.${rKey}`)
      .where(`${this.pivotTable}.${this.foreignPivotKey}`, (this.parent as any).id)
      .select(`${Related.tableName()}.*`, `${this.pivotTable}.${this.foreignPivotKey} as _pivot_foreign_id`)

    await this.addPivotConstraints(query)
    return query.get()
  }

  async eagerLoad(relationName: string, models: Model[], callback?: (query: any) => void) {
    const Related = await this.related()
    const rKey = await this.getRelatedPivotKey()
    const parentIds = models.map(model => (model as any).id).filter(val => val !== undefined && val !== null)
    if (!parentIds.length) {
      for (const model of models) (model as any)[relationName] = []
      return
    }

    const query = Related.query()
      .join(this.pivotTable, `${Related.tableName()}.id`, `${this.pivotTable}.${rKey}`)
      .whereIn(`${this.pivotTable}.${this.foreignPivotKey}`, parentIds)
      .select(`${Related.tableName()}.*`, `${this.pivotTable}.${this.foreignPivotKey} as _pivot_foreign_id`)

    await this.addPivotConstraints(query)
    if (callback) callback(query)
    const results = await query.get()

    for (const model of models) {
      const parentId = (model as any).id
      ;(model as any)[relationName] = results.filter((child: any) => String(child._pivot_foreign_id) === String(parentId))
    }
  }

  // Pivot Management operations
  async attach(ids: any | any[], attributes: Record<string, any> = {}) {
    const array = Array.isArray(ids) ? ids : [ids]
    const extra = await this.extraPivotAttributes()
    const rKey = await this.getRelatedPivotKey()
    const rows = array.map(id => ({
      [this.foreignPivotKey]: (this.parent as any).id,
      [rKey]: id,
      ...extra,
      ...attributes
    }))
    await DB.table(this.pivotTable).insert(rows)
  }

  async detach(ids?: any | any[]) {
    const query = DB.table(this.pivotTable).where(this.foreignPivotKey, (this.parent as any).id)
    await this.addPivotConstraints(query)
    if (ids !== undefined) {
      const array = Array.isArray(ids) ? ids : [ids]
      const rKey = await this.getRelatedPivotKey()
      query.whereIn(rKey, array)
    }
    await query.delete()
  }

  async sync(ids: any[] | Record<string | number, Record<string, any>>) {
    const targetIds = Array.isArray(ids) ? ids.map(String) : Object.keys(ids).map(String)
    const targetData = Array.isArray(ids) ? null : ids
    const rKey = await this.getRelatedPivotKey()

    const query = DB.table(this.pivotTable).where(this.foreignPivotKey, (this.parent as any).id)
    await this.addPivotConstraints(query)
    const currentRows = await query.select(rKey)
    const currentIds = currentRows.map((row: any) => String(row[rKey]))

    const toDetach = currentIds.filter(id => !targetIds.includes(id))
    const toAttach = targetIds.filter(id => !currentIds.includes(id))
    const toUpdate = targetIds.filter(id => currentIds.includes(id))

    if (toDetach.length) {
      await this.detach(toDetach)
    }
    if (toAttach.length) {
      const extra = await this.extraPivotAttributes()
      const rows = toAttach.map(id => ({
        [this.foreignPivotKey]: (this.parent as any).id,
        [rKey]: id,
        ...extra,
        ...(targetData ? targetData[id] : {})
      }))
      await DB.table(this.pivotTable).insert(rows)
    }
    if (toUpdate.length && targetData) {
      for (const id of toUpdate) {
        const attributes = targetData[id]
        if (Object.keys(attributes).length) {
          const updateQuery = DB.table(this.pivotTable)
            .where(this.foreignPivotKey, (this.parent as any).id)
            .where(rKey, id)
          await this.addPivotConstraints(updateQuery)
          await updateQuery.update(attributes)
        }
      }
    }
  }

  async toggle(ids: any | any[]) {
    const array = (Array.isArray(ids) ? ids : [ids]).map(String)
    const rKey = await this.getRelatedPivotKey()
    const query = DB.table(this.pivotTable)
      .where(this.foreignPivotKey, (this.parent as any).id)
      .whereIn(rKey, array)
    await this.addPivotConstraints(query)
    const currentRows = await query.select(rKey)
    const currentIds = currentRows.map((row: any) => String(row[rKey]))

    const toDetach = array.filter(id => currentIds.includes(id))
    const toAttach = array.filter(id => !currentIds.includes(id))

    if (toDetach.length) await this.detach(toDetach)
    if (toAttach.length) await this.attach(toAttach)
  }
}

export class MorphTo extends Relation<any> {
  constructor(
    parent: Model,
    protected name?: string,
    protected typeColumn?: string,
    protected idColumn?: string
  ) {
    super(parent, null as any)
  }

  async first() {
    const name = this.name ?? getCallerName() ?? 'commentable'
    const typeColumn = this.typeColumn ?? `${name}_type`
    const idColumn = this.idColumn ?? `${name}_id`

    const type = (this.parent as any)[typeColumn]
    const id = (this.parent as any)[idColumn]

    if (!type || !id) return null

    const RelatedModel = await resolveModel(type)
    return RelatedModel.find(id)
  }

  async eagerLoad(relationName: string, models: Model[], callback?: (query: any) => void) {
    const name = this.name ?? getCallerName() ?? 'commentable'
    const typeColumn = this.typeColumn ?? `${name}_type`
    const idColumn = this.idColumn ?? `${name}_id`

    const groups = new Map<string, any[]>()
    for (const model of models) {
      const type = (model as any)[typeColumn]
      if (type) {
        const list = groups.get(type) ?? []
        list.push(model)
        groups.set(type, list)
      } else {
        ;(model as any)[relationName] = null
      }
    }

    for (const [typeName, groupModels] of groups.entries()) {
      const RelatedModel = await resolveModel(typeName)
      const ids = groupModels.map(m => (m as any)[idColumn]).filter(val => val !== undefined && val !== null)
      if (!ids.length) {
        for (const m of groupModels) (m as any)[relationName] = null
        continue
      }

      const query = RelatedModel.query().whereIn(RelatedModel.primaryKey, ids)
      if (callback) callback(query)
      const results = await query.get()

      for (const m of groupModels) {
        const id = (m as any)[idColumn]
        ;(m as any)[relationName] = results.find((child: any) => String(child[RelatedModel.primaryKey]) === String(id)) ?? null
      }
    }
  }
}

export class MorphOne<T extends typeof Model> extends Relation<T> {
  constructor(
    parent: Model,
    Related: ModelReference<T>,
    protected name: string,
    protected typeColumn?: string,
    protected idColumn?: string
  ) {
    super(parent, Related)
  }

  async first() {
    const Related = await this.related()
    const typeColumn = this.typeColumn ?? `${this.name}_type`
    const idColumn = this.idColumn ?? `${this.name}_id`
    const parentType = this.parent.constructor.name

    return Related.where(typeColumn, parentType)
      .where(idColumn, (this.parent as any).id)
      .first()
  }

  async eagerLoad(relationName: string, models: Model[], callback?: (query: any) => void) {
    const Related = await this.related()
    const typeColumn = this.typeColumn ?? `${this.name}_type`
    const idColumn = this.idColumn ?? `${this.name}_id`
    const parentType = this.parent.constructor.name

    const parentIds = models.map(model => (model as any).id).filter(val => val !== undefined && val !== null)
    if (!parentIds.length) {
      for (const model of models) (model as any)[relationName] = null
      return
    }

    const query = Related.query().where(typeColumn, parentType).whereIn(idColumn, parentIds)
    if (callback) callback(query)
    const results = await query.get()

    for (const model of models) {
      ;(model as any)[relationName] = results.find((child: any) => String(child[idColumn]) === String((model as any).id)) ?? null
    }
  }
}

export class MorphMany<T extends typeof Model> extends Relation<T> {
  constructor(
    parent: Model,
    Related: ModelReference<T>,
    protected name: string,
    protected typeColumn?: string,
    protected idColumn?: string
  ) {
    super(parent, Related)
  }

  async get() {
    const Related = await this.related()
    const typeColumn = this.typeColumn ?? `${this.name}_type`
    const idColumn = this.idColumn ?? `${this.name}_id`
    const parentType = this.parent.constructor.name

    return Related.where(typeColumn, parentType)
      .where(idColumn, (this.parent as any).id)
      .get()
  }

  async eagerLoad(relationName: string, models: Model[], callback?: (query: any) => void) {
    const Related = await this.related()
    const typeColumn = this.typeColumn ?? `${this.name}_type`
    const idColumn = this.idColumn ?? `${this.name}_id`
    const parentType = this.parent.constructor.name

    const parentIds = models.map(model => (model as any).id).filter(val => val !== undefined && val !== null)
    if (!parentIds.length) {
      for (const model of models) (model as any)[relationName] = []
      return
    }

    const query = Related.query().where(typeColumn, parentType).whereIn(idColumn, parentIds)
    if (callback) callback(query)
    const results = await query.get()

    for (const model of models) {
      ;(model as any)[relationName] = results.filter((child: any) => String(child[idColumn]) === String((model as any).id))
    }
  }
}

export class MorphToMany<T extends typeof Model> extends BelongsToMany<T> {
  private typeCol: string
  private parentType: string

  constructor(
    parent: Model,
    Related: ModelReference<T>,
    protected name: string,
    pivotTable?: string,
    foreignPivotKey?: string,
    relatedPivotKey?: string,
    typeColumn?: string
  ) {
    const pTable = pivotTable ?? `${name}s`
    const fKey = foreignPivotKey ?? `${name}_id`
    super(parent, Related, pTable, fKey, relatedPivotKey)
    this.typeCol = typeColumn ?? `${name}_type`
    this.parentType = parent.constructor.name
  }

  protected async extraPivotAttributes() {
    return { [this.typeCol]: this.parentType }
  }

  protected async addPivotConstraints(query: any) {
    return query.where(this.typeCol, this.parentType)
  }
}

export class MorphedByMany<T extends typeof Model> extends BelongsToMany<T> {
  private typeCol: string
  private relatedType?: string

  constructor(
    parent: Model,
    Related: ModelReference<T>,
    protected name: string,
    pivotTable?: string,
    foreignPivotKey?: string,
    relatedPivotKey?: string,
    typeColumn?: string
  ) {
    const pTable = pivotTable ?? `${name}s`
    const fKey = foreignPivotKey ?? `${parent.constructor.name.toLowerCase()}_id`
    const rKey = relatedPivotKey ?? `${name}_id`
    super(parent, Related, pTable, fKey, rKey)
    this.typeCol = typeColumn ?? `${name}_type`
  }

  protected async getRelatedType() {
    if (this.relatedType) return this.relatedType
    const Related = await this.related()
    this.relatedType = Related.name
    return this.relatedType
  }

  protected async extraPivotAttributes() {
    return { [this.typeCol]: await this.getRelatedType() }
  }

  protected async addPivotConstraints(query: any) {
    return query.where(this.typeCol, await this.getRelatedType())
  }
}

export class HasManyThrough<T extends typeof Model, R extends typeof Model> extends Relation<T> {
  constructor(
    parent: Model,
    Related: ModelReference<T>,
    protected Through: ModelReference<R>,
    protected firstKey?: string,
    protected secondKey?: string,
    protected localKey?: string,
    protected secondLocalKey?: string
  ) {
    super(parent, Related)
  }

  async get() {
    const Related = await this.related()
    const Through = await resolveModel(this.Through)
    const firstKey = this.firstKey ?? `${this.parent.constructor.name.toLowerCase()}_id`
    const secondKey = this.secondKey ?? `${Through.name.toLowerCase()}_id`
    const localKey = this.localKey ?? 'id'
    const secondLocalKey = this.secondLocalKey ?? 'id'

    return Related.query()
      .join(Through.tableName(), `${Related.tableName()}.${secondKey}`, `${Through.tableName()}.${secondLocalKey}`)
      .where(`${Through.tableName()}.${firstKey}`, (this.parent as any)[localKey])
      .select(`${Related.tableName()}.*`)
      .get()
  }

  async eagerLoad(relationName: string, models: Model[], callback?: (query: any) => void) {
    const Related = await this.related()
    const Through = await resolveModel(this.Through)
    const firstKey = this.firstKey ?? `${this.parent.constructor.name.toLowerCase()}_id`
    const secondKey = this.secondKey ?? `${Through.name.toLowerCase()}_id`
    const localKey = this.localKey ?? 'id'
    const secondLocalKey = this.secondLocalKey ?? 'id'

    const parentIds = models.map(model => (model as any)[localKey]).filter(val => val !== undefined && val !== null)
    if (!parentIds.length) {
      for (const model of models) (model as any)[relationName] = []
      return
    }

    const query = Related.query()
      .join(Through.tableName(), `${Related.tableName()}.${secondKey}`, `${Through.tableName()}.${secondLocalKey}`)
      .whereIn(`${Through.tableName()}.${firstKey}`, parentIds)
      .select(`${Related.tableName()}.*`, `${Through.tableName()}.${firstKey} as _through_first_id`)

    if (callback) callback(query)
    const results = await query.get()

    for (const model of models) {
      const pk = (model as any)[localKey]
      ;(model as any)[relationName] = results.filter((child: any) => String(child._through_first_id) === String(pk))
    }
  }
}

export class HasOneThrough<T extends typeof Model, R extends typeof Model> extends Relation<T> {
  constructor(
    parent: Model,
    Related: ModelReference<T>,
    protected Through: ModelReference<R>,
    protected firstKey?: string,
    protected secondKey?: string,
    protected localKey?: string,
    protected secondLocalKey?: string
  ) {
    super(parent, Related)
  }

  async first() {
    const Related = await this.related()
    const Through = await resolveModel(this.Through)
    const firstKey = this.firstKey ?? `${this.parent.constructor.name.toLowerCase()}_id`
    const secondKey = this.secondKey ?? `${Through.name.toLowerCase()}_id`
    const localKey = this.localKey ?? 'id'
    const secondLocalKey = this.secondLocalKey ?? 'id'

    const row = await Related.query()
      .join(Through.tableName(), `${Related.tableName()}.${secondKey}`, `${Through.tableName()}.${secondLocalKey}`)
      .where(`${Through.tableName()}.${firstKey}`, (this.parent as any)[localKey])
      .select(`${Related.tableName()}.*`)
      .first()

    return row ? Related.hydrate(row) : null
  }

  async eagerLoad(relationName: string, models: Model[], callback?: (query: any) => void) {
    const Related = await this.related()
    const Through = await resolveModel(this.Through)
    const firstKey = this.firstKey ?? `${this.parent.constructor.name.toLowerCase()}_id`
    const secondKey = this.secondKey ?? `${Through.name.toLowerCase()}_id`
    const localKey = this.localKey ?? 'id'
    const secondLocalKey = this.secondLocalKey ?? 'id'

    const parentIds = models.map(model => (model as any)[localKey]).filter(val => val !== undefined && val !== null)
    if (!parentIds.length) {
      for (const model of models) (model as any)[relationName] = null
      return
    }

    const query = Related.query()
      .join(Through.tableName(), `${Related.tableName()}.${secondKey}`, `${Through.tableName()}.${secondLocalKey}`)
      .whereIn(`${Through.tableName()}.${firstKey}`, parentIds)
      .select(`${Related.tableName()}.*`, `${Through.tableName()}.${firstKey} as _through_first_id`)

    if (callback) callback(query)
    const results = await query.get()

    for (const model of models) {
      const pk = (model as any)[localKey]
      ;(model as any)[relationName] = results.find((child: any) => String(child._through_first_id) === String(pk)) ?? null
    }
  }
}

function getCallerName(): string | undefined {
  const stack = new Error().stack
  if (!stack) return undefined
  const lines = stack.split('\n')
  const idx = lines.findIndex(line => line.includes('.morphTo'))
  if (idx !== -1 && lines[idx + 1]) {
    const callerLine = lines[idx + 1]
    const match = callerLine.match(/at\s+(?:[^(]+?\.([a-zA-Z0-9_$]+)|([a-zA-Z0-9_$]+))\s+\(/) 
                  || callerLine.match(/at\s+([a-zA-Z0-9_$]+)\s+$/)
    if (match) {
      return match[1] || match[2]
    }
  }
  const callerLine = lines[3]
  if (callerLine) {
    const match = callerLine.match(/at\s+(?:[^(]+?\.([a-zA-Z0-9_$]+)|([a-zA-Z0-9_$]+))\s+\(/) 
                  || callerLine.match(/at\s+([a-zA-Z0-9_$]+)\s+$/)
    if (match) {
      return match[1] || match[2]
    }
  }
  return undefined
}

async function resolveModel<T extends typeof Model>(reference: ModelReference<T>): Promise<T> {
  const candidate = reference as unknown
  if (typeof candidate === 'function') {
    if (isModelClass(candidate as T)) return candidate as T
    const resolved = (candidate as () => T | Promise<T>)()
    return await Promise.resolve(resolved as T | Promise<T>)
  }

  const referenceName = String(reference)

  try {
    return SerializableModelRegistry.resolve(referenceName) as T
  } catch {}

  const candidates = [
    new URL(`../../src/app/Models/${referenceName}.js`, import.meta.url).href,
    new URL(`../../src/app/Models/${referenceName}.ts`, import.meta.url).href,
    new URL(`../../src/app/Models/${referenceName}Model.js`, import.meta.url).href
  ]

  for (const candidate of candidates) {
    try {
      const imported = await import(candidate)
      const model = imported.default ?? imported[referenceName] ?? Object.values(imported).find(value => typeof value === 'function')
      if (typeof model === 'function') {
        SerializableModelRegistry.register(model as T, referenceName)
        return model as T
      }
    } catch (error: any) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'MODULE_NOT_FOUND') throw error
    }
  }

  throw new Error(`Model [${reference}] could not be resolved.`)
}

function isModelClass<T extends typeof Model>(value: T | (() => T | Promise<T>)) {
  return typeof value === 'function'
    && typeof (value as any).query === 'function'
    && typeof (value as any).hydrate === 'function'
    && typeof (value as any).tableName === 'function'
}
