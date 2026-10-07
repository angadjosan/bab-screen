// The styles a freeform <html> answer is drawn with (app/StagePieces.tsx). The frame is sandboxed, so it cannot read
// the page's CSS variables: the brand's values (app/brand.css) are repeated here as literals. The model is told these
// class names (lib/stage/prompt.ts), which is what keeps a page it writes on-brand.

const FONT = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap";

const STYLES = `
:root {
  --ink: #FFFFFF;
  --muted: rgba(255, 255, 255, 0.80);
  --faint: rgba(255, 255, 255, 0.68);
  --line: rgba(255, 255, 255, 0.12);
  --surface: rgba(255, 255, 255, 0.06);
  --gold: #FECB33;
  --up: #30EAC5;
  --down: #FD8173;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; color: var(--ink); font: 400 24px/1.35 Inter, -apple-system, sans-serif; font-variant-numeric: tabular-nums; }
body { padding: 4px; overflow: hidden; }
h1, h2, h3, p, ul, ol { margin: 0; }
h1 { font-size: 48px; font-weight: 600; line-height: 1.1; }
h2 { font-size: 36px; font-weight: 600; line-height: 1.15; }
h3 { font-size: 28px; font-weight: 600; }
p + p, h1 + p, h2 + p, h3 + p { margin-top: 12px; }
svg { display: block; max-width: 100%; }
img { max-width: 100%; display: block; }
.row { display: flex; gap: 24px; align-items: center; }
.col { display: flex; flex-direction: column; gap: 16px; }
.grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; }
.grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; }
.card { background: var(--surface); padding: 28px; }
.stat { font-size: 88px; font-weight: 600; line-height: 1; }
.big { font-size: 40px; font-weight: 500; line-height: 1.2; }
.label { color: var(--faint); font-size: 22px; }
.muted { color: var(--muted); }
.accent { color: var(--gold); }
.up { color: var(--up); }
.down { color: var(--down); }
.tag { display: inline-block; padding: 4px 14px; background: var(--surface); color: var(--muted); font-size: 22px; border-radius: 999px; }
.timeline { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 20px; border-left: 3px solid var(--line); }
.timeline li { padding-left: 24px; position: relative; }
.timeline li::before { content: ""; position: absolute; left: -9px; top: 10px; width: 15px; height: 15px; background: var(--gold); }
table { border-collapse: collapse; width: 100%; }
th { text-align: left; color: var(--faint); font-weight: 400; font-size: 22px; padding: 0 16px 10px 0; }
td { padding: 12px 16px 12px 0; border-top: 1px solid var(--line); }
`;

/** A whole document for the frame: the brand's font and styles, then the model's markup, with nothing that can run. */
export function stageFrameDocument(markup: string): string {
  const safe = markup.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${FONT}"><style>${STYLES}</style></head><body>${safe}</body></html>`;
}
