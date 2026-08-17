# COLD OPEN Companion

A SillyTavern extension that turns the [COLD OPEN](https://github.com/GrayAegis/cold-open) preset's prompt list into an actual control panel.

COLD OPEN's entry names carry a deliberate grammar — `❮ section ❯`, `░ radio group`, `⋯ option`, `⋯ ✚ additive`, `⋯ ✚✚ dependency`, `▏ ✦ structural`. The Prompt Manager can't act on any of that; it just shows you a hundred checkboxes and trusts you to remember the rules. This extension reads the grammar and enforces it.

## What it does

- **A floating panel.** A draggable clapperboard button sits at the edge of the chat; click it and the panel opens in a movable, fixed-size window. Both remember where you put them. The extensions drawer keeps only a stub — open the panel, reset its position, and the lock switch.
- **The Prompt Manager is locked.** While a COLD OPEN preset is loaded, the native list's toggles, edit, detach and drag-reorder are refused, so the panel stays the single source of truth and nothing can quietly break the grammar. Inspection, scrolling and token counts still work. Unlock it from the panel header or the drawer when you want raw access.
- **Caps enforced from the grammar.** `░ ⑤ Genre Lenses — additive, stack at most TWO` caps itself at two: enable a third and the one you enabled longest ago drops, rather than the click being refused. The number is parsed out of the group's own name, so a future capped group enforces itself with no extension release — COLD OPEN v1.22 added `░ ⑥ Setting — additive, stack at most ONE` and this extension enforced it on day one without a line changing. A live `2/2` chip sits on the header, and flags amber if a preset arrives over its own cap.
- **Your loadout survives an upgrade.** Load a new COLD OPEN version and a banner offers to re-apply everything you had switched on, entry by entry, telling you how many are new here and naming what no longer exists. Identifiers are the join key — COLD OPEN keeps them stable across versions, so the match is exact rather than name-guessing. Structural plumbing and markers are excluded from both sides of that comparison, so the wrappers and reset entries that appear in every version are never counted as new.
- **Hover to see what an entry actually says.** Every row carries a summary built from the entry's own prompt text — its token cost, then the opening of what it instructs the model to do — so you can tell Anti-Echo from Epistemic Bounds without opening the Prompt Manager. Nothing here is hand-written prose that could drift out of date: the `{{addvar}}` plumbing and XML scaffolding are stripped, `{{user}}` and friends are left intact because they are part of what the entry says, and the text is clipped rather than dumped. Locked rows show why they are locked, then their text underneath.
- **Real radio groups.** Picking a Narrator Register, POV, Length, Directive, or CoT style switches its siblings off. No more two Registers fighting each other because the menus were "enforced by convention".
- **Dependencies handled.** Turning on any tracker enables `✚✚ Tracker Grammar` for you.
- **You can see what's currently on.** The active tier and the active de-slop family are highlighted in the toolbar, so you never have to work out which is which by reading a hundred checkboxes. A tier is judged by its Directive and reasoning block — the two things that define it — and if you have hand-edited modules since applying it, it stays marked but gains a dashed border and an asterisk, meaning *this tier, modified*. Clicking it again restores the full load.
- **Tier buttons.** Lean / Standard / Deep set the Directive, the craft load, and the reasoning block in one click. They deliberately leave Systems, your De-slop choice and the Variety Seed alone — enabling everything is the documented way to make a preset worse.
- **Model quick-setup.** One button per family enables the matching `De-slop` module and disables the rest.
- **Live token estimates** per section and overall, using ST's own tokenizer where available.
- **Structural entries are locked** — the XML wrappers, the Lens Reset plumbing, and the empty Post-History Instructions slot that passes your character cards' PHI through. That last one looks useless and isn't; the panel won't let you switch it off.

## Install

Extensions → Install Extension → paste this repo's URL.

The panel appears in the extensions settings drawer. It fills in automatically when a COLD OPEN preset is loaded and says so when one isn't.

## How it's built

Every state change goes through the `/setpromptentry` slash command rather than touching SillyTavern internals — that command clears the token-count cache, re-renders the Prompt Manager, and saves, so the panel and the native UI can never disagree. Reads come from `getContext().chatCompletionSettings`, fetched fresh each time because a cached context goes stale after a chat switch.

The lock is the one place this extension reaches for ST's DOM. It works by refusing events at the capture phase on `#completion_prompt_manager` before ST's own handlers see them — no overlay, no patched functions, no monkeypatching of `PromptManager`. It engages only while a COLD OPEN preset is loaded, so every other preset behaves exactly as it always did, and turning the extension off restores everything. The window drag is hand-rolled for the same reason: ST's `dragElement` lives in `RossAscends-mods.js` and isn't exposed on `getContext()`, and thirty lines of arithmetic beat an import from internals.

Its own state is only UI state — whether the lock is on, and where you dragged the window and launcher — kept in `extensionSettings.coldopen_companion`. Nothing about the preset is stored here; the preset remains the single source of truth. Uninstalling changes nothing about how the preset behaves, and unlocking is always one click away inside the app.

Verified against SillyTavern 1.18.0, whose Prompt Manager markup the lock targets (`.prompt-manager-toggle-action`, `.prompt-manager-edit-action`, `.prompt-manager-detach-action`, `.drag-handle`). If a future ST renames those, the lock quietly stops locking — it fails open, never closed, and the panel keeps working regardless. Requires nothing else.

## Not in this version

Sidecar tracker generation — offloading tracker evaluation to a separate cheap model so the main model spends its whole output budget on prose, and tracker state costs zero context. The plumbing for it (`ConnectionManagerRequestService`, `CHAT_COMPLETION_PROMPT_READY`) is confirmed available; it's the next job.

## License

MIT. See [LICENSE](LICENSE).
