# Figma MCP Compiler

A Figma-to-Code compiler that reads Figma designs via the Figma API and renders them as live HTML/CSS in the browser, with React component hydration using the **rk-designsystem** (Red Cross Design System). Supports exporting deployable HTML/CSS and React (Vite) zip packages.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env and add your Figma Personal Access Token

# 3. Start the server
npm start

# 4. Open http://localhost:3000
# Paste a Figma URL and click Load
```

## Features

- **Live Preview** — Paste a Figma URL, get a pixel-accurate browser preview
- **Auto Layout → CSS Flexbox** — Direct 1:1 translation of Figma layout properties
- **Design Token Resolution** — Bound Figma variables resolve to CSS custom properties
- **Image Handling** — IMAGE fills, SVG vectors, GIFs, videos, and Lottie animations
- **Code Connect Integration** — Detects rk-designsystem components via Figma Code Connect API
- **React Hydration** — Design system components (Heading, Card, Paragraph, etc.) are hydrated as live React components using esbuild
- **Export** — Download deployable zip packages:
  - **HTML/CSS** — Static `index.html` + `styles.css` + `README.md`
  - **React** — Vite project with JSX components and CSS modules

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Browser (localhost:3000)             │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Setup Page   │  │ Compiler Page│  │ React Bundle  │  │
│  │ (token cfg)  │  │ (preview +   │  │ (esbuild,     │  │
│  │              │  │  export btns)│  │  hydration)   │  │
│  └─────────────┘  └──────┬───────┘  └───────┬───────┘  │
│                          │                   │          │
└──────────────────────────┼───────────────────┼──────────┘
                           │                   │
┌──────────────────────────┼───────────────────┼──────────┐
│                   Express Server (mcp-compiler.js)       │
│                          │                   │          │
│  ┌───────────────────────▼───────────────────▼───────┐  │
│  │                  MCPCompiler class                 │  │
│  │                                                   │  │
│  │  ┌─────────────┐  ┌────────────┐  ┌────────────┐ │  │
│  │  │ Figma Data  │  │ HTML       │  │ React      │ │  │
│  │  │ Fetching    │  │ Translation│  │ Hydration  │ │  │
│  │  │             │  │            │  │ & Export   │ │  │
│  │  │ • fetchData │  │ • autoLayout│ │ • esbuild  │ │  │
│  │  │ • images    │  │   → flexbox│  │ • bundle   │ │  │
│  │  │ • variables │  │ • text     │  │ • zip      │ │  │
│  │  │ • codeConnect│ │ • fills    │  │   export   │ │  │
│  │  └──────┬──────┘  └────────────┘  └────────────┘ │  │
│  └─────────┼─────────────────────────────────────────┘  │
│            │                                            │
└────────────┼────────────────────────────────────────────┘
             │
┌────────────▼────────────┐     ┌─────────────────────────┐
│   FigmaMCPClient        │     │  rk-designsystem        │
│   (mcp-client.js)       │     │  (node_modules)         │
│                         │     │                         │
│  • MCP server (if avail)│     │  • Heading, Card,       │
│  • Direct Figma REST API│     │    Paragraph, Button... │
│    (fallback)           │     │  • CSS theme + tokens   │
└────────────┬────────────┘     └─────────────────────────┘
             │
┌────────────▼────────────┐
│   Figma REST API        │
│   api.figma.com/v1      │
│                         │
│  • /files/:key/nodes    │
│  • /images/:key         │
│  • /code_connect        │
│  • /variables           │
└─────────────────────────┘
```

## File Structure

```
├── index.js              # Entry point — starts Express server
├── mcp-compiler.js       # Core compiler: Figma→HTML translation, server routes, exports
├── mcp-client.js         # Figma API client (MCP server with REST API fallback)
├── package.json          # Dependencies and scripts
├── .env.example          # Environment variable template
└── .gitignore
```

## Core Modules

### `mcp-compiler.js` — MCPCompiler class

The main compiler (~4000 lines). Key responsibilities:

