import { isIP } from 'node:net'
import { resolve } from 'node:dns/promises'

export type RuleContext = {
  field: string
  data: Record<string, any>
  meta?: Record<string, any>
}

export type Rule = {
  name: string
  validate: (value: any, ctx: RuleContext) => boolean | Promise<boolean>
  message?: string | ((field: string) => string)
  transform?: (value: any) => any
  meta?: Record<string, any>
}

type ImageDimensionOptions = {
  width?: number
  height?: number
  minWidth?: number
  maxWidth?: number
  minHeight?: number
  maxHeight?: number
  ratio?: number | string
}

type EnumSource<T> = readonly T[] | Record<string, T | string>

export class FieldSchema<T = unknown> {
  private rules: Rule[] = []
  private optionalField = false
  private nullableField = false
  private bailField = false

  constructor(private caster?: (value: any) => T) {}

  getRules() { return this.rules }
  isOptional() { return this.optionalField }
  isNullable() { return this.nullableField }
  shouldBail() { return this.bailField }

  use(name: string, options?: any) { this.rules.push({ name, validate: (value, ctx) => customRules.get(name)?.(value, ctx, options) ?? false }); return this }
  optional() { this.optionalField = true; return this }
  nullable() { this.nullableField = true; return this }
  required() { this.optionalField = false; return this }
  sometimes() { return this.optional() }
  bail() { this.bailField = true; return this }
  present() { this.optionalField = true; this.rules.push({ name: 'present', validate: (_, ctx) => Object.prototype.hasOwnProperty.call(ctx.data, ctx.field) }); return this }
  filled() { this.optionalField = true; this.rules.push({ name: 'filled', validate: value => !isMissing(value) && value !== null }); return this }
  missing() { this.optionalField = true; this.rules.push({ name: 'missing', validate: (_, ctx) => !Object.prototype.hasOwnProperty.call(ctx.data, ctx.field) }); return this }
  missingIf(field: string, expected: unknown) { this.optionalField = true; this.rules.push({ name: 'missing_if', validate: (_, ctx) => ctx.data[field] === expected ? !Object.prototype.hasOwnProperty.call(ctx.data, ctx.field) : true, meta: { field, expected } }); return this }
  missingUnless(field: string, expected: unknown) { this.optionalField = true; this.rules.push({ name: 'missing_unless', validate: (_, ctx) => ctx.data[field] !== expected ? !Object.prototype.hasOwnProperty.call(ctx.data, ctx.field) : true, meta: { field, expected } }); return this }
  missingWith(...fields: string[]) { this.optionalField = true; this.rules.push({ name: 'missing_with', validate: (_, ctx) => fields.some(field => !isMissing(ctx.data[field])) ? !Object.prototype.hasOwnProperty.call(ctx.data, ctx.field) : true, meta: { fields } }); return this }
  missingWithAll(...fields: string[]) { this.optionalField = true; this.rules.push({ name: 'missing_with_all', validate: (_, ctx) => fields.every(field => !isMissing(ctx.data[field])) ? !Object.prototype.hasOwnProperty.call(ctx.data, ctx.field) : true, meta: { fields } }); return this }
  prohibited() { this.optionalField = true; this.rules.push({ name: 'prohibited', validate: value => isMissing(value) || value === null || (Array.isArray(value) && value.length === 0) }); return this }
  prohibits(...fields: string[]) {
    this.rules.push({ name: 'prohibits', validate: (value, ctx) => isMissing(value) || value === null ? true : fields.every(field => isMissing(ctx.data[field]) || ctx.data[field] === null) })
    return this
  }
  excludeIf(field: string, expected: unknown) { this.optionalField = true; this.rules.push({ name: 'exclude_if', validate: () => true, meta: { field, expected } }); return this }
  excludeUnless(field: string, expected: unknown) { this.optionalField = true; this.rules.push({ name: 'exclude_unless', validate: () => true, meta: { field, expected } }); return this }
  requiredIf(field: string, expected: unknown) {
    this.optionalField = true
    this.rules.push({ name: 'required_if', validate: (value, ctx) => ctx.data[field] === expected ? !isMissing(value) : true })
    return this
  }
  requiredUnless(field: string, expected: unknown) {
    this.optionalField = true
    this.rules.push({ name: 'required_unless', validate: (value, ctx) => ctx.data[field] !== expected ? !isMissing(value) : true })
    return this
  }
  requiredWith(...fields: string[]) {
    this.optionalField = true
    this.rules.push({ name: 'required_with', validate: (value, ctx) => fields.some(field => !isMissing(ctx.data[field])) ? !isMissing(value) : true, meta: { fields } })
    return this
  }
  requiredWithAll(...fields: string[]) {
    this.optionalField = true
    this.rules.push({ name: 'required_with_all', validate: (value, ctx) => fields.every(field => !isMissing(ctx.data[field])) ? !isMissing(value) : true, meta: { fields } })
    return this
  }
  requiredWithout(...fields: string[]) {
    this.optionalField = true
    this.rules.push({ name: 'required_without', validate: (value, ctx) => fields.some(field => isMissing(ctx.data[field])) ? !isMissing(value) : true, meta: { fields } })
    return this
  }
  requiredWithoutAll(...fields: string[]) {
    this.optionalField = true
    this.rules.push({ name: 'required_without_all', validate: (value, ctx) => fields.every(field => isMissing(ctx.data[field])) ? !isMissing(value) : true, meta: { fields } })
    return this
  }
  minLength(length: number) { this.rules.push({ name: 'min', validate: value => String(value).length >= length }); return this }
  maxLength(length: number) { this.rules.push({ name: 'max', validate: value => String(value).length <= length }); return this }
  min(value: number) { this.rules.push({ name: 'min', validate: actual => Number(actual) >= value }); return this }
  max(value: number) { this.rules.push({ name: 'max', validate: actual => Number(actual) <= value }); return this }
  size(value: number) { this.rules.push({ name: 'size', validate: actual => sizeOf(actual) === value || Number(actual) === value, meta: { size: value } }); return this }
  between(min: number, max: number) { this.rules.push({ name: 'between', validate: actual => Number(actual) >= min && Number(actual) <= max }); return this }
  gt(fieldOrValue: string | number) { this.rules.push({ name: 'gt', validate: (value, ctx) => Number(value) > Number(resolveComparison(fieldOrValue, ctx)) }); return this }
  gte(fieldOrValue: string | number) { this.rules.push({ name: 'gte', validate: (value, ctx) => Number(value) >= Number(resolveComparison(fieldOrValue, ctx)) }); return this }
  lt(fieldOrValue: string | number) { this.rules.push({ name: 'lt', validate: (value, ctx) => Number(value) < Number(resolveComparison(fieldOrValue, ctx)) }); return this }
  lte(fieldOrValue: string | number) { this.rules.push({ name: 'lte', validate: (value, ctx) => Number(value) <= Number(resolveComparison(fieldOrValue, ctx)) }); return this }
  digits(length: number) { this.rules.push({ name: 'digits', validate: value => new RegExp(`^\\d{${length}}$`).test(String(value)) }); return this }
  digitsBetween(min: number, max: number) { this.rules.push({ name: 'digits_between', validate: value => new RegExp(`^\\d{${min},${max}}$`).test(String(value)) }); return this }
  minDigits(length: number) { this.rules.push({ name: 'min_digits', validate: value => new RegExp(`^\\d{${length},}$`).test(String(value)), meta: { min: length } }); return this }
  maxDigits(length: number) { this.rules.push({ name: 'max_digits', validate: value => new RegExp(`^\\d{1,${length}}$`).test(String(value)), meta: { max: length } }); return this }
  decimal(min = 1, max = min) { this.rules.push({ name: 'decimal', validate: value => new RegExp(`^-?\\d+\\.\\d{${min},${max}}$`).test(String(value)) }); return this }
  multipleOf(value: number) { this.rules.push({ name: 'multiple_of', validate: actual => Number(actual) % value === 0 }); return this }
  email() { this.rules.push({ name: 'email', validate: value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value)) }); return this }
  url() { this.rules.push({ name: 'url', validate: value => { try { const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) } catch { return false } } }); return this }
  activeUrl() { this.rules.push({ name: 'active_url', validate: async value => hasResolvableHost(String(value)) }); return this }
  uuid() { this.rules.push({ name: 'uuid', validate: value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(String(value)) }); return this }
  ulid() { this.rules.push({ name: 'ulid', validate: value => /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(String(value).toUpperCase()) }); return this }
  ip() { this.rules.push({ name: 'ip', validate: value => isIP(String(value)) !== 0 }); return this }
  ipv4() { this.rules.push({ name: 'ipv4', validate: value => isIP(String(value)) === 4 }); return this }
  ipv6() { this.rules.push({ name: 'ipv6', validate: value => isIP(String(value)) === 6 }); return this }
  macAddress() { this.rules.push({ name: 'mac_address', validate: value => /^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/i.test(String(value)) }); return this }
  timezone() { this.rules.push({ name: 'timezone', validate: value => isTimeZone(String(value)) }); return this }
  json() { this.rules.push({ name: 'json', validate: value => { try { JSON.parse(String(value)); return true } catch { return false } } }); return this }
  regex(pattern: RegExp) { this.rules.push({ name: 'regex', validate: value => pattern.test(String(value)) }); return this }
  notRegex(pattern: RegExp) { this.rules.push({ name: 'not_regex', validate: value => !pattern.test(String(value)) }); return this }
  alpha() { this.rules.push({ name: 'alpha', validate: value => /^[\p{L}]+$/u.test(String(value)) }); return this }
  alphaNum() { this.rules.push({ name: 'alpha_num', validate: value => /^[\p{L}\p{N}]+$/u.test(String(value)) }); return this }
  ascii() { this.rules.push({ name: 'ascii', validate: value => /^[\x00-\x7F]*$/.test(String(value)) }); return this }
  lowercase() { this.rules.push({ name: 'lowercase', validate: value => String(value) === String(value).toLowerCase() }); return this }
  uppercase() { this.rules.push({ name: 'uppercase', validate: value => String(value) === String(value).toUpperCase() }); return this }
  startsWith(values: string | string[]) { const list = Array.isArray(values) ? values : [values]; this.rules.push({ name: 'starts_with', validate: value => list.some(prefix => String(value).startsWith(prefix)) }); return this }
  endsWith(values: string | string[]) { const list = Array.isArray(values) ? values : [values]; this.rules.push({ name: 'ends_with', validate: value => list.some(suffix => String(value).endsWith(suffix)) }); return this }
  doesntStartWith(values: string | string[]) { const list = Array.isArray(values) ? values : [values]; this.rules.push({ name: 'doesnt_start_with', validate: value => list.every(prefix => !String(value).startsWith(prefix)) }); return this }
  doesntEndWith(values: string | string[]) { const list = Array.isArray(values) ? values : [values]; this.rules.push({ name: 'doesnt_end_with', validate: value => list.every(suffix => !String(value).endsWith(suffix)) }); return this }
  in(values: unknown[]) { this.rules.push({ name: 'in', validate: value => values.includes(value), meta: { values } }); return this }
  notIn(values: unknown[]) { this.rules.push({ name: 'not_in', validate: value => !values.includes(value), meta: { values } }); return this }
  inArray(field: string) { this.rules.push({ name: 'in_array', validate: (value, ctx) => Array.isArray(ctx.data[field]) && ctx.data[field].includes(value), meta: { field } }); return this }
  enum<T>(source: EnumSource<T>) {
    const values = enumValues(source)
    this.rules.push({ name: 'enum', validate: value => values.some(candidate => candidate === value || String(candidate) === String(value)), meta: { values } })
    return this
  }
  same(field: string) { this.rules.push({ name: 'same', validate: (value, ctx) => value === ctx.data[field] }); return this }
  different(field: string) { this.rules.push({ name: 'different', validate: (value, ctx) => value !== ctx.data[field] }); return this }
  confirmed(field?: string) { this.rules.push({ name: 'confirmed', validate: (value, ctx) => value === ctx.data[field ?? `${ctx.field}_confirmation`] }); return this }
  accepted() { this.rules.push({ name: 'accepted', validate: value => [true, 1, '1', 'yes', 'on'].includes(value) }); return this }
  acceptedIf(field: string, expected: unknown) { this.optionalField = true; this.rules.push({ name: 'accepted_if', validate: (value, ctx) => ctx.data[field] === expected ? [true, 1, '1', 'yes', 'on'].includes(value) : true, meta: { field, expected } }); return this }
  declined() { this.rules.push({ name: 'declined', validate: value => [false, 0, '0', 'no', 'off'].includes(value) }); return this }
  declinedIf(field: string, expected: unknown) { this.optionalField = true; this.rules.push({ name: 'declined_if', validate: (value, ctx) => ctx.data[field] === expected ? [false, 0, '0', 'no', 'off'].includes(value) : true, meta: { field, expected } }); return this }
  requiredIfAccepted(field: string) {
    this.optionalField = true
    this.rules.push({ name: 'required_if_accepted', validate: (value, ctx) => [true, 1, '1', 'yes', 'on'].includes(ctx.data[field]) ? !isMissing(value) : true, meta: { field } })
    return this
  }
  requiredIfDeclined(field: string) {
    this.optionalField = true
    this.rules.push({ name: 'required_if_declined', validate: (value, ctx) => [false, 0, '0', 'no', 'off'].includes(ctx.data[field]) ? !isMissing(value) : true, meta: { field } })
    return this
  }
  boolean() { this.rules.push({ name: 'boolean', validate: value => [true, false, 0, 1, '0', '1', 'true', 'false'].includes(value) }); return this }
  currentPassword(guard = 'default') { this.rules.push({ name: 'current_password', validate: async (value, ctx) => ctx.meta?.currentPasswordValidator?.(value, guard, ctx) ?? false, meta: { guard } }); return this }
  hexColor() { this.rules.push({ name: 'hex_color', validate: value => /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(String(value)) }); return this }
  after(dateOrField: string | Date) { this.rules.push({ name: 'after', validate: (value, ctx) => toTime(value) > toTime(resolveComparison(dateOrField, ctx)) }); return this }
  afterOrEqual(dateOrField: string | Date) { this.rules.push({ name: 'after_or_equal', validate: (value, ctx) => toTime(value) >= toTime(resolveComparison(dateOrField, ctx)) }); return this }
  before(dateOrField: string | Date) { this.rules.push({ name: 'before', validate: (value, ctx) => toTime(value) < toTime(resolveComparison(dateOrField, ctx)) }); return this }
  beforeOrEqual(dateOrField: string | Date) { this.rules.push({ name: 'before_or_equal', validate: (value, ctx) => toTime(value) <= toTime(resolveComparison(dateOrField, ctx)) }); return this }
  dateEquals(dateOrField: string | Date) { this.rules.push({ name: 'date_equals', validate: (value, ctx) => sameDate(value, resolveComparison(dateOrField, ctx)) }); return this }
  dateFormat(format: string) { this.rules.push({ name: 'date_format', validate: value => dateFormatRegex(format).test(String(value)) }); return this }
  file() { this.rules.push({ name: 'file', validate: value => Boolean(value && typeof value === 'object') }); return this }
  image() { this.rules.push({ name: 'image', validate: value => String(value?.mimeType ?? value?.mimetype ?? '').startsWith('image/') }); return this }
  dimensions(options: ImageDimensionOptions) { this.rules.push({ name: 'dimensions', validate: value => validateDimensions(value, options) }); return this }
  width(width: number) { return this.dimensions({ width }) }
  height(height: number) { return this.dimensions({ height }) }
  mime(type: string) { return this.mimes([type]) }
  mimeTypes(types: string[]) {
    this.rules.push({ name: 'mimetypes', validate: value => types.includes(String(value?.mimeType ?? value?.mimetype ?? '')), meta: { values: types } })
    return this
  }
  mimes(types: string[]) {
    this.rules.push({
      name: 'mimes',
      validate: value => {
        const mimeType = String(value?.mimeType ?? value?.mimetype ?? '')
        const extension = String(value?.extension ?? value?.originalName?.()?.split('.').pop?.() ?? value?.filename?.split('.').pop?.() ?? '')
        return types.includes(mimeType) || types.includes(extension)
      }
    })
    return this
  }
  extensions(types: string[]) {
    const normalized = types.map(type => type.replace(/^\./, '').toLowerCase())
    this.rules.push({ name: 'extensions', validate: value => normalized.includes(String(value?.extension ?? value?.originalName?.()?.split('.').pop?.() ?? value?.filename?.split('.').pop?.() ?? '').toLowerCase()), meta: { values: normalized } })
    return this
  }
  maxFileSize(bytes: number) { this.rules.push({ name: 'max_file_size', validate: value => Number(value?.size ?? 0) <= bytes }); return this }
  minFileSize(bytes: number) { this.rules.push({ name: 'min_file_size', validate: value => Number(value?.size ?? 0) >= bytes }); return this }
  requiredArrayKeys(...keys: string[]) { this.rules.push({ name: 'required_array_keys', validate: value => keys.every(key => value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)) }); return this }
  exists(table: string, column = 'id') { this.rules.push({ name: 'exists', validate: (_, ctx) => databaseRule('exists', table, column, ctx.field, ctx.data) }); return this }
  unique(table: string, column = 'id') { this.rules.push({ name: 'unique', validate: (_, ctx) => databaseRule('unique', table, column, ctx.field, ctx.data) }); return this }
  transform(transform: (value: T) => T) { this.rules.push({ name: 'transform', validate: () => true, transform }); return this }

  cast(value: any) {
    return this.caster ? this.caster(value) : value
  }
}

