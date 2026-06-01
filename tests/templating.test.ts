import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { app as maximaApp, renderEmail, renderFragment, renderInline, setApplication, view, viewExists, viewFirst } from '@lib/foundation/helpers.js'
import { ViewFactory } from '@lib/view/ViewFactory.js'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-views-'))
  await fs.mkdir(path.join(root, 'resources', 'views', 'users'), { recursive: true })
  await fs.mkdir(path.join(root, 'resources', 'emails'), { recursive: true })
  await fs.writeFile(path.join(root, 'resources', 'views', 'users', 'show.edge'), '<h1>{{ title }}</h1><p>{{ appName }}</p>')
  await fs.writeFile(path.join(root, 'resources', 'emails', 'welcome.mjml'), '<mjml><mj-body><mj-section><mj-column><mj-text><p>Welcome {{ user.name }}</p></mj-text></mj-column></mj-section></mj-body></mjml>')

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

  it('supports layouts with Edge-native include and loop tags', async () => {
    await fs.mkdir(path.join(root, 'resources', 'views', 'layouts'), { recursive: true })
    await fs.mkdir(path.join(root, 'resources', 'views', 'partials'), { recursive: true })
    await fs.writeFile(path.join(root, 'resources', 'views', 'layouts', 'app.edge'), '<main>@yield(\'content\')</main>')
    await fs.writeFile(path.join(root, 'resources', 'views', 'partials', 'badge.edge'), '<span>{{ label }}</span>')
    await fs.writeFile(path.join(root, 'resources', 'views', 'blade.edge'), `
      @extends('layouts/app')
      @section('content')
        @includeIf(showBadge, 'partials/badge')
        @unless(showMissing)
          @include('partials/badge')
        @endunless
        @once
          once
        @endonce
        @each(user in users)
          {{ user }}
        @endeach
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
    await fs.mkdir(path.join(root, 'src', 'resources', 'lang', 'en'), { recursive: true })
    await fs.mkdir(path.join(root, 'src', 'resources', 'lang', 'fr'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'resources', 'lang', 'en', 'messages.json'), JSON.stringify({
      fallback: 'Fallback :name',
      apples: '{0} No apples|{1} One apple|[2,*] :count apples'
    }))
    await fs.writeFile(path.join(root, 'src', 'resources', 'lang', 'fr', 'messages.json'), JSON.stringify({
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

  it('supports the documented @empty directive without rewriting it to @else', async () => {
    await fs.writeFile(path.join(root, 'resources', 'views', 'empty.edge'), `
      @empty(items)
        No items
      @endempty
    `)

    const factory = new ViewFactory(path.join(root, 'resources'))

    await expect(factory.render('empty', { items: [] })).resolves.toContain('No items')
    await expect(factory.render('empty', { items: ['Ada'] })).resolves.not.toContain('No items')
  })

  it('supports non-Edge Blade directives without component or alias shims', async () => {
    await fs.writeFile(path.join(root, 'resources', 'views', 'blade-directives.edge'), `
      {{-- hidden --}}
      @switch(status)
        @case('draft') Draft @break
        @default Published
      @endswitch
      @env(['local', 'testing']) EnvMatched @endenv
      @verbatim {{ untouched }} @endverbatim
      @@json
      <span class="@class({ active: active, hidden: false })" style="@style({ color: 'red', display: false })"></span>
      @json(payload)
      @fragment('preview') Preview {{ name }} @endfragment
    `)

    const factory = new ViewFactory(path.join(root, 'resources'))
    const html = await factory.render('blade-directives', {
      status: 'draft',
      active: true,
      payload: { tag: '<script>' },
      name: 'Ada'
    })

    expect(html).not.toContain('hidden')
    expect(html).toContain('Draft')
    expect(html).toContain('EnvMatched')
    expect(html).toContain('{{ untouched }}')
    expect(html).toContain('@json')
    expect(html).toContain('class="active"')
    expect(html).toContain('style="color: red"')
    expect(html).toContain('\\u003Cscript\\u003E')
    expect(html).toContain('Preview Ada')
    await expect(factory.renderFragment('blade-directives', 'preview', { name: 'Grace' })).resolves.toContain('Preview Grace')
  })

  it('supports composers, creators, view lookup helpers, and inline rendering', async () => {
    await fs.writeFile(path.join(root, 'resources', 'views', 'composed.edge'), '{{ created }} {{ composed }} {{ shared }}')
    await fs.writeFile(path.join(root, 'resources', 'views', 'fragmented.edge'), '@fragment(\'preview\')Preview {{ name }}@endfragment')
    const factory = new ViewFactory(path.join(root, 'resources'))
    factory.share('shared', 'shared-data')
    factory.creator('composed', data => { data.created = 'created-data' })
    factory.composer('composed', data => { data.composed = 'composed-data' })

    const html = await factory.render('composed')
    expect(html).toContain('created-data composed-data shared-data')
    await expect(factory.first(['missing', 'composed'])).resolves.toContain('created-data')
    await expect(factory.renderInline('Hello {{ name }}', { name: 'Inline' })).resolves.toContain('Hello Inline')

    ;(maximaApp() as Application).instance(ViewFactory, factory)
    await expect(viewExists('composed')).resolves.toBe(true)
    await expect(viewFirst(['missing', 'composed'])).resolves.toContain('composed-data')
    await expect(renderInline('Helper {{ name }}', { name: 'Inline' })).resolves.toContain('Helper Inline')
    await expect(renderFragment('fragmented', 'preview', { name: 'Helper' })).resolves.toContain('Preview Helper')
  })

  it('supports nesting of switch, error, and session directives correctly', async () => {
    await fs.writeFile(path.join(root, 'resources', 'views', 'nested-directives.edge'), `
      @switch(outer)
        @case('a')
          @switch(inner)
            @case('b') AB @break
            @default AD @break
          @endswitch
          @break
        @default Other @break
      @endswitch

      @session('outer-session')
        OuterSession
        @session('inner-session')
          InnerSession
        @endsession
      @endsession

      @error('outer-error')
        OuterError
        @error('inner-error')
          InnerError
        @enderror
      @enderror
    `)

    const factory = new ViewFactory(path.join(root, 'resources'))
    const html = await factory.render('nested-directives', {
      outer: 'a',
      inner: 'b',
      session: { 'outer-session': true, 'inner-session': true },
      errors: { 'outer-error': 'Outer', 'inner-error': 'Inner' }
    })

    expect(html.trim()).toContain('AB')
    expect(html.trim()).not.toContain('Other')
    expect(html.trim()).toContain('OuterSession')
    expect(html.trim()).toContain('InnerSession')
    expect(html.trim()).toContain('OuterError')
    expect(html.trim()).toContain('InnerError')
  })


  it('invalidates compiled view cache when the source mtime changes', async () => {
    const cacheDir = path.join(root, 'storage', 'framework', 'views')
    await fs.writeFile(path.join(root, 'resources', 'views', 'cached.edge'), 'First')
    const factory = new ViewFactory(path.join(root, 'resources'), cacheDir)

    await expect(factory.render('cached')).resolves.toContain('First')
    expect((await fs.readdir(cacheDir)).length).toBeGreaterThan(0)
    await new Promise(resolve => setTimeout(resolve, 10))
    await fs.writeFile(path.join(root, 'resources', 'views', 'cached.edge'), 'Second')

    await expect(factory.render('cached')).resolves.toContain('Second')
  })

  it('invalidates compiled view cache when a layout changes', async () => {
    const cacheDir = path.join(root, 'storage', 'framework', 'views')
    await fs.mkdir(path.join(root, 'resources', 'views', 'layouts'), { recursive: true })
    await fs.writeFile(path.join(root, 'resources', 'views', 'layouts', 'app.edge'), '<main>@yield(\'content\')</main>')
    await fs.writeFile(path.join(root, 'resources', 'views', 'page.edge'), `
      @extends('layouts/app')
      @section('content')
        <p>One</p>
      @endsection
    `)
    const factory = new ViewFactory(path.join(root, 'resources'), cacheDir)

    await expect(factory.render('page')).resolves.toContain('<main>')
    const layoutPath = path.join(root, 'resources', 'views', 'layouts', 'app.edge')
    await fs.writeFile(layoutPath, '<section>@yield(\'content\')</section>')

    // Explicitly update mtime so filesystem timestamp resolution doesn't flake on Windows
    const stat = await fs.stat(layoutPath)
    await fs.utimes(layoutPath, new Date(), new Date(stat.mtime.getTime() + 5000))

    await expect(factory.render('page')).resolves.toContain('<section>')
  })

  it('recompiles when a compiled view cache file is corrupt', async () => {
    const cacheDir = path.join(root, 'storage', 'framework', 'views')
    await fs.writeFile(path.join(root, 'resources', 'views', 'corrupt.edge'), 'Fresh {{ name }}')
    const factory = new ViewFactory(path.join(root, 'resources'), cacheDir)

    await expect(factory.render('corrupt', { name: 'Ada' })).resolves.toContain('Fresh Ada')
    const [cacheFile] = await fs.readdir(cacheDir)
    await fs.writeFile(path.join(cacheDir, cacheFile), 'not-json')

    await expect(factory.render('corrupt', { name: 'Grace' })).resolves.toContain('Fresh Grace')
  })
})
