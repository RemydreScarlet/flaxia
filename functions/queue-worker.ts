/// <reference types="@cloudflare/workers-types" />

interface DeliveryMessage {
  inboxUrl: string
  activity: object
  senderUsername: string
}

interface Env {
  DB: D1Database
  BASE_URL: string
}

export default {
  async queue(batch: MessageBatch<DeliveryMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const { inboxUrl, activity, senderUsername } = message.body

      try {
        // 1. D1 から送信者の private_key_pem を取得
        const keyResult = await env.DB.prepare(`
          SELECT ak.private_key_pem FROM actor_keys ak
          JOIN users u ON u.id = ak.user_id
          WHERE u.username = ?
        `).bind(senderUsername).first()

        if (!keyResult || !keyResult.private_key_pem) {
          console.error('No private key found for user:', senderUsername)
          message.ack()
          continue
        }

        const privateKeyPem = keyResult.private_key_pem as string
        const keyId = `${env.BASE_URL}/actors/${senderUsername}#main-key`

        // 2. signRequest で Headers 生成
        const { signRequest } = await import('./lib/activitypub/signature')
        const body = JSON.stringify(activity)
        const headers = await signRequest(inboxUrl, body, privateKeyPem, keyId)

        // 3. POST リクエストを送信
        const response = await fetch(inboxUrl, {
          method: 'POST',
          headers: headers,
          body: body
        })

        // 4. レスポンスを確認
        if (!response.ok) {
          console.error('Delivery failed:', inboxUrl, 'status:', response.status)
        }

        message.ack()
      } catch (e) {
        console.error('Delivery error:', inboxUrl, e)
        message.retry()
      }
    }
  }
}
