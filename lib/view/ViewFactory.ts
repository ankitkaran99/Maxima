import { Edge } from 'edge.js'
import { migrate } from 'edge.js/plugins/migrate'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resourcePath, trans, transChoice } from '@lib/foundation/helpers.js'
import { Gate } from '@lib/auth/Gate.js'

export class ViewFactory {
  private edge = Edge.create()

  constructor(private rootPath = resourcePath()) {
    this.edge.use(migrate)
    this.registerLoopDirectives()
    this.edge.mount(`${this.rootPath}/views`)
    this.edge.mount('emails', `${this.rootPath}/emails`)
    this.preprocessLoadedTemplates()
    this.edge.global('authUser', undefined)
    this.edge.global('csrf_field', () => (global as any).csrf_field?.() ?? '')
    this.edge.global('Gate', Gate)
    this.edge.global('trans', trans)
    this.edge.global('transChoice', transChoice)
    this.edge.global('__isEmpty', (value: any) => {
      if (value === undefined || value === null || value === false || value === '') return true
      if (Array.isArray(value)) return value.length === 0
      if (typeof value === 'object') return Object.keys(value).length === 0
      return false
    })
    this.edge.global('__canAny', async (abilities: string[] | string, subject?: any) => {
      const list = Array.isArray(abilities) ? abilities : [abilities]
      for (const ability of list) {
        if (await Gate.allows(ability, subject)) return true
      }
      return false
    })
    this.edge.global('__range', (start: number, end: number) => {
      const output: number[] = []
      for (let i = Number(start); i < Number(end); i++) output.push(i)
      return output
    })
  }

  share(key: string, value: unknown) {
    this.edge.global(key, value)
  }

  render(template: string, data: Record<string, unknown> = {}) {
    return this.renderTemplate(template.replaceAll('.', '/'), data)
  }

  renderEmail(template: string, data: Record<string, unknown> = {}) {
    return this.edge.render(`emails::${template.replaceAll('.', '/')}`, { __onceKeys: new Set<string>(), ...data })
  }

  private async renderTemplate(template: string, data: Record<string, unknown>) {
    const file = path.join(this.rootPath, 'views', `${template}.edge`)
    const contents = await this.applyLayout(await fs.readFile(file, 'utf8'))
    return this.edge.renderRaw(this.compileDirectives(contents), { __onceKeys: new Set<string>(), ...data }, template)
  }

