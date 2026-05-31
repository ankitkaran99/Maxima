import { Edge } from 'edge.js'
import { migrate } from 'edge.js/plugins/migrate'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { app, env, resourcePath, storagePath, trans, transChoice } from '@lib/foundation/helpers.js'
import { Gate } from '@lib/auth/Gate.js'

type ViewCallback = (data: Record<string, unknown>, view: { name: string, path: string }) => void | Promise<void>
type CompiledCache = {
  source: string
  template: string
  mtimeMs: number
  compiled: string
  dependencyFiles?: string[]
  dependencyMtimes?: Record<string, number>
}

class LruCache<K, V> {
  private cache = new Map<K, V>()
  constructor(private limit = 100) {}

  get(key: K): V | undefined {
    if (!this.cache.has(key)) return undefined
    const value = this.cache.get(key)!
    this.cache.delete(key)
    this.cache.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.limit) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey)
      }
    }
    this.cache.set(key, value)
  }
}

export class ViewFactory {
  private edge = Edge.create()
  private shared: Record<string, unknown> = {}
  private composers: { pattern: string | RegExp, callback: ViewCallback }[] = []
  private creators: { pattern: string | RegExp, callback: ViewCallback }[] = []
  private compiledPath: string
  private compilationPromises = new Map<string, Promise<string>>()
  private compiledCache = new LruCache<string, string>(Number(env('VIEW_CACHE_LIMIT', 100)))
  private hashCache = new LruCache<string, string>(Number(env('VIEW_HASH_CACHE_LIMIT', 100)))
  private existenceCache = new Map<string, boolean>()

  constructor(private rootPath = resourcePath(), compiledPath = storagePath('framework/views')) {
    this.compiledPath = compiledPath
    this.edge.use(migrate)
    this.registerLoopDirectives()
    this.edge.mount(`${this.rootPath}/views`)
    this.preprocessLoadedTemplates()
    this.edge.global('authUser', undefined)
    this.edge.global('csrf_field', () => (global as any).csrf_field?.() ?? '')
    this.edge.global('Gate', Gate)
    this.edge.global('env', env)
    this.edge.global('trans', trans)
    this.edge.global('transChoice', transChoice)
    this.edge.global('__isEmpty', (value: any) => {
      if (value === undefined || value === null || value === false || value === '') return true
      if (Array.isArray(value)) return value.length === 0
      if (typeof value === 'object') return Object.keys(value).length === 0
      return false
    })
    this.edge.global('__isEnvironment', (expected: string | string[]) => {
      const current = String(env('APP_ENV', 'local'))
      return Array.isArray(expected) ? expected.includes(current) : current === expected
    })
    this.edge.global('__canAny', async (abilities: string[] | string, subject?: any) => {
      const list = Array.isArray(abilities) ? abilities : [abilities]
      for (const ability of list) {
        if (await Gate.allows(ability, subject)) return true
      }
      return false
    })
    this.edge.global('__entries', (value: any) => {
      const items = Array.isArray(value) ? value : Object.values(value ?? {})
      const count = items.length
      return items.map((entry, index) => ({
        value: entry,
        loop: {
          index,
          iteration: index + 1,
          remaining: count - index - 1,
          count,
          first: index === 0,
          last: index === count - 1,
          even: (index + 1) % 2 === 0,
          odd: (index + 1) % 2 === 1,
          depth: 1
        }
      }))
    })
    this.edge.global('__range', (start: number, end: number) => {
      const output: number[] = []
      for (let i = Number(start); i < Number(end); i++) output.push(i)
      return output
    })
    this.edge.global('__json', (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003C').replace(/>/g, '\\u003E').replace(/&/g, '\\u0026').replace(/'/g, '\\u0027'))
    this.edge.global('__classList', (value: Record<string, boolean> | Array<string | Record<string, boolean>> | string) => {
      if (typeof value === 'string') return value
      const entries = Array.isArray(value) ? value.flatMap(item => typeof item === 'string' ? [[item, true]] : Object.entries(item)) : Object.entries(value)
      return entries.filter(([, enabled]) => !!enabled).map(([name]) => name).join(' ')
    })
    this.edge.global('__styleList', (value: Record<string, string | number | boolean>) => {
      return Object.entries(value)
        .filter(([, enabled]) => enabled !== false && enabled !== undefined && enabled !== null)
        .map(([name, style]) => style === true ? name : `${name}: ${style}`)
        .join('; ')
    })
  }

