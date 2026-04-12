# Flaxia

Chronological SNS where posts are living, interactive applications.

## Development

```bash
npm run build && npx wrangler pages deploy dist
```

```bash
wrangler pages deployment tail
```

```bash
npx wrangler deploy functions/queue-worker.ts --config wrangler.toml.worker --name flaxia-ap-delivery --compatibility-date 2024-01-01
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
