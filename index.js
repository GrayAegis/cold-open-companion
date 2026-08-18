/**
 * COLD OPEN Companion — a control panel for the COLD OPEN preset.
 *
 * Reads the preset's naming grammar (❮ section ❯ / ░ radio group / ⋯ child /
 * ⋯ ✚ additive / ⋯ ✚✚ dependency / ▏ ✦ structural) and renders it as a real UI.
 *
 * All state changes go through the /setpromptentry slash command, which is the
 * public API: it clears the token-count cache, re-renders the Prompt Manager,
 * and saves — so this extension never touches ST internals.
 */

const KEY = 'coldopen_companion';
const PANEL = 'coldopen_panel';

/** Always fetch fresh — cached context goes stale after a chat switch. */
const ctx = () => SillyTavern.getContext();

// ─────────────────────────────────────────────────────────── model

function classify(rawName) {
    const n = (rawName || '').trim();
    if (n.startsWith('❮')) return 'section';
    if (n.startsWith('░')) return 'group';
    if (n.startsWith('⋯')) {
        if (/^⋯\s*✚\s*✚/.test(n)) return 'depend';
        if (/^⋯\s*✚/.test(n)) return 'additive';
        return 'radio';
    }
    if (n.startsWith('▏') || n.startsWith('✦')) return 'structural';
    return 'other';
}

/** Strip the sigils for display. */
function label(rawName) {
    return (rawName || '')
        .replace(/^[❮░⋯▏✦\s]+/, '')
        .replace(/[❯\s]+$/, '')
        .replace(/^✚+\s*/, '')
        .replace(/^✦\s*/, '')
        .trim() || rawName;
}

/**
 * Build the section → group → entry tree from the live preset.
 * Returns null when the loaded preset isn't COLD OPEN-shaped.
 */
function buildModel() {
    const c = ctx();
    const settings = c.chatCompletionSettings;
    if (!settings || !Array.isArray(settings.prompts) || !Array.isArray(settings.prompt_order)) return null;

    // Chat Completion always reads the dummy character block.
    const block = settings.prompt_order.find(b => b.character_id === 100001) || settings.prompt_order[0];
    if (!block || !Array.isArray(block.order)) return null;

    const byId = new Map(settings.prompts.map(p => [p.identifier, p]));
    const sections = [];
    let section = null;
    let group = null;
    let sigilCount = 0;

    for (const entry of block.order) {
        const prompt = byId.get(entry.identifier);
        if (!prompt) continue;
        const kind = classify(prompt.name);
        if (kind !== 'other') sigilCount++;

        if (kind === 'section') {
            section = { name: label(prompt.name), raw: prompt.name, groups: [], loose: [] };
            sections.push(section);
            group = null;
            continue;
        }
        if (!section) {
            section = { name: 'Ungrouped', raw: '', groups: [], loose: [] };
            sections.push(section);
        }
        if (kind === 'group') {
            group = { name: label(prompt.name), raw: prompt.name, entries: [] };
            section.groups.push(group);
            continue;
        }

        const item = {
            id: entry.identifier,
            enabled: !!entry.enabled,
            kind,
            name: label(prompt.name),
            raw: prompt.name,
            content: prompt.content || '',
            marker: !!prompt.marker,
        };
        (group ? group.entries : section.loose).push(item);
    }

    // Heuristic: a real COLD OPEN preset is dense with sigils.
    if (sigilCount < 8) return null;
    return sections;
}

function allEntries(model) {
    const out = [];
    for (const s of model) {
        out.push(...s.loose);
        for (const g of s.groups) out.push(...g.entries);
    }
    return out;
}

// ─────────────────────────────────────────────────────────── writes

/** Apply {id: desiredEnabled} via /setpromptentry, skipping no-ops. */
async function applyChanges(changes) {
    const model = buildModel();
    if (!model) return;
    const current = new Map(allEntries(model).map(e => [e.id, e.enabled]));
    const c = ctx();
    let applied = 0;

    for (const [id, want] of Object.entries(changes)) {
        if (current.get(id) === want) continue;      // no-op: don't force a re-render
        const cmd = `/setpromptentry identifier=${id} ${want ? 'on' : 'off'}`;
        try {
            await c.executeSlashCommandsWithOptions(cmd, { handleExecutionErrors: true });
            applied++;
        } catch (err) {
            console.error('[COLD OPEN] failed to toggle', id, err);
        }
    }
    if (applied) {
        syncPanel();
        const fresh = buildModel();
        const prev = settings().loadout;
        if (fresh && (!prev || prev.preset === presetName())) snapshotLoadout(fresh);
    }
    return applied;
}

/** Enabling a radio child disables its siblings. */
function radioChanges(group, chosenId) {
    const changes = {};
    for (const e of group.entries) {
        if (e.kind !== 'radio') continue;            // ✚ modules in a radio group stay additive
        changes[e.id] = e.id === chosenId;
    }
    return changes;
}

// ─────────────────────────────────────────────────────────── group caps

const CAP_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

/**
 * The cap is written into the grammar, not into this file: a group named
 * `░ ⑤ Genre Lenses — additive, stack at most TWO` caps at two. Parse it, and
 * any future capped group enforces itself without an extension release.
 */
function groupCap(group) {
    const m = /at most\s+(one|two|three|four|five|six|\d+)/i.exec(group?.raw || '');
    if (!m) return null;
    const word = m[1].toLowerCase();
    return CAP_WORDS[word] ?? (parseInt(word, 10) || null);
}

/** Additives currently on in a capped group. */
function capEnabled(group) {
    return group.entries.filter(e => e.kind === 'additive' && e.enabled);
}

