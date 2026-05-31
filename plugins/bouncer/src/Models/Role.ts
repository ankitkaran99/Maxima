import { Model } from '@lib/database/Model.js'

export class Role extends Model {
  static table = 'roles'
  static fillable = ['name']
}
