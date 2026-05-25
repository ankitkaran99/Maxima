import { Controller } from '@lib/http/Controller.js'
import { Post } from '@app/Models/Post.js'

export class PostController extends Controller {
  async index() {
    return Post.get()
  }

  async show(request) {
    return Post.findOrFail(request.params.id)
  }

  async store(request) {
    const data = await request.validate({
      title: (await import('@lib/validation/schema.js')).schema.string().minLength(3).maxLength(120),
      body: (await import('@lib/validation/schema.js')).schema.string().minLength(10),
      user_id: (await import('@lib/validation/schema.js')).schema.integer().optional()
    })
    return Post.create({ user_id: data.user_id ?? 1, title: data.title, body: data.body })
  }

  async update(request) {
    const post = await Post.findOrFail(request.params.id)
    await this.authorize('update', post)
    await post.update(request.only(['title', 'body']))
    return post
  }

  async destroy(request) {
    const post = await Post.findOrFail(request.params.id)
    await this.authorize('delete', post)
    await post.delete()
    return { deleted: true }
  }
}
