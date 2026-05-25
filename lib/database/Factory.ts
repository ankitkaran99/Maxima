import type { Model } from '@lib/database/Model.js'

export class FactoryRegistry {
  private static factories = new Map<any, any>()
  static register(modelClass: any, factoryClass: any) {
    this.factories.set(modelClass, factoryClass)
  }
  static get(modelClass: any) {
    return this.factories.get(modelClass)
  }
}

export abstract class Factory<T extends typeof Model> {
  abstract model: T
  abstract definition(): Record<string, any>
  protected countNumber?: number
  protected stateOverrides: any[] = []

  count(n: number) {
    const factory = Object.create(this)
    factory.countNumber = n
    return factory
  }

  state(state: Record<string, any> | ((attributes: Record<string, any>) => Record<string, any>)) {
    const factory = Object.create(this)
    factory.stateOverrides = [...this.stateOverrides, state]
    return factory
  }

  make(overrides: Record<string, any> = {}): any {
    if (this.countNumber !== undefined) {
      return Array.from({ length: this.countNumber }, () => new this.model(this.getAttributes(overrides)))
    }
    return new this.model(this.getAttributes(overrides))
  }

  async create(overrides: Record<string, any> = {}): Promise<any> {
    if (this.countNumber !== undefined) {
      const instances = Array.from({ length: this.countNumber }, () => new this.model(this.getAttributes(overrides)))
      await Promise.all(instances.map(inst => inst.save()))
      return instances
    }
    return this.model.create(this.getAttributes(overrides))
  }

  private getAttributes(overrides: Record<string, any> = {}) {
    let attributes = { ...this.definition() }
    for (const override of this.stateOverrides) {
      const resolved = typeof override === 'function' ? override(attributes) : override
      Object.assign(attributes, resolved)
    }
    return { ...attributes, ...overrides }
  }
}

export abstract class Seeder {
  abstract run(): Promise<void> | void
}