/**
 * A cap only means anything where it can actually bind — on a group with two
 * or more additives competing for the slots. `░ ⑫ Reasoning — at most ONE`
 * holds two radios and a single additive: there the phrase describes the radio
 * choice, which radio behaviour already enforces, and a chip counting only
 * additives would read 0/1 while a CoT is plainly selected.
 */
function capBinds(group) {
    return !!groupCap(group)
        && group.entries.filter(e => e.kind === 'additive').length > 1;
}

/**
 * Enabling past the cap evicts the *least recently enabled* member rather than
 * refusing the click — picking a third lens should give you the third lens.
 * Recency is remembered per group so the eviction order survives a reload.
 */
function capChanges(group, changedId) {
    const cap = groupCap(group);
    if (!cap) return {};

    const s = settings();
    const stacks = (s.stack ??= {});
    const key = group.raw || group.name;

    const order = (stacks[key] ?? []).filter(id => id !== changedId);
    order.push(changedId);                                  // newest last

    const live = group.entries
        .filter(e => e.kind === 'additive' && (e.id === changedId || e.enabled))
        .map(e => e.id);

    // Anything with no recorded history ranks oldest, so it goes first.
    const byAge = [...live].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const evict = byAge.slice(0, Math.max(0, byAge.length - cap));

    stacks[key] = order.filter(id => !evict.includes(id));
    save();

    return Object.fromEntries(evict.map(id => [id, false]));
}

/** Turning on any additive in a section with a ✚✚ entry also turns that on. */
function dependencyChanges(model, changedId, wantEnabled) {
    const changes = {};
    if (!wantEnabled) return changes;
    for (const s of model) {
        for (const g of s.groups) {
            const has = g.entries.some(e => e.id === changedId && e.kind === 'additive');
            if (!has) continue;
            for (const dep of g.entries.filter(e => e.kind === 'depend' && !e.enabled)) {
                changes[dep.id] = true;
            }
        }
    }
    return changes;
}

// ─────────────────────────────────────────────────────────── tiers

/**
 * Tiers set the Directive, the craft load, and the reasoning block only.
 * Systems (trackers, VTK) and the model de-slop module are deliberately left
 * alone — enabling everything is the documented way to make a preset worse.
 */
const TIERS = {
    Lean: { directive: /Directive\s*—\s*Lean/i, cot: null,
        craft: [/Anti-Echo/i, /Epistemic Bounds/i, /Agency Line/i] },
    Standard: { directive: /Directive\s*—\s*Standard/i, cot: /CoT\s*—\s*Lean/i,
        craft: [/Anti-Echo/i, /Epistemic Bounds/i, /Agency Line/i, /Specificity/i,
            /Sentence Rhythm/i, /Off-Screen World/i, /No Free Respect/i, /OOC Channel/i] },
    Deep: { directive: /Directive\s*—\s*Deep/i, cot: /CoT\s*—\s*Deep/i,
        craft: [/Anti-Echo/i, /Epistemic Bounds/i, /Agency Line/i, /Specificity/i,
            /Sentence Rhythm/i, /Off-Screen World/i, /No Free Respect/i, /OOC Channel/i,
            /Ban List/i, /Dialogue Craft/i, /Minor NPCs/i, /NPC Initiative/i, /The World Can Win/i] },
};

/**
 * Modules a tier must never touch. De-slop encodes which model you are running;
 * Variety Seed encodes whether you want the randomiser. Neither is a statement
 * about how deep the prose should go, so Lean/Standard/Deep leave both alone.
 */
const TIER_EXEMPT = /De-slop|Variety Seed/i;

function tierChanges(model, tierName) {
    const tier = TIERS[tierName];
    const changes = {};
    for (const e of allEntries(model)) {
        if (/Directive\s*—/i.test(e.raw)) changes[e.id] = tier.directive.test(e.raw);
        else if (/CoT\s*—/i.test(e.raw)) changes[e.id] = !!tier.cot && tier.cot.test(e.raw);
        else if (e.kind === 'additive' && TIER_EXEMPT.test(e.raw)) continue;  // taste, not depth
        else if (e.kind === 'additive' && tier.craft.some(rx => rx.test(e.raw))) changes[e.id] = true;
        else if (e.kind === 'additive' && isCraftModule(model, e.id)) changes[e.id] = false;
    }
    return changes;
}

/** True when the entry lives in the Craft group (so tiers don't touch Systems). */
function isCraftModule(model, id) {
    for (const s of model) {
        for (const g of s.groups) {
            if (!/craft/i.test(g.name)) continue;
            if (g.entries.some(e => e.id === id)) return true;
        }
    }
    return false;
}

/**
 * A tier is "on" when its Directive and its reasoning block are the ones
 * selected — those two define it. The craft load is compared separately so a
 * tier you have since tweaked reads as active-but-modified rather than off.
 */
function activeTier(model) {
    const entries = allEntries(model);
    const cots = entries.filter(e => /CoT\s*—/i.test(e.raw));
    for (const [name, tier] of Object.entries(TIERS)) {
        const dir = entries.find(e => /Directive\s*—/i.test(e.raw) && tier.directive.test(e.raw));
        if (!dir?.enabled) continue;
        const cotOk = tier.cot
            ? cots.some(e => e.enabled && tier.cot.test(e.raw))
            : !cots.some(e => e.enabled);
        if (cotOk) return name;
    }
    return null;
}

/** True when nothing has drifted since the tier was applied. */
function tierIsClean(model, name) {
    const current = new Map(allEntries(model).map(e => [e.id, e.enabled]));
    return Object.entries(tierChanges(model, name))
        .every(([id, want]) => current.get(id) === want);
}

