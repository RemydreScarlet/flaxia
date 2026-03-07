---
trigger: model_decision
description: When make zip execution
---

では実行仕様を書きます。

---

# ZIP Execution Specification

## 1. Trigger

User clicks the thumbnail on a post card in the timeline. Execution does not start automatically on scroll or page load.

## 2. Simultaneous Execution Limit

Maximum 1 active iframe at a time. When a new ZIP content is triggered, the existing iframe is destroyed before the new one is created.

## 3. Display

The iframe expands in-place within the post card, below the text and thumbnail. Fixed size: 600×400px. A fullscreen button is shown in the top-right corner of the iframe container.

## 4. iframe Configuration

```html
<iframe
  src="blob:..."
  sandbox="allow-scripts allow-pointer-lock"
  allow="fullscreen"
  referrerpolicy="no-referrer"
  width="600"
  height="400"
/>
```

## 5. Execution Flow

Step 1: User clicks thumbnail.
Step 2: Fetch ZIP from R2 via /api/zip/{post_id}.
Step 3: Validate ZIP using JSZip (see ZIP Upload Specification section 3). If validation fails, show error message and abort.
Step 4: Extract all files and generate blob URL map:
```
{
  "index.html"       → blob:...
  "script.js"        → blob:...
  "assets/logo.png"  → blob:...
}
```
Step 5: Rewrite index.html — replace all static path references in HTML and CSS with corresponding blob URLs.
Step 6: Convert rewritten index.html to blob URL.
Step 7: Create iframe with src set to index.html blob URL.
Step 8: Inject fresh-bridge.js into the page via postMessage handshake.

## 6. Path Rewriting Rules

Rewrite targets in HTML:
```
src="script.js"
src="./script.js"
href="style.css"
href="./style.css"
```

Rewrite targets in CSS:
```
url('assets/bg.png')
url("assets/bg.png")
url(assets/bg.png)
```

Do not rewrite:
```
src="https://..."
src="http://..."
src="data:..."
```

JS内の動的参照は置換対象外。制作者の責任範囲とする。

## 7. Fullscreen

Fullscreen button calls requestFullscreen() on the iframe element. This is handled by the parent page, not the iframe content. ZIP content can also request fullscreen via the postMessage bridge:
```
{ type: 'REQUEST_FULLSCREEN' }
```

## 8. Cleanup

When the iframe is closed or replaced, all blob URLs are revoked via URL.revokeObjectURL() to free memory.

## 9. Error Handling

Errors shown to user:

- ZIP download failed
- ZIP validation failed (with specific reason)
- index.html not found
- File type not allowed (with filename)
