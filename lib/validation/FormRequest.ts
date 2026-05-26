import { Request } from '@lib/http/Request.js'
import type { ValidationRules } from '@lib/validation/Validator.js'
import { Validator } from '@lib/validation/Validator.js'
import { AuthorizationException } from '@lib/auth/Gate.js'
import { ValidationException } from '@lib/validation/ValidationException.js'

type DependencyResolver = (key: any) => unknown | Promise<unknown>

export abstract class FormRequest extends Request {
  redirect?: string
  redirectRoute?: string
  errorBag = 'default'

  authorize(): Promise<boolean> | boolean { return true }
  abstract rules(): ValidationRules
  messages(): Record<string, string> { return {} }
  attributes(): Record<string, string> { return {} }
  validationData(): Record<string, any> { return this.body }
  prepareForValidation(): void | Promise<void> {}
  after(): void | Promise<void> {}
  failedAuthorization(): never {
    throw new AuthorizationException('This action is unauthorized.')
  }
  failedValidation(error: ValidationException): never {
    throw error
  }

  async validateResolved(resolve?: DependencyResolver) {
    await this.prepareForValidation()
    if (!(await invokeMethod(this, 'authorize', resolve))) this.failedAuthorization()
    try {
      const data = await Validator.validate(this.validationData(), await invokeMethod(this, 'rules', resolve), {
        messages: this.messages(),
        attributes: this.attributes()
      })
      this.setValidated(data)
    } catch (error) {
      if (error instanceof ValidationException) {
        error.withErrorBag(this.errorBag)
        const redirectTo = this.redirect ?? this.redirectRoute
        if (redirectTo) error.redirectToUrl(redirectTo)
        this.setErrors(error.errors, this.errorBag)
        this.failedValidation(error)
      }
      throw error
    }
    await this.after()
  }
}

async function invokeMethod(target: any, method: string, resolve?: DependencyResolver) {
  const callback = target[method]
  const inject = callback?.inject ?? target.constructor?.injectMethods?.[method]
  if (!inject?.length) return callback.call(target)
  const dependencies = await Promise.all(inject.map((key: any) => resolve?.(key) ?? undefined))
  return callback.call(target, ...dependencies)
}
