export async function up(knex) {
  await knex.schema.createTable('posts', table => {
    table.increments('id').primary()
    table.integer('user_id').unsigned().references('id').inTable('users')
    table.string('title').notNullable()
    table.text('body').notNullable()
    table.timestamp('deleted_at').nullable()
    table.timestamps(true, true)
  })
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('posts')
}
