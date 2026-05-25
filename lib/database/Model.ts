import { DB } from '@lib/database/DB.js'
import { BelongsTo, BelongsToMany, HasMany, HasOne, MorphTo, MorphOne, MorphMany, MorphToMany, MorphedByMany, HasManyThrough, HasOneThrough } from '@lib/database/Relations.js'
import moment from 'moment'
import { FactoryRegistry } from '@lib/database/Factory.js'
import { ulid } from 'ulid'
import { randomUUID } from 'node:crypto'

export interface CastsAttributes {
  get(model: any, key: string, value: any, attributes: any): any
  set(model: any, key: string, value: any, attributes: any): any
}

type EventName = 'creating' | 'created' | 'updating' | 'updated' | 'deleting' | 'deleted'
type EventCallback = (model: Model) => void | Promise<void>

export class ModelCollection<T extends Model = Model> extends Array<T> {
  static get [Symbol.species]() {
    return Array
  }

  constructor(items: T[] = []) {
    super(...items)
    Object.setPrototypeOf(this, new.target.prototype)
  }

  modelKeys() {
    return this.map(model => model.getRouteKey())
  }

  async load(relation: string | string[] | Record<string, (query: any) => void>) {
    if (this.length) await (this[0].constructor as typeof Model).load(this, relation)
    return this
  }

  async loadMissing(relation: string | string[] | Record<string, (query: any) => void>) {
    const names = Array.isArray(relation) ? relation : typeof relation === 'string' ? [relation] : Object.keys(relation)
    const missing = this.filter(model => names.some(name => typeof (model as any)[name] === 'function'))
    if (missing.length) await new ModelCollection(missing).load(relation)
    return this
  }

  async fresh() {
    return new ModelCollection((await Promise.all(this.map(model => model.fresh()))).filter(Boolean) as T[])
  }

  toQuery() {
    if (!this.length) throw new Error('Cannot build query from an empty model collection.')
    const ModelClass = this[0].constructor as typeof Model
    return ModelClass.query().whereIn(ModelClass.primaryKey, this.map(model => (model as any)[ModelClass.primaryKey]))
  }

  makeVisible(keys: string | string[]) {
    this.forEach(model => model.makeVisible(keys))
    return this
  }

  makeHidden(keys: string | string[]) {
    this.forEach(model => model.makeHidden(keys))
    return this
  }

  only(keys: Array<string | number>) {
    const set = new Set(keys.map(String))
    return new ModelCollection(this.filter(model => set.has(String(model.getRouteKey()))))
  }

  except(keys: Array<string | number>) {
    const set = new Set(keys.map(String))
    return new ModelCollection(this.filter(model => !set.has(String(model.getRouteKey()))))
  }

  partition(callback: (model: T, index: number) => boolean) {
    const matched = new ModelCollection<T>()
    const unmatched = new ModelCollection<T>()
    this.forEach((model, index) => (callback(model, index) ? matched : unmatched).push(model))
    return [matched, unmatched] as const
  }
}

export class Model {
  [key: string]: any

  static table?: string
  static primaryKey = 'id'
  static timestamps = true
  static softDeletes = false
  static fillable: string[] = []
  static guarded: string[] = ['id']
  static hidden: string[] = []
  static visible: string[] = []
  static appends: string[] = []
  static casts: Record<string, 'number' | 'string' | 'boolean' | 'date' | 'json' | any> = {}
  static accessors: Record<string, (value: any, model: Model) => any> = {}
  static mutators: Record<string, (value: any, model: Model) => any> = {}
  static touches: string[] = []
  static collection = ModelCollection
  static routeKeyName = 'id'
  static lazyLoadingPrevented = false
  static dispatchesEvents = true
  
  private static events: Record<EventName, EventCallback[]> = {
    creating: [], created: [], updating: [], updated: [], deleting: [], deleted: []
  }

  exists = false
  protected original: Record<string, any> = {}
  protected changes: Record<string, any> = {}

  constructor(attributes: Record<string, any> = {}, options: { force?: boolean } = {}) {
    options.force ? this.forceFill(attributes) : this.fill(attributes)
    this.syncOriginal()
  }

