import { Controller } from '@lib/http/Controller.js'

export class HomeController extends Controller {
  async index(_request, response) {
    return response.view('home', { title: 'Maxima' })
  }
}
