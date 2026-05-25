import { Route } from '@lib/http/Route.js'
import { PostController } from '@app/Http/Controllers/PostController.js'
import { schema } from '@lib/validation/schema.js'

Route.group({ prefix: '/api', middleware: ['api'] }, () => {
  Route.get('/posts', [PostController, 'index']).name('posts.index')
  Route.get('/posts/:id', [PostController, 'show']).name('posts.show')
  Route.post('/posts', [PostController, 'store'])
    .validate({
      body: {
        title: schema.string().minLength(3).maxLength(120),
        body: schema.string().minLength(10),
        user_id: schema.integer().optional()
      }
    })
    .name('posts.store')
  Route.put('/posts/:id', [PostController, 'update']).middleware('can:update,post').name('posts.update')
  Route.delete('/posts/:id', [PostController, 'destroy']).middleware('can:delete,post').name('posts.destroy')
})
