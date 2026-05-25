export default class CommentPolicy {
  async delete(user, comment) {
    return user?.id === comment?.user_id
  }
}