function isMissing(value: unknown) {
  return value === undefined || value === ''
}

function sizeOf(value: unknown) {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object' && 'size' in value) return Number((value as any).size)
  return String(value).length
}

function enumValues<T>(source: EnumSource<T>) {
  if (Array.isArray(source)) return source
  return Object.entries(source)
    .filter(([key]) => !/^\d+$/.test(key))
    .map(([, value]) => value as T)
}

function resolveComparison(value: string | number | Date, ctx: RuleContext) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ctx.data, value) ? ctx.data[value] : value
}

function toTime(value: any) {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(time) ? time : Number.NaN
}

function sameDate(value: any, expected: any) {
  const first = new Date(value)
  const second = new Date(expected)
  return Number.isFinite(first.getTime())
    && Number.isFinite(second.getTime())
    && first.toISOString().slice(0, 10) === second.toISOString().slice(0, 10)
}

function dateFormatRegex(format: string) {
  const escaped = format.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = escaped
    .replace(/YYYY/g, '\\d{4}')
    .replace(/YY/g, '\\d{2}')
    .replace(/MM/g, '(0[1-9]|1[0-2])')
    .replace(/DD/g, '(0[1-9]|[12]\\d|3[01])')
    .replace(/HH/g, '([01]\\d|2[0-3])')
    .replace(/mm/g, '([0-5]\\d)')
    .replace(/ss/g, '([0-5]\\d)')
  return new RegExp(`^${pattern}$`)
}

function isTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

async function hasResolvableHost(value: string) {
  try {
    const url = value.includes('://') ? new URL(value) : new URL(`http://${value}`)
    await resolve(url.hostname)
    return true
  } catch {
    return false
  }
}

function validateDimensions(value: any, options: ImageDimensionOptions) {
  const width = Number(value?.width ?? value?.metadata?.width ?? value?.dimensions?.width)
  const height = Number(value?.height ?? value?.metadata?.height ?? value?.dimensions?.height)
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false
  if (options.width !== undefined && width !== options.width) return false
  if (options.height !== undefined && height !== options.height) return false
  if (options.minWidth !== undefined && width < options.minWidth) return false
  if (options.maxWidth !== undefined && width > options.maxWidth) return false
  if (options.minHeight !== undefined && height < options.minHeight) return false
  if (options.maxHeight !== undefined && height > options.maxHeight) return false
  if (options.ratio !== undefined) {
    const expected = typeof options.ratio === 'string' && options.ratio.includes('/')
      ? Number(options.ratio.split('/')[0]) / Number(options.ratio.split('/')[1])
      : Number(options.ratio)
    if (!Number.isFinite(expected) || Math.abs((width / height) - expected) > 0.001) return false
  }
  return true
}

export class ArraySchema<T = unknown> extends FieldSchema<T[]> {
  private memberSchema?: FieldSchema
  constructor() { super(value => Array.isArray(value) ? value : [value]) }
  members(schema: FieldSchema) { this.memberSchema = schema; return this }
  getMemberSchema() { return this.memberSchema }
  distinct() { this.getRules().push({ name: 'distinct', validate: value => Array.isArray(value) && new Set(value.map(item => JSON.stringify(item))).size === value.length }); return this }
  keys(...keys: string[]) { return this.requiredArrayKeys(...keys) }
}

