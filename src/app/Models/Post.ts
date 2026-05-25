import { Model } from '@lib/database/Model.js'

export class Post extends Model {
  static table = 'posts'
  static fillable = ['user_id', 'title', 'body']
  static softDeletes = true

  user() {
    return this.belongsTo('User', 'user_id')
  }
}