  static tableName() {
    return this.table ?? `${this.name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}s`
  }

  static query<T extends typeof Model>(this: T): ModelQueryBuilder<T> {
    return new ModelQueryBuilder(this, DB.table(this.tableName()))
  }

  static where<T extends typeof Model>(this: T, column: string, operator: any, value?: any): ModelQueryBuilder<T> {
    return this.query().where(column, operator, value)
  }

  static scope<T extends typeof Model>(this: T, name: string, ...args: any[]) {
    return this.query().scope(name, ...args)
  }

  static async create<T extends typeof Model>(this: T, attributes: Record<string, any>): Promise<InstanceType<T>> {
    const model = new this(attributes) as InstanceType<T>
    await model.save()
    return model
  }

  static async find<T extends typeof Model>(this: T, id: string | number): Promise<InstanceType<T> | null> {
    return this.query().where(this.primaryKey, id).first()
  }

  static async findMany<T extends typeof Model>(this: T, ids: Array<string | number>): Promise<ModelCollection<InstanceType<T>>> {
    return this.query().whereIn(this.primaryKey, ids).get() as any
  }

  static async findOrFail<T extends typeof Model>(this: T, id: string | number): Promise<InstanceType<T>> {
    const model = await this.find(id)
    if (!model) throw new Error(`${this.name} [${id}] was not found.`)
    return model
  }

  static async get<T extends typeof Model>(this: T): Promise<ModelCollection<InstanceType<T>>> {
    return this.query().get()
  }

  static async firstOrCreate<T extends typeof Model>(this: T, attributes: Record<string, any>, values: Record<string, any> = {}) {
    return await this.query().whereAttributes(attributes).first() ?? this.create({ ...attributes, ...values })
  }

  static async firstOrNew<T extends typeof Model>(this: T, attributes: Record<string, any>, values: Record<string, any> = {}) {
    return await this.query().whereAttributes(attributes).first() ?? new this({ ...attributes, ...values }) as InstanceType<T>
  }

  static async updateOrCreate<T extends typeof Model>(this: T, attributes: Record<string, any>, values: Record<string, any> = {}) {
    const model = await this.firstOrNew(attributes)
    await model.update(values)
    return model
  }

  static async upsert<T extends typeof Model>(this: T, values: any | any[], uniqueBy: string | string[], update?: string[]) {
    return DB.table(this.tableName()).upsert(values, uniqueBy, update)
  }

  static async first<T extends typeof Model>(this: T): Promise<InstanceType<T> | null> {
    return this.query().first()
  }

  static async paginate<T extends typeof Model>(this: T, page = 1, perPage = 15) {
    return this.query().paginate(page, perPage)
  }

  static factory(count?: number) {
    const FactoryClass = FactoryRegistry.get(this)
    if (!FactoryClass) throw new Error(`Factory for model [${this.name}] is not registered. Make sure the factory file exists and is loaded.`)
    const instance = new FactoryClass()
    return count !== undefined ? instance.count(count) : instance
  }

  static with<T extends typeof Model>(this: T, relation: string | Record<string, (query: any) => void>) {
    return new EagerBuilder(this, [relation])
  }

  static on(event: EventName, callback: EventCallback) {
    if (!Object.prototype.hasOwnProperty.call(this, 'events')) {
      this.events = {
        creating: [], created: [], updating: [], updated: [], deleting: [], deleted: []
      }
    }
    this.events[event].push(callback)
  }

  static observe(observer: any) {
    const instance = typeof observer === 'function' ? new observer() : observer
    for (const event of ['creating', 'created', 'updating', 'updated', 'deleting', 'deleted'] as const) {
      if (typeof instance?.[event] === 'function') {
        this.on(event, (model) => instance[event](model))
      }
    }
  }

  static hydrate<T extends typeof Model>(this: T, attributes: Record<string, any>): InstanceType<T> {
    const model = new this(attributes, { force: true }) as InstanceType<T>
    model.exists = true
    return model
  }

  // Global scope support
  static addGlobalScope(name: string, callback: (builder: any) => void) {
    if (!Object.prototype.hasOwnProperty.call(this, '_globalScopes')) {
      ;(this as any)._globalScopes = new Map()
    }
    ;(this as any)._globalScopes.set(name, callback)
  }

