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
