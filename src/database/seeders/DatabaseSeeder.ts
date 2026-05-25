import { User } from '@app/Models/User.js'
import { Post } from '@app/Models/Post.js'

export async function seed() {
  const user = await User.create({ name: 'Ada Lovelace', email: 'ada@example.com', password: 'secret' })
  await Post.create({ user_id: (user as any).id, title: 'Hello Maxima', body: 'This is a complete CRUD example powered by Maxima.' })
}