  static getGlobalScopes(): Map<string, (builder: any) => void> {
    const scopes = new Map<string, (builder: any) => void>()
    let current = this
    while (current && current !== Model) {
      if (Object.prototype.hasOwnProperty.call(current, '_globalScopes')) {
        const currentScopes = (current as any)._globalScopes
        for (const [key, val] of currentScopes.entries()) {
          if (!scopes.has(key)) scopes.set(key, val)
        }
      }
      current = Object.getPrototypeOf(current)
    }
    return scopes
  }

  // Lazy Eager Loading
  async load(relation: string | string[] | Record<string, (query: any) => void>) {
    const builder = new EagerBuilder(this.constructor as typeof Model, [])
    const relationsList = Array.isArray(relation) ? relation : [relation]
    for (const r of relationsList) {
      builder.with(r)
    }
    await builder.loadModels([this])
    return this
  }

  static async load(models: Model[], relation: string | string[] | Record<string, (query: any) => void>) {
    if (!models.length) return models
    const builder = new EagerBuilder(this, [])
    const relationsList = Array.isArray(relation) ? relation : [relation]
    for (const r of relationsList) {
      builder.with(r)
    }
    await builder.loadModels(models)
    return models
  }

  static preventLazyLoading(value = true) {
    this.lazyLoadingPrevented = value
  }

  static getRouteKeyName() {
    return this.routeKeyName
  }

  static async withoutEvents<T>(callback: () => T | Promise<T>) {
    const previous = this.dispatchesEvents
    this.dispatchesEvents = false
    try {
      return await callback()
    } finally {
      this.dispatchesEvents = previous
    }
  }

  static newUniqueId() {
    return randomUUID()
  }

  static newUlid() {
    return ulid()
  }

  async touch() {
    const Constructor = this.constructor as typeof Model
    if (Constructor.timestamps) {
      ;(this as any).updated_at = moment()
      await DB.table(Constructor.tableName())
        .where(Constructor.primaryKey, (this as any)[Constructor.primaryKey])
        .update({ updated_at: (this as any).updated_at.toISOString() })
    }
  }

  private async touchOwners() {
    const Constructor = this.constructor as typeof Model
    const touches = Constructor.touches ?? []
    for (const relation of touches) {
      if (typeof (this as any)[relation] === 'function') {
        const relInstance = (this as any)[relation]()
        const parent = typeof relInstance.first === 'function' ? await relInstance.first() : null
        if (parent) {
          await parent.touch()
        }
      }
    }
  }

  fill(attributes: Record<string, any>) {
    const Constructor = this.constructor as typeof Model
    for (const [key, value] of Object.entries(attributes)) {
      if (Constructor.fillable.length && !Constructor.fillable.includes(key)) continue
      if (Constructor.guarded.includes(key) && !Constructor.fillable.includes(key)) continue
      ;(this as any)[key] = this.mutateAttribute(key, cast(value, Constructor.casts[key], this, key))
    }
    return this
  }

  forceFill(attributes: Record<string, any>) {
    const Constructor = this.constructor as typeof Model
    for (const [key, value] of Object.entries(attributes)) {
      ;(this as any)[key] = this.mutateAttribute(key, cast(value, Constructor.casts[key], this, key))
    }
    return this
  }

  async save() {
    const Constructor = this.constructor as typeof Model
    const now = moment()
    if (Constructor.timestamps) {
      if (!this.exists) (this as any).created_at ??= now.clone()
      ;(this as any).updated_at = now.clone()
    }
    await this.fire(this.exists ? 'updating' : 'creating')
    if (this.exists) {
      const before = { ...this.original }
      await DB.table(Constructor.tableName()).where(Constructor.primaryKey, (this as any)[Constructor.primaryKey]).update(this.persistableAttributes())
      this.changes = changedAttributes(before, this.attributes())
      await this.fire('updated')
    } else {
      const [id] = await DB.table(Constructor.tableName()).insert(this.persistableAttributes())
      ;(this as any)[Constructor.primaryKey] ??= id
      this.exists = true
      this.changes = this.attributes()
      await this.fire('created')
    }
    await this.touchOwners()
    this.syncOriginal()
    return this
  }

