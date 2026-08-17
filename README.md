# COLD OPEN Companion

A SillyTavern extension that turns the [COLD OPEN](https://github.com/GrayAegis/cold-open) preset's prompt list into an actual control panel.

COLD OPEN's entry names carry a deliberate grammar — `❮ section ❯`, `░ radio group`, `⋯ option`, `⋯ ✚ additive`, `⋯ ✚✚ dependency`, `▏ ✦ structural`. The Prompt Manager can't act on any of that; it just shows you a hundred checkboxes and trusts you to remember the rules. This extension reads the grammar and enforces it.

## What it does

- **Real radio groups.** Picking a Narrator Register, POV, Length, Directive, or CoT style switches its siblings off. No more two Registers fighting each other because the menus were "enforced by convention".
- **Dependencies handled.** Turning on any tracker enables `✚✚ Tracker Grammar` for you.
- **Tier buttons.** Lean / Standard / Deep set the Directive, the craft load, and the reasoning block in one click. They deliberately leave Systems and your De-slop choice alone — enabling everything is the documented way to make a preset worse.
- **Model quick-setup.** One button per family enables the matching `De-slop` module and disables the rest.
- **Live token estimates** per section and overall, using ST's own tokenizer where available.
- **Structural entries are locked** — the XML wrappers, the Lens Reset plumbing, and the empty Post-History Instructions slot that passes your character cards' PHI through. That last one looks useless and isn't; the panel won't let you switch it off.

## Install

Extensions → Install Extension → paste this repo's URL.

The panel appears in the extensions settings drawer. It fills in automatically when a COLD OPEN preset is loaded and says so when one isn't.

## How it's built

Every state change goes through the `/setpromptentry` slash command rather than touching SillyTavern internals — that command clears the token-count cache, re-renders the Prompt Manager, and saves, so the panel and the native UI can never disagree. Reads come from `getContext().chatCompletionSettings`, fetched fresh each time because a cached context goes stale after a chat switch.

No state of its own beyond a version stamp: the preset remains the single source of truth, and the extension is pure convenience. Uninstalling it changes nothing about how the preset behaves.

Verified against SillyTavern 1.18.0. Requires nothing else.

## Not in this version

Sidecar tracker generation — offloading tracker evaluation to a separate cheap model so the main model spends its whole output budget on prose, and tracker state costs zero context. The plumbing for it (`ConnectionManagerRequestService`, `CHAT_COMPLETION_PROMPT_READY`) is confirmed available; it's a v0.2 job.