function activeModels(model) {
    const out = [];
    for (const e of allEntries(model)) {
        const m = /De-slop:\s*(\w+)/i.exec(e.raw);
        if (m && e.enabled) out.push(m[1]);
    }
    return out;
}

const MODELS = ['DeepSeek', 'GLM', 'Kimi', 'Claude', 'Gemini', 'GPT'];

function deslopChanges(model, family) {
    const changes = {};
    for (const e of allEntries(model)) {
        const m = /De-slop:\s*(\w+)/i.exec(e.raw);
        if (m) changes[e.id] = m[1].toLowerCase() === family.toLowerCase();
    }
    return changes;
}

// ─────────────────────────────────────────────────────────── tokens

async function estimate(text) {
    if (!text) return 0;
    try {
        const n = await ctx().getTokenCountAsync(text);
        if (Number.isFinite(n)) return n;
    } catch { /* fall through to the cheap estimate */ }
    return Math.round(text.replace(/\{\{\/\/[\s\S]*?\}\}/g, '').length / 4);
}

async function refreshCounts(model) {
    let total = 0;
    for (const s of model) {
        let sectionTotal = 0;
        const items = [...s.loose, ...s.groups.flatMap(g => g.entries)];
        for (const e of items) {
            if (!e.enabled || e.marker) continue;
            sectionTotal += await estimate(e.content);
        }
        total += sectionTotal;
        const el = document.querySelector(`[data-co-section-count="${CSS.escape(s.name)}"]`);
        if (el) el.textContent = sectionTotal ? `≈${sectionTotal}` : '';
    }
    const totalEl = document.getElementById('coldopen_total');
    if (totalEl) totalEl.textContent = `≈${total} tokens enabled`;
}

/** Show which tier and which model family are actually live right now. */
function refreshToolbar(model) {
    const tier = activeTier(model);
    const clean = tier ? tierIsClean(model, tier) : false;

    for (const b of document.querySelectorAll('[data-co-tier]')) {
        const on = b.dataset.coTier === tier;
        b.classList.toggle('coldopen-btn-on', on);
        b.classList.toggle('coldopen-btn-drifted', on && !clean);
        b.title = on
            ? (clean
                ? `Currently active.\n\n${b.dataset.coBase}`
                : `Currently active, but modules have changed since you applied it — click to restore the full ${b.dataset.coTier} load.\n\n${b.dataset.coBase}`)
            : b.dataset.coBase;
    }

    const families = activeModels(model);
    for (const b of document.querySelectorAll('[data-co-model]')) {
        const on = families.includes(b.dataset.coModel);
        b.classList.toggle('coldopen-btn-on', on);
        b.title = on ? `Currently active.\n\n${b.dataset.coBase}` : b.dataset.coBase;
    }
}

/** Live "2/2" chips on capped groups, flagged when the preset arrives over cap. */
function refreshCaps(model) {
    for (const group of model.flatMap(s => s.groups)) {
        if (!capBinds(group)) continue;
        const cap = groupCap(group);
        const chip = document.querySelector(`[data-co-cap="${CSS.escape(group.raw || group.name)}"]`);
        if (!chip) continue;
        const on = capEnabled(group).length;
        chip.textContent = `${on}/${cap}`;
        chip.classList.toggle('coldopen-cap-over', on > cap);
        chip.title = on > cap
            ? `${on} enabled, ${cap} allowed. Turn one off, or enable another and the oldest drops.`
            : `Stack at most ${cap}. Enabling one more drops whichever you enabled longest ago.`;
    }
}

// ─────────────────────────────────────────────────────────── UI

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

/**
 * Which section drawers you left open. ST's `.inline-drawer-content` is
 * display:none by default, so a rebuilt panel collapses everything unless we
 * put it back — and a rebuild happens on every toggle.
 */
const openSections = new Set();

// ─────────────────────────────────────────────────────────── loadout carry

const presetName = () => ctx().chatCompletionSettings?.preset_settings_openai || '';

/**
 * Snapshot what you have switched on, keyed by identifier. Identifiers survive
 * COLD OPEN version bumps intact — v1.20 → v1.21 renamed nothing and removed
 * nothing — so they are the stable join key across an upgrade. Names are kept
 * only so the diff can name what vanished.
 */
function snapshotLoadout(model) {
    const s = settings();
    s.loadout = {
        preset: presetName(),
        entries: Object.fromEntries(allEntries(model)
            .filter(e => e.kind !== 'structural' && !e.marker)
            .map(e => [e.id, { on: e.enabled, name: e.name }])),
    };
    save();
}

/**
 * What a previous preset's loadout would change here. Null when there is
 * nothing to offer — same preset, no overlap, or your selections already match.
 */
function pendingCarry(model) {
    const prev = settings().loadout;
    if (!prev?.entries || prev.preset === presetName()) return null;

    const all = new Map(allEntries(model).map(e => [e.id, e]));

    // Must use the same filter snapshotLoadout does. Structural plumbing and
    // markers are never snapshotted, so comparing them against the snapshot
    // reports every wrapper and reset entry as "new" on every upgrade.
    const toggleable = new Map([...all].filter(([, e]) => e.kind !== 'structural' && !e.marker));

    const shared = Object.keys(prev.entries).filter(id => toggleable.has(id));
    if (!shared.length) return null;

    const differing = shared.filter(id => toggleable.get(id).enabled !== prev.entries[id].on);
    if (!differing.length) return null;

    return {
        from: prev.preset,
        differing,
        added: [...toggleable.keys()].filter(id => !(id in prev.entries)),
        // `all`, not `toggleable`: an entry that became structural still exists.
        gone: Object.keys(prev.entries).filter(id => !all.has(id))
            .map(id => prev.entries[id].name),
    };
}