export class ObjectSchema extends FieldSchema<Record<string, unknown>> {
  constructor(private shape: Record<string, FieldSchema> = {}) { super(value => value ?? {}) }
  getShape() { return this.shape }
  keys(...keys: string[]) { return this.requiredArrayKeys(...keys) }
}

export class PasswordSchema extends FieldSchema<string> {
  constructor() {
    super(value => value === undefined || value === null ? value : String(value))
    this.minLength(8)
  }

  min(length: number) {
    const rules = this.getRules()
    const idx = rules.findIndex(r => r.name === 'min')
    if (idx !== -1) rules.splice(idx, 1)
    this.minLength(length)
    return this
  }

  letters() {
    this.getRules().push({
      name: 'password_letters',
      validate: value => /[a-zA-Z]/.test(String(value)),
      message: field => `The ${field} must contain at least one letter.`
    })
    return this
  }

  mixedCase() {
    this.getRules().push({
      name: 'password_mixed',
      validate: value => /[a-z]/.test(String(value)) && /[A-Z]/.test(String(value)),
      message: field => `The ${field} must contain both uppercase and lowercase letters.`
    })
    return this
  }

  numbers() {
    this.getRules().push({
      name: 'password_numbers',
      validate: value => /\d/.test(String(value)),
      message: field => `The ${field} must contain at least one number.`
    })
    return this
  }

