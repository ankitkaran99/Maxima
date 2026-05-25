import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { renderEmail, setApplication, view } from '@lib/foundation/helpers.js'
import { ViewFactory } from '@lib/view/ViewFactory.js'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-views-'))
  await fs.mkdir(path.join(root, 'resources', 'views', 'users'), { recursive: true })
  await fs.mkdir(path.join(root, 'resources', 'emails'), { recursive: true })
  await fs.writeFile(path.join(root, 'resources', 'views', 'users', 'show.edge'), '<h1>{{ title }}</h1><p>{{ appName }}</p>')
  await fs.writeFile(path.join(root, 'resources', 'emails', 'welcome.edge'), '<p>Welcome {{ user.name }}</p>')

  const app = new Application(root)
  setApplication(app)
  app.instance(ViewFactory, new ViewFactory(path.join(root, 'resources')))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('Templating', () => {
  it('renders dot-notated page templates', async () => {
    const factory = new ViewFactory(path.join(root, 'resources'))

    await expect(factory.render('users.show', { title: 'Ada' })).resolves.toContain('<h1>Ada</h1>')
  })

  it('shares globals with Edge views', async () => {
    const factory = new ViewFactory(path.join(root, 'resources'))
    factory.share('appName', 'Maxima')

    await expect(factory.render('users.show', { title: 'Ada' })).resolves.toContain('<p>Maxima</p>')
  })

  it('renders email templates from the emails namespace', async () => {
    const factory = new ViewFactory(path.join(root, 'resources'))

    await expect(factory.renderEmail('welcome', { user: { name: 'Grace' } })).resolves.toContain('Welcome Grace')
  })

  it('supports global view and renderEmail helpers', async () => {
    await expect(view('users.show', { title: 'Helper' })).resolves.toContain('Helper')
    await expect(renderEmail('welcome', { user: { name: 'Linus' } })).resolves.toContain('Welcome Linus')
  })

  it('supports Laravel-style form and auth directives', async () => {
    await fs.writeFile(path.join(root, 'resources', 'views', 'directives.edge'), `
      @auth signed-in @endauth
      @guest guest @endguest
      <form>@csrf @method('PUT') <input @checked(active)></form>
    `)
    const factory = new ViewFactory(path.join(root, 'resources'))

    await expect(factory.render('directives', { active: true })).resolves.toContain('guest')
    await expect(factory.render('directives', { active: true })).resolves.toContain('_method')
    await expect(factory.render('directives', { active: true })).resolves.toContain('checked')
  })

  it('supports Blade-style layout, include, once, and loop aliases', async () => {
    await fs.mkdir(path.join(root, 'resources', 'views', 'layouts'), { recursive: true })
    await fs.mkdir(path.join(root, 'resources', 'views', 'partials'), { recursive: true })
    await fs.writeFile(path.join(root, 'resources', 'views', 'layouts', 'app.edge'), '<main>@yield(\'content\')</main>')
    await fs.writeFile(path.join(root, 'resources', 'views', 'partials', 'badge.edge'), '<span>{{ label }}</span>')
    await fs.writeFile(path.join(root, 'resources', 'views', 'blade.edge'), `
      @extends('layouts/app')
      @section('content')
        @includeWhen(showBadge, 'partials/badge')
        @includeUnless(showMissing, 'partials/badge')
        @once
          once
        @endonce
        @eachelse(users as user)
          {{ user }}
        @empty
          empty
        @endeachelse
        @for(let i = 0; i < 2; i++)
          {{ i }}
        @endfor
      @endsection
    `)

    const html = await new ViewFactory(path.join(root, 'resources')).render('blade', {
      showBadge: true,
      showMissing: false,
      label: 'New',
      users: ['Ada']
    })

    expect(html).toContain('<main>')
    expect(html.match(/<span>New<\/span>/g)).toHaveLength(2)
    expect(html).toContain('once')
    expect(html).toContain('Ada')
    expect(html).toContain('0')
    expect(html).toContain('1')
  })

  it('supports arbitrary for, while, break, and continue directives', async () => {
    await fs.writeFile(path.join(root, 'resources', 'views', 'loops.edge'), `
      @for(let i = 0; i < values.length; i++)
        @if(values[i] === 'skip')
          @continue
        @endif
        @if(values[i] === 'stop')
          @break
        @endif
        for:{{ values[i] }}
      @endfor

      @while(counter.value < 5)
        @eval(counter.value++)
        @if(counter.value === 2)
          @continue
        @endif
        @if(counter.value === 4)
          @break
        @endif
        while:{{ counter.value }}
      @endwhile

      @for(const value of values)
        @if(value === 'stop')
          @break
        @endif
        of:{{ value }}
      @endfor
    `)

    const html = await new ViewFactory(path.join(root, 'resources')).render('loops', {
      values: ['keep', 'skip', 'stop', 'never'],
      counter: { value: 0 }
    })

    expect(html).toContain('for:keep')
    expect(html).not.toContain('for:skip')
    expect(html).not.toContain('for:stop')
    expect(html).not.toContain('for:never')
    expect(html).toContain('while:1')
    expect(html).not.toContain('while:2')
    expect(html).toContain('while:3')
    expect(html).not.toContain('while:4')
    expect(html).not.toContain('while:5')
    expect(html).toContain('of:keep')
    expect(html).toContain('of:skip')
    expect(html).not.toContain('of:stop')
  })

  it('supports localized lang and choice directives with fallback locale', async () => {
    await fs.mkdir(path.join(root, 'resources', 'lang', 'en'), { recursive: true })
    await fs.mkdir(path.join(root, 'resources', 'lang', 'fr'), { recursive: true })
    await fs.writeFile(path.join(root, 'resources', 'lang', 'en', 'messages.json'), JSON.stringify({
      fallback: 'Fallback :name',
      apples: '{0} No apples|{1} One apple|[2,*] :count apples'
    }))
    await fs.writeFile(path.join(root, 'resources', 'lang', 'fr', 'messages.json'), JSON.stringify({
      welcome: 'Bonjour :name'
    }))
    await fs.writeFile(path.join(root, 'resources', 'views', 'localized.edge'), `
      @lang('messages.welcome', { name: 'Ada', locale: 'fr', fallbackLocale: 'en' })
      @lang('messages.fallback', { name: 'Ada', locale: 'fr', fallbackLocale: 'en' })
      @choice('messages.apples', count, { locale: 'fr', fallbackLocale: 'en' })
    `)

    const html = await new ViewFactory(path.join(root, 'resources')).render('localized', { count: 3 })

    expect(html).toContain('Bonjour Ada')
    expect(html).toContain('Fallback Ada')
    expect(html).toContain('3 apples')
  })
})