/** Stop offering the carry without applying it: adopt what is loaded now. */
function dismissCarry(model) {
    snapshotLoadout(model);
    renderPanel();
}

/**
 * Identity of the panel's *shape* — sections, groups, entry ids. Enabled
 * flags are deliberately excluded: flipping a switch must not count as a
 * structural change, or we'd rebuild for the very thing sync handles.
 */
function signature(model) {
    return model
        .map(s => `${s.name}[${s.groups.map(g => g.name).join('~')}]:` +
            [...s.loose, ...s.groups.flatMap(g => g.entries)].map(e => e.id).join(','))
        .join('|');
}

let lastSignature = null;

/**
 * Update checkboxes and counts in place. No DOM teardown, so open drawers stay
 * open, scroll position holds, and nothing flickers. Falls back to a full
 * render when the preset's shape actually changed.
 */
function syncPanel() {
    const host = document.getElementById(PANEL);
    if (!host) return;
    const model = buildModel();
    if (!model || signature(model) !== lastSignature) return renderPanel();

    refreshCaps(model);
    refreshToolbar(model);

    const byId = new Map(allEntries(model).map(e => [e.id, e]));
    for (const box of host.querySelectorAll('input[data-co-id]')) {
        const entry = byId.get(box.dataset.coId);
        if (entry) box.checked = entry.enabled;
    }
    refreshCounts(model);
}

function renderPanel() {
    const host = document.getElementById(PANEL);
    if (!host) return;

    const scroller = host.closest('.coldopen-window-body');
    const scrollTop = scroller ? scroller.scrollTop : 0;
    host.innerHTML = '';

    const model = buildModel();
    if (!model) {
        lastSignature = null;
        host.append(el('div', 'coldopen-empty',
            'No COLD OPEN preset detected. Load one in AI Response Configuration and this panel fills in.'));
        return;
    }
    lastSignature = signature(model);
    if (scroller) requestAnimationFrame(() => { scroller.scrollTop = scrollTop; });

    if (!settings().loadout) snapshotLoadout(model);
    const carry = pendingCarry(model);
    if (carry) host.append(renderCarry(carry, model));

    const board = renderBoard();
    if (board) host.append(board);

    // toolbar
    const bar = el('div', 'coldopen-bar');
    bar.append(el('span', 'coldopen-bar-label', 'Tier'));
    for (const name of Object.keys(TIERS)) {
        const b = el('button', 'menu_button coldopen-btn', name);
        b.dataset.coTier = name;
        b.dataset.coBase = `Set the Directive, craft modules and reasoning for ${name}. Systems, De-slop and Variety Seed are left as you have them.`;
        b.title = b.dataset.coBase;
        b.addEventListener('click', () => applyChanges(tierChanges(buildModel(), name)));
        bar.append(b);
    }
    bar.append(el('span', 'coldopen-bar-label', 'Model'));
    for (const m of MODELS) {
        const b = el('button', 'menu_button coldopen-btn coldopen-btn-sm', m);
        b.dataset.coModel = m;
        b.dataset.coBase = `Enable De-slop: ${m} and disable the other families.`;
        b.title = b.dataset.coBase;
        b.addEventListener('click', () => applyChanges(deslopChanges(buildModel(), m)));
        bar.append(b);
    }
    host.append(bar);

    const total = el('div', 'coldopen-total');
    total.id = 'coldopen_total';
    host.append(total);

    for (const section of model) {
        if (!section.groups.length && !section.loose.some(e => !e.marker)) continue;

        const drawer = el('div', 'inline-drawer coldopen-section');
        const head = el('div', 'inline-drawer-toggle inline-drawer-header');
        head.append(el('b', null, section.name));
        const count = el('small', 'coldopen-count');
        count.setAttribute('data-co-section-count', section.name);
        head.append(count);
        const icon = el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down');
        head.append(icon);
        drawer.append(head);

        const body = el('div', 'inline-drawer-content');

        // ST's delegated handler does the animating; we only remember the outcome.
        const name = section.name;
        head.addEventListener('click', () => {
            if (openSections.has(name)) openSections.delete(name);
            else openSections.add(name);
            settings().open = [...openSections];
            save();
        });

        if (openSections.has(name)) {
            body.style.display = 'block';
            icon.className = 'inline-drawer-icon fa-solid fa-circle-chevron-up up';
        }

        for (const item of section.loose) body.append(renderEntry(item, null, model));
        for (const group of section.groups) {
            const gEl = el('div', 'coldopen-group');
            const gh = el('div', 'coldopen-group-head');
            gh.append(el('span', 'coldopen-group-name', group.name));

            if (capBinds(group)) {
                const chip = el('small', 'coldopen-cap');
                chip.setAttribute('data-co-cap', group.raw || group.name);
                gh.append(chip);
            } else if (group.entries.some(e => e.kind === 'radio')) {
                gh.append(el('small', 'coldopen-hint', 'pick one'));
            }
            gEl.append(gh);
            for (const item of group.entries) gEl.append(renderEntry(item, group, model));
            body.append(gEl);
        }

        drawer.append(body);
        host.append(drawer);
    }

    // Marking which tier and model are live must not wait on the tokenizer —
    // refreshCounts awaits an estimate per entry and lands a beat later.
    refreshCaps(model);
    refreshToolbar(model);
    refreshCounts(model);
}


// ─────────────────────────────────────────────────────────── tracker board