  symbols() {
    this.getRules().push({
      name: 'password_symbols',
      validate: value => /[^a-zA-Z0-9]/.test(String(value)),
      message: field => `The ${field} must contain at least one symbol.`
    })
    return this
  }
}

const customRules = new Map<string, (value: any, ctx: RuleContext, options?: any) => boolean | Promise<boolean>>()
let databaseRule: (type: 'exists' | 'unique', table: string, column: string, field: string, data: Record<string, any>) => Promise<boolean> = async () => true

export const schema = {
  string: () => new FieldSchema<string>(value => value === undefined || value === null ? value : String(value)),
  number: () => new FieldSchema<number>(value => Number(value)),
  integer: () => new FieldSchema<number>(value => Number.parseInt(value, 10)),
  boolean: () => new FieldSchema<boolean>(value => value === true || value === 'true' || value === '1' || value === 1 || value === 'on'),
  date: () => new FieldSchema<Date>(value => value instanceof Date ? value : new Date(value)),
  array: () => new ArraySchema(),
  object: (shape?: Record<string, FieldSchema>) => new ObjectSchema(shape),
  file: () => new FieldSchema<any>(),
  password: () => new PasswordSchema()
}

export function extendRule(name: string, rule: (value: any, ctx: RuleContext, options?: any) => boolean | Promise<boolean>) {
  customRules.set(name, rule)
}

export function setDatabaseRuleResolver(resolver: typeof databaseRule) {
  databaseRule = resolver
}
