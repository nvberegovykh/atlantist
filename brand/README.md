# Atlantist Brand System

Version 1.0 — 2026-05-24

One reference for every visual decision. Read this before touching any logo, color, or type.

---

## Directory layout

```
brand/
├── tokens.css              # CSS custom properties — single source of truth
├── brand-sheet.svg         # One-page brand reference (logo, palette, type scale)
├── og-template.svg         # 1200×630 Open Graph image template
├── README.md               # This file
├── logo/
│   ├── atlantist-light.svg # Wordmark + monogram — for light backgrounds
│   └── atlantist-dark.svg  # Wordmark + monogram — for dark backgrounds
├── icons/
│   └── monogram.svg        # Square app icon (64px grid, dark background)
└── characters/
    ├── manifest.json       # Character illustration registry with URLs + usage
    └── (illustrations hosted on Polsia R2)
```

## Files deployed to `/public`

| File | Path | Purpose |
|------|------|---------|
| `favicon.svg` | `/public/favicon.svg` | Browser tab icon (SVG, all sizes) |
| `og-image.svg` | `/public/og-image.svg` | OG image served at `/og-image.svg` |
| `brand-tokens.css` | `/public/css/brand-tokens.css` | Token stylesheet loaded before `app.css` |

---

## Core design decisions

**The mark** — Three concentric rings (Atlantis city plan in plan view) with an `A` letterform bridging all three. The rings are not decorative — they reference the product: nested geometry, constraint relationships, radial structure. At small sizes (32px), the rings fade and the A letterform carries the mark.

**The palette** — Deep ocean navy (`--brand-ink: #0f1923`) + warm paper white (`--brand-paper: #f7f6f3`) + Atlantis blue (`--brand-accent: #1d5fa6`). Three semantic colors: warn amber, success green, error red. No gradients in UI; gradient only in the icon core dot (conveys depth without decoration).

**The type** — DM Serif Display for headings and the wordmark (humanist serif, architectural authority without being stuffy). DM Sans for all UI (neutral, legible at 11px). DM Mono for coordinates, IDs, and code.

---

## Color tokens quick reference

| Token | Value | Use |
|-------|-------|-----|
| `--brand-ink` | `#0f1923` | Primary text, strokes |
| `--brand-paper` | `#f7f6f3` | Canvas, backgrounds |
| `--brand-accent` | `#1d5fa6` | Links, buttons, marks |
| `--brand-accent-light` | `#3479c4` | Hover states |
| `--brand-accent-dark` | `#134a84` | Active/pressed |
| `--brand-warn` | `#d97706` | Warnings, amber states |
| `--brand-success` | `#16a34a` | Success, compliance pass |
| `--brand-error` | `#dc2626` | Errors, constraint fail |
| `--brand-n100` | `#e8e6e1` | Dividers, subtle fills |
| `--brand-n400` | `#8a8680` | Secondary text |
| `--brand-n700` | `#3d3a35` | Body text |

Dark surface override: add `.theme-dark` to `<html>` or a container. Ink/paper swap automatically.

---

## Type scale

| Role | Size | Line height | Weight | Font |
|------|------|-------------|--------|------|
| Display | clamp(2.5–4rem) | 1.08 | 400 | DM Serif Display |
| H1 | clamp(2–3rem) | 1.12 | 600 | DM Sans |
| H2 | clamp(1.5–2rem) | 1.2 | 600 | DM Sans |
| H3 | 1.25rem | 1.3 | 600 | DM Sans |
| H4 | 1rem | 1.4 | 700 | DM Sans |
| Body | 1rem | 1.6 | 400 | DM Sans |
| Caption | 0.75rem | 1.5 | 400 | DM Sans |
| Mono | 0.875rem | 1.6 | 400 | DM Mono |

Google Fonts link (already in all HTML files):
```html
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400&family=DM+Sans:wght@400;600;700&family=DM+Serif+Display&display=swap" rel="stylesheet">
```

---

## Characters

Three illustrations in the navy + cobalt palette, hosted on Polsia R2. See `characters/manifest.json` for URLs.

| ID | Name | Placement |
|----|------|-----------|
| `char-01-drafter` | The Drafter | Landing hero, onboarding empty state |
| `char-02-inspector` | The Inspectors | Collaboration tab, issues empty state |
| `char-03-explorer` | The Explorer | 3D model empty state, feature illustrations |

Style reference: architectural, slightly surreal, confident linework, restrained palette. All three share the same navy ink + cobalt blue system — never mix with other illustration styles or apply color filters.

---

## Logo usage rules

- **Minimum width**: 120px (wordmark) / 32px (monogram only)
- **Clear space**: ½ × outer ring radius on all four sides
- **Light surfaces**: use `logo/atlantist-light.svg`
- **Dark surfaces**: use `logo/atlantist-dark.svg`
- **Never**: recolor individual elements, remove rings, stretch non-uniformly, place on busy backgrounds

---

## OG Image

The template is at `brand/og-template.svg` and deployed to `/public/og-image.svg`. All pages reference `https://atlantist.cloud/og-image.svg`. To update: edit the SVG source and re-deploy. For social campaigns with custom taglines, fork the template — don't modify the base.

---

## Email footer (Postmark)

- Background: `--brand-ink` (#0f1923)
- Logo: dark variant inline SVG
- Body font: DM Sans, 13px, `--brand-n400` for secondary text
- Accent links: `--brand-accent-light` (#3479c4)
- Never add extra color blocks or gradients to email

---

## Adding new brand assets

1. Generate or create the asset in the correct style
2. Upload to Polsia R2 via the asset system
3. Add entry to `characters/manifest.json` (for illustrations) or `logo/` (for marks)
4. Update this README's relevant table
5. No approval needed for style-consistent extensions; major pivots (new character style, color change) require a brand update cycle