/**
 * Read-only view of what the trackers currently hold, rebuilt from the chat
 * rather than from the preset. Splitting on "|" instead of matching a shape
 * means every malformed line the renders defend against still parses here:
 * a missing closing bracket, a merged field, "trust 6" written into a value.
 */
const TRACKER = /\[(BOND|PLOT|SCENE|STATE)\|([^\]\r\n]*)\]?/g;
const STATUS = /simmering|moving|cresting/i;

const firstInt = v => {
    const m = /-?\d+/.exec(v ?? '');
    return m ? parseInt(m[0], 10) : null;
};

function parseTrackers(text) {
    const out = [];
    for (const m of String(text || '').matchAll(TRACKER)) {
        out.push({ tag: m[1], fields: m[2].split('|').map(x => x.trim()) });
    }
    return out;
}

const BOND_AXES = ['trust', 'respect', 'friction', 'attraction'];

/** Walk the chat oldest-first so the last write per entity wins. */
function readBoard() {
    const chat = ctx().chat;
    if (!Array.isArray(chat)) return null;

    const bonds = new Map();
    const threads = new Map();
    let replies = 0;

    for (const msg of chat) {
        if (!msg || msg.is_user || msg.is_system) continue;
        const lines = parseTrackers(msg.mes);
        if (lines.length) replies++;

        for (const { tag, fields } of lines) {
            if (tag === 'BOND' && fields.length >= 5) {
                const name = fields[0] || '—';
                const rec = bonds.get(name) || { name, series: [[], [], [], []] };
                rec.values = fields.slice(1, 5).map(firstInt);
                rec.wants = fields[5] || '';
                rec.debt = fields[7] || fields[6] || '';
                rec.values.forEach((v, i) => { if (v !== null) rec.series[i].push(v); });
                bonds.set(name, rec);
            }
            if (tag === 'PLOT' && fields.length >= 3) {
                const name = fields[0] || '—';
                const rec = threads.get(name) || { name };
                rec.status = (fields.find(f => STATUS.test(f)) || '').toLowerCase();
                const tail = fields.slice(-2).map(firstInt);
                const fused = fields.length >= 5 && tail.every(v => v !== null);
                rec.filled = fused ? tail[0] : null;
                rec.total = fused ? tail[1] : null;
                threads.set(name, rec);
            }
        }
    }
    if (!bonds.size && !threads.size) return null;
    return { bonds: [...bonds.values()], threads: [...threads.values()], replies };
}

/** Everything the preset can only ask for, checked here in code. */
function boardIssues(board) {
    const out = [];
    for (const b of board.bonds) {
        b.values.forEach((v, i) => {
            if (v !== null && (v < 0 || v > 10)) {
                out.push(`${b.name}: ${BOND_AXES[i]} is ${v}, outside 0-10`);
            }
        });
    }
    if (board.bonds.length > 6) out.push(`${board.bonds.length} bond lines — the module caps this at six`);

    const fused = board.threads.filter(t => t.filled !== null);
    for (const t of fused) {
        if (t.filled > t.total) out.push(`${t.name}: fuse reads ${t.filled}/${t.total}`);
    }
    if (fused.length > 2) out.push(`${fused.length} threads carry a fuse — the module caps this at two`);
    if (board.threads.length > 4) out.push(`${board.threads.length} live threads — the module caps this at four`);
    return out;
}

/** How often a value has moved recently: the drift question, answered. */
function moves(series, window = 8) {
    const tail = series.slice(-window);
    let n = 0;
    for (let i = 1; i < tail.length; i++) if (tail[i] !== tail[i - 1]) n++;
    return { moved: n, of: Math.max(0, tail.length - 1), tail };
}

function renderBoard() {
    const board = readBoard();
    if (!board) return null;

    const drawer = el('div', 'inline-drawer coldopen-section coldopen-board');
    const head = el('div', 'inline-drawer-toggle inline-drawer-header');
    head.append(el('b', null, 'Tracker board'));
    const issues = boardIssues(board);
    const flag = el('small', issues.length ? 'coldopen-cap coldopen-cap-over' : 'coldopen-count',
        issues.length ? `${issues.length} to check` : `${board.bonds.length}b · ${board.threads.length}t`);
    head.append(flag);
    const icon = el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down');
    head.append(icon);

    const body = el('div', 'inline-drawer-content');
    const NAME = 'Tracker board';
    head.addEventListener('click', () => {
        if (openSections.has(NAME)) openSections.delete(NAME); else openSections.add(NAME);
        settings().open = [...openSections];
        save();
    });
    if (openSections.has(NAME)) {
        body.style.display = 'block';
        icon.className = 'inline-drawer-icon fa-solid fa-circle-chevron-up up';
    }

    for (const msg of issues) {
        const row = el('div', 'coldopen-board-issue');
        row.append(el('i', 'fa-solid fa-triangle-exclamation'), el('span', null, msg));
        body.append(row);
    }

    if (board.bonds.length) {
        body.append(el('div', 'coldopen-board-head', 'Bonds'));
        for (const b of board.bonds) {
            const row = el('div', 'coldopen-board-row');
            row.append(el('span', 'coldopen-board-name', b.name));
            const vals = el('span', 'coldopen-board-vals');
            b.values.forEach((v, i) => {
                const m = moves(b.series[i]);
                const cell = el('span', 'coldopen-board-cell', v === null ? '–' : String(v));
                if (m.of >= 3 && m.moved >= m.of - 1) cell.classList.add('coldopen-board-jitter');
                cell.title = `${BOND_AXES[i]} — ${m.tail.join(' → ') || 'no history'}` +
                    (m.of ? `\nmoved ${m.moved} of the last ${m.of} times this line appeared` : '');
                vals.append(cell);
            });
            row.append(vals);
            if (b.debt && b.debt !== '-' && b.debt !== '—') {
                row.append(el('small', 'coldopen-board-debt', b.debt));
            }
            body.append(row);
        }
    }

    if (board.threads.length) {
        body.append(el('div', 'coldopen-board-head', 'Threads'));
        for (const t of board.threads) {
            const row = el('div', 'coldopen-board-row');
            row.append(el('span', 'coldopen-board-name', t.name));
            if (t.status) row.append(el('small', 'coldopen-board-status', t.status));
            if (t.filled !== null) {
                const fuse = el('small', 'coldopen-board-fuse', `${t.filled}/${t.total}`);
                if (t.filled > t.total) fuse.classList.add('coldopen-board-jitter');
                row.append(fuse);
            }
            body.append(row);
        }
    }

    body.append(el('small', 'coldopen-board-note',
        `Read from ${board.replies} replies carrying tracker lines. Hover a number for its history. Nothing here is written back — the preset stays the source of truth.`));

    drawer.append(head, body);
    return drawer;
}

