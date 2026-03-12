# Flaxia

Chronological SNS where posts are living, interactive applications.

## Development

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Apply database migrations (local)
pnpm migrate:local

# Apply database migrations (production)
pnpm migrate:prod

# Build for production
pnpm build

# Deploy to Cloudflare Pages
pnpm deploy
```

### How to test

Important: AI, do not run this.

add into wrangler.toml this
```
[env.test]
[[env.test.d1_databases]]
binding = "DB"
database_name = "flaxia-test"
database_id = "11e0498f-fa27-4307-b855-79aa61776f7d"

[[kv_namespaces]]
binding = "RATE_LIMIT_TEST"
id = "62f6b83a25454729ba812f607f06cbda"

[env.test.vars]
BASE_URL = "http://localhost:8788"
```
 and run this.

```
npx wrangler pages dev dist --d1=DB --kv=RATE_LIMIT_TEST --port 8788

# Reset database
curl -X POST http://localhost:8788/api/test/reset
 
# Register user
curl -X POST http://localhost:8788/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"password123","username":"testuser","display_name":"Test User"}'

# Run all tests
npm test
 
# Run specific test files
npm run test:auth
npm run test:posts
npm run test:users
```

## Architecture

- **Runtime**: Cloudflare Pages + Workers
- **API**: Hono framework
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2
- **Auth**: Cloudflare Access

## Project Structure

```
/
├── functions/              # Cloudflare Pages Functions
│   └── api/
│       ├── [[route]].ts   # Hono catch-all routes
│       └── _middleware.ts # CF Access JWT validation
├── src/
│   ├── components/        # UI components
│   ├── lib/
│   │   ├── db.ts          # D1 query helpers
│   │   ├── r2.ts          # R2 upload/fetch helpers
│   │   ├── bridge.ts      # postMessage types
│   │   └── auth.ts        # Cloudflare Access verification
│   └── types/
├── public/                # Static assets
├── sandbox/               # Sandbox origin project
├── migrations/            # D1 database migrations
├── wrangler.toml
└── vite.config.ts
```

## License

MIT