  async update(attributes: Record<string, any>) {
    this.fill(attributes)
    return this.save()
  }

  async delete() {
    const Constructor = this.constructor as typeof Model
    await this.fire('deleting')
    if (Constructor.softDeletes) {
      ;(this as any).deleted_at = moment()
      await this.save()
    } else {
      await DB.table(Constructor.tableName()).where(Constructor.primaryKey, (this as any)[Constructor.primaryKey]).delete()
    }
    await this.fire('deleted')
    await this.touchOwners()
  }

  async restore() {
    const Constructor = this.constructor as typeof Model
    if (!Constructor.softDeletes) return
    ;(this as any).deleted_at = null
    await this.save()
  }

  replicate(except: string[] = []) {
    const Constructor = this.constructor as typeof Model
    const skip = new Set([Constructor.primaryKey, 'created_at', 'updated_at', ...except])
    return new (Constructor as any)(Object.fromEntries(Object.entries(this.attributes()).filter(([key]) => !skip.has(key))), { force: true })
  }

  async refresh() {
    const Constructor = this.constructor as typeof Model
    const fresh = await Constructor.find((this as any)[Constructor.primaryKey])
    if (!fresh) return this
    this.forceFill(fresh.attributes())
    this.exists = true
    this.syncOriginal()
    return this
  }

  async fresh() {
    const Constructor = this.constructor as typeof Model
    return Constructor.find((this as any)[Constructor.primaryKey])
  }

  isDirty(key?: string) {
    const dirty = changedAttributes(this.original, this.attributes())
    return key ? Object.prototype.hasOwnProperty.call(dirty, key) : Object.keys(dirty).length > 0
  }

  wasChanged(key?: string) {
    return key ? Object.prototype.hasOwnProperty.call(this.changes, key) : Object.keys(this.changes).length > 0
  }

  getChanges() {
    return { ...this.changes }
  }

  async increment(column: string, amount = 1) {
    ;(this as any)[column] = Number((this as any)[column] ?? 0) + amount
    return this.save()
  }

  async decrement(column: string, amount = 1) {
    return this.increment(column, -amount)
  }

  getRouteKey() {
    const Constructor = this.constructor as typeof Model
    return (this as any)[Constructor.getRouteKeyName()]
  }

  makeVisible(keys: string | string[]) {
    const Constructor = this.constructor as typeof Model
    Constructor.hidden = Constructor.hidden.filter(key => !(Array.isArray(keys) ? keys : [keys]).includes(key))
    return this
  }

  makeHidden(keys: string | string[]) {
    const Constructor = this.constructor as typeof Model
    Constructor.hidden = [...new Set([...Constructor.hidden, ...(Array.isArray(keys) ? keys : [keys])])]
    return this
  }

  attributes() {
    return Object.fromEntries(
      Object.entries(this)
        .filter(([key]) => !['exists', 'original', 'changes'].includes(key) && !key.startsWith('_'))
        .map(([key, value]) => [key, this.accessAttribute(key, value)])
    )
  }

  persistableAttributes() {
    const Constructor = this.constructor as typeof Model
    return Object.fromEntries(Object.entries(this.attributes()).map(([key, value]) => [key, serialize(value, Constructor.casts[key], this, key)]))
  }

  toJSON() {
    const Constructor = this.constructor as typeof Model
    const data = this.attributes()
    for (const key of Constructor.appends) data[key] = this.accessAttribute(key, (this as any)[key])
    for (const key of Constructor.hidden) delete data[key]
    if (Constructor.visible.length) return Object.fromEntries(Object.entries(data).filter(([key]) => Constructor.visible.includes(key)))
    return data
  }

