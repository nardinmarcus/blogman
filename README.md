# Blogman

[English](README.md) | [简体中文](README.zh-CN.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nardinmarcus/blogman)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**An open-source, self-hosted blog platform that runs entirely on Cloudflare, Next.js 16 + Workers + D1 + R2. Not a static template: a full writing platform with a WYSIWYG editor, AI writing assistance, AI image generation, and a theme system.**

![Blogman editor with autosave status](docs/screenshots/editor-overview.webp)

## What it does

Blogman gives you a complete blog you own end to end: write in a Notion-style editor, let AI polish, summarize, tag, and illustrate your posts, pick one of four homepage themes, and publish with fine-grained visibility controls. Everything runs on Cloudflare's edge platform, no server, database, or CDN to operate.

## Features

**Editor**
- Dual WYSIWYG editors (Tiptap / Novel) on front end and admin
- Bubble Menu + Ask AI, select text to rewrite, polish, expand, or translate
- Markdown import/export, image crop/align, YouTube embeds, math blocks

**AI**
- Auto-generate summaries, tags, SEO slug, and cover images
- Configurable AI text model presets (OpenAI, Workers AI, custom endpoints)
- AI image generation with model templates and generation history
- Image right-click: download, set as cover, crop, reuse as image-gen reference

**Themes & publishing**
- 4 homepage themes, mobile-friendly, out of the box
- Publish states: public, draft, password-protected, link-only
- First-run initialization: navigation, categories, fonts, AI model templates

**Infrastructure**
- Cloudflare Workers + D1 + R2, nothing to maintain
- API tokens for external integrations
- Optional: background jobs, Workers AI, vector search, Cloudflare image pipeline

## Screenshots

| Homepage themes | Ask AI bubble menu | Publish states |
| --- | --- | --- |
| ![Homepage with theme switcher showing the 4 built-in themes](docs/screenshots/home-themes.webp) | ![Ask AI bubble menu with rewrite, expand, translate actions](docs/screenshots/ask-ai.png) | ![Publish state picker: public, draft, password, link-only](docs/screenshots/publish-states.png) |

## Quick start

Requires Node.js 20+ and npm.

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

To preview the real Worker runtime locally:

```bash
npm run preview
```

## Deploy to Cloudflare

Click **Deploy to Cloudflare** above: it auto-provisions D1 and R2, then applies pending D1 migrations through the fail-closed migration ledger.

> [!NOTE]
> Deployment creates resources in your own Cloudflare account (a Worker, a D1 database, an R2 bucket) and asks you to set the secrets below. Nothing runs on third-party infrastructure.

| Secret | Description |
| --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Your public blog URL, e.g. `https://blog.example.com` |
| `ADMIN_PASSWORD` | Admin login password |
| `ADMIN_TOKEN_SALT` | Token signing salt (`openssl rand -hex 32`) |
| `AI_CONFIG_ENCRYPTION_SECRET` | Encrypts stored AI provider keys (`openssl rand -hex 32`) |
| `AI_API_KEY` | Optional. AI service API key |

### Manual CLI deployment

```bash
npm install
cp .env.example .env.local
npx wrangler login
npm run cf:init -- --site-url=https://your-domain.com
npm run build
npm run deploy
```

See [DEPLOY.md](DEPLOY.md) for the full deployment guide.

## Ecosystem

External publishing tools that all route back to the same blog backend:

- [`ecosystem/chrome-clipper`](ecosystem/chrome-clipper/), clip web pages into blog drafts
- [`ecosystem/obsidian-publisher`](ecosystem/obsidian-publisher/), one-click publish from Obsidian
- [`ecosystem/namoo-blog-publisher`](ecosystem/namoo-blog-publisher/), Claude Skill / CLI publish workflow

## Tech stack

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

<details>
<summary>Schema migrations</summary>

D1 schema changes go through a fail-closed, ledger-based migration runner (`scripts/migrations.mjs`) with `plan` / `status` / `verify` / `apply` commands. See [`db/MIGRATIONS.md`](db/MIGRATIONS.md).

</details>

## Development

| Command | Description |
| --- | --- |
| `npm run dev` | Local dev server |
| `npm run build` | Production build |
| `npm run preview` | Worker runtime preview |
| `npm run deploy` | Deploy to Cloudflare Workers |
| `npm run cf:init` | Initialize Cloudflare resources and defaults |
| `npm run test` | Run tests in watch mode (Vitest) |
| `npm run test:run` | Run tests once (CI mode) |
| `npm run verify:quick` | Lint + tests + build |
| `npm run verify` | Full verification pipeline (incl. OpenNext build) |

## Docs

- [DEPLOY.md](DEPLOY.md), deployment guide
- [db/MIGRATIONS.md](db/MIGRATIONS.md), D1 migration runner
- [docs/adr](docs/adr/), architecture decision records
- [ecosystem/README.md](ecosystem/README.md), companion publishing tools

## License

[MIT](LICENSE)
