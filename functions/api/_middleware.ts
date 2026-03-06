import { verifyCloudflareAccess } from '../lib/auth'

interface Env {
  DB: D1Database
  BUCKET: R2Bucket
  CF_ACCESS_AUD: string
  CF_TEAM_DOMAIN: string
  SANDBOX_ORIGIN: string
}

interface RequestData {
  user: {
    sub: string
    email: string
  }
}

export async function onRequest(ctx: EventContext<Env, string, RequestData>) {
  const identity = await verifyCloudflareAccess(ctx.request, ctx.env)
  if (!identity) return new Response('Unauthorized', { status: 401 })
  ctx.data = { user: identity }
  return ctx.next()
}
