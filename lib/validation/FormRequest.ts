import { Request } from '@lib/http/Request.js'
import type { ValidationRules } from '@lib/validation/Validator.js'
import { Validator } from '@lib/validation/Validator.js'
import { AuthorizationException } from '@lib/auth/Gate.js'

export abstract class FormRequest extends Request {
  authorize(): Promise<boolean> | boolean { return true }
  abstract rules(): ValidationRules
  messages(): Record<string, string> { return {} }
  prepareForValidation(): void | Promise<void> {}
  after(): void | Promise<void> {}

  async validateResolved() {
    await this.prepareForValidation()
    if (!(await this.authorize())) throw new AuthorizationException('This action is unauthorized.')
    const data = await Validator.validate(this.body, this.rules(), { messages: this.messages() })
    this.setValidated(data)
    await this.after()
  }
}