  share(key: string, value: unknown) {
    this.shared[key] = value
    this.edge.global(key, value)
    return this
  }

  composer(pattern: string | string[] | RegExp, callback: ViewCallback) {
    for (const item of Array.isArray(pattern) ? pattern : [pattern]) this.composers.push({ pattern: item, callback })
    return this
  }

  creator(pattern: string | string[] | RegExp, callback: ViewCallback) {
    for (const item of Array.isArray(pattern) ? pattern : [pattern]) this.creators.push({ pattern: item, callback })
    return this
  }

  render(template: string, data: Record<string, unknown> = {}) {
    return this.renderTemplate(template, data)
  }

  async renderEmail(template: string, data: Record<string, unknown> = {}) {
    const relativePath = template.replaceAll('.', '/')
    const filePath = path.join(this.rootPath, 'emails', `${relativePath}.mjml`)

    const content = await fs.readFile(filePath, 'utf8')
    const renderedMjml = await this.edge.renderRaw(content, this.baseData(data))

    let mjmlToUse = renderedMjml
    if (!renderedMjml.includes('<mjml>')) {
      mjmlToUse = `<mjml><mj-body><mj-section><mj-column><mj-text>${renderedMjml}</mj-text></mj-column></mj-section></mj-body></mjml>`
    }

    const mjml2html = (await import('mjml')).default
    const result = await mjml2html(mjmlToUse)
    return result.html
  }

  async renderInline(template: string, data: Record<string, unknown> = {}) {
    const compiled = this.compileDirectives(template)
    return this.edge.renderRaw(compiled, this.baseData(data), `inline:${this.cacheKey(compiled)}`)
  }

  async renderFragment(template: string, fragment: string, data: Record<string, unknown> = {}) {
    const file = this.resolveViewPath(template)
    const contents = await this.applyLayout(await fs.readFile(file, 'utf8'), file)
    const pattern = new RegExp(`@fragment\\(\\s*['"]${this.escapeRegExp(fragment)}['"]\\s*\\)([\\s\\S]*?)@endfragment\\b`)
    const match = contents.match(pattern)
    if (!match) return ''
    const compiled = this.compileDirectives(match[1])
    return this.edge.renderRaw(compiled, this.baseData(data), `fragment:${template}:${fragment}:${this.cacheKey(compiled)}`)
  }

  async exists(template: string): Promise<boolean> {
    const filePath = this.resolveViewPath(template)
    if (this.existenceCache.has(filePath)) {
      return this.existenceCache.get(filePath)!
    }
    let existsResult = false
    try {
      await fs.access(filePath)
      existsResult = true
    } catch {
      existsResult = false
    }
    const isProduction = env('APP_ENV') === 'production' || env('CACHE_VIEWS') === 'true' || env('CACHE_VIEWS') === true
    if (isProduction) {
      this.existenceCache.set(filePath, existsResult)
    }
    return existsResult
  }

  async first(templates: string[], data: Record<string, unknown> = {}) {
    let match: string | undefined
    for (const template of templates) {
      if (await this.exists(template)) {
        match = template
        break
      }
    }
    if (!match) throw new Error(`None of the requested views exist: ${templates.join(', ')}`)
    return this.render(match, data)
  }

  async cacheViews() {
    await fs.mkdir(this.compiledPath, { recursive: true })
    const root = path.join(this.rootPath, 'views')
    try {
      await fs.access(root)
    } catch {
      return []
    }
    const files = await this.viewFiles(root)
    const compiled: string[] = []
    for (const file of files) {
      await this.compiledTemplate(file, file)
      compiled.push(file)
    }
    return compiled
  }

  private async renderTemplate(template: string, data: Record<string, unknown>) {
    const file = this.resolveViewPath(template)
    const viewData = this.baseData(data)
    await this.runCallbacks(this.creators, template, file, viewData)
    await this.runCallbacks(this.composers, template, file, viewData)
    const compiled = await this.compiledTemplate(file, template)
    return this.edge.renderRaw(compiled, viewData, `${template}:${this.cacheKey(compiled)}`)
  }