| Area | Methods | Description |
|------|---------|-------------|
| **Figma Data** | `fetchFigmaData`, `fetchImageUrls`, `fetchVariableDefinitions`, `fetchCodeConnectMappings` | Fetches design data, images (PNG/SVG), design tokens, and Code Connect component mappings from the Figma API |
| **HTML Translation** | `translateNodeToHTML`, `translateAutoLayoutToCSS`, `translateTextStyle`, `translateRectangleStyle` | Converts Figma node tree to HTML/CSS. Maps Auto Layout → flexbox, handles FRAME, TEXT, RECTANGLE, INSTANCE, VECTOR, ELLIPSE, etc. |
| **Image Handling** | `collectImageNodes`, `processSvg`, `hasLottieFill`, `hasVideoFill`, `hasGifFill` | Detects and renders IMAGE fills as `<img>`, SVGs inline, Lottie via dotlottie-wc, videos and GIFs as containers |
| **Design Tokens** | `getBoundVariableValue`, `getVariableCSS`, `figmaColorToCSS` | Resolves Figma bound variables to `var(--token-name)` CSS custom properties |
| **React Hydration** | `generateReactPreviewEntry`, `buildComponentTree` | Generates esbuild entry that imports rk-designsystem components and hydrates them into the pre-rendered HTML |
| **Export** | `/api/export-html`, `/api/export-react` | Generates downloadable zip files — static HTML/CSS or a full Vite React project |
| **Pages** | `generateCompilerPage`, `generateSetupPage`, `generateReactPreviewPage` | Server-rendered HTML pages for the compiler UI |

### `mcp-client.js` — FigmaMCPClient class

Figma API client with two connection modes:
1. **MCP Server** — Connects to a local MCP server if available
2. **Direct REST API** — Falls back to `api.figma.com/v1` using `FIGMA_ACCESS_TOKEN`

Provides: `connect()`, `callTool(name, args)` for `figma_get_file`, `figma_get_images`, `figma_get_code_connect`, `figma_get_variable_defs`.

## How It Works

### Compilation Pipeline

1. **Parse URL** — Extract `fileKey` and `nodeId` from the Figma URL
2. **Fetch Data** — Call Figma API for the node tree, images, variables, and Code Connect mappings
3. **Translate** — Walk the Figma node tree recursively:
   - **FRAME** → `<div>` with flexbox CSS from Auto Layout properties
   - **TEXT** → `<p>`, `<h1>`–`<h6>`, or `<span>` with font styles
   - **RECTANGLE** → `<div>` with background/border, or `<img>` if it has an IMAGE fill
   - **INSTANCE/COMPONENT** → `<img>` if it has an IMAGE fill (e.g. `.Aspect Ratio Spacer`), otherwise recurse into children
   - **VECTOR** → Inline `<svg>` or fallback `<img>`
   - **ELLIPSE** → `<div>` with `border-radius: 50%`
4. **Hydrate** — esbuild bundles a React entry that finds `[data-figma-id]` elements matching Code Connect components and replaces them with live React components
5. **Serve** — Express serves the compiled page with design system CSS from `node_modules`

### Code Connect Integration

The compiler queries the Figma Code Connect API to identify which INSTANCE nodes map to rk-designsystem components. For each match, it stores the component name, props, and node data. During React hydration, these are used to render actual React components (e.g. `<Heading>`, `<Card>`, `<Paragraph>`) with correctly mapped props.

**Prop mapping:**
- `size`: `xxlarge` → `2xl`, `large` → `lg`, etc.
- `color`: `main` → `accent`, `neutral` → `neutral`
- `Body` (Code Connect name) → `Paragraph` (actual export)

### Export Formats

**HTML/CSS Export** — Extracts inline styles into a `styles.css` file, produces a clean `index.html` with class-based styling.

**React Export** — Generates a complete Vite project:
```
├── package.json          # React + Vite deps
├── vite.config.js
├── index.html
├── src/
│   ├── main.jsx
│   ├── App.jsx
│   └── components/
│       ├── FigmaComponent.jsx
│       └── FigmaComponent.module.css
└── README.md
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FIGMA_ACCESS_TOKEN` | Yes | Figma Personal Access Token |
| `FIGMA_TEAM_ID` | No | Figma Team ID (for future use) |
| `MCP_SERVER_URL` | No | MCP server URL (default: fallback to REST API) |

## Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server |
| `node-fetch` | Figma API requests |
| `dotenv` | Environment variable loading |
| `archiver` | Zip file generation for exports |
| `react`, `react-dom` | React hydration of design system components |
| `rk-designsystem` | Red Cross Design System components |
| `@digdir/designsystemet-react` | Digdir base design system |
| `esbuild` | Bundling React components for browser hydration |

## License

MIT
