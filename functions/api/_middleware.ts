import { verifyCloudflareAccess } from '../lib/auth'

interface Env {
  DB: D1Database
  SANDBOX_ORIGIN: string
}

export async function onRequest(ctx: EventContext<Env, string, unknown>) {
  const identity = await verifyCloudflareAccess(ctx.request, ctx.env)
  if (!identity) return new Response('Unauthorized', { status: 401 })
  ctx.data = { user: identity }
  return ctx.next()
}