  private async applyLayout(contents: string, sourcePath: string) {
    const layoutMatch = contents.match(/@extends\(\s*['"]([^'"]+)['"]\s*\)/)
    if (!layoutMatch) return contents

    const sections = new Map<string, string>()
    const sectionPattern = /@section\(\s*['"]([^'"]+)['"]\s*\)([\s\S]*?)@(endsection|show)\b/g
    for (const match of contents.matchAll(sectionPattern)) {
      sections.set(match[1], match[2])
    }

    const layoutFile = path.join(this.rootPath, 'views', `${layoutMatch[1].replaceAll('.', '/')}.edge`)
    let layout = await fs.readFile(layoutFile, 'utf8')
    layout = layout.replace(/@yield\(\s*['"]([^'"]+)['"]\s*\)/g, (_match, name) => sections.get(name) ?? '')
    layout = layout.replace(sectionPattern, (_match, name, fallback) => {
      const section = sections.get(name)
      return section ? section.replace(/@parent\b/g, fallback) : fallback
    })
    layout = layout.replace(/@hasSection\(\s*['"]([^'"]+)['"]\s*\)([\s\S]*?)@endif\b/g, (_match, name, body) => sections.has(name) ? body : '')
    layout = layout.replace(/@sectionMissing\(\s*['"]([^'"]+)['"]\s*\)([\s\S]*?)@endif\b/g, (_match, name, body) => sections.has(name) ? '' : body)
    if (sourcePath) layout = layout.replace(layoutMatch[0], '')
    return layout
  }

  private preprocessLoadedTemplates() {
    const resolve = this.edge.loader.resolve.bind(this.edge.loader)
    this.edge.loader.resolve = (templatePath: string) => {
      const resolved = resolve(templatePath)
      return { ...resolved, template: this.compileDirectives(resolved.template) }
    }
  }

