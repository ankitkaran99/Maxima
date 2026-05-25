import { describe, expect, it } from 'vitest'
import { Model } from '@lib/database/Model.js'

class UpperCast {
  get(model: any, key: string, value: any) {
    return String(value).toUpperCase()
  }
  set(model: any, key: string, value: any) {
    return String(value).toLowerCase()
  }
}

class TestModel extends Model {
  static casts = {
    code: UpperCast
  }
}

describe('Custom Model Casts', () => {
  it('runs custom getter and setter casts', () => {
    // Getter cast on hydration/instantiation
    const model = new TestModel({ code: 'abc' })
    expect((model as any).code).toBe('ABC')

    // Setter cast on serialization
    const persistable = model.persistableAttributes()
    expect(persistable.code).toBe('abc')
  })
})
