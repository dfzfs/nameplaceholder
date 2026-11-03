/* Name Swap - SillyTavern extension
 * Temporarily replace the {{char}} and {{user}} names for the current chat only.
 * Group chats: each group member can be renamed separately.
 * The replacement happens on the final prompt sent to the AI; chat text on screen
 * and the character card are never modified. */

const MODULE_NAME = 'name_swap';
const META_KEY = 'name_swap';

const defaultSettings = Object.freeze({
    names: [], // saved names (shared by all chats)
});

let lastMemberInput = null; // last focused member input (group chats)

/* ------------------------------------------------------------------ helpers */

const ctx = () => SillyTavern.getContext();

function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = structuredClone(defaultSettings[key]);
        }
    }
    return extensionSettings[MODULE_NAME];
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasChat() {
    const c = ctx();
    return !!c.getCurrentChatId?.() && (c.groupId || (c.characterId !== undefined && c.characterId !== null && c.characterId !== ''));
}

function readOverride() {
    const o = ctx().chatMetadata?.[META_KEY];
    return {
        char: o?.char ?? '',
        user: o?.user ?? '',
        members: o?.members && typeof o.members === 'object' ? o.members : {},
    };
}

// Names of the members of the current group chat (empty when not a group chat)
function getGroupMemberNames() {
    const c = ctx();
    if (!c.groupId) return [];
    const groups = Array.isArray(c.groups) ? c.groups : [];
    const group = groups.find((g) => String(g.id) === String(c.groupId));
    if (!group || !Array.isArray(group.members)) return [];
    const names = group.members
        .map((avatar) => (c.characters ?? []).find((ch) => ch.avatar === avatar)?.name)
        .filter(Boolean);
    return [...new Set(names)];
}

/* --------------------------------------------------------------- name swap */

// Build {from -> to} for the current chat. Real names are read live from ST.
function buildSwapMap() {
    const c = ctx();
    const o = readOverride();
    const map = new Map();
    const add = (from, to) => {
        const source = String(from ?? '').trim();
        const target = String(to ?? '').trim();
        if (source && target && source !== target) map.set(source, target);
    };

    if (c.groupId) {
        for (const [from, to] of Object.entries(o.members)) add(from, to);
    } else {
        // name2 is the active chat character name in current ST builds.
        // Fall back to the selected character object for builds where it is absent.
        const character = Array.isArray(c.characters)
            ? c.characters[Number(c.characterId)]
            : null;
        const originalCharName = c.name2 || character?.name || '';
        add(originalCharName, o.char);
    }

    // name1 is the active user/persona name. Keep it separate from character names.
    add(c.name1 || c.user_name || '', o.user);
    return map;
}

// One pass over the text, so swapping A<->B or "Sun"->"Sunny" never compounds.
function makeSwapper(map) {
    if (!map.size) return null;
    // English names only match as whole words ("Sun" does not touch "Sunday").
    // Names starting/ending with Korean etc. match anywhere, so particles like "앨리스는" still work.
    const isAscii = (ch) => /[A-Za-z0-9_]/.test(ch);
    const keys = [...map.keys()].sort((a, b) => b.length - a.length).map((k) => {
        const head = isAscii(k[0]) ? '(?<![A-Za-z0-9_])' : '';
        const tail = isAscii(k[k.length - 1]) ? '(?![A-Za-z0-9_])' : '';
        return `${head}${escapeRegex(k)}${tail}`;
    });
    const re = new RegExp(keys.join('|'), 'g');
    return (text) => String(text).replace(re, (m) => map.get(m) ?? m);
}

function swapChatMessage(message, swap, map) {
    if (!message || typeof message !== 'object') return;
    if (typeof message.content === 'string') {
        message.content = swap(message.content);
    } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
            if (typeof part?.text === 'string') part.text = swap(part.text);
        }
    }
    // Change the speaker label in the outgoing API payload only.
    if (typeof message.name === 'string' && map.has(message.name)) {
        message.name = map.get(message.name);
    }
}

function onChatCompletionPromptReady(data) {
    try {
        const map = buildSwapMap();
        const swap = makeSwapper(map);
        if (!swap || !data || typeof data !== 'object') return;

        // SillyTavern's Chat Completion prompt-ready payload normally exposes chat.
        // Some builds/integrations expose the message array as prompt instead.
        const messages = Array.isArray(data.chat)
            ? data.chat
            : (Array.isArray(data.prompt) ? data.prompt : null);
        if (!messages) {
            console.warn(`[${MODULE_NAME}] Chat Completion prompt event had no chat/prompt array`, data);
            return;
        }
        for (const message of messages) swapChatMessage(message, swap, map);
        console.debug(`[${MODULE_NAME}] Applied prompt-only name swap`, Object.fromEntries(map));
    } catch (err) {
        console.error(`[${MODULE_NAME}] chat completion hook error`, err);
    }
}