  private compileDirectives(contents: string) {
    let onceIndex = 0
    const verbatim: string[] = []
    const escaped: string[] = []
    contents = contents
      .replace(/@@([A-Za-z_][\w]*)/g, (_match, directive) => {
        const key = `__ESCAPED_BLADE_${escaped.length}__`
        escaped.push(`@${directive}`)
        return key
      })
      .replace(/@verbatim\b([\s\S]*?)@endverbatim\b/g, (_match, body) => {
        const key = `__VERBATIM_BLADE_${verbatim.length}__`
        verbatim.push(body)
        return key
      })
      .replace(/\{\{--[\s\S]*?--\}\}/g, '')

    contents = this.compileSwitches(contents)

    // Compile nested block directives from inside out
    const blockDirectives = [
      {
        regex: /@auth(?:\([^)]*\))?\b((?:(?!@auth(?:\([^)]*\))?\b)[\s\S])*?)@endauth\b/g,
        replacement: '@if(authUser)\n$1\n@endif'
      },
      {
        regex: /@guest(?:\([^)]*\))?\b((?:(?!@guest(?:\([^)]*\))?\b)[\s\S])*?)@endguest\b/g,
        replacement: '@if(!authUser)\n$1\n@endif'
      },
      {
        regex: /@can\(([^)]*)\)((?:(?!@can\b)[\s\S])*?)@endcan\b/g,
        replacement: '@if(await Gate.allows($1))\n$2\n@endif'
      },
      {
        regex: /@cannot\(([^)]*)\)((?:(?!@cannot\b)[\s\S])*?)@endcannot\b/g,
        replacement: '@if(await Gate.denies($1))\n$2\n@endif'
      },
      {
        regex: /@canany\(([^)]*)\)((?:(?!@canany\b)[\s\S])*?)@endcanany\b/g,
        replacement: '@if(await __canAny($1))\n$2\n@endif'
      },
      {
        regex: /@isset\(([^)]*)\)((?:(?!@isset\b)[\s\S])*?)@endisset\b/g,
        replacement: '@if(($1) !== undefined && ($1) !== null)\n$2\n@endif'
      },
      {
        regex: /@empty\(([^)]*)\)((?:(?!@empty\b)[\s\S])*?)@endempty\b/g,
        replacement: '@if(__isEmpty($1))\n$2\n@endif'
      },
      {
        regex: /@production\b((?:(?!@production\b)[\s\S])*?)@endproduction\b/g,
        replacement: '@if(__isEnvironment("production"))\n$1\n@endif'
      },
      {
        regex: /@env\(([^)]*)\)((?:(?!@env\b)[\s\S])*?)@endenv\b/g,
        replacement: '@if(__isEnvironment($1))\n$2\n@endif'
      },
      {
        regex: /@session\(([^)]*)\)((?:(?!@session\b)[\s\S])*?)@endsession\b/g,
        replacement: '@if(session && session[$1] !== undefined)\n$2\n@endif'
      },
      {
        regex: /@error\(([^)]*)\)((?:(?!@error\b)[\s\S])*?)@enderror\b/g,
        replacement: '@if(errors && errors[$1])\n@set("message", Array.isArray(errors[$1]) ? errors[$1][0] : errors[$1])\n$2\n@endif'
      }
    ]

    for (const directive of blockDirectives) {
      while (directive.regex.test(contents)) {
        directive.regex.lastIndex = 0
        contents = contents.replace(directive.regex, directive.replacement)
      }
    }

    const fragmentRegex = /@fragment\(([^)]*)\)((?:(?!@fragment\b)[\s\S])*?)@endfragment\b/g
    while (fragmentRegex.test(contents)) {
      fragmentRegex.lastIndex = 0
      contents = contents.replace(fragmentRegex, '$2')
    }

    contents = contents
      .replace(/@once\b([\s\S]*?)@endonce\b/g, (_match, body) => {
        const key = `once:${onceIndex++}`
        return `@if(!__onceKeys.has('${key}'))\n@eval(__onceKeys.add('${key}'))\n${body}\n@endif`
      })
      .replace(/@ignore\b([\s\S]*?)@endignore\b/g, (_match, body) => body.replaceAll('@', '&#64;'))
      .replace(/@parent\b/g, '@super')
      .replace(/@show\b|@overwrite\b|@append\b/g, '@endsection')
      .replace(/@elsecan\(([^)]*)\)/g, '@elseif(await Gate.allows($1))')
      .replace(/@elsecannot\(([^)]*)\)/g, '@elseif(await Gate.denies($1))')
      .replace(/@lang\(([^)]*)\)/g, '{{ await trans($1) }}')
      .replace(/@choice\(([^)]*)\)/g, '{{ await transChoice($1) }}')
      .replace(/@json\(([^)]*)\)/g, '{{{ __json($1) }}}')
      .replace(/@js\(([^)]*)\)/g, '{{{ __json($1) }}}')
      .replace(/@class\(([^)]*)\)/g, '{{ __classList($1) }}')
      .replace(/@style\(([^)]*)\)/g, '{{ __styleList($1) }}')
      .replace(/@csrf\b/g, '{{{ csrf_field() }}}')
      .replace(/@method\(([^)]*)\)/g, '<input type="hidden" name="_method" value="{{ $1 }}">')
      .replace(/@checked\(([^)]*)\)/g, '{{ $1 ? "checked" : "" }}')
      .replace(/@selected\(([^)]*)\)/g, '{{ $1 ? "selected" : "" }}')
      .replace(/@disabled\(([^)]*)\)/g, '{{ $1 ? "disabled" : "" }}')
      .replace(/@readonly\(([^)]*)\)/g, '{{ $1 ? "readonly" : "" }}')
      .replace(/@required\(([^)]*)\)/g, '{{ $1 ? "required" : "" }}')
      .replace(/^\s+(@layout\()/, '$1')
      .replace(/__ESCAPED_BLADE_(\d+)__/g, (_match, index) => escaped[Number(index)])
      .replace(/__VERBATIM_BLADE_(\d+)__/g, (_match, index) => `{{{ ${JSON.stringify(verbatim[Number(index)])} }}}`)

    return contents
  }

  private registerLoopDirectives() {
    this.edge.registerTag({
      block: true,
      seekable: true,
      tagName: 'for',
      compile: (parser: any, buffer: any, token: any) => {
        parser.stack.defineScope()
        const statement = this.compileForStatement(parser, token)
        buffer.writeStatement(`${statement} {`, token.filename, token.loc.start.line)
        token.children.forEach((child: any) => parser.processToken(child, buffer))
        parser.stack.clearScope()
        buffer.writeStatement('}', token.filename, -1)
      }
    } as any)

    this.edge.registerTag({
      block: true,
      seekable: true,
      tagName: 'while',
      compile: (parser: any, buffer: any, token: any) => {
        const condition = this.transformExpression(parser, token, token.properties.jsArg)
        buffer.writeStatement(`while (${condition}) {`, token.filename, token.loc.start.line)
        token.children.forEach((child: any) => parser.processToken(child, buffer))
        buffer.writeStatement('}', token.filename, -1)
      }
    } as any)

    this.edge.registerTag({
      block: false,
      seekable: false,
      tagName: 'break',
      noNewLine: true,
      compile: (_parser: any, buffer: any, token: any) => {
        buffer.writeStatement('break', token.filename, token.loc.start.line)
      }
    } as any)

    this.edge.registerTag({
      block: false,
      seekable: false,
      tagName: 'continue',
      noNewLine: true,
      compile: (_parser: any, buffer: any, token: any) => {
        buffer.writeStatement('continue', token.filename, token.loc.start.line)
      }
    } as any)
  }

  private compileForStatement(parser: any, token: any) {
    const header = token.properties.jsArg.trim()
    const forOfMatch = header.match(/^(let|const|var)\s+([A-Za-z_$][\w$]*)\s+(of|in)\s+([\s\S]+)$/)
    if (forOfMatch) {
      parser.stack.defineVariable(forOfMatch[2])
      return `for (${forOfMatch[1]} ${forOfMatch[2]} ${forOfMatch[3]} ${this.transformExpression(parser, token, forOfMatch[4])})`
    }

    const parts = this.splitTopLevel(header, ';')
    if (parts.length !== 3) return `for (${header})`

    const init = this.compileForInitializer(parser, token, parts[0].trim())
    const test = parts[1].trim() ? this.transformExpression(parser, token, parts[1]) : ''
    const update = parts[2].trim() ? this.transformExpression(parser, token, parts[2]) : ''
    return `for (${init}; ${test}; ${update})`
  }

  private compileForInitializer(parser: any, token: any, init: string) {
    if (!init) return ''

    const declaration = init.match(/^(let|const|var)\s+([\s\S]+)$/)
    if (!declaration) return this.transformExpression(parser, token, init)

    const kind = declaration[1]
    const declarators = this.splitTopLevel(declaration[2], ',').map((part) => {
      const [name, value] = this.splitTopLevel(part, '=')
      const variable = name.trim()
      if (/^[A-Za-z_$][\w$]*$/.test(variable)) parser.stack.defineVariable(variable)
      if (value === undefined) return variable
      return `${variable} = ${this.transformExpression(parser, token, value)}`
    })

    return `${kind} ${declarators.join(', ')}`
  }

  private transformExpression(parser: any, token: any, expression: string) {
    const parsed = parser.utils.generateAST(expression.trim(), token.loc, token.filename)
    const transformed = parser.utils.transformAst(parsed, token.filename, parser)
    return parser.utils.stringify(transformed)
  }

  private splitTopLevel(input: string, separator: string) {
    const parts: string[] = []
    let current = ''
    let depth = 0
    let quote: string | null = null
    let escaped = false

    for (const char of input) {
      if (quote) {
        current += char
        escaped = char === '\\' && !escaped
        if (char === quote && !escaped) quote = null
        if (char !== '\\') escaped = false
        continue
      }

      if (char === '"' || char === "'" || char === '`') {
        quote = char
        current += char
        continue
      }

      if (char === '(' || char === '[' || char === '{') depth++
      if (char === ')' || char === ']' || char === '}') depth--
      if (char === separator && depth === 0) {
        parts.push(current)
        current = ''
        continue
      }

      current += char
    }

    parts.push(current)
    return parts
  }

  private baseData(data: Record<string, unknown>) {
    return { ...this.shared, __onceKeys: new Set<string>(), app, ...data }
  }

  private resolveViewPath(template: string) {
    const relativePath = template.replaceAll('.', '/')
    return path.join(this.rootPath, 'views', `${relativePath}.edge`)
  }

  private async compiledTemplate(file: string, template: string) {
    const isProduction = env('APP_ENV') === 'production' || env('CACHE_VIEWS') === 'true' || env('CACHE_VIEWS') === true
    if (isProduction) {
      const cached = this.compiledCache.get(file)
      if (cached) return cached
    }

    let promise = this.compilationPromises.get(file)
    if (!promise) {
      promise = this.doCompileTemplate(file, template, isProduction).finally(() => {
        this.compilationPromises.delete(file)
      })
      this.compilationPromises.set(file, promise)
    }
    const compiled = await promise
    if (isProduction) {
      this.compiledCache.set(file, compiled)
    }
    return compiled
  }

  private async doCompileTemplate(file: string, template: string, isProduction: boolean) {
    const cacheFile = path.join(this.compiledPath, `${crypto.createHash('sha1').update(file).digest('hex')}.edge`)
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as CompiledCache
      if (typeof cached.compiled === 'string') {
        if (isProduction) {
          return cached.compiled
        }
        const stat = await fs.stat(file)
        if (cached.mtimeMs >= stat.mtimeMs) {
          if (cached.dependencyFiles?.length) {
            let valid = true
            for (const dependency of cached.dependencyFiles) {
              const dependencyStat = await fs.stat(dependency).catch(() => null)
              if (!dependencyStat || (cached.dependencyMtimes?.[dependency] ?? 0) < dependencyStat.mtimeMs) {
                valid = false
                break
              }
            }
            if (valid) return cached.compiled
          } else {
            return cached.compiled
          }
        }
      }
    } catch {
      // Recompile if missing, invalid, or stale
    }
    const stat = await fs.stat(file)
    const rawContents = await fs.readFile(file, 'utf8')
    const dependencyFiles = this.layoutDependencies(rawContents)
    const contents = await this.applyLayout(rawContents, file)
    const compiled = this.compileDirectives(contents)
    const dependencyMtimes: Record<string, number> = {}
    for (const dependency of dependencyFiles) {
      const dependencyStat = await fs.stat(dependency).catch(() => null)
      if (dependencyStat) dependencyMtimes[dependency] = dependencyStat.mtimeMs
    }
    await fs.mkdir(this.compiledPath, { recursive: true })
    await fs.writeFile(cacheFile, JSON.stringify({ source: file, template, mtimeMs: stat.mtimeMs, compiled, dependencyFiles, dependencyMtimes }))
    return compiled
  }

  private layoutDependencies(contents: string) {
    const layoutMatch = contents.match(/@extends\(\s*['"]([^'"]+)['"]\s*\)/)
    if (!layoutMatch) return []
    const layoutFile = path.join(this.rootPath, 'views', `${layoutMatch[1].replaceAll('.', '/')}.edge`)
    return [layoutFile]
  }

  private cacheKey(value: string) {
    let hash = this.hashCache.get(value)
    if (!hash) {
      hash = crypto.createHash('sha1').update(value).digest('hex')
      this.hashCache.set(value, hash)
    }
    return hash
  }

  private escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  private async viewFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const files = await Promise.all(entries.map(entry => {
      const target = path.join(dir, entry.name)
      return entry.isDirectory() ? this.viewFiles(target) : Promise.resolve(entry.name.endsWith('.edge') ? [target] : [])
    }))
    return files.flat()
  }

  private async runCallbacks(callbacks: { pattern: string | RegExp, callback: ViewCallback }[], name: string, file: string, data: Record<string, unknown>) {
    for (const item of callbacks) {
      if (!this.matchesViewPattern(item.pattern, name)) continue
      await item.callback(data, { name, path: file })
    }
  }

  private matchesViewPattern(pattern: string | RegExp, name: string) {
    if (pattern instanceof RegExp) return pattern.test(name)
    if (pattern === '*' || pattern === name || pattern === name.replaceAll('/', '.')) return true
    const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '.*')}$`)
    return regex.test(name) || regex.test(name.replaceAll('/', '.'))
  }

  private compileSwitches(contents: string) {
    let index = 0
    const regex = /@switch\(((?:[^()]+|\([^()]*\))*)\)((?:(?!@switch\b)[\s\S])*?)@endswitch\b/g
    while (regex.test(contents)) {
      regex.lastIndex = 0
      contents = contents.replace(regex, (_match, expression, body) => {
        const currentIdx = index++
        const cases = [...body.matchAll(/@(case|default)(?:\(([^)]*)\))?([\s\S]*?)(?=@case\(|@default\b|$)/g)]
        let output = ''
        for (const [caseIndex, item] of cases.entries()) {
          const caseBody = item[3].replace(/@break\b/g, '')
          if (item[1] === 'default') output += `${caseIndex === 0 ? '@else' : '@else'}\n${caseBody}`
          else output += `${caseIndex === 0 ? '@if' : '@elseif'}(__switch${currentIdx} === ${item[2]})\n${caseBody}`
        }
        return `@set("__switch${currentIdx}", ${expression})\n${output}\n@endif`
      })
    }
    return contents
  }

}
