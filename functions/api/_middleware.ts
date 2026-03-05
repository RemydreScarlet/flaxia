import { verifyCloudflareAccess } from '../../lib/auth'

export async function onRequest(ctx: EventContext<Env, string, unknown>) {
  const identity = await verifyCloudflareAccess(ctx.request, ctx.env)
  if (!identity) return new Response('Unauthorized', { status: 401 })
  ctx.data.user = identity
  return ctx.next()
}
