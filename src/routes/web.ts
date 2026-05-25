import { Route } from '@lib/http/Route.js'
import { HomeController } from '@app/Http/Controllers/HomeController.js'

Route.group({ middleware: ['web'] }, () => {
  Route.get('/', [HomeController, 'index']).name('home')
})
