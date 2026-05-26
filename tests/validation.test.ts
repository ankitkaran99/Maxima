import { describe, expect, it } from 'vitest'
import { FormRequest, schema, Validator } from '@lib/index.js'

describe('Validator', () => {
  it('casts and returns validated data', async () => {
    const data = await Validator.validate({ age: '42', email: 'a@example.com' }, {
      age: schema.integer(),
      email: schema.string().email()
    })

    expect(data.age).toBe(42)
  })

  it('returns validation errors', async () => {
    await expect(Validator.validate({ email: 'bad' }, {
      email: schema.string().email()
    })).rejects.toMatchObject({
      errors: { email: expect.any(Array) }
    })
  })

  it('validates nested objects and returns sanitized nested data', async () => {
    const data = await Validator.validate({
      profile: { name: '  maxima  ', age: '3' }
    }, {
      profile: schema.object({
        name: schema.string().transform(value => value.trim()),
        age: schema.integer()
      })
    })

    expect(data).toEqual({ profile: { name: 'maxima', age: 3 } })
  })

  it('validates and casts array members', async () => {
    const data = await Validator.validate({ ids: ['1', '2'] }, {
      ids: schema.array().members(schema.integer())
    })

    expect(data.ids).toEqual([1, 2])
  })

  it('supports conditional validation rules', async () => {
    await expect(Validator.validate({ type: 'company' }, {
      company_name: schema.string().requiredIf('type', 'company')
    })).rejects.toMatchObject({
      errors: { company_name: expect.any(Array) }
    })

    await expect(Validator.validate({ type: 'person' }, {
      company_name: schema.string().requiredIf('type', 'company')
    })).resolves.toEqual({})
  })

  it('supports custom validation rules', async () => {
    Validator.extend('uppercase', value => value === String(value).toUpperCase())

    await expect(Validator.validate({ code: 'abc' }, {
      code: schema.string().use('uppercase')
    })).rejects.toMatchObject({
      errors: { code: expect.any(Array) }
    })

    await expect(Validator.validate({ code: 'ABC' }, {
      code: schema.string().use('uppercase')
    })).resolves.toEqual({ code: 'ABC' })
  })

  it('supports runtime sometimes callbacks and bail rules', async () => {
    const validator = Validator.make({ type: 'company', company_name: '' }, {})
      .sometimes('company_name', schema.string().bail().minLength(3).email(), data => data.type === 'company')

    await expect(validator.validate()).rejects.toMatchObject({
      errors: { company_name: ['The company_name field is invalid.'] }
    })
  })

  it('loads localized validation messages', async () => {
    await expect(Validator.validate({ email: 'bad' }, {
      email: schema.string().email()
    }, { locale: 'fr', fallbackLocale: 'en' })).rejects.toMatchObject({
      errors: { email: ['The email must be a valid email address.'] }
    })
  })

  it('supports JSON and file validation rules', async () => {
    const avatar = { mimeType: 'image/png', size: 512, filename: 'avatar.png' }

    await expect(Validator.validate({ meta: '{"ok":true}', avatar }, {
      meta: schema.string().json(),
      avatar: schema.file().file().image().mimes(['png']).maxFileSize(1024)
    })).resolves.toEqual({ meta: '{"ok":true}', avatar })
  })

  it('supports date comparison and date format rules', async () => {
    const rules = {
      start: schema.string().dateFormat('YYYY-MM-DD').before('end'),
      end: schema.string().afterOrEqual('start'),
      same_day: schema.string().dateEquals('2026-05-24')
    }

    await expect(Validator.validate({
      start: '2026-05-24',
      end: '2026-05-25',
      same_day: '2026-05-24T10:00:00Z'
    }, rules)).resolves.toMatchObject({ start: '2026-05-24' })

    await expect(Validator.validate({
      start: '24/05/2026',
      end: '2026-05-23',
      same_day: '2026-05-25'
    }, rules)).rejects.toMatchObject({
      errors: {
        start: expect.any(Array),
        same_day: expect.any(Array)
      }
    })
  })

  it('supports numeric, string, boolean, timezone, mac address, and ulid rules', async () => {
    await expect(Validator.validate({
      code: '12345',
      pin: '1234',
      amount: '10.50',
      step: 12,
      min: 3,
      value: 5,
      word: 'Maxima',
      lower: 'maxima',
      upper: 'MAXIMA',
      alpha_num: 'Maxima2026',
      slug: 'maxima-framework',
      file: 'report.pdf',
      flag: 'false',
      tz: 'Asia/Kolkata',
      mac: 'AA:BB:CC:DD:EE:FF',
      ulid: '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    }, {
      code: schema.string().digits(5),
      pin: schema.string().digitsBetween(4, 6),
      amount: schema.string().decimal(2),
      step: schema.number().multipleOf(3),
      value: schema.number().gt('min').gte(5).lt(10).lte(5),
      word: schema.string().alpha(),
      lower: schema.string().lowercase(),
      upper: schema.string().uppercase(),
      alpha_num: schema.string().alphaNum(),
      slug: schema.string().startsWith('maxima').endsWith('framework'),
      file: schema.string().endsWith(['.pdf', '.doc']),
      flag: schema.string().boolean(),
      tz: schema.string().timezone(),
      mac: schema.string().macAddress(),
      ulid: schema.string().ulid()
    })).resolves.toBeDefined()
  })

  it('supports array shape, distinct, presence, prohibition, and exclusion rules', async () => {
    await expect(Validator.validate({
      roles: ['admin', 'editor'],
      profile: { name: 'Ada', email: 'ada@example.com' },
      visible: true,
      hidden: 'secret',
      optional_note: 'kept',
      forbidden: '',
      mode: 'auto',
      skip_me: 'drop'
    }, {
      roles: schema.array().distinct(),
      profile: schema.object().requiredArrayKeys('name', 'email'),
      visible: schema.boolean().present(),
      optional_note: schema.string().filled(),
      missing_field: schema.string().missing(),
      forbidden: schema.string().prohibited(),
      mode: schema.string().prohibits('manual_reason'),
      skip_me: schema.string().excludeIf('mode', 'auto')
    })).resolves.toEqual({
      roles: ['admin', 'editor'],
      profile: { name: 'Ada', email: 'ada@example.com' },
      visible: true,
      optional_note: 'kept',
      mode: 'auto'
    })

    await expect(Validator.validate({
      roles: ['admin', 'admin'],
      profile: { name: 'Ada' },
      present_field: undefined,
      forbidden: 'nope',
      mode: 'auto',
      manual_reason: 'because'
    }, {
      roles: schema.array().distinct(),
      profile: schema.object().keys('name', 'email'),
      present_field: schema.string().present(),
      forbidden: schema.string().prohibited(),
      mode: schema.string().prohibits('manual_reason')
    })).rejects.toMatchObject({
      errors: {
        roles: expect.any(Array),
        profile: expect.any(Array),
        forbidden: expect.any(Array),
        mode: expect.any(Array)
      }
    })
  })

  it('supports image dimension rules', async () => {
    const image = { mimeType: 'image/png', width: 800, height: 600, size: 100 }

    await expect(Validator.validate({ image }, {
      image: schema.file().image().dimensions({ minWidth: 600, maxWidth: 1000, minHeight: 400, maxHeight: 800, ratio: '4/3' })
    })).resolves.toEqual({ image })

    await expect(Validator.validate({ image }, {
      image: schema.file().image().width(1024)
    })).rejects.toMatchObject({ errors: { image: expect.any(Array) } })
  })

  it('supports Laravel parity validation rules', async () => {
    enum Status { Draft = 'draft', Published = 'published' }
    const upload = { mimeType: 'application/pdf', size: 512, filename: 'report.pdf' }

    await expect(Validator.validate({
      accepted: 'yes',
      declined: 'no',
      ascii: 'Maxima',
      password: 'secret',
      password_confirmation: 'secret',
      color: '#ffaa00',
      status: 'draft',
      selected: 'admin',
      roles: ['admin', 'editor'],
      ip: '127.0.0.1',
      ip4: '127.0.0.1',
      ip6: '::1',
      pin: '123456',
      code: 'ABC-123',
      url: 'https://example.com',
      uuid: '550e8400-e29b-41d4-a716-446655440000',
      upload,
      allow_terms: 'on',
      deny_terms: 'off',
      note_source: 'present',
      other: 'same',
      compare: 'same',
      avoid: 'different'
    }, {
      accepted: schema.string().accepted(),
      declined: schema.string().declined(),
      ascii: schema.string().ascii().doesntStartWith('tmp').doesntEndWith('bak'),
      password: schema.string().confirmed(),
      color: schema.string().hexColor(),
      status: schema.string().enum(Status).in(['draft', 'published']).notIn(['archived']),
      selected: schema.string().inArray('roles'),
      ip: schema.string().ip(),
      ip4: schema.string().ipv4(),
      ip6: schema.string().ipv6(),
      pin: schema.string().minDigits(4).maxDigits(6),
      code: schema.string().regex(/^[A-Z]+-\d+$/).notRegex(/BAD/),
      url: schema.string().url(),
      uuid: schema.string().uuid(),
      upload: schema.file().file().mimeTypes(['application/pdf']).extensions(['pdf']).minFileSize(100).maxFileSize(1024),
      allow_terms: schema.string().acceptedIf('note_source', 'present'),
      deny_terms: schema.string().declinedIf('note_source', 'present'),
      required_because_accepted: schema.string().requiredIfAccepted('allow_terms'),
      required_because_declined: schema.string().requiredIfDeclined('deny_terms'),
      required_unless: schema.string().requiredUnless('note_source', 'absent'),
      required_with_all: schema.string().requiredWithAll('accepted', 'declined'),
      other: schema.string().same('compare'),
      avoid: schema.string().different('compare'),
      missing_if: schema.string().missingIf('note_source', 'present'),
      missing_unless: schema.string().missingUnless('note_source', 'absent'),
      missing_with: schema.string().missingWith('note_source'),
      missing_with_all: schema.string().missingWithAll('accepted', 'declined')
    })).rejects.toMatchObject({
      errors: {
        required_because_accepted: expect.any(Array),
        required_because_declined: expect.any(Array),
        required_unless: expect.any(Array)
      }
    })
  })

  it('replaces validation message placeholders and returns safe validated input', async () => {
    await expect(Validator.validate({ users: [{ email: 'bad' }], role: 'root' }, {
      'users.0.email': schema.string().email(),
      role: schema.string().in(['admin'])
    }, {
      messages: {
        'users.*.email.email': 'The :attribute must be valid.',
        in: 'The :attribute value :value must be one of :values.'
      },
      attributes: {
        'users.*.email': 'user email',
        role: 'role'
      },
      values: {
        role: { root: 'superuser' }
      },
      replacers: {
        in: message => message.replace(':values', 'admin')
      }
    })).rejects.toMatchObject({
      errors: {
        'users.0.email': ['The user email must be valid.'],
        role: ['The role value superuser must be one of admin.']
      }
    })
  })

  it('runs FormRequest preparation, validation, and after hooks', async () => {
    class StoreUserRequest extends FormRequest {
      afterRan = false

      rules() {
        return { email: schema.string().email() }
      }

      prepareForValidation() {
        this.merge({ email: this.input<string>('email', '').trim().toLowerCase() })
      }

      after() {
        this.afterRan = true
      }
    }

    const request = new StoreUserRequest({ body: { email: '  USER@EXAMPLE.COM  ' } } as any, {} as any)
    await request.validateResolved()

    expect(request.validated()).toEqual({ email: 'user@example.com' })
    expect(request.safe().only(['email'])).toEqual({ email: 'user@example.com' })
    expect(request.afterRan).toBe(true)
  })

  it('supports FormRequest hooks, attributes, validationData, and error bag customization', async () => {
    class UpdateUserRequest extends FormRequest {
      errorBag = 'profile'

      rules() {
        return { email: schema.string().email() }
      }

      messages() {
        return { email: 'The :attribute is not acceptable.' }
      }

      attributes() {
        return { email: 'contact email' }
      }

      validationData() {
        return { email: this.input('contact') }
      }
    }

    const request = new UpdateUserRequest({ body: { contact: 'bad' } } as any, {} as any)
    await expect(request.validateResolved()).rejects.toMatchObject({
      errorBag: 'profile',
      errors: { email: ['The contact email is not acceptable.'] }
    })
    expect(request.errors('profile')).toEqual({ email: ['The contact email is not acceptable.'] })
  })
})
