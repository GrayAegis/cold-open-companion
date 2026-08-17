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
    if (applied) renderPanel();
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

function tierChanges(model, tierName) {
    const tier = TIERS[tierName];
    const changes = {};
    for (const e of allEntries(model)) {
        if (/Directive\s*—/i.test(e.raw)) changes[e.id] = tier.directive.test(e.raw);
        else if (/CoT\s*—/i.test(e.raw)) changes[e.id] = !!tier.cot && tier.cot.test(e.raw);
        else if (e.kind === 'additive' && /De-slop/i.test(e.raw)) continue;   // user's model choice
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

// ─────────────────────────────────────────────────────────── UI

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

function renderPanel() {
    const host = document.getElementById(PANEL);
    if (!host) return;
    host.innerHTML = '';

    const model = buildModel();
    if (!model) {
        host.append(el('div', 'coldopen-empty',
            'No COLD OPEN preset detected. Load one in AI Response Configuration and this panel fills in.'));
        return;
    }

    // toolbar
    const bar = el('div', 'coldopen-bar');
    bar.append(el('span', 'coldopen-bar-label', 'Tier'));
    for (const name of Object.keys(TIERS)) {
        const b = el('button', 'menu_button coldopen-btn', name);
        b.title = `Set the Directive, craft modules and reasoning for ${name}. Systems and De-slop are left as you have them.`;
        b.addEventListener('click', () => applyChanges(tierChanges(buildModel(), name)));
        bar.append(b);
    }
    bar.append(el('span', 'coldopen-bar-label', 'Model'));
    for (const m of MODELS) {
        const b = el('button', 'menu_button coldopen-btn coldopen-btn-sm', m);
        b.title = `Enable De-slop: ${m} and disable the other families.`;
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
        head.append(el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
        drawer.append(head);

        const body = el('div', 'inline-drawer-content');

        for (const item of section.loose) body.append(renderEntry(item, null, model));
        for (const group of section.groups) {
            const gEl = el('div', 'coldopen-group');
            const gh = el('div', 'coldopen-group-head');
            gh.append(el('span', null, group.name));
            const radios = group.entries.filter(e => e.kind === 'radio');
            if (radios.length) gh.append(el('small', 'coldopen-hint', 'pick one'));
            gh.append(el('span', null, ''));
            gEl.append(gh);
            for (const item of group.entries) gEl.append(renderEntry(item, group, model));
            body.append(gEl);
        }

        drawer.append(body);
        host.append(drawer);
    }

    refreshCounts(model);
}

function renderEntry(item, group, model) {
    const row = el('label', `coldopen-row coldopen-${item.kind}`);

    // The empty Post-History Instructions entry is the passthrough for character
    // cards' own PHI. Disabling it silently kills that field on every card, so
    // the panel refuses to offer the switch.
    const isPhiPassthrough = /Post-History Instructions/i.test(item.raw) && !item.content.trim();

    if (item.kind === 'structural' || item.marker || isPhiPassthrough) {
        row.classList.add('coldopen-locked');
        row.title = isPhiPassthrough
            ? 'Locked on purpose: this empty slot is what lets your character cards’ own post-history instructions through. Disabling it kills that field on every card.'
            : 'Structural — the preset needs this where it is.';
        row.append(el('i', 'fa-solid fa-lock coldopen-lock'));
        row.append(el('span', 'coldopen-name', item.name));
        if (isPhiPassthrough) row.append(el('small', 'coldopen-tag', 'card PHI'));
        return row;
    }

    const box = document.createElement('input');
    box.type = item.kind === 'radio' ? 'radio' : 'checkbox';
    if (item.kind === 'radio' && group) box.name = `coldopen_${group.name.replace(/\W+/g, '_')}`;
    box.checked = item.enabled;

    box.addEventListener('change', async () => {
        const fresh = buildModel();
        if (!fresh) return;
        if (item.kind === 'radio' && group) {
            const g = fresh.flatMap(s => s.groups).find(x => x.name === group.name);
            await applyChanges(radioChanges(g || group, item.id));
        } else {
            const changes = { [item.id]: box.checked };
            Object.assign(changes, dependencyChanges(fresh, item.id, box.checked));
            await applyChanges(changes);
        }
    });

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
    s.window ??= { x: null, y: null, w: 380, h: 540, open: false };
    s.launcher ??= { x: null, y: null };
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

    win.style.width = `${s.window.w}px`;
    win.style.height = `${s.window.h}px`;
    if (s.window.x != null) place(win, s.window.x, s.window.y);

    draggable(head, win, s.window);

    // CSS resize writes straight to the element; mirror it into settings.
    new ResizeObserver(() => {
        if (win.style.display === 'none') return;
        s.window.w = win.offsetWidth;
        s.window.h = win.offsetHeight;
        save();
    }).observe(win);

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
        s.window.w = 380;
        s.window.h = 540;
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
        if (settings().window.open) renderPanel();
        attach();
        paintLock();
    };
    for (const name of ['OAI_PRESET_CHANGED_AFTER', 'PRESET_CHANGED', 'CHAT_CHANGED', 'SETTINGS_UPDATED', 'APP_READY']) {
        if (t[name]) ev.on(t[name], refresh);
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