function onCombinePrompts(result) {
    try {
        const swap = makeSwapper(buildSwapMap());
        if (!swap || typeof result?.prompt !== 'string') return;
        result.prompt = swap(result.prompt);
    } catch (err) {
        console.error(`[${MODULE_NAME}] text completion hook error`, err);
    }
}

/* ----------------------------------------------------------------- actions */

async function saveOverride(override) {
    const c = ctx();
    const meta = c.chatMetadata;
    const hasMembers = override.members && Object.keys(override.members).length > 0;
    if (override.char || override.user || hasMembers) {
        meta[META_KEY] = { char: override.char, user: override.user, members: override.members ?? {} };
    } else {
        delete meta[META_KEY];
    }
    await c.saveMetadata();
}

async function applyNames() {
    if (!hasChat()) {
        toastr.warning('먼저 채팅을 열어 주세요.');
        return;
    }
    const c = ctx();
    const userVal = document.getElementById('ns_user').value.trim();
    const next = { char: '', user: userVal === c.name1 ? '' : userVal, members: {} };

    if (c.groupId) {
        document.querySelectorAll('#ns_members .ns-member-input').forEach((input) => {
            const orig = input.dataset.orig;
            const val = input.value.trim();
            if (val && val !== orig) next.members[orig] = val;
        });
    } else {
        const charVal = document.getElementById('ns_char').value.trim();
        next.char = charVal === c.name2 ? '' : charVal;
    }

    try {
        await saveOverride(next);
        renderStatus();
        toastr.success('이 채팅의 이름을 적용했어요.');
    } catch (err) {
        console.error(`[${MODULE_NAME}]`, err);
        toastr.error('저장에 실패했어요. 콘솔(F12)을 확인해 주세요.');
    }
}

async function resetNames() {
    if (!hasChat()) return;
    try {
        await saveOverride({ char: '', user: '', members: {} });
        syncInputs();
        renderStatus();
        toastr.info('원래 이름으로 되돌렸어요.');
    } catch (err) {
        console.error(`[${MODULE_NAME}]`, err);
        toastr.error('되돌리기에 실패했어요.');
    }
}

function addSavedName() {
    const input = document.getElementById('ns_new');
    const name = input.value.trim().slice(0, 50);
    if (!name) return;
    const settings = getSettings();
    if (settings.names.includes(name)) {
        toastr.info('이미 저장된 이름이에요.');
        return;
    }
    if (settings.names.length >= 100) {
        toastr.warning('저장은 최대 100개까지 가능해요.');
        return;
    }
    settings.names.push(name);
    ctx().saveSettingsDebounced();
    input.value = '';
    renderSavedNames();
}

function removeSavedName(name) {
    const settings = getSettings();
    settings.names = settings.names.filter((n) => n !== name);
    ctx().saveSettingsDebounced();
    renderSavedNames();
}

/* ---------------------------------------------------------------------- UI */

function renderStatus() {
    const box = document.getElementById('ns_status');
    if (!box) return;
    const c = ctx();
    if (!hasChat()) {
        box.textContent = '채팅을 열면 이름을 지정할 수 있어요.';
        return;
    }
    const o = readOverride();
    const line = (label, orig, cur) => (cur && cur !== orig
        ? `${label}: ${escapeHtml(orig)} → <b>${escapeHtml(cur)}</b>`
        : `${label}: ${escapeHtml(orig)} <span class="ns-hint">(원래 이름 사용 중)</span>`);

    const lines = [];
    if (c.groupId) {
        const members = getGroupMemberNames();
        if (members.length) {
            members.forEach((n) => lines.push(line('멤버', n, o.members[n])));
        } else {
            lines.push('멤버: <span class="ns-hint">멤버 목록을 찾지 못했어요</span>');
        }
    } else {
        lines.push(line('char', c.name2, o.char));
    }
    lines.push(line('user', c.name1, o.user));
    box.innerHTML = lines.join('<br>');
}

function syncInputs() {
    const charField = document.getElementById('ns_char_field');
    const charInput = document.getElementById('ns_char');
    const userInput = document.getElementById('ns_user');
    const membersBox = document.getElementById('ns_members');
    if (!charField || !charInput || !userInput || !membersBox) return;

    const c = ctx();
    const o = readOverride();
    const isGroup = !!c.groupId;

    charField.style.display = isGroup ? 'none' : '';
    charInput.value = isGroup ? '' : o.char;
    userInput.value = o.user;
    lastMemberInput = null;

    if (isGroup) {
        const members = getGroupMemberNames();
        membersBox.innerHTML = members.length
            ? members.map((n) => `
                <div class="ns-field">
                    <span>${escapeHtml(n)} (이 채팅만)</span>
                    <input class="text_pole ns-member-input" type="text" maxlength="50"
                        data-orig="${escapeHtml(n)}" value="${escapeHtml(o.members[n] ?? '')}" placeholder="비워 두면 원래 이름" />
                </div>`).join('')
            : '<div class="ns-hint">그룹 멤버 목록을 찾지 못했어요.</div>';
    } else {
        membersBox.innerHTML = '';
    }
}

