export class Storage {
  constructor(private bucket: R2Bucket) {}
  
  async uploadGif(postId: string, gif: ArrayBuffer): Promise<string> {
    const key = `gif/${postId}.gif`
    await this.bucket.put(key, gif)
    return key
  }
  
  async uploadPayload(postId: string, payload: ArrayBuffer): Promise<string> {
    const key = `payload/${postId}`
    await this.bucket.put(key, payload)
    return key
  }
  
  async getPayload(key: string): Promise<ArrayBuffer | null> {
    const object = await this.bucket.get(key)
    return object ? await object.arrayBuffer() : null
  }
  
  async deletePayload(key: string): Promise<void> {
    await this.bucket.delete(key)
  }
  
  getPublicUrl(key: string): string {
    return `https://flaxia-content.com/${key}`
  }
}
