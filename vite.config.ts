import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: 'index.html'
      }
    }
  },
  server: {
    port: 3000
  },
  define: {
    'import.meta.env.VITE_SANDBOX_ORIGIN': JSON.stringify(process.env.SANDBOX_ORIGIN || 'http://localhost:8080'),
    'import.meta.env.VITE_CLOUDFLARE_ACCOUNT_ID': JSON.stringify(process.env.CLOUDFLARE_ACCOUNT_ID || '')
  }
})