  hasMany<T extends typeof Model>(Related: T | string | (() => T | Promise<T>), foreignKey = `${this.constructor.name.toLowerCase()}_id`) { return new HasMany(this, Related, foreignKey) }
  hasOne<T extends typeof Model>(Related: T | string | (() => T | Promise<T>), foreignKey = `${this.constructor.name.toLowerCase()}_id`) { return new HasOne(this, Related, foreignKey) }
  belongsTo<T extends typeof Model>(Related: T | string | (() => T | Promise<T>), foreignKey?: string, ownerKey = 'id') { return new BelongsTo(this, Related, foreignKey, ownerKey) }
  belongsToMany<T extends typeof Model>(Related: T | string | (() => T | Promise<T>), pivotTable: string, foreignPivotKey: string, relatedPivotKey: string) { return new BelongsToMany(this, Related, pivotTable, foreignPivotKey, relatedPivotKey) }
  morphTo(name?: string, typeColumn?: string, idColumn?: string) { return new MorphTo(this, name, typeColumn, idColumn) }
  morphOne<T extends typeof Model>(Related: T | string | (() => T | Promise<T>), name: string, typeColumn?: string, idColumn?: string) { return new MorphOne(this, Related, name, typeColumn, idColumn) }
  morphMany<T extends typeof Model>(Related: T | string | (() => T | Promise<T>), name: string, typeColumn?: string, idColumn?: string) { return new MorphMany(this, Related, name, typeColumn, idColumn) }
  morphToMany<T extends typeof Model>(Related: T | string | (() => T | Promise<T>), name: string, pivotTable?: string, foreignPivotKey?: string, relatedPivotKey?: string, typeColumn?: string) { return new MorphToMany(this, Related, name, pivotTable, foreignPivotKey, relatedPivotKey, typeColumn) }
  morphedByMany<T extends typeof Model>(Related: T | string | (() => T | Promise<T>), name: string, pivotTable?: string, foreignPivotKey?: string, relatedPivotKey?: string, typeColumn?: string) { return new MorphedByMany(this, Related, name, pivotTable, foreignPivotKey, relatedPivotKey, typeColumn) }
  hasManyThrough<T extends typeof Model, R extends typeof Model>(Related: T | string | (() => T | Promise<T>), Through: R | string | (() => R | Promise<R>), firstKey?: string, secondKey?: string, localKey?: string, secondLocalKey?: string) { return new HasManyThrough(this, Related, Through, firstKey, secondKey, localKey, secondLocalKey) }
  hasOneThrough<T extends typeof Model, R extends typeof Model>(Related: T | string | (() => T | Promise<T>), Through: R | string | (() => R | Promise<R>), firstKey?: string, secondKey?: string, localKey?: string, secondLocalKey?: string) { return new HasOneThrough(this, Related, Through, firstKey, secondKey, localKey, secondLocalKey) }

  private async fire(event: EventName) {
    const Constructor = this.constructor as typeof Model
    if (!Constructor.dispatchesEvents) return
    const list = Constructor.events?.[event] ?? []
    for (const callback of list) await callback(this)
  }

  private syncOriginal() {
    this.original = { ...this.attributes() }
  }

  private accessAttribute(key: string, value: any) {
    const Constructor = this.constructor as typeof Model
    return Constructor.accessors[key]?.(value, this) ?? value
  }

  private mutateAttribute(key: string, value: any) {
    const Constructor = this.constructor as typeof Model
    return Constructor.mutators[key]?.(value, this) ?? value
  }
}

export class ModelQueryBuilder<T extends typeof Model> {
  private includeTrashed = false
  private trashOnly = false
  private globalScopesApplied = false
  private removedGlobalScopes = new Set<string>()
  private postFilters: Array<(model: InstanceType<T>) => Promise<boolean>> = []
  private aggregateRelations: Array<{ relation: string, type: 'count' | 'exists' | 'sum' | 'avg' | 'min' | 'max', alias: string, column?: string }> = []