/**
 * A hover summary built from the entry's real prompt text rather than a
 * hand-written blurb, so it cannot drift as the preset changes. Most COLD OPEN
 * modules wrap their payload in {{addvar::var::…}}, which is plumbing rather
 * than content — unwrap it, drop the XML scaffolding, and keep {{user}} and
 * friends intact because those are part of what the entry actually says.
 */
const PAYLOAD = /\{\{(?:add|set)var::[^:]+::([\s\S]*?)\}\}\s*(?:\{\{trim\}\})?\s*$/;

function describe(item) {
    if (item.marker) {
        return 'SillyTavern marker — the slot where ST injects its own block (chat history, world info). No text of its own.';
    }

    const raw = item.content || '';
    const m = PAYLOAD.exec(raw.trim());
    const text = (m ? m[1] : raw)
        .replace(/\{\{trim\}\}/g, '')
        .replace(/<\/?[a-z_][\w-]*\s*\/?>/gi, ' ')   // <directive>, <tracker_plot> …
        .replace(/\s+/g, ' ')
        .trim();

    if (!text) return 'Carries no text of its own — structural plumbing or a passthrough slot.';

    const tokens = Math.round(text.length / 4);
    const clipped = text.length > 300
        ? text.slice(0, 299).replace(/\s+\S*$/, '') + '…'
        : text;
    return `≈${tokens} tok — ${clipped}`;
}

/** The upgrade banner: what your last preset had on, and what moved. */
function renderCarry(carry, model) {
    const box = el('div', 'coldopen-carry');

    const head = el('div', 'coldopen-carry-head');
    head.append(el('i', 'fa-solid fa-arrow-right-arrow-left coldopen-carry-icon'));
    head.append(el('b', null, carry.from ? `Loadout from ${carry.from}` : 'Loadout from a previous preset'));
    box.append(head);

    const bits = [`${carry.differing.length} to restore`];
    if (carry.added.length) bits.push(`${carry.added.length} new here`);
    if (carry.gone.length) bits.push(`${carry.gone.length} gone`);
    box.append(el('div', 'coldopen-carry-line', bits.join('  ·  ')));

    if (carry.gone.length) {
        const names = carry.gone.slice(0, 4).join(', ') + (carry.gone.length > 4 ? '…' : '');
        box.append(el('small', 'coldopen-carry-gone', `No longer in this preset: ${names}`));
    }

    const row = el('div', 'coldopen-carry-row');

    const apply = el('div', 'menu_button coldopen-btn', 'Restore my selection');
    apply.title = 'Re-apply what you had switched on, for every entry that still exists here.';
    apply.addEventListener('click', async () => {
        const fresh = buildModel();
        if (!fresh) return;
        const prev = settings().loadout?.entries || {};
        const here = new Set(allEntries(fresh).map(e => e.id));
        const changes = {};
        for (const id of carry.differing) if (here.has(id) && prev[id]) changes[id] = prev[id].on;
        await applyChanges(changes);
        snapshotLoadout(buildModel() || fresh);
        renderPanel();
    });

    const skip = el('div', 'menu_button coldopen-btn coldopen-btn-sm', 'Keep as-is');
    skip.title = 'Adopt what this preset shipped with and stop asking.';
    skip.addEventListener('click', () => dismissCarry(model));

    row.append(apply, skip);
    box.append(row);
    return box;
}

function renderEntry(item, group, model) {
    const row = el('label', `coldopen-row coldopen-${item.kind}`);

    // The empty Post-History Instructions entry is the passthrough for character
    // cards' own PHI. Disabling it silently kills that field on every card, so
    // the panel refuses to offer the switch.
    const isPhiPassthrough = /Post-History Instructions/i.test(item.raw) && !item.content.trim();

    if (item.kind === 'structural' || item.marker || isPhiPassthrough) {
        row.classList.add('coldopen-locked');
        const why = isPhiPassthrough
            ? 'Locked on purpose: this empty slot is what lets your character cards’ own post-history instructions through. Disabling it kills that field on every card.'
            : 'Structural — the preset needs this where it is.';
        row.title = `${why}\n\n${describe(item)}`;
        row.append(el('i', 'fa-solid fa-lock coldopen-lock'));
        row.append(el('span', 'coldopen-name', item.name));
        if (isPhiPassthrough) row.append(el('small', 'coldopen-tag', 'card PHI'));
        return row;
    }

    const box = document.createElement('input');
    box.type = item.kind === 'radio' ? 'radio' : 'checkbox';
    if (item.kind === 'radio' && group) box.name = `coldopen_${group.name.replace(/\W+/g, '_')}`;
    box.checked = item.enabled;
    box.dataset.coId = item.id;

    box.addEventListener('change', async () => {
        const fresh = buildModel();
        if (!fresh) return;
        if (item.kind === 'radio' && group) {
            const g = fresh.flatMap(s => s.groups).find(x => x.name === group.name);
            await applyChanges(radioChanges(g || group, item.id));
        } else {
            const changes = { [item.id]: box.checked };
            Object.assign(changes, dependencyChanges(fresh, item.id, box.checked));
            if (group && box.checked) {
                const g = fresh.flatMap(s => s.groups).find(x => x.name === group.name);
                Object.assign(changes, capChanges(g || group, item.id));
            }
            await applyChanges(changes);
        }
    });

    row.title = describe(item);
    row.append(box);
    row.append(el('span', 'coldopen-name', item.name));
    if (item.kind === 'depend') {
        const tag = el('small', 'coldopen-tag', 'required by others');
        row.append(tag);
    }
    return row;
}

