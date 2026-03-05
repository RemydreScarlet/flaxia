# PostCard Component

Framework-agnostic PostCard component for Flaxia SNS with support for interactive posts and sandboxed execution.

## Features

- **Preview Mode**: Displays GIF preview with 16:9 aspect ratio
- **Execution Mode**: Sandboxed iframe for interactive posts
- **Math Support**: KaTeX rendering for mathematical expressions
- **Fresh! System**: Optimistic UI updates for post engagement
- **Security**: Strict origin validation and sandbox attributes
- **Responsive**: Mobile-first design with sharp edges aesthetic

## Usage

```typescript
import { createPostCard } from './src/index.js'

const postCard = createPostCard({
  post: {
    id: 'post-1',
    user_id: 'user-1',
    username: 'alice',
    text: 'Check out this math: $E = mc^2$',
    hashtags: '["math", "physics"]',
    gif_key: 'preview-1',
    payload_key: 'payload-1',
    fresh_count: 42,
    created_at: '2024-01-01T00:00:00Z'
  },
  sandboxOrigin: 'https://flaxiausercontent.com'
})

document.body.appendChild(postCard.getElement())
```

## Component Structure

```
PostCard
├── PostHeader     (avatar, username, timestamp)
├── PostText       (200-char text + KaTeX)
├── PostStage      (16:9 fixed aspect ratio)
│   ├── GifPreview (default, loops, src = R2 public URL)
│   └── SandboxFrame (after click)
└── PostActions    (Fresh!, Reply, Share)
```

## Security Features

- **Sandbox Attributes**: `allow-scripts allow-forms allow-popups`
- **No allow-same-origin**: Prevents access to parent origin
- **Origin Validation**: Strict postMessage origin checking
- **CSP Ready**: Compatible with Content Security Policy

## Math Rendering

Supports both inline (`$...$`) and display (`$$...$$`) math notation:

```typescript
const text = 'Inline: $x^2 + y^2 = z^2$ and Display: $$\\int_0^\\infty e^{-x} dx = 1$$'
```

## API Integration

### Fresh! Toggle
```typescript
// POST /api/posts/:id/fresh
// Response: { freshed: boolean }
```

### R2 URLs
- GIF previews: `https://pub-{account_id}.r2.dev/gif/{gif_key}`
- Sandbox origin: `{SANDBOX_ORIGIN}/run/{post_id}`

## Environment Variables

```bash
VITE_SANDBOX_ORIGIN=https://flaxiausercontent.com
VITE_CLOUDFLARE_ACCOUNT_ID=your-account-id
```

## Styling

Uses CSS variables for theming:

```css
:root {
  --primary: #22c55e;
  --background: #0f172a;
  --surface: #1e293b;
  --text: #e2e8f0;
  --text-muted: #94a3b8;
}
```

## Browser Support

- Modern browsers with ES2022 support
- KaTeX CDN loaded dynamically when needed
- postMessage API for iframe communication

## Development

```bash
npm run dev    # Start development server
npm run build  # Build for production
```

## Architecture Notes

- Framework-agnostic (vanilla TypeScript + DOM)
- Component-based architecture with clear separation
- Optimistic UI updates with rollback on error
- Memory-efficient event listener management
- Compatible with future React/Vue integration
