import { ArraySchema, FieldSchema, ObjectSchema, extendRule, type Rule } from '@lib/validation/schema.js'
import { ValidationException } from '@lib/validation/ValidationException.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { storagePath } from '@lib/support/paths.js'

export type ValidationRules = Record<string, FieldSchema | Record<string, FieldSchema>>
export type ValidatorOptions = {
  messages?: Record<string, string>
  attributes?: Record<string, string>
  values?: Record<string, Record<string, string> | string>
  replacers?: Record<string, (message: string, field: string, rule: Rule, value: unknown, data: Record<string, any>) => string>
  meta?: Record<string, any>
  locale?: string
  fallbackLocale?: string
  stopOnFirstFailure?: boolean
}
type SometimesCallback = (data: Record<string, any>, value: any) => boolean | Promise<boolean>
type ConditionalRules = { field: string, rules: FieldSchema, callback: SometimesCallback }

export class ValidatorInstance<T extends Record<string, unknown> = Record<string, unknown>> {
  private errorBag: Record<string, string[]> = {}
  private validatedData?: T
  private conditionalRules: ConditionalRules[] = []
  private stopOnFirstFailureFlag = false
  private localeMessages: Record<string, string> = {}

  constructor(private data: Record<string, any>, private rules: ValidationRules, private options: ValidatorOptions = {}) {}

  async validate() {
    this.errorBag = {}
    this.localeMessages = await this.loadLocaleMessages()
    const output: Record<string, unknown> = {}
    const rules = { ...this.rules }

    for (const conditional of this.conditionalRules) {
      if (await conditional.callback(this.data, this.data[conditional.field])) {
        rules[conditional.field] = conditional.rules
      }
    }

    for (const [field, fieldSchema] of Object.entries(rules)) {
      if (!(fieldSchema instanceof FieldSchema)) continue
      const value = getNestedValue(this.data, field)
      const missing = value === undefined || value === ''
      if (this.shouldExclude(fieldSchema, this.data)) continue
      if (missing && fieldSchema.isOptional()) {
        await this.validateRules(field, value, fieldSchema.getRules().filter(rule => isImplicitRule(rule.name)))
        if (this.errorBag[field]?.length) continue
        continue
      }
      if (value === null && fieldSchema.isNullable()) {
        output[field] = null
        continue
      }
      if (missing) {
        await this.validateRules(field, value, fieldSchema.getRules().filter(rule => isImplicitRule(rule.name)))
        if (!this.errorBag[field]?.length) this.addError(field, { name: 'required', validate: () => false }, value)
        continue
      }

      let casted = fieldSchema.cast(value)
      await this.validateRules(field, casted, fieldSchema.getRules(), fieldSchema.shouldBail())

      if (fieldSchema instanceof ArraySchema && fieldSchema.getMemberSchema() && Array.isArray(casted)) {
        for (let i = 0; i < casted.length; i++) {
          const memberSchema = fieldSchema.getMemberSchema()!
          let memberValue = memberSchema.cast(casted[i])
          await this.validateRules(`${field}.${i}`, memberValue, memberSchema.getRules(), memberSchema.shouldBail())
          memberValue = this.applyTransforms(memberValue, memberSchema.getRules())
          casted[i] = memberValue
        }
      }

      if (fieldSchema instanceof ObjectSchema && Object.keys(fieldSchema.getShape()).length) {
        const nested = new ValidatorInstance(casted as Record<string, any>, fieldSchema.getShape(), this.options)
        await nested.validate().then(data => {
          casted = data
        }).catch((error: ValidationException) => {
          for (const [key, messages] of Object.entries(error.errors)) this.errorBag[`${field}.${key}`] = messages
        })
      }

      casted = this.applyTransforms(casted, fieldSchema.getRules())
      output[field] = casted
    }

    if (Object.keys(this.errorBag).length) throw new ValidationException(this.errorBag)
    this.validatedData = output as T
    return this.validatedData
  }

  sometimes(field: string, rules: FieldSchema, callback: SometimesCallback) {
    this.conditionalRules.push({ field, rules, callback })
    return this
  }

  stopOnFirstFailure() {
    this.stopOnFirstFailureFlag = true
    return this
  }

  async fails() {
    try {
      await this.validate()
      return false
    } catch {
      return true
    }
  }

  errors() {
    return this.errorBag
  }

  validated() {
    return this.validatedData ?? {} as T
  }

  private async validateRules(field: string, value: unknown, rules: Rule[], bail = false) {
    for (const rule of rules) {
      const passes = await rule.validate(value, { field, data: this.data, meta: this.options.meta })
      if (!passes) {
        this.addError(field, rule, value)
        if (this.options.stopOnFirstFailure || this.stopOnFirstFailureFlag) throw new ValidationException(this.errorBag)
        if (bail) break
      }
    }
  }

  private applyTransforms(value: unknown, rules: Rule[]) {
    let transformed = value
    for (const rule of rules) {
      if (rule.transform) transformed = rule.transform(transformed)
    }
    return transformed
  }

  private shouldExclude(fieldSchema: FieldSchema, data: Record<string, any>) {
    for (const rule of fieldSchema.getRules()) {
      if (rule.name === 'exclude_if' && data[rule.meta?.field] === rule.meta?.expected) return true
      if (rule.name === 'exclude_unless' && data[rule.meta?.field] !== rule.meta?.expected) return true
    }
    return false
  }