  constructor(private ModelClass: T, private knexQuery: any) {
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop in target) {
          const value = Reflect.get(target, prop, receiver)
          if (typeof value === 'function' && prop !== 'ModelClass') {
            return (...args: any[]) => {
              const result = value.apply(receiver, args)
              if (result === receiver || result === target) return receiver
              return result
            }
          }
          return value
        }
        const value = Reflect.get(target.knexQuery, prop)
        if (typeof value === 'function') {
          return (...args: any[]) => {
            const result = value.apply(target.knexQuery, args)
            if (result === target.knexQuery) return receiver
            return result
          }
        }
        return value
      }
    })
  }

  withTrashed() {
    this.includeTrashed = true
    return this
  }

  onlyTrashed() {
    this.trashOnly = true
    return this
  }

  withoutGlobalScope(name: string) {
    this.removedGlobalScopes.add(name)
    return this
  }

  withoutGlobalScopes() {
    const scopes = this.ModelClass.getGlobalScopes()
    for (const name of scopes.keys()) {
      this.removedGlobalScopes.add(name)
    }
    return this
  }

  then(onfulfilled?: any, onrejected?: any) {
    return this.compile().then(onfulfilled, onrejected)
  }

  catch(onrejected?: any) {
    return this.compile().catch(onrejected)
  }

  private compile() {
    const q = this.knexQuery.clone()

    const tempBuilder = new ModelQueryBuilder(this.ModelClass, q)
    tempBuilder.globalScopesApplied = true

    if (!this.globalScopesApplied) {
      const scopes = this.ModelClass.getGlobalScopes()
      for (const [name, callback] of scopes.entries()) {
        if (!this.removedGlobalScopes.has(name)) {
          callback(tempBuilder)
        }
      }
    }

    if (this.ModelClass.softDeletes) {
      if (this.trashOnly) {
        q.whereNotNull(`${this.ModelClass.tableName()}.deleted_at`)
      } else if (!this.includeTrashed) {
        q.whereNull(`${this.ModelClass.tableName()}.deleted_at`)
      }
    }
    return q
  }

  clone() {
    const cloned = new ModelQueryBuilder(this.ModelClass, this.knexQuery.clone())
    cloned.includeTrashed = this.includeTrashed
    cloned.trashOnly = this.trashOnly
    cloned.globalScopesApplied = this.globalScopesApplied
    cloned.removedGlobalScopes = new Set(this.removedGlobalScopes)
    cloned.postFilters = [...this.postFilters]
    cloned.aggregateRelations = [...this.aggregateRelations]
    return cloned
  }

  where(column: string, operator: any, value?: any) {
    if (value === undefined) {
      this.knexQuery.where(column, operator)
    } else {
      this.knexQuery.where(column, operator, value)
    }
    return this
  }

  whereIn(column: string, values: any[]) {
    this.knexQuery.whereIn(column, values)
    return this
  }

  whereAttributes(attributes: Record<string, any>) {
    for (const [key, value] of Object.entries(attributes)) this.where(key, value)
    return this
  }

  join(...args: any[]) {
    this.knexQuery.join(...args)
    return this
  }

  select(...args: any[]) {
    this.knexQuery.select(...args)
    return this
  }

  limit(value: number) {
    this.knexQuery.limit(value)
    return this
  }

  offset(value: number) {
    this.knexQuery.offset(value)
    return this
  }

  orderBy(column: string, direction: 'asc' | 'desc' = 'asc') {
    this.knexQuery.orderBy(column, direction)
    return this
  }

  scope(name: string, ...args: any[]) {
    const method = `scope${name.charAt(0).toUpperCase()}${name.slice(1)}`
    const scope = (this.ModelClass as any)[method]
    if (typeof scope !== 'function') throw new Error(`Model scope [${name}] is not defined.`)
    return scope.call(this.ModelClass, this, ...args) ?? this
  }

  whereHas(relation: string, callback?: (query: any) => void) {
    this.postFilters.push(async model => {
      const related = await resolveRelationResults(model, relation, callback)
      return related.length > 0
    })
    return this
  }

  orWhereHas(relation: string, callback?: (query: any) => void) {
    return this.whereHas(relation, callback)
  }

  doesntHave(relation: string) {
    this.postFilters.push(async model => (await resolveRelationResults(model, relation)).length === 0)
    return this
  }

  whereRelation(relation: string, column: string, operator: any, value?: any) {
    return this.whereHas(relation, query => query.where(column, operator, value))
  }

  withCount(relation: string, alias = `${relation}_count`) {
    this.aggregateRelations.push({ relation, type: 'count', alias })
    return this
  }

  withExists(relation: string, alias = `${relation}_exists`) {
    this.aggregateRelations.push({ relation, type: 'exists', alias })
    return this
  }

  withSum(relation: string, column: string, alias = `${relation}_sum_${column}`) {
    return this.withAggregate(relation, column, 'sum', alias)
  }

  withAggregate(relation: string, column: string, type: 'sum' | 'avg' | 'min' | 'max' = 'sum', alias = `${relation}_${type}_${column}`) {
    this.aggregateRelations.push({ relation, type, column, alias })
    return this
  }

  async first() {
    const models = await (this.postFilters.length ? this.clone().get() : this.clone().limit(1).get())
    return models[0] ?? null
  }

  async firstOrFail() {
    const model = await this.first()
    if (!model) throw new Error(`${this.ModelClass.name} was not found.`)
    return model
  }

  async sole() {
    const rows = await this.compile().limit(2)
    if (rows.length !== 1) throw new Error(`Expected exactly one ${this.ModelClass.name} record, found ${rows.length}.`)
    return this.ModelClass.hydrate(rows[0]) as InstanceType<T>
  }

  async get(): Promise<ModelCollection<InstanceType<T>>> {
    const rows = await this.compile()
    const models = new this.ModelClass.collection(rows.map((row: any) => this.ModelClass.hydrate(row) as InstanceType<T>)) as ModelCollection<InstanceType<T>>
    const filtered = this.postFilters.length ? new this.ModelClass.collection([]) as ModelCollection<InstanceType<T>> : models
    if (this.postFilters.length) {
      for (const model of models) {
        const passes = await Promise.all(this.postFilters.map(filter => filter(model)))
        if (passes.every(Boolean)) filtered.push(model)
      }
    }
    for (const model of filtered) {
      for (const aggregate of this.aggregateRelations) {
        const related = await resolveRelationResults(model, aggregate.relation)
        if (aggregate.type === 'count') {
          ;(model as any)[aggregate.alias] = related.length
        } else if (aggregate.type === 'exists') {
          ;(model as any)[aggregate.alias] = related.length > 0
        } else {
          const values = related.map((item: any) => Number(item[aggregate.column!])).filter((value: number) => !Number.isNaN(value))
          if (aggregate.type === 'sum') (model as any)[aggregate.alias] = values.reduce((sum, value) => sum + value, 0)
          if (aggregate.type === 'avg') (model as any)[aggregate.alias] = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
          if (aggregate.type === 'min') (model as any)[aggregate.alias] = values.length ? Math.min(...values) : null
          if (aggregate.type === 'max') (model as any)[aggregate.alias] = values.length ? Math.max(...values) : null
        }
      }
    }
    return filtered
  }

  async value(column: string) {
    const row = await this.compile().select(column).first()
    return row?.[column]
  }

  async pluck(column: string) {
    const rows = await this.compile().select(column)
    return rows.map((row: any) => row[column])
  }

  async chunk(size: number, callback: (models: ModelCollection<InstanceType<T>>, page: number) => unknown | Promise<unknown>) {
    let page = 0
    while (true) {
      const rows = await this.compile().limit(size).offset(page * size)
      if (!rows.length) break
      const result = await callback(new this.ModelClass.collection(rows.map((row: any) => this.ModelClass.hydrate(row) as InstanceType<T>)) as any, page + 1)
      if (result === false) break
      page++
    }
  }

  async chunkById(size: number, callback: (models: ModelCollection<InstanceType<T>>) => unknown | Promise<unknown>, column = this.ModelClass.primaryKey) {
    let lastId: any
    while (true) {
      const query = this.compile().orderBy(column).limit(size)
      if (lastId !== undefined) query.where(column, '>', lastId)
      const rows = await query
      if (!rows.length) break
      const models = new this.ModelClass.collection(rows.map((row: any) => this.ModelClass.hydrate(row) as InstanceType<T>)) as any
      const result = await callback(models)
      if (result === false) break
      lastId = rows[rows.length - 1][column]
    }
  }

  async paginate(page = 1, perPage = 15) {
    const [{ count }] = await this.compile().clone().count({ count: '*' })
    const rows = await this.compile().limit(perPage).offset((page - 1) * perPage)
    return { data: rows.map((row: any) => this.ModelClass.hydrate(row)), total: Number(count), page, perPage }
  }
}