  private async applyLayout(contents: string) {
    const layoutMatch = contents.match(/@extends\(\s*['"]([^'"]+)['"]\s*\)/)
    if (!layoutMatch) return contents

    const sections = new Map<string, string>()
    const sectionPattern = /@section\(\s*['"]([^'"]+)['"]\s*\)([\s\S]*?)@(endsection|show)\b/g
    for (const match of contents.matchAll(sectionPattern)) {
      sections.set(match[1], match[2])
    }

    const layoutFile = path.join(this.rootPath, 'views', `${layoutMatch[1]}.edge`)
    let layout = await fs.readFile(layoutFile, 'utf8')
    layout = layout.replace(/@yield\(\s*['"]([^'"]+)['"]\s*\)/g, (_match, name) => sections.get(name) ?? '')
    layout = layout.replace(sectionPattern, (_match, name, fallback) => {
      const section = sections.get(name)
      return section ? section.replace(/@parent\b/g, fallback) : fallback
    })
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
    return contents
      .replace(/@once\b([\s\S]*?)@endonce\b/g, (_match, body) => {
        const key = `once:${onceIndex++}`
        return `@if(!__onceKeys.has('${key}'))\n@eval(__onceKeys.add('${key}'))\n${body}\n@endif`
      })
      .replace(/@ignore\b([\s\S]*?)@endignore\b/g, (_match, body) => body.replaceAll('@', '&#64;'))
      .replace(/@yield\(([^)]*)\)/g, '@section($1)\n@endsection')
      .replace(/@parent\b/g, '@super')
      .replace(/@show\b|@overwrite\b|@append\b/g, '@endsection')
      .replace(/@includeWhen\(([^,]+),\s*([^)]+)\)/g, '@includeIf($1, $2)')
      .replace(/@includeUnless\(([^,]+),\s*([^)]+)\)/g, '@unless($1)\n@include($2)\n@endunless')
      .replace(/@eachelse\(\s*\$?([A-Za-z_$][\w$.\[\]]*)\s+as\s+\$?([A-Za-z_$][\w$]*)\s*\)/g, '@each($2 in $1)')
      .replace(/@endeachelse\b/g, '@endeach')
      .replace(/@auth\b([\s\S]*?)@endauth\b/g, '@if(authUser)\n$1\n@endif')
      .replace(/@guest\b([\s\S]*?)@endguest\b/g, '@if(!authUser)\n$1\n@endif')
      .replace(/@can\(([^)]*)\)([\s\S]*?)@endcan\b/g, '@if(await Gate.allows($1))\n$2\n@endif')
      .replace(/@cannot\(([^)]*)\)([\s\S]*?)@endcannot\b/g, '@if(await Gate.denies($1))\n$2\n@endif')
      .replace(/@canany\(([^)]*)\)([\s\S]*?)@endcanany\b/g, '@if(await __canAny($1))\n$2\n@endif')
      .replace(/@isset\(([^)]*)\)([\s\S]*?)@endisset\b/g, '@if(($1) !== undefined && ($1) !== null)\n$2\n@endif')
      .replace(/@empty\(([^)]*)\)([\s\S]*?)@endempty\b/g, '@if(__isEmpty($1))\n$2\n@endif')
      .replace(/@env\(([^)]*)\)([\s\S]*?)@endenv\b/g, '@if(env("APP_ENV", "local") === ($1))\n$2\n@endif')
      .replace(/@session\(([^)]*)\)([\s\S]*?)@endsession\b/g, '@if(session && session[$1] !== undefined)\n$2\n@endif')
      .replace(/@error\(([^)]*)\)([\s\S]*?)@enderror\b/g, '@if(errors && errors[$1])\n@set("message", Array.isArray(errors[$1]) ? errors[$1][0] : errors[$1])\n$2\n@endif')
      .replace(/@auth\b/g, '@if(authUser)')
      .replace(/@endauth\b/g, '@endif')
      .replace(/@guest\b/g, '@if(!authUser)')
      .replace(/@endguest\b/g, '@endif')
      .replace(/@can\(([^)]*)\)/g, '@if(await Gate.allows($1))')
      .replace(/@cannot\(([^)]*)\)/g, '@if(await Gate.denies($1))')
      .replace(/@canany\(([^)]*)\)/g, '@if(await __canAny($1))')
      .replace(/@elsecan\(([^)]*)\)/g, '@elseif(await Gate.allows($1))')
      .replace(/@elsecannot\(([^)]*)\)/g, '@elseif(await Gate.denies($1))')
      .replace(/@endcan\b|@endcannot\b|@endcanany\b/g, '@endif')
      .replace(/@isset\(([^)]*)\)/g, '@if(($1) !== undefined && ($1) !== null)')
      .replace(/@endisset\b/g, '@endif')
      .replace(/@empty\(([^)]*)\)/g, '@if(__isEmpty($1))')
      .replace(/@endempty\b/g, '@endif')
      .replace(/@empty\b/g, '@else')
      .replace(/@env\(([^)]*)\)/g, '@if(env("APP_ENV", "local") === ($1))')
      .replace(/@endenv\b/g, '@endif')
      .replace(/@lang\(([^)]*)\)/g, '{{ await trans($1) }}')
      .replace(/@choice\(([^)]*)\)/g, '{{ await transChoice($1) }}')
      .replace(/@csrf\b/g, '{{{ csrf_field() }}}')
      .replace(/@method\(([^)]*)\)/g, '<input type="hidden" name="_method" value="{{ $1 }}">')
      .replace(/@checked\(([^)]*)\)/g, '{{ $1 ? "checked" : "" }}')
      .replace(/@selected\(([^)]*)\)/g, '{{ $1 ? "selected" : "" }}')
      .replace(/@disabled\(([^)]*)\)/g, '{{ $1 ? "disabled" : "" }}')
      .replace(/@readonly\(([^)]*)\)/g, '{{ $1 ? "readonly" : "" }}')
      .replace(/@required\(([^)]*)\)/g, '{{ $1 ? "required" : "" }}')
      .replace(/^\s+(@layout\()/, '$1')
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
}
