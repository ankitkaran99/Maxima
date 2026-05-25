import { FormRequest, schema } from '@lib/index.js'

export class StorePostRequest extends FormRequest {
  async authorize() {
    return true
  }

  rules() {
    return {
      title: schema.string().minLength(3).maxLength(120),
      body: schema.string().minLength(10),
      user_id: schema.integer().optional()
    }
  }

  messages() {
    return {
      'title.min': 'The title must be at least 3 characters.',
      'body.min': 'The body must be at least 10 characters.'
    }
  }

  prepareForValidation() {
    this.merge({
      title: this.input<string>('title', '').trim()
    })
  }
}
