import { Model } from '@lib/database/Model.js'

export class Ability extends Model {
  static table = 'abilities'
  static fillable = ['name']
}
