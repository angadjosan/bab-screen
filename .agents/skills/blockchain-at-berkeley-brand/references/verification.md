# B@B Design Verification — adversarial visual QA

A short, capability-gated loop: **render the page, have a fresh subagent tear it
apart against the B@B identity, fix what's real, re-check once.** It exists
because this brand's failure mode ("generic dark SaaS") is easy to ship and hard
to see in your own work — a cold, adversarial second pair of eyes catches it.

This is optional polish, not a required step. Run it only when it's cheap and
non-invasive (see the gate). When you can't, do the self-audit in §4 instead and
say so.

---

## 1. When to run it (capability gate — check before doing anything)

Run the loop **only if all of these hold**:

1. **You can spawn a subagent** (a Task/Agent tool is available). No subagent →
   skip to §4 self-audit; do not fake a "critic" in your own head and call it QA.
2. **A rendering path exists** (a browser MCP is connected, or CLI + a headless
   browser you can reach — see §2). No render path → §4.
3. **Verifying is non-invasive.** You are in a dev/CI context where opening a
   browser or serving a static file is expected. Don't do it if it would disrupt
   the user's session.

**Never, to enable verification:**
- Install global packages, browser binaries, or system deps **without explicit
  user consent.** `npx playwright install` downloads ~hundreds of MB of browsers —
  ask first, every time.
- Start long-lived servers, change ports the user is using, or leave processes
  running. Tear down anything you start.
- Touch anything outside the project you're building.

If verification would require any of the above and the user hasn't okayed it,
**skip it** and fall back to §4. Shared skill, many environments — default to not
touching people's machines.

---

## 2. Pick a rendering path (most preferred first)

Detect, don't assume. Use the **first** option actually available:

1. **An already-connected browser MCP** — e.g. Chrome DevTools MCP, a Playwright/
   Puppeteer MCP, Browserbase, or similar. This is the least invasive because the
   user already set it up. Use its navigate + screenshot (+ console/network if
   present) tools directly.
2. **Playwright, already installed** in the project (`node_modules/.bin/playwright`,
   a `playwright` dep, or a global bin). Drive it headlessly for screenshots. Only
   run `playwright install` with consent.
3. **Puppeteer, already installed** — same idea.
4. **A headless Chrome/Chromium/Edge already on the machine** — e.g.
   `chrome --headless=new --screenshot=out.png --window-size=1440,900 <url>`. Use
   whatever binary exists; don't install one.
5. **Nothing renderable** → §4 self-audit, and tell the user you couldn't render
   so they can eyeball it themselves.

Serve static builds over a throwaway local server on an unused port (or open the
`file://` URL if the browser tool allows it), and shut it down when done.

Screenshot at least **two viewports**: desktop (~1440×900) and mobile (~390×844).
Add a wide 4K check only if the layout is fluid/edge-anchored. Capture full-page
where the tool supports it.

---

## 3. The loop (bounded — do not grind)

**Budget: 1 critique pass, then at most 1 re-verify after fixes. Hard stop at 2
render+critique rounds.** These are students' / an org's tokens — a tight loop
that catches the top 3 problems beats an exhaustive one.

1. **Render** the target at the two viewports (§2).
2. **Spawn one adversarial critic subagent** (§3.1). Give it the screenshots, the
   brand checklist, and the failure-mode list. One critic, not a panel.
3. **Triage its findings.** Fix the ones that are real identity/taste/UX breaks.
   Explicitly discard nitpicks and anything that would fight the brand (the critic
   can be wrong — e.g. "add rounded corners," "use more color": reject those).
4. **Re-render and re-critique once** to confirm the fixes landed and introduced
   nothing new. If it's clean or only cosmetic quibbles remain, **stop.**
5. If round 2 still shows a *structural* problem, don't loop a third time — fix
   the obvious thing, then **hand back to the user** with a note on what's still
   soft. Looping further wastes tokens on diminishing returns.

### 3.1 Adversarial critic prompt (template)

Spawn a fresh subagent (it should start cold — no attachment to the design).
Give it the rendered screenshots and paste this:

> You are a ruthless design critic reviewing a webpage built in the Blockchain at
> Berkeley (B@B) brand. Your job is to find what's **wrong**, not to praise. Be
> specific and cite the region of the screenshot. Assume the author is too close
> to it to see the flaws.
>
> **The B@B identity (what "correct" means):**
> - Near-black `#0C0C0C` canvas, pure-white text, hairline `#2A2A2A` ledger rules
>   framing/dividing content.
> - One oversized EB Garamond line per view, sentence case, ultra-tight leading.
> - Instrument Sans body; DM Mono / IBM Plex Mono uppercase labels at ~50% white.
> - **Every typeface tracked −0.03em.** Square (0-radius) corners. Signature
>   spacing 69 / 46 / 31.
> - Gold (`#FECB33`) is rare — logo, nav "Apply", a glint, one live number.
>   **The primary button is white, not gold.** ≤3 gold spots per viewport.
> - Imagery is dithered/ASCII/halftone monochrome; ambient transaction-hash
>   texture is welcome. Trailing `→` on primary actions.
>
> **Hunt specifically for these B@B failure modes:**
> 1. Reads like generic dark SaaS / a crypto template — no editorial ledger feel.
> 2. Gold overused, gold button fills, gold gradients, or gold body text.
> 3. Rounded corners, drop shadows, glows, gradient fills, full-color photos.
> 4. Tracking not tightened; Garamond too small/timid, or set in ALL CAPS; leading
>    too loose; more than one giant display line competing per view.
> 5. Weak hierarchy, muddy contrast (esp. gold or 50%-white text too small), or
>    the hairline grid missing/inconsistent.
> 6. Broken responsive layout, horizontal scroll, overflows, tap targets too small.
> 7. Generic UX problems: unclear primary action, cramped or unbalanced spacing,
>    orphaned/awkward line breaks, misaligned baselines.
>
> Return a ranked list, worst first. For each: **[CONFIRMED | NITPICK]**, the
> exact location, why it breaks the brand or good taste, and a concrete fix. If
> something is genuinely excellent, note it in one line at the end — but lead with
> the problems. Do **not** suggest changes that fight the identity above (e.g.
> more color, rounder corners, bigger drop shadows); flag those as off-brand.

Tell the critic to return **text only** (a findings list) — it isn't editing
files. Keep its scope to the screenshots you give it.

---

## 4. Fallback: static self-audit (no render / no subagent)

If the gate fails, walk the built markup/styles yourself against the
**SKILL.md build checklist** and this file's failure-mode list. Concretely verify:
canvas hex, universal −0.03em tracking, 0-radius corners, hairline rules present,
exactly one big Garamond line, mono labels uppercase at ~50%, primary button
white (not gold), gold used in ≤3 real-signal spots, no full-color imagery. Then
tell the user you audited statically and recommend they eyeball it in a browser,
since you couldn't render it here.

---

## 5. Token discipline (why the limits)

- **One** critic subagent per round, not several.
- **Two** viewports unless the layout demands a third.
- **≤2** render+critique rounds, then hand back.
- Prefer a server/preview that's already running; don't spin up more than needed.
- Fix the top few real issues, not every quibble — re-verifying is the expensive
  part.
