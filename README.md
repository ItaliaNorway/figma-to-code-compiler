# Figma MCP Compiler

A Figma to HTML/React compiler that mirrors your Figma designs in the browser with manual sync.

## How It Works

1. **Paste Figma URL** → Compiler reads the design via Figma API
2. **Auto Layout → CSS Flexbox** → Direct translation, no AI interpretation
3. **Refresh Button** → Re-syncs with Figma to get latest changes
4. **Browser Mirror** → Like Polipo/Bravo Studio - design reflected in browser

## Usage

```bash
# Start the compiler with your Figma design URL
npm start "https://www.figma.com/design/YOUR_FILE_KEY/Design?node-id=XX-XXXX" 3000

# Or use npm run mcp
npm run mcp "https://www.figma.com/design/..." 3000
```

Then open http://localhost:3000 to see your design.

## Setup

1. Copy `.env.example` to `.env`
2. Add your Figma access token: `FIGMA_ACCESS_TOKEN=your_token_here`
3. Run `npm install`

## Current Features

- ✅ Read Figma design via API
- ✅ Translate Auto Layout to CSS Flexbox
- ✅ Render rectangles with colors
- ✅ Render text with styles
- ✅ Manual refresh button to sync changes
- ✅ No code generation - direct translation

## Next Iteration (Planned)

- 🔜 **Tagging System**: Add tags to Figma elements (e.g., `#input:name`, `#button:submit`)
- 🔜 **Function Binding**: Connect UI elements to backend functions
- 🔜 **Persistent Logic**: Change design in Figma, keep the functions attached
- 🔜 **React/Tailwind Output**: Generate production-ready code

## Files

- `mcp-compiler.js` - Main compiler
- `mcp-client.js` - Figma API client
- `src/token-mapper.js` - Design tokens (for future RK Design System)
- `src/structure-first-renderer.js` - React/Tailwind renderer (for future use)

## Architecture

```
Figma Design
     ↓
Figma API (via mcp-client.js)
     ↓
mcp-compiler.js (translates Auto Layout → CSS)
     ↓
Browser Preview (localhost:3000)
     ↓
[Refresh Button] → Re-fetch from Figma
```

## License

MIT
