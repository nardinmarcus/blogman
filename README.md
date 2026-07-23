# Blogman

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nardinmarcus/blogman)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Open-source blog system built on Next.js 16 + Cloudflare Workers + D1 + R2. Not a static template — a full-featured writing platform with WYSIWYG editor, AI writing assistance, AI image generation, theme system, and external publishing ecosystem.

## Features

**Editor**
- Front-end and back-end dual WYSIWYG editors (Tiptap / Novel)
- Bubble Menu + Ask AI — select text to rewrite, polish, expand, or translate
- Markdown import/export, image crop/align, YouTube embeds, math blocks

**AI**
- Auto-generate summaries, tags, SEO slug, and cover images
- Configurable AI text model presets (OpenAI, Workers AI, custom endpoints)
- AI image generation with model templates and generation history
- Image right-click: download, set cover, crop, reference for image gen

**Themes & Publishing**
- 4 homepage themes, mobile-friendly, out of the box
- Publish states: public, draft, password-protected, link-only
- Default initialization: navigation, categories, fonts, AI model templates

**Infrastructure**
- Cloudflare Workers + D1 + R2 — no server or CDN to maintain
- API Token support for external integrations
- Optional: background jobs, Workers AI, vector search, Cloudflare image pipeline

## Ecosystem

External publishing tools that all route back to the same blog backend:

- [`ecosystem/chrome-clipper`](ecosystem/chrome-clipper/) — Web page clipping to blog drafts
- [`ecosystem/obsidian-publisher`](ecosystem/obsidian-publisher/) — One-click publish from Obsidian
- [`ecosystem/namoo-blog-publisher`](ecosystem/namoo-blog-publisher/) — Claude Skill / CLI publish workflow

## Deploy to Cloudflare

Click the **Deploy to Cloudflare** button above. It auto-provisions D1 and R2, then applies pending D1 migrations through the fail-closed migration ledger.

Secrets to configure:

| Secret | Description |
| --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Your public blog URL, e.g. `https://blog.example.com` |
| `ADMIN_PASSWORD` | Admin login password |
| `ADMIN_TOKEN_SALT` | Token signing salt (`openssl rand -hex 32`) |
| `AI_CONFIG_ENCRYPTION_SECRET` | Encrypts stored AI provider keys (`openssl rand -hex 32`) |
| `AI_API_KEY` | Optional. AI service API key |

### Manual CLI Deployment

```bash
npm install
cp .env.example .env.local
npx wrangler login
npm run cf:init -- --site-url=https://your-domain.com
npm run build
npm run deploy
```

## Local Development

```bash
git clone https://github.com/nardinmarcus/blogman.git
cd blogman
npm install
cp .env.example .env.local
npm run dev
```

Entry points:

- Blog: `/`
- Admin: `/admin`
- Editor: `/editor`

Worker runtime preview:

```bash
npm run preview
```

## Tech Stack

| Layer | Technology |
| --- | --- |
| Framework | Next.js 16, React 19, TypeScript |
| Editor | Novel / Tiptap |
| Runtime | Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| Storage | Cloudflare R2 |
| Styling | Tailwind CSS 4 |
| AI | OpenAI SDK, Workers AI (optional) |
| Build | OpenNext for Cloudflare |

## Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Local dev server |
| `npm run build` | Production build |
| `npm run preview` | Worker runtime preview |
| `npm run deploy` | Deploy to Cloudflare Workers |
| `npm run cf:init` | Initialize Cloudflare resources and defaults |
| `npm run test` | Run tests (Vitest) |
| `npm run verify:quick` | Lint + test + build |
| `npm run verify` | Full verification pipeline |

Migration `plan`, `apply`, `status`, and `verify` usage is documented in [`db/MIGRATIONS.md`](db/MIGRATIONS.md).

## License

[MIT](LICENSE)