type EagerRelation = {
  name: string
  callback?: (query: any) => void
}

class EagerBuilder<T extends typeof Model> {
  private relations: EagerRelation[] = []

  constructor(private ModelClass: T, relations: (string | Record<string, (query: any) => void> | EagerRelation)[]) {
    for (const r of relations) this.with(r)
  }

  with(relation: string | Record<string, (query: any) => void> | EagerRelation) {
    if (typeof relation === 'string') {
      this.relations.push({ name: relation })
    } else if (typeof relation === 'object' && relation !== null) {
      if ('name' in relation) {
        this.relations.push(relation as EagerRelation)
      } else {
        for (const [name, callback] of Object.entries(relation)) {
          this.relations.push({ name, callback })
        }
      }
    }
    return this
  }

  async find(id: string | number): Promise<any | null> {
    const model = await this.ModelClass.find(id)
    if (!model) return null
    await this.loadModels([model])
    return model
  }

  async get(): Promise<any[]> {
    const models = await this.ModelClass.get()
    await this.loadModels(models)
    return models
  }

  async loadModels(models: any[]) {
    if (!models.length) return
    for (const rel of this.relations) {
      const dummy = new this.ModelClass({}, { force: true })
      if (typeof dummy[rel.name] !== 'function') {
        throw new Error(`Relation [${rel.name}] is not defined on model [${this.ModelClass.name}].`)
      }
      const relationInstance = dummy[rel.name]()
      if (typeof relationInstance.eagerLoad !== 'function') {
        throw new Error(`Relation [${rel.name}] does not support bulk eager loading.`)
      }
      await relationInstance.eagerLoad(rel.name, models, rel.callback)
    }
  }
}

