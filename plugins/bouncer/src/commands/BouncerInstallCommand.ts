import { Schema } from '@lib/database/Schema.js'

export default class BouncerInstallCommand {
  signature = 'bouncer:install {--force : Recreate existing Bouncer tables}'
  description = 'Install the database tables required by Bouncer'

  async handle(options: { force?: boolean }) {
    const force = Boolean(options.force)

    if (force) {
      console.log('Dropping existing Bouncer tables...')
      await Schema.dropIfExists('user_roles')
      await Schema.dropIfExists('role_abilities')
      await Schema.dropIfExists('user_abilities')
      await Schema.dropIfExists('roles')
      await Schema.dropIfExists('abilities')
    }

    console.log('Creating Bouncer tables...')

    if (!(await Schema.hasTable('roles'))) {
      await Schema.create('roles', table => {
        table.increments('id').primary()
        table.string('name').notNullable().unique()
        table.timestamps(true, true)
      })
      console.log('Created table: roles')
    } else {
      console.log('Table roles already exists.')
    }

    if (!(await Schema.hasTable('abilities'))) {
      await Schema.create('abilities', table => {
        table.increments('id').primary()
        table.string('name').notNullable()
        table.string('entity_type').nullable()
        table.string('entity_id').nullable()
        table.boolean('only_owned').notNullable().defaultTo(false)
        table.unique(['name', 'entity_type', 'entity_id', 'only_owned'])
        table.timestamps(true, true)
      })
      console.log('Created table: abilities')
    } else {
      console.log('Table abilities already exists.')
    }

    if (!(await Schema.hasTable('user_roles'))) {
      await Schema.create('user_roles', table => {
        table.integer('user_id').unsigned().notNullable()
        table.integer('role_id').unsigned().notNullable()
        table.foreign('role_id').references('id').inTable('roles').onDelete('CASCADE')
        table.primary(['user_id', 'role_id'])
      })
      console.log('Created table: user_roles')
    } else {
      console.log('Table user_roles already exists.')
    }

    if (!(await Schema.hasTable('role_abilities'))) {
      await Schema.create('role_abilities', table => {
        table.integer('role_id').unsigned().notNullable()
        table.integer('ability_id').unsigned().notNullable()
        table.boolean('forbidden').notNullable().defaultTo(false)
        table.foreign('role_id').references('id').inTable('roles').onDelete('CASCADE')
        table.foreign('ability_id').references('id').inTable('abilities').onDelete('CASCADE')
        table.primary(['role_id', 'ability_id'])
      })
      console.log('Created table: role_abilities')
    } else {
      console.log('Table role_abilities already exists.')
    }

    if (!(await Schema.hasTable('user_abilities'))) {
      await Schema.create('user_abilities', table => {
        table.integer('user_id').unsigned().notNullable()
        table.integer('ability_id').unsigned().notNullable()
        table.boolean('forbidden').notNullable().defaultTo(false)
        table.foreign('ability_id').references('id').inTable('abilities').onDelete('CASCADE')
        table.primary(['user_id', 'ability_id'])
      })
      console.log('Created table: user_abilities')
    } else {
      console.log('Table user_abilities already exists.')
    }

    console.log('Bouncer tables installed successfully.')
  }
}