function renderSavedNames() {
    const list = document.getElementById('ns_list');
    if (!list) return;
    const names = getSettings().names;
    if (!names.length) {
        list.innerHTML = '<div class="ns-hint">저장된 이름이 없어요.</div>';
        return;
    }
    const isGroup = !!ctx().groupId;
    list.innerHTML = names.map((n) => `
        <div class="ns-name-row">
            <div class="ns-name">${escapeHtml(n)}</div>
            <button class="menu_button ns-pick" data-slot="char" data-name="${escapeHtml(n)}">${isGroup ? '멤버 칸에 넣기' : 'char 칸에 넣기'}</button>
            <button class="menu_button ns-pick" data-slot="user" data-name="${escapeHtml(n)}">user 칸에 넣기</button>
            <button class="menu_button ns-del" data-name="${escapeHtml(n)}" title="삭제"><i class="fa-solid fa-trash"></i></button>
        </div>`).join('') + (isGroup ? '<div class="ns-hint">멤버 칸에 넣기는 마지막으로 누른 멤버 칸에 들어가요.</div>' : '');
}

function createSettingsUI() {
    const html = `
    <div id="${MODULE_NAME}_settings" class="extension_settings ns-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Name Swap (이름 바꾸기)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div id="ns_status" class="ns-status"></div>

                <div id="ns_char_field" class="ns-field">
                    <span>char 이름 (이 채팅만)</span>
                    <input id="ns_char" class="text_pole" type="text" maxlength="50" placeholder="비워 두면 원래 이름" />
                </div>
                <div id="ns_members"></div>
                <div class="ns-field">
                    <span>user 이름 (이 채팅만)</span>
                    <input id="ns_user" class="text_pole" type="text" maxlength="50" placeholder="비워 두면 원래 이름" />
                </div>
                <div class="ns-buttons">
                    <button id="ns_apply" class="menu_button"><i class="fa-solid fa-check"></i> 적용</button>
                    <button id="ns_reset" class="menu_button"><i class="fa-solid fa-rotate-left"></i> 원래 이름으로</button>
                </div>
                <div class="ns-hint">AI에게 보내는 프롬프트에서만 바뀌어요. 화면의 글과 캐릭터 카드는 그대로예요.</div>

                <h4>저장된 이름</h4>
                <div class="ns-add-row">
                    <input id="ns_new" class="text_pole" type="text" maxlength="50" placeholder="자주 쓰는 이름 추가" />
                    <button id="ns_add" class="menu_button">저장</button>
                </div>
                <div id="ns_list"></div>
            </div>
        </div>
    </div>`;
    document.getElementById('extensions_settings2').insertAdjacentHTML('beforeend', html);

    document.getElementById('ns_apply').addEventListener('click', applyNames);
    document.getElementById('ns_reset').addEventListener('click', resetNames);
    document.getElementById('ns_add').addEventListener('click', addSavedName);
    document.getElementById('ns_new').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addSavedName();
    });

    // Remember which member input was used last (group chats)
    document.getElementById('ns_members').addEventListener('focusin', (e) => {
        if (e.target?.classList?.contains('ns-member-input')) lastMemberInput = e.target;
    });

    // Buttons inside the saved-name list (re-rendered, so use delegation)
    document.getElementById('ns_list').addEventListener('click', (e) => {
        const btn = e.target?.closest?.('button');
        if (!btn) return;
        const name = btn.dataset.name;
        if (btn.classList.contains('ns-del')) {
            removeSavedName(name);
        } else if (btn.classList.contains('ns-pick')) {
            let target;
            if (btn.dataset.slot === 'user') {
                target = document.getElementById('ns_user');
            } else if (ctx().groupId) {
                target = lastMemberInput && document.body.contains(lastMemberInput) ? lastMemberInput : null;
                if (!target) {
                    toastr.info('먼저 이름을 넣을 멤버 칸을 눌러 주세요.');
                    return;
                }
            } else {
                target = document.getElementById('ns_char');
            }
            target.value = name;
        }
    });

    // Refresh the status line whenever the panel is opened
    document.querySelector(`#${MODULE_NAME}_settings .inline-drawer-toggle`).addEventListener('click', () => {
        renderStatus();
    });

    syncInputs();
    renderStatus();
    renderSavedNames();
}

/* ------------------------------------------------------------------- boot */

(function boot() {
    const { eventSource, event_types } = ctx();

    if (event_types.CHAT_COMPLETION_PROMPT_READY) {
        eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
    }
    if (event_types.GENERATE_AFTER_COMBINE_PROMPTS) {
        eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, onCombinePrompts);
    }

    eventSource.on(event_types.APP_READY, () => {
        createSettingsUI();
        eventSource.on(event_types.CHAT_CHANGED, () => {
            syncInputs();
            renderStatus();
            renderSavedNames();
        });
        console.log(`[${MODULE_NAME}] Loaded`);
    });
})();