function cast(value: any, type?: any, model?: any, key?: string) {
  if (value === undefined || value === null) return value
  if (typeof type === 'string' && type.startsWith('date:')) return moment(value, type.slice('date:'.length))
  if (type === 'number') return Number(value)
  if (type === 'boolean') return Boolean(value)
  if (type === 'date') return moment.isMoment(value) ? value : moment(value)
  if (type === 'json' || type === 'array' || type === 'object') return typeof value === 'string' ? JSON.parse(value) : value
  if (type === 'encrypted') {
    if (typeof value !== 'string') return value
    return isBase64(value) ? Buffer.from(value, 'base64').toString('utf8') : value
  }

  const CastClass = typeof type === 'function' ? new type() : type
  if (CastClass && typeof CastClass.get === 'function') {
    return CastClass.get(model, key ?? '', value, model ? model.attributes() : {})
  }
  return value
}

function serialize(value: any, type?: any, model?: any, key?: string) {
  if (value === undefined) return value
  if (type === 'json' || type === 'array' || type === 'object') return typeof value === 'string' ? value : JSON.stringify(value)
  if (type === 'encrypted') return Buffer.from(String(value)).toString('base64')
  if (type === 'date') {
    if (moment.isMoment(value)) return value.toISOString()
    if (value instanceof Date) return value.toISOString()
    return value
  }

  const CastClass = typeof type === 'function' ? new type() : type
  if (CastClass && typeof CastClass.set === 'function') {
    return CastClass.set(model, key ?? '', value, model ? model.attributes() : {})
  }
  return value
}

function changedAttributes(before: Record<string, any>, after: Record<string, any>) {
  const changes: Record<string, any> = {}
  for (const [key, value] of Object.entries(after)) {
    if (String((before as any)[key]) !== String(value)) changes[key] = value
  }
  return changes
}

function isBase64(value: string) {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
}

async function resolveRelationResults(model: any, relation: string, callback?: (query: any) => void) {
  if (typeof model[relation] !== 'function') return []
  const relationInstance = model[relation]()
  if (callback && relationInstance?.where) callback(relationInstance)
  if (callback && !relationInstance?.where && relationInstance?.get) {
    // Existing relation objects expose get()/first() rather than a separate query builder.
  }
  const result = typeof relationInstance.get === 'function'
    ? await relationInstance.get()
    : typeof relationInstance.first === 'function'
      ? await relationInstance.first()
      : null
  if (!result) return []
  return Array.isArray(result) ? result : [result]
}
