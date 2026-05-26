export class ValidationException extends Error {
  public errorBag = 'default'
  public redirectTo?: string

  constructor(public readonly errors: Record<string, string[]>) {
    super('Validation failed')
    this.name = 'ValidationException'
  }

  withErrorBag(errorBag: string) {
    this.errorBag = errorBag
    return this
  }

  redirectToUrl(url: string) {
    this.redirectTo = url
    return this
  }
}
