export default class PostPolicy {
  async view() {
    return true
  }

  async update(user, post) {
    return user?.id === post.user_id
  }

  async delete(user, post) {
    return user?.id === post.user_id
  }
}