// ─────────────────────────────────────────────────────────── settings

const WINDOW = 'coldopen_window';
const LAUNCHER = 'coldopen_launcher';

/** Live settings object, migrated forward from v1 in place. */
function settings() {
    const c = ctx();
    const s = (c.extensionSettings[KEY] ??= {});
    if (typeof s.locked !== 'boolean') s.locked = true;
    s.window ??= { x: null, y: null, open: false };
    s.launcher ??= { x: null, y: null };
    s.open ??= [];
    s.version = 2;
    return s;
}

const save = () => ctx().saveSettingsDebounced();

// ─────────────────────────────────────────────────────────── preset lock

/**
 * The native Prompt Manager can't express the preset's grammar, so while a
 * COLD OPEN preset is loaded we stop its mutating controls at the capture
 * phase — before ST's own listeners see the event. Reads (inspect, scroll,
 * token counts) are left alone, and everything unlocks the moment you flip
 * the switch or load a different preset.
 */
const PM_ROOT = 'completion_prompt_manager';
const PM_BLOCKED = [
    '.prompt-manager-toggle-action',
    '.prompt-manager-detach-action',
    '.prompt-manager-edit-action',
    '.drag-handle',
].join(', ');

/** Only lock when there is actually a COLD OPEN preset to protect. */
function lockActive() {
    return settings().locked && !!buildModel();
}

function guard(e) {
    if (!lockActive()) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    const root = t.closest(`#${PM_ROOT}`);
    if (!root) return;

    const isEntryControl = !!t.closest(PM_BLOCKED);
    const isFooterControl = !!t.closest('[id^="completion_prompt_manager_footer"]');
    if (!isEntryControl && !isFooterControl) return;   // inspect / scroll stay usable

    e.stopImmediatePropagation();
    e.preventDefault();
    if (e.type === 'pointerdown' || e.type === 'mousedown') nudge(root);
}

let nudgeTimer = null;
function nudge(root) {
    root.classList.add('coldopen-pm-refused');
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => root.classList.remove('coldopen-pm-refused'), 500);
}

/** Visual state only — the guard above is what actually enforces it. */
function paintLock() {
    const root = document.getElementById(PM_ROOT);
    if (root) root.classList.toggle('coldopen-pm-locked', lockActive());
    const btn = document.querySelector('.coldopen-lockbtn');
    if (btn) {
        const on = settings().locked;
        btn.className = `coldopen-lockbtn fa-solid ${on ? 'fa-lock' : 'fa-lock-open'}`;
        btn.title = on
            ? 'Prompt Manager is locked. Changes go through this panel so the grammar holds. Click to unlock.'
            : 'Prompt Manager is unlocked — raw editing, no grammar enforcement. Click to lock.';
    }
    const box = document.getElementById('coldopen_lock_toggle');
    if (box) box.checked = settings().locked;
}

function toggleLock(next) {
    const s = settings();
    s.locked = next ?? !s.locked;
    save();
    paintLock();
}

// ─────────────────────────────────────────────────────────── floating UI

/** Clamp to the viewport so a saved position can never strand the panel. */
function place(node, x, y) {
    const maxX = Math.max(0, window.innerWidth - node.offsetWidth);
    const maxY = Math.max(0, window.innerHeight - node.offsetHeight);
    node.style.left = `${Math.min(Math.max(0, x), maxX)}px`;
    node.style.top = `${Math.min(Math.max(0, y), maxY)}px`;
    node.style.right = 'auto';
    node.style.bottom = 'auto';
}

/**
 * Pointer-events drag. ST's own dragElement lives in RossAscends-mods.js and
 * isn't on getContext(), so importing it would mean reaching into internals
 * for thirty lines of arithmetic. This is those thirty lines.
 */
function draggable(handle, target, store, onClick) {
    let id, sx, sy, ox, oy, travel;

    handle.addEventListener('pointerdown', e => {
        if (e.button !== 0 || e.target.closest('.coldopen-nodrag')) return;
        const r = target.getBoundingClientRect();
        [id, sx, sy, ox, oy, travel] = [e.pointerId, e.clientX, e.clientY, r.left, r.top, 0];
        handle.setPointerCapture(id);
        target.classList.add('coldopen-dragging');
        e.preventDefault();
    });

    handle.addEventListener('pointermove', e => {
        if (e.pointerId !== id) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        travel = Math.max(travel, Math.abs(dx) + Math.abs(dy));
        place(target, ox + dx, oy + dy);
    });

    const release = e => {
        if (e.pointerId !== id) return;
        handle.releasePointerCapture(id);
        id = undefined;
        target.classList.remove('coldopen-dragging');
        const r = target.getBoundingClientRect();
        store.x = r.left;
        store.y = r.top;
        save();
        if (travel < 5 && onClick) onClick();          // a tap, not a drag
    };
    handle.addEventListener('pointerup', release);
    handle.addEventListener('pointercancel', release);
}

