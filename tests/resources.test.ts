import { describe, expect, it } from 'vitest'
import { JsonResource, ResourceCollection } from '@lib/http/Resource.js'

class MockModel {
  constructor(public id: number, public name: string, public email: string) {}
  toJSON() {
    return { id: this.id, name: this.name, email: this.email }
  }
}

class UserResource extends JsonResource {
  toArray(request: any) {
    return {
      userId: this.id,
      userName: this.name,
      userEmail: this.email
    }
  }
}

describe('API Resources', () => {
  it('formats single resource attributes and proxies model properties', () => {
    const user = new MockModel(1, 'Ada', 'ada@example.com')
    const resource = new UserResource(user)

    // Proxy properties check
    expect((resource as any).id).toBe(1)
    expect((resource as any).name).toBe('Ada')
    
    // Resolve check
    expect(resource.resolve()).toEqual({
      data: {
        userId: 1,
        userName: 'Ada',
        userEmail: 'ada@example.com'
      }
    })
  })

  it('formats collection responses', () => {
    const users = [
      new MockModel(1, 'Ada', 'ada@example.com'),
      new MockModel(2, 'Bob', 'bob@example.com')
    ]
    const collection = UserResource.collection(users)
    expect(collection.resolve()).toEqual({
      data: [
        { userId: 1, userName: 'Ada', userEmail: 'ada@example.com' },
        { userId: 2, userName: 'Bob', userEmail: 'bob@example.com' }
      ]
    })
  })

  it('formats paginated collection responses', () => {
    const paginated = {
      data: [
        new MockModel(1, 'Ada', 'ada@example.com'),
        new MockModel(2, 'Bob', 'bob@example.com')
      ],
      total: 50,
      page: 2,
      perPage: 15
    }
    const collection = UserResource.collection(paginated)
    const result = collection.resolve()

    expect(result.data).toEqual([
      { userId: 1, userName: 'Ada', userEmail: 'ada@example.com' },
      { userId: 2, userName: 'Bob', userEmail: 'bob@example.com' }
    ])
    expect(result.links).toEqual({
      first: '/?page=1',
      last: '/?page=4',
      prev: '/?page=1',
      next: '/?page=3'
    })
    expect(result.meta).toEqual({
      current_page: 2,
      from: 16,
      last_page: 4,
      per_page: 15,
      to: 30,
      total: 50
    })
  })
})
