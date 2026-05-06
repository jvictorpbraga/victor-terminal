# Claude Terminal — Design + Tauri Research

## Section A — Visual references and metallic CSS

**Production references:**
- **Linear** — flat charcoal `#08090A` base + a single huge soft radial highlight from the top-center; the "metal" is actually atmospheric noise + 1px inner border (`box-shadow: inset 0 0 0 1px rgba(255,255,255,.04)`).
- **Vercel dashboard** — pure neutral grayscale, very low-saturation; uses `radial-gradient` ellipses (~120% wide, ~80% tall) to fake a brushed-aluminum sheen without animation.
- **Warp Terminal** — dark base + low-opacity conic gradient pinned to corners + heavy SVG grain overlay (multiply blend) — that grain is what reads as "metal" rather than gradients alone.
- **Cursor** — top-down vertical gradient (`#0F1014` → `#16181F`) plus a faint diagonal sheen from upper-left; subtle and full-coverage, never a hard line.
- **Raycast** — stacked radials (cyan + violet at very low alpha) on a near-black base, blurred by the tone itself, no `backdrop-filter` needed.

**Recipe 1 — distributed metallic sheen (recommended for `#14151c`):**
```css
.app{
  background:
    radial-gradient(120% 80% at 50% -10%, rgba(255,255,255,.045), transparent 60%),
    radial-gradient(90% 60% at 100% 110%, rgba(120,150,200,.05), transparent 65%),
    linear-gradient(180deg, #16171f 0%, #14151c 45%, #111219 100%);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.03);
}
```

**Recipe 2 — diagonal brushed-metal (Cursor-style):**
```css
.app{
  background:
    linear-gradient(135deg, rgba(255,255,255,.035) 0%, transparent 35%, transparent 65%, rgba(255,255,255,.02) 100%),
    linear-gradient(180deg, #15161e, #131420);
}
```

**Recipe 3 — grain overlay (the secret of Warp/Linear):**
```css
.app::after{
  content:""; position:fixed; inset:0; pointer-events:none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.5'/></svg>");
  mix-blend-mode: overlay; opacity:.06;
}
```

`backdrop-filter` is **not** needed here (no translucent surfaces). `mix-blend-mode: overlay` on the grain layer is the highest-leverage trick. `box-shadow: inset` adds the 1px metal rim Linear/Vercel use. Avoid animating the gradient — premium = static.

## Section B — Premium monospace fonts

1. **Geist Mono** (top pick) — Vercel's font; geometric, no ligatures, perfectly neutral, free, OFL.
   ```css
   @import url('https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&display=swap');
   font-family:'Geist Mono', ui-monospace, monospace;
   font-feature-settings:"ss01","ss02","cv11";
   font-weight:450; letter-spacing:-.005em;
   ```
2. **Commit Mono** — engineered to "disappear", calmest reading experience; via Google Fonts.
   ```css
   @import url('https://fonts.googleapis.com/css2?family=Commit+Mono:wght@400;700&display=swap');
   font-family:'Commit Mono', ui-monospace, monospace;
   font-feature-settings:"calt","liga";
   ```
3. **JetBrains Mono** — most refined free option with 138 ligatures if you want them.
   ```css
   @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap');
   font-feature-settings:"calt","ss19";
   ```

Skip: Berkeley Mono (paid), Cascadia (Windows-feel), Fira Code (overused), Spline Sans Mono (less polished).

## Section C — Tauri 2 drag region + buttons (definitive)

**Verified from Tauri v2 docs and issue #9901:** in v2, `data-tauri-drag-region` only applies to the element it's set on; child elements **do not** inherit the drag and `data-tauri-drag-region="false"` is **not** a documented opt-out — there is no boolean negation in v2.

**Correct pattern — siblings, not nested:**
```tsx
<header className="titlebar">
  <div className="titlebar-drag" data-tauri-drag-region>
    <span className="titlebar-title">claude-terminal</span>
  </div>
  <div className="titlebar-controls">
    <button onClick={minimize}>—</button>
    <button onClick={maximize}>▢</button>
    <button onClick={close}>×</button>
  </div>
</header>
```
```css
.titlebar{display:flex;align-items:center;height:36px}
.titlebar-drag{flex:1;height:100%;display:flex;align-items:center;padding:0 12px}
.titlebar-title{pointer-events:none;user-select:none}  /* text must not eat drags */
.titlebar-controls button{-webkit-app-region:no-drag}  /* harmless extra safety */
```

**Critical rules:**
1. Drag region and buttons are **siblings**. Never wrap buttons inside `data-tauri-drag-region`.
2. Any text/icon inside the drag div needs `pointer-events:none` so the drag hit-test reaches the drag div itself (this is the WebView2 quirk that breaks empty-area dragging).
3. If you must keep buttons inside the drag container, attach a manual handler: `onMouseDown={(e)=>{ if(e.buttons===1) getCurrentWindow().startDragging(); }}` on the wrapper, and `e.stopPropagation()` on each button. Prefer the sibling pattern.

Sources: [Tauri Window Customization](https://v2.tauri.app/learn/window-customization/), [Issue #9901](https://github.com/tauri-apps/tauri/issues/9901), [Issue #9751](https://github.com/tauri-apps/tauri/issues/9751), [Ellie's drag-event notes](https://ellie.wtf/notes/drag-event-issues-in-Tauri).
