import type { Model } from '@lib/database/Model.js'

export class SerializableModelRegistry {
  private static models = new Map<string, typeof Model>()

  static register(model: typeof Model, name = model.name) {
    this.models.set(name, model)
  }

  static resolve(name: string) {
    const model = this.models.get(name)
    if (!model) throw new Error(`Serialized model [${name}] is not registered.`)
    return model
  }
}
