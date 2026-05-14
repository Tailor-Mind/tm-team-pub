# TailorMind — Talent (public site)

Bilingual (EN/ES) hiring site for senior AI-empowered full-stack developers, remote, Peru.

Built with **Astro** + Tailwind v4. Deploys to GitHub Pages on push to `main`.

## Local dev

```bash
npm install
cp .env.example .env   # fill in Form URLs and Apps Script endpoint
npm run dev
```

## Structure

```
src/
├── layouts/Base.astro
├── components/CompReveal.astro
├── i18n/ui.ts
└── pages/
    ├── index.astro          # redirect → /en/
    ├── en/                  # English pages
    └── es/                  # Spanish pages
diagrams/                    # Mermaid sources, rendered to public/img/flows/ in CI
public/                      # static assets (llm.txt, robots.txt, rendered SVGs)
```

## Environment variables

All `PUBLIC_*` are inlined at build time. Set as **repository variables** in GitHub
(Settings → Secrets and variables → Actions → Variables) so the deploy workflow picks them up.

| Var | Source |
|-----|--------|
| `PUBLIC_TRACK_ENDPOINT` | Apps Script Web App URL (from `private-kit`) |
| `PUBLIC_APPLY_FORM_URL_EN` | Google Form public URL (English) |
| `PUBLIC_APPLY_FORM_URL_ES` | Google Form public URL (Spanish) |

## Deploy

Push to `main`. The workflow:
1. Renders Mermaid diagrams to SVG.
2. Builds Astro.
3. Uploads `dist/` as the Pages artifact.

First time: in repo Settings → Pages → Source = **GitHub Actions**.

## Site URL

Set `site:` in `astro.config.mjs` once the GitHub org/repo is fixed (e.g.
`https://tailormind.github.io`). If served from a project subpath, also set
`base: '/<repo-name>'` and update internal links accordingly.

## Commands

| Command           | Action                              |
| :---------------- | :---------------------------------- |
| `npm run dev`     | Dev server at `localhost:4321`      |
| `npm run build`   | Production build → `./dist/`        |
| `npm run preview` | Preview build locally               |