  private addError(field: string, rule: Rule, value: unknown) {
    const key = `${field}.${rule.name}`
    const message = this.formatMessage(field, rule, value, this.options.messages?.[key]
      ?? this.findWildcardMessage(field, rule.name, this.options.messages)
      ?? this.options.messages?.[rule.name]
      ?? this.localeMessages[key]
      ?? this.findWildcardMessage(field, rule.name, this.localeMessages)
      ?? this.localeMessages[rule.name]
      ?? (typeof rule.message === 'function' ? rule.message(field) : rule.message)
      ?? `The :attribute field is invalid.`)
    this.errorBag[field] ??= []
    this.errorBag[field].push(message)
  }

  private findWildcardMessage(field: string, rule: string, messages?: Record<string, string>) {
    if (!messages) return undefined
    const candidates = [`${field}.${rule}`, field]
    for (const [key, message] of Object.entries(messages)) {
      const regex = wildcardRegex(key)
      if (candidates.some(candidate => regex.test(candidate))) return message
    }
    return undefined
  }

  private formatMessage(field: string, rule: Rule, value: unknown, message: string) {
    const replacements: Record<string, string> = {
      ':attribute': this.attributeName(field),
      ':input': String(value ?? ''),
      ':value': this.valueName(field, value),
      ':other': this.attributeName(String(rule.meta?.field ?? rule.meta?.fields?.[0] ?? '')),
      ':values': Array.isArray(rule.meta?.values) ? rule.meta.values.join(', ') : '',
      ':min': String(rule.meta?.min ?? ''),
      ':max': String(rule.meta?.max ?? ''),
      ':size': String(rule.meta?.size ?? '')
    }
    const formatted = Object.entries(replacements)
      .sort(([first], [second]) => second.length - first.length)
      .reduce((current, [search, replacement]) => current.replaceAll(search, replacement), message)
    return this.options.replacers?.[rule.name]?.(formatted, field, rule, value, this.data) ?? formatted
  }

  private attributeName(field: string) {
    const localeAttributes = Object.fromEntries(
      Object.entries(this.localeMessages)
        .filter(([key]) => key.startsWith('attributes.'))
        .map(([key, value]) => [key.slice('attributes.'.length), value])
    )
    return this.options.attributes?.[field]
      ?? this.findWildcardValue(field, this.options.attributes)
      ?? localeAttributes[field]
      ?? this.findWildcardValue(field, localeAttributes)
      ?? field
  }

  private valueName(field: string, value: unknown) {
    const optionValues = this.options.values?.[field] ?? this.findWildcardValue(field, this.options.values as Record<string, any> | undefined)
    if (optionValues && typeof optionValues === 'object') return optionValues[String(value)] ?? String(value ?? '')
    if (typeof optionValues === 'string') return optionValues
    return this.localeMessages[`values.${field}.${String(value)}`] ?? String(value ?? '')
  }

  private findWildcardValue(field: string, values?: Record<string, any>) {
    if (!values) return undefined
    for (const [key, value] of Object.entries(values)) {
      const regex = wildcardRegex(key)
      if (regex.test(field)) return value
    }
    return undefined
  }

  private async loadLocaleMessages() {
    const locale = this.options.locale ?? this.options.meta?.locale
    if (!locale) return {}
    const fallbackLocale = this.options.fallbackLocale ?? this.options.meta?.fallbackLocale ?? 'en'
    const messages: Record<string, string> = {}
    for (const currentLocale of [...new Set([fallbackLocale, locale].filter(Boolean))]) {
      for (const file of this.localeFileCandidates(currentLocale)) {
        try {
          Object.assign(messages, JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, string>)
          break
        } catch {}
      }
    }
    return messages
  }

  private localeFileCandidates(locale: string) {
    return [
      storagePath('..', 'resources', 'lang', locale, 'validation.json'),
      path.resolve(process.cwd(), 'src', 'resources', 'lang', locale, 'validation.json'),
      path.resolve(process.cwd(), 'resources', 'lang', locale, 'validation.json')
    ]
  }
}

function isImplicitRule(name: string) {
  return name.startsWith('required_')
    || ['present', 'filled', 'missing', 'missing_if', 'missing_unless', 'missing_with', 'missing_with_all', 'prohibited', 'exclude_if', 'exclude_unless', 'accepted_if', 'declined_if'].includes(name)
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function wildcardRegex(value: string) {
  return new RegExp(`^${value.split('*').map(escapeRegex).join('[^.]+')}$`)
}

function getNestedValue(source: Record<string, any>, key: string) {
  if (Object.prototype.hasOwnProperty.call(source, key)) return source[key]
  return key.split('.').reduce<any>((current, segment) => {
    if (current === undefined || current === null || typeof current !== 'object') return undefined
    return current[segment]
  }, source)
}

export const Validator = {
  make<T extends Record<string, unknown> = Record<string, unknown>>(data: Record<string, any>, rules: ValidationRules, options?: ValidatorOptions) {
    return new ValidatorInstance<T>(data, rules, options)
  },

  async validate<T extends Record<string, unknown> = Record<string, unknown>>(data: Record<string, any>, rules: ValidationRules, options?: ValidatorOptions) {
    return new ValidatorInstance<T>(data, rules, options).validate()
  },

  extend: extendRule
}
