export type MacroCallback = (...args: any[]) => any

export class MacroRegistry {
  private macros = new Map<string, MacroCallback>()

  macro(name: string, callback: MacroCallback) {
    this.macros.set(name, callback)
  }

  hasMacro(name: string) {
    return this.macros.has(name)
  }

  flushMacros() {
    this.macros.clear()
  }

  call(target: any, name: string, args: any[]) {
    const macro = this.macros.get(name)
    if (!macro) throw new Error(`Macro [${name}] is not registered.`)
    return macro.apply(target, args)
  }
}

export function proxyMacros<T extends object>(target: T, registry: MacroRegistry): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'string' && registry.hasMacro(property)) {
        return (...args: any[]) => registry.call(receiver, property, args)
      }
      return Reflect.get(object, property, receiver)
    }
  })
}
