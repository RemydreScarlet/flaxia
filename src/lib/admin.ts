export function isAdmin(env: Env, username: string): boolean {
  if (!env.ADMIN_USERNAMES) {
    return false
  }
  return env.ADMIN_USERNAMES.split(',')
    .map((u: string) => u.trim())
    .includes(username)
}