function buildWindow() {
    const s = settings();
    const win = el('div', 'coldopen-window');
    win.id = WINDOW;

    const head = el('div', 'coldopen-window-head');
    head.append(el('i', 'fa-solid fa-clapperboard coldopen-window-icon'));
    head.append(el('b', 'coldopen-window-title', 'COLD OPEN'));
    head.append(el('span', 'coldopen-spacer'));

    const lockBtn = el('i', 'coldopen-lockbtn fa-solid fa-lock coldopen-nodrag');
    lockBtn.addEventListener('click', () => toggleLock());
    head.append(lockBtn);

    const close = el('i', 'coldopen-close fa-solid fa-xmark coldopen-nodrag');
    close.title = 'Close';
    close.addEventListener('click', () => showWindow(false));
    head.append(close);

    const body = el('div', 'coldopen-window-body');
    const panel = el('div');
    panel.id = PANEL;
    body.append(panel);

    win.append(head, body);
    document.body.append(win);

    if (s.window.x != null) place(win, s.window.x, s.window.y);
    draggable(head, win, s.window);
    return win;
}

function buildLauncher() {
    const s = settings();
    const btn = el('div', 'coldopen-launcher');
    btn.id = LAUNCHER;
    btn.title = 'COLD OPEN — preset control panel';
    btn.append(el('i', 'fa-solid fa-clapperboard'));
    document.body.append(btn);

    if (s.launcher.x != null) place(btn, s.launcher.x, s.launcher.y);
    draggable(btn, btn, s.launcher, () => showWindow());
    return btn;
}

function showWindow(next) {
    const s = settings();
    const win = document.getElementById(WINDOW) || buildWindow();
    s.window.open = next ?? !s.window.open;
    win.style.display = s.window.open ? 'flex' : 'none';
    save();
    if (s.window.open) {
        renderPanel();
        paintLock();
    }
}

/** The drawer keeps a stub: a way back to the panel and the lock switch. */
function mountDrawerStub() {
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container || document.getElementById('coldopen_stub')) return;

    const drawer = el('div', 'coldopen-root inline-drawer');
    drawer.id = 'coldopen_stub';
    const head = el('div', 'inline-drawer-toggle inline-drawer-header');
    head.append(el('b', null, 'COLD OPEN'));
    head.append(el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));

    const body = el('div', 'inline-drawer-content');

    const open = el('div', 'menu_button coldopen-btn', 'Open panel');
    open.addEventListener('click', () => showWindow(true));

    const reset = el('div', 'menu_button coldopen-btn', 'Reset position');
    reset.addEventListener('click', () => {
        const s = settings();
        s.window.x = s.window.y = s.launcher.x = s.launcher.y = null;
        save();
        for (const id of [WINDOW, LAUNCHER]) document.getElementById(id)?.remove();
        buildLauncher();
        if (s.window.open) showWindow(true);
    });

    const row = el('div', 'coldopen-stub-row');
    row.append(open, reset);

    const lockRow = el('label', 'coldopen-stub-lock');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'coldopen_lock_toggle';
    box.checked = settings().locked;
    box.addEventListener('change', () => toggleLock(box.checked));
    lockRow.append(box, el('span', null, 'Lock the native Prompt Manager'));

    const note = el('small', 'coldopen-stub-note',
        'While locked, the Prompt Manager’s toggles, edit, detach and drag-reorder are refused so the panel stays the single source of truth. Inspection and token counts still work. Unlocking hands you raw ST behaviour with no grammar enforcement.');

    body.append(row, lockRow, note);
    drawer.append(head, body);
    container.append(drawer);
}

// ─────────────────────────────────────────────────────────── boot

(function init() {
    const c = ctx();
    settings();
    c.saveSettingsDebounced();

    for (const name of settings().open) openSections.add(name);

    mountDrawerStub();
    buildLauncher();

    const s = settings();
    const win = buildWindow();
    win.style.display = s.window.open ? 'flex' : 'none';
    if (s.window.open) renderPanel();

    for (const type of ['pointerdown', 'mousedown', 'click', 'change']) {
        document.addEventListener(type, guard, true);
    }

    // ST rebuilds the prompt list on every change; re-apply the visual state.
    const observer = new MutationObserver(() => paintLock());
    const attach = () => {
        const root = document.getElementById(PM_ROOT);
        if (root) observer.observe(root, { childList: true, subtree: true });
    };
    attach();

    const ev = c.eventSource, t = c.eventTypes;
    const refresh = () => {
        if (settings().window.open) syncPanel();
        attach();
        paintLock();
    };
    for (const name of ['OAI_PRESET_CHANGED_AFTER', 'PRESET_CHANGED', 'CHAT_CHANGED', 'SETTINGS_UPDATED', 'APP_READY']) {
        if (t[name]) ev.on(t[name], refresh);
    }
    // The board is derived from chat, so it has its own reasons to redraw.
    for (const name of ['MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED']) {
        if (t[name]) ev.on(t[name], () => { if (settings().window.open) renderPanel(); });
    }

    window.addEventListener('resize', () => {
        for (const id of [WINDOW, LAUNCHER]) {
            const n = document.getElementById(id);
            if (n && n.style.display !== 'none') place(n, n.offsetLeft, n.offsetTop);
        }
    });

    paintLock();
    console.log('[COLD OPEN Companion] loaded');
})();
