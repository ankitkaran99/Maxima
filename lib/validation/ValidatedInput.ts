export class ValidatedInput<T extends Record<string, unknown> = Record<string, unknown>> {
  constructor(private readonly input: T) {}

  all() {
    return { ...this.input } as T
  }

  only<K extends keyof T>(keys: K[]) {
    return Object.fromEntries(keys.filter(key => key in this.input).map(key => [key, this.input[key]])) as Pick<T, K>
  }

  except<K extends keyof T>(keys: K[]) {
    return Object.fromEntries(Object.entries(this.input).filter(([key]) => !keys.includes(key as K))) as Omit<T, K>
  }

  collect() {
    return Object.entries(this.input)
  }

  merge(values: Record<string, unknown>) {
    return new ValidatedInput({ ...this.input, ...values })
  }

  toJSON() {
    return this.all()
  }
}
