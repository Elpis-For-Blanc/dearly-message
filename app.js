import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFirestore, doc, setDoc, deleteDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import {
  getMessaging,
  isSupported as isMessagingSupported,
  onMessage,
  onRegistered,
  onUnregistered,
  register as registerMessaging,
  unregister as unregisterMessaging,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging.js';

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDxHoReGJVBh-574v4cYSpq2GiPgs3TaOg',
  authDomain: 'dearly-message.firebaseapp.com',
  projectId: 'dearly-message',
  storageBucket: 'dearly-message.firebasestorage.app',
  messagingSenderId: '864968097858',
  appId: '1:864968097858:web:e60e44cd381ca3a7e9addb',
  measurementId: 'G-T79KM8496B',
};
const VAPID_PUBLIC_KEY = 'BIosGtZESeGIXKZY5X-YQ5IXs8uLLDHoVP6MvhYADmWdE0kEHkp8M7Kf-qvB1jasepU459gX7qYhWMMkUNfKXUc';
const STORAGE_KEY = 'dearMessageStateV2';
const LEGACY_KEY = 'dearMessageStateV1';
const uid = () => crypto.randomUUID();

const makeDefaults = () => {
  const cid = uid();
  return {
    version: 2,
    characters: [{ id: cid, name: '', avatar: '', enabled: true }],
    selectedCharacterId: cid,
    groups: [
      ['아침', '07:00', '10:00', true],
      ['점심', '11:30', '14:00', false],
      ['저녁', '18:00', '21:00', false],
      ['밤', '22:00', '01:00', false],
    ].map(x => ({
      id: uid(), characterId: cid, name: x[0], start: x[1], end: x[2],
      dailyCount: 1, enabled: x[3], messages: [], sentToday: [],
    })),
    history: [],
    recentMessages: [],
    settings: { avoidRecent: true, recentCount: 3, checkInterval: 5, timezone: 'Asia/Seoul' },
    push: {
      deviceId: localStorage.getItem('dearMessageDeviceId') || uid(),
      connected: false,
      fid: '',
    },
    lastResetDate: '',
  };
};

let state = loadState();
let deferredPrompt = null;
let timer = null;
let pendingAvatar = '';
let cloudSyncTimer = null;
let firebaseContextPromise = null;
let pendingFidResolver = null;

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function migrateV1(v1) {
  const d = makeDefaults(), c = d.characters[0];
  c.name = v1.character?.name || '';
  c.avatar = v1.character?.avatar || '';
  d.groups = (v1.groups || []).map(g => ({ ...g, characterId: c.id, sentToday: g.sentToday || [] }));
  d.history = (v1.history || []).map(h => ({ ...h, characterId: c.id, characterName: c.name }));
  d.recentMessages = v1.recentMessages || [];
  d.settings = { ...d.settings, ...(v1.settings || {}) };
  d.lastResetDate = v1.lastResetDate || '';
  return d;
}

function normalize(s) {
  const d = makeDefaults();
  if (s?.version === 2 && Array.isArray(s.characters)) {
    const push = { ...d.push, ...s.push };
    // 기존 Supabase판의 connected=true가 남아 있어도 Firebase FID가 없으면 새 연결로 취급.
    if (!push.fid) push.connected = false;
    return {
      ...d,
      ...s,
      settings: { ...d.settings, ...s.settings },
      push,
      characters: s.characters.length ? s.characters : d.characters,
      groups: Array.isArray(s.groups) ? s.groups : d.groups,
      history: Array.isArray(s.history) ? s.history : [],
    };
  }
  return migrateV1(s || {});
}

function loadState() {
  try {
    const v2 = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (v2) return normalize(v2);
    const v1 = JSON.parse(localStorage.getItem(LEGACY_KEY));
    if (v1) {
      const m = migrateV1(v1);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(m));
      return m;
    }
  } catch {}
  return makeDefaults();
}

function persist(render = true) {
  localStorage.setItem('dearMessageDeviceId', state.push.deviceId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (state.push.connected && state.push.fid) queueCloudSync();
  if (render) renderAll();
}

function selectedChar() { return state.characters.find(c => c.id === state.selectedCharacterId) || state.characters[0]; }
function charGroups(cid = state.selectedCharacterId) { return state.groups.filter(g => g.characterId === cid); }
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function resetDailyIfNeeded() {
  const t = todayKey();
  if (state.lastResetDate !== t) {
    state.groups.forEach(g => g.sentToday = []);
    state.lastResetDate = t;
    persist(false);
  }
}
function mins(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function inWindow(start, end, date = new Date()) {
  const n = date.getHours() * 60 + date.getMinutes(), s = mins(start), e = mins(end);
  return s <= e ? n >= s && n <= e : n >= s || n <= e;
}
function eligibleGroups() {
  resetDailyIfNeeded();
  return state.groups.filter(g => {
    const c = state.characters.find(x => x.id === g.characterId);
    return c?.enabled && g.enabled && g.messages?.length && inWindow(g.start, g.end) && (g.sentToday?.length || 0) < Number(g.dailyCount || 1);
  });
}
function chooseMessage(g) {
  let p = [...g.messages];
  if (state.settings.avoidRecent) {
    const r = new Set(state.recentMessages.slice(-Number(state.settings.recentCount || 0)));
    const f = p.filter(m => !r.has(m));
    if (f.length) p = f;
  }
  return p[Math.floor(Math.random() * p.length)];
}
function esc(s = '') {
  return String(s).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
function toast(m) {
  const t = $('#toast');
  t.textContent = m;
  t.classList.add('show');
  clearTimeout(t._x);
  t._x = setTimeout(() => t.classList.remove('show'), 2400);
}


const AVATAR_DB = 'dear-message-avatars';
const AVATAR_STORE = 'avatars';

function openAvatarDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(AVATAR_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AVATAR_STORE)) db.createObjectStore(AVATAR_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheAvatar(characterId, dataUrl) {
  if (!characterId || !dataUrl?.startsWith('data:image/')) return;
  try {
    const db = await openAvatarDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(AVATAR_STORE, 'readwrite');
      tx.objectStore(AVATAR_STORE).put(dataUrl, characterId);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn('Avatar cache failed:', e);
  }
}

async function removeCachedAvatar(characterId) {
  if (!characterId) return;
  try {
    const db = await openAvatarDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(AVATAR_STORE, 'readwrite');
      tx.objectStore(AVATAR_STORE).delete(characterId);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn('Avatar cache delete failed:', e);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function squareAvatarFromDataUrl(dataUrl, size = 256) {
  const img = await loadImage(dataUrl);
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  const side = Math.min(sw, sh);
  const sx = Math.max(0, (sw - side) / 2);
  const sy = Math.max(0, (sh - side) / 2);

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { alpha: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
  return canvas.toDataURL('image/png');
}

async function squareAvatarFromFile(file, size = 256) {
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  return squareAvatarFromDataUrl(dataUrl, size);
}

async function normalizeAndCacheAvatars() {
  let changed = false;
  for (const c of state.characters) {
    if (!c.avatar?.startsWith('data:image/')) continue;
    try {
      const squared = await squareAvatarFromDataUrl(c.avatar, 256);
      if (squared !== c.avatar) {
        c.avatar = squared;
        changed = true;
      }
      await cacheAvatar(c.id, c.avatar);
    } catch (e) {
      console.warn('Avatar normalization failed:', e);
    }
  }
  if (changed) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    renderAll();
    if (state.push.connected && state.push.fid) queueCloudSync();
  }
}

async function notify(g, message) {
  const c = state.characters.find(x => x.id === g.characterId) || selectedChar();
  const opt = {
    body: message,
    icon: c.avatar || './icon-192.png',
    badge: './icon-192.png',
    tag: `${g.id}-${Date.now()}`,
    data: { groupId: g.id, characterId: c.id },
  };
  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(c.name || '새 메시지', opt);
  } else if (Notification.permission === 'granted') {
    new Notification(c.name || '새 메시지', opt);
  }
  recordMessage(c, g, message);
}

function recordMessage(c, g, message) {
  const item = {
    id: uid(), characterId: c.id, characterName: c.name,
    groupId: g.id, groupName: g.name, message, ts: Date.now(),
  };
  state.history.unshift(item);
  g.sentToday = g.sentToday || [];
  g.sentToday.push(item.id);
  state.recentMessages.push(message);
  state.recentMessages = state.recentMessages.slice(-50);
  persist();
}

function recordRemoteMessage(data = {}) {
  const c = state.characters.find(x => x.id === data.characterId);
  const g = state.groups.find(x => x.id === data.groupId);
  const message = data.body || '';
  state.history.unshift({
    id: uid(),
    characterId: c?.id || data.characterId || '',
    characterName: data.title || c?.name || '새 메시지',
    groupId: g?.id || data.groupId || '',
    groupName: data.groupName || g?.name || 'Push',
    message,
    ts: Date.now(),
  });
  if (message) {
    state.recentMessages.push(message);
    state.recentMessages = state.recentMessages.slice(-50);
  }
  persist();
}

function consumePushLog() {
  return new Promise(resolve => {
    if (!('indexedDB' in window)) return resolve();
    const q = indexedDB.open('dear-message-v2', 1);
    q.onupgradeneeded = () => q.result.createObjectStore('pushlog', { keyPath: 'id' });
    q.onerror = () => resolve();
    q.onsuccess = () => {
      const db = q.result, tx = db.transaction('pushlog', 'readwrite'), store = tx.objectStore('pushlog'), get = store.getAll();
      get.onsuccess = () => {
        for (const x of get.result || []) {
          if (state.history.some(h => h.pushLogId === x.id)) continue;
          const c = state.characters.find(c => c.id === x.data?.characterId), g = state.groups.find(g => g.id === x.data?.groupId);
          state.history.unshift({
            id: uid(), pushLogId: x.id,
            characterId: c?.id || '', characterName: x.title || c?.name || '',
            groupId: g?.id || '', groupName: x.data?.groupName || g?.name || 'Push',
            message: x.message, ts: x.ts,
          });
          if (x.message) state.recentMessages.push(x.message);
          store.delete(x.id);
        }
        state.recentMessages = state.recentMessages.slice(-50);
      };
      tx.oncomplete = () => { db.close(); persist(); resolve(); };
    };
  });
}

async function permission() {
  if (!('Notification' in window)) {
    toast('이 브라우저는 알림을 지원하지 않아요.');
    return false;
  }
  const p = await Notification.requestPermission();
  renderPermission();
  toast(p === 'granted' ? '알림을 허용했어요.' : '알림 권한이 허용되지 않았어요.');
  return p === 'granted';
}

async function test() {
  const pool = state.groups.filter(g => state.characters.find(c => c.id === g.characterId)?.enabled && g.enabled && g.messages?.length);
  if (!pool.length) return toast('활성 그룹에 대사를 먼저 추가해 주세요.');
  if (Notification.permission !== 'granted' && !await permission()) return;
  const g = pool[Math.floor(Math.random() * pool.length)];
  await notify(g, chooseMessage(g));
}

async function checkDue(manual = false) {
  const gs = eligibleGroups();
  if (!gs.length) {
    if (manual) toast('지금 시간대에 보낼 수 있는 그룹이 없어요.');
    return;
  }
  if (Notification.permission !== 'granted') {
    if (manual) await permission();
    return;
  }
  const g = gs[Math.floor(Math.random() * gs.length)];
  await notify(g, chooseMessage(g));
  if (manual) toast(`${g.name} 그룹에서 선택했어요.`);
}

function startTimer() {
  clearInterval(timer);
  if (state.push.connected) return;
  timer = setInterval(() => checkDue(), Math.max(1, +state.settings.checkInterval || 5) * 60000);
}

function renderPermission() {
  const e = $('#permissionState');
  if (!('Notification' in window)) return e.textContent = '지원하지 않음';
  e.textContent = ({ granted: '허용됨', denied: '차단됨', default: '아직 허용 전' })[Notification.permission];
}
function avatarInto(img, fb, c) {
  if (c?.avatar) { img.src = c.avatar; img.hidden = false; fb.hidden = true; }
  else { img.hidden = true; fb.hidden = false; }
}
function groupCard(g, editable) {
  const el = document.createElement('div');
  el.className = editable ? 'editor-card' : 'group-card';
  el.innerHTML = `<div class="group-main"><div class="group-title"><span class="status-dot ${g.enabled ? '' : 'off'}"></span>${esc(g.name)}</div><div class="group-meta">${g.start} ~ ${g.end} · 하루 ${g.dailyCount}회 · 대사 ${g.messages?.length || 0}개</div></div>${editable ? `<div class="editor-actions"><button class="mini-btn" data-preview="${g.id}">미리보기</button><button class="mini-btn" data-edit="${g.id}">편집</button><button class="mini-btn danger" data-delete="${g.id}">삭제</button></div>` : ''}`;
  return el;
}
function renderHome() {
  const c = selectedChar();
  avatarInto($('#homeAvatar'), $('#avatarFallback'), c);
  $('#homeName').textContent = c?.name || '이름을 설정해 주세요.';
  const active = charGroups(c?.id).filter(g => g.enabled && g.messages?.length);
  $('#nextSummary').textContent = active.length ? `${active.length}개 그룹이 활성화되어 있어요.` : '활성화된 메시지 그룹이 아직 없어요.';
  const b = $('#homeGroupList');
  b.innerHTML = '';
  active.forEach(g => b.appendChild(groupCard(g, false)));
  if (!active.length) b.innerHTML = '<div class="empty">메시지 그룹에 대사를 추가하고 활성화해 주세요.</div>';
}
function renderCharacters() {
  const b = $('#characterList');
  b.innerHTML = '';
  state.characters.forEach(c => {
    const e = document.createElement('div');
    e.className = `editor-card character-card ${c.id === state.selectedCharacterId ? 'selected' : ''}`;
    e.innerHTML = `${c.avatar ? `<img class="avatar" src="${c.avatar}" alt="">` : '<div class="avatar fallback">♡</div>'}<div class="grow"><div class="group-title">${esc(c.name || '이름 없음')}</div><div class="group-meta">${c.enabled ? '알림 사용' : '알림 꺼짐'} · 그룹 ${charGroups(c.id).length}개</div></div><div class="editor-actions"><button class="mini-btn" data-select-char="${c.id}">선택</button><button class="mini-btn" data-edit-char="${c.id}">편집</button><button class="mini-btn danger" data-delete-char="${c.id}">삭제</button></div>`;
    b.appendChild(e);
  });
}
function renderGroups() {
  const c = selectedChar();
  $('#groupCharacterName').textContent = c?.name || '선택한 캐릭터';
  const b = $('#groupEditorList');
  b.innerHTML = '';
  charGroups(c?.id).forEach(g => b.appendChild(groupCard(g, true)));
  if (!b.children.length) b.innerHTML = '<div class="empty">아직 그룹이 없어요. 첫 그룹을 만들어 주세요.</div>';
}
function renderHistory() {
  const b = $('#historyList');
  b.innerHTML = '';
  state.history.forEach(h => {
    const d = new Date(h.ts), e = document.createElement('div');
    e.className = 'history-card';
    e.innerHTML = `<div class="history-time">${d.toLocaleDateString('ko-KR')}<br>${d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</div><div><div class="history-message">${esc(h.message)}</div><div class="history-group">${esc(h.characterName || '')} · ${esc(h.groupName || '')}</div></div>`;
    b.appendChild(e);
  });
  if (!state.history.length) b.innerHTML = '<div class="empty">아직 받은 메시지가 없어요.</div>';
}
function renderSettings() {
  $('#avoidRecent').checked = !!state.settings.avoidRecent;
  $('#recentCount').value = state.settings.recentCount;
  $('#checkInterval').value = String(state.settings.checkInterval);
  $('#timezone').value = state.settings.timezone || 'Asia/Seoul';
  const e = $('#pushState');
  e.textContent = state.push.connected ? '이 기기 알림 연결됨' : '연결 안 됨';
  e.className = state.push.connected ? 'muted ok' : 'muted';
}
function renderAll() { renderPermission(); renderHome(); renderCharacters(); renderGroups(); renderHistory(); renderSettings(); }
function openCharacter(c = null) {
  $('#characterId').value = c?.id || '';
  $('#characterDialogTitle').textContent = c ? '캐릭터 편집' : '캐릭터 추가';
  $('#characterName').value = c?.name || '';
  $('#characterEnabled').checked = c ? !!c.enabled : true;
  pendingAvatar = c?.avatar || '';
  $('#avatarFile').value = '';
  renderAvatarPreview();
  $('#characterDialog').showModal();
}
function renderAvatarPreview() { $('#avatarPreviewWrap').innerHTML = pendingAvatar ? `<img src="${pendingAvatar}" alt="프로필 미리보기">` : ''; }



const OOC_CATEGORIES = [
  { key: 'morning', label: '아침' },
  { key: 'lunch', label: '점심' },
  { key: 'evening', label: '저녁' },
  { key: 'night', label: '밤' },
  { key: 'dawn', label: '새벽' },
  { key: 'cold', label: '추울 때' },
  { key: 'hot', label: '더울 때' },
  { key: 'rain', label: '비가 오는 날' },
];

function makeOocPrompt(label) {
  const character = selectedChar();
  const characterName = character?.name?.trim() || '현재 캐릭터';

  return `OOC: 현재 롤플레잉 중단.
NPC인 ${characterName}가 PC에게 보내는 문자 메시지 내용을 작성해 주세요.

상황: ${label}

Dearly Message에 등록해서 사용할 수 있도록, 해당 상황에서 NPC가 PC에게 보낼 짧은 문자 메시지를 10개 이상 작성해 주세요.

작성 규칙
- 반드시 최소 10개 이상 작성해 주세요.
- NPC의 기존 성격, 말투, 관계, 호칭, 설정을 그대로 유지해 주세요.
- 모든 메시지는 NPC가 PC에게 직접 보내는 문자 메시지여야 합니다.
- 실제 메신저나 문자처럼 자연스럽고 간략하게 작성해 주세요.
- 각 메시지는 1~2문장 정도로 짧게 작성해 주세요.
- 행동 묘사, 상황 설명, 지문, 독백은 넣지 말아 주세요.
- ${label} 상황에 자연스럽게 어울리는 내용으로 작성해 주세요.
- 같은 문장이나 비슷한 표현이 반복되지 않게 다양하게 작성해 주세요.
- NPC와 PC의 기존 관계성과 호칭을 가장 우선해 주세요.
- 지나치게 문학적이거나 장황한 표현은 피해주세요.
- 이모티콘, 말줄임표, 애칭 등은 NPC가 평소 사용하는 경우에만 자연스럽게 사용해 주세요.
- 1번부터 번호를 붙여 출력해 주세요.
- 메시지 외의 해설이나 부가 설명은 붙이지 말아 주세요.`;
}

function renderOocCategories(forceReset = false) {
  const list = $('#oocCategoryList');
  if (!list) return;

  if (!forceReset && list.children.length) return;
  list.innerHTML = '';

  OOC_CATEGORIES.forEach(category => {
    const card = document.createElement('section');
    card.className = 'ooc-category-card';
    card.dataset.category = category.key;

    const head = document.createElement('div');
    head.className = 'ooc-category-head';

    const titleWrap = document.createElement('div');

    const title = document.createElement('strong');
    title.textContent = category.label;

    const count = document.createElement('small');
    count.textContent = '10개 이상';

    titleWrap.append(title, count);

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'mini-btn ooc-copy-one';
    copyButton.dataset.copyCategory = category.key;
    copyButton.textContent = `${category.label} 복사`;

    head.append(titleWrap, copyButton);

    const textarea = document.createElement('textarea');
    textarea.className = 'ooc-category-text';
    textarea.spellcheck = false;
    textarea.dataset.oocCategory = category.key;
    textarea.value = makeOocPrompt(category.label);

    card.append(head, textarea);
    list.appendChild(card);
  });
}

function openOocDialog() {
  const dialog = $('#oocDialog');
  if (!dialog) {
    toast('OOC 창을 불러오지 못했어요.');
    return;
  }

  renderOocCategories(false);

  if (!dialog.open) {
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }
}

function closeOocDialog() {
  const dialog = $('#oocDialog');
  if (!dialog) return;

  if (typeof dialog.close === 'function' && dialog.open) {
    dialog.close();
  } else {
    dialog.removeAttribute('open');
  }
}

async function copyOocText(textarea, button) {
  const value = textarea?.value?.trim();
  if (!value) {
    toast('복사할 OOC 내용이 없어요.');
    return;
  }

  let copied = false;

  try {
    await navigator.clipboard.writeText(value);
    copied = true;
  } catch (_) {
    try {
      textarea.focus();
      textarea.select();
      copied = document.execCommand('copy');
    } catch (_) {}
  }

  if (copied) {
    toast('OOC를 복사했어요.');
    if (button) {
      const original = button.textContent;
      button.textContent = '복사됨 ✓';
      setTimeout(() => {
        button.textContent = original;
      }, 1300);
    }
  } else {
    toast('자동 복사가 어려워요. 내용을 길게 눌러 직접 복사해 주세요.');
  }
}

async function copyAllOoc() {
  renderOocCategories(false);

  const texts = OOC_CATEGORIES.map(category => {
    const textarea = document.querySelector(
      `[data-ooc-category="${category.key}"]`
    );
    return textarea?.value?.trim() || '';
  }).filter(Boolean);

  if (!texts.length) {
    toast('복사할 OOC 내용이 없어요.');
    return;
  }

  const temporary = document.createElement('textarea');
  temporary.value = texts.join('\n\n');
  temporary.style.position = 'fixed';
  temporary.style.opacity = '0';
  document.body.appendChild(temporary);

  let copied = false;
  try {
    await navigator.clipboard.writeText(temporary.value);
    copied = true;
  } catch (_) {
    try {
      temporary.focus();
      temporary.select();
      copied = document.execCommand('copy');
    } catch (_) {}
  }

  temporary.remove();

  if (copied) {
    toast('전체 OOC를 복사했어요.');
    const button = $('#copyAllOocBtn');
    if (button) {
      const original = button.textContent;
      button.textContent = '전체 복사됨 ✓';
      setTimeout(() => {
        button.textContent = original;
      }, 1300);
    }
  } else {
    toast('자동 복사가 어려워요. 종류별 복사 버튼을 이용해 주세요.');
  }
}

function resetOocPrompts() {
  renderOocCategories(true);
  toast('OOC를 기본값으로 되돌렸어요.');
}

function makeMessageRow(value = '') {
  const row = document.createElement('div');
  row.className = 'message-input-row';
  row.innerHTML = `
    <span class="message-row-number" aria-hidden="true"></span>
    <input class="message-line-input" type="text" maxlength="500" placeholder="보낼 대사를 입력해 주세요." value="${esc(value)}">
    <button type="button" class="message-remove-btn" aria-label="대사 삭제">×</button>
  `;
  return row;
}

function refreshMessageRowNumbers() {
  $$('#messageInputs .message-input-row').forEach((row, i) => {
    const n = row.querySelector('.message-row-number');
    if (n) n.textContent = String(i + 1);
  });
}

function addMessageRow(value = '', focus = false, afterRow = null) {
  const list = $('#messageInputs');
  const row = makeMessageRow(value);

  if (afterRow && afterRow.parentElement === list) {
    afterRow.insertAdjacentElement('afterend', row);
  } else {
    list.appendChild(row);
  }

  refreshMessageRowNumbers();
  if (focus) row.querySelector('.message-line-input')?.focus();
  return row;
}

function setMessageRows(messages = []) {
  const list = $('#messageInputs');
  list.innerHTML = '';
  const values = Array.isArray(messages) && messages.length ? messages : [''];
  values.forEach(v => addMessageRow(v));
}

function getMessageRows() {
  return $$('#messageInputs .message-line-input')
    .map(input => input.value.trim())
    .filter(Boolean);
}

function openGroup(g = null) {
  $('#groupId').value = g?.id || '';
  $('#dialogTitle').textContent = g ? '그룹 편집' : '그룹 추가';
  $('#groupName').value = g?.name || '';
  $('#startTime').value = g?.start || '07:00';
  $('#endTime').value = g?.end || '10:00';
  $('#dailyCount').value = String(g?.dailyCount || 1);
  setMessageRows(g?.messages || []);
  $('#groupEnabled').checked = g ? !!g.enabled : true;
  $('#groupDialog').showModal();
}
function switchTab(id) {
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === id));
  scrollTo({ top: 0, behavior: 'smooth' });
}

function cloudPayload(user, fid) {
  return {
    uid: user.uid,
    deviceId: state.push.deviceId,
    fid,
    active: true,
    timezone: state.settings.timezone || 'Asia/Seoul',
    characters: state.characters.map(c => ({
      id: c.id,
      name: c.name,
      avatar: c.avatar?.startsWith('data:') ? '' : c.avatar,
      enabled: !!c.enabled,
    })),
    groups: state.groups.map(g => ({
      id: g.id,
      characterId: g.characterId,
      name: g.name,
      start: g.start,
      end: g.end,
      dailyCount: Number(g.dailyCount || 1),
      enabled: !!g.enabled,
      messages: Array.isArray(g.messages) ? g.messages : [],
    })),
    updatedAt: serverTimestamp(),
  };
}

function deviceDocId(user) { return `${user.uid}_${state.push.deviceId}`; }

async function ensureFirebase() {
  if (firebaseContextPromise) return firebaseContextPromise;
  firebaseContextPromise = (async () => {
    const app = initializeApp(FIREBASE_CONFIG);
    const auth = getAuth(app);
    if (typeof auth.authStateReady === 'function') await auth.authStateReady();
    let user = auth.currentUser;
    if (!user) user = (await signInAnonymously(auth)).user;
    const db = getFirestore(app);

    let messaging = null;
    if (await isMessagingSupported()) {
      messaging = getMessaging(app);

      onRegistered(messaging, async fid => {
        state.push.fid = fid;
        state.push.connected = true;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        try {
          await setDoc(doc(db, 'pushDevices', deviceDocId(user)), cloudPayload(user, fid), { merge: true });
        } catch (e) {
          console.error('Firestore Push sync failed:', e);
        }
        renderAll();
        startTimer();
        if (pendingFidResolver) {
          pendingFidResolver(fid);
          pendingFidResolver = null;
        }
      });

      onUnregistered(messaging, async fid => {
        try { await deleteDoc(doc(db, 'pushDevices', deviceDocId(user))); } catch (e) { console.warn(e); }
        if (!state.push.fid || state.push.fid === fid) {
          state.push.fid = '';
          state.push.connected = false;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
          renderAll();
          startTimer();
        }
      });

      onMessage(messaging, async payload => {
        const data = payload.data || {};
        const title = payload.notification?.title || data.title || '새 메시지';
        const body = payload.notification?.body || data.body || '';
        try {
          const reg = await navigator.serviceWorker.ready;
          const localCharacter = state.characters.find(c => c.id === data.characterId);
          await reg.showNotification(title, {
            body,
            icon: localCharacter?.avatar || data.icon || './icon-192.png',
            badge: './icon-192.png',
            tag: data.tag || `dear-${Date.now()}`,
            data,
          });
        } catch (e) { console.warn(e); }
        recordRemoteMessage({ ...data, title, body });
      });
    }

    return { app, auth, user, db, messaging };
  })();
  return firebaseContextPromise;
}

async function syncDeviceToFirestore() {
  if (!state.push.connected || !state.push.fid) return;
  const { user, db } = await ensureFirebase();
  await setDoc(doc(db, 'pushDevices', deviceDocId(user)), cloudPayload(user, state.push.fid), { merge: true });
}
function queueCloudSync() {
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => syncDeviceToFirestore().catch(e => console.error('Push data sync failed:', e)), 700);
}

async function syncPush() {
  if (!('serviceWorker' in navigator)) return toast('이 브라우저에서는 알림 연결을 지원하지 않아요.');
  if (!await permission()) return;
  try {
    const { messaging } = await ensureFirebase();
    if (!messaging) return toast('이 브라우저에서는 알림 연결을 사용할 수 없어요.');
    const reg = await navigator.serviceWorker.ready;

    const fidPromise = new Promise(resolve => {
      pendingFidResolver = resolve;
      setTimeout(() => {
        if (pendingFidResolver === resolve) {
          pendingFidResolver = null;
          resolve(state.push.fid || '');
        }
      }, 15000);
    });

    await registerMessaging(messaging, {
      vapidKey: VAPID_PUBLIC_KEY,
      serviceWorkerRegistration: reg,
    });

    const fid = await fidPromise;
    if (!fid) throw new Error('Firebase Installation ID registration timed out');
    state.push.fid = fid;
    state.push.connected = true;
    persist();
    await syncDeviceToFirestore();
    startTimer();
    toast('알림을 연결했어요.');
  } catch (e) {
    console.error(e);
    toast('알림 연결에 실패했어요. 잠시 뒤 다시 시도해 주세요.');
  }
}

async function unsubscribePush() {
  try {
    const { user, db, messaging } = await ensureFirebase();
    try { await deleteDoc(doc(db, 'pushDevices', deviceDocId(user))); } catch (e) { console.warn(e); }
    if (messaging) await unregisterMessaging(messaging);
    state.push.fid = '';
    state.push.connected = false;
    persist();
    startTimer();
    toast('알림 연결을 해제했어요.');
  } catch (e) {
    console.error(e);
    toast('연결 해제 중 오류가 발생했어요.');
  }
}

$$('.tab').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
$$('[data-go]').forEach(b => b.onclick = () => switchTab(b.dataset.go));
$$('[data-close]').forEach(b => b.onclick = () => $('#' + b.dataset.close).close());

$('#permissionBtn').onclick = permission;
$('#testBtn').onclick = test;
$('#runDueBtn').onclick = () => checkDue(true);
$('#addCharacterBtn').onclick = () => openCharacter();
$('#addGroupBtn').onclick = () => openGroup();

$('#oocBtn').onclick = openOocDialog;
$('#closeOocBtn').onclick = closeOocDialog;
$('#resetOocBtn').onclick = resetOocPrompts;
$('#copyAllOocBtn').onclick = copyAllOoc;

$('#oocCategoryList').onclick = e => {
  const button = e.target.closest('[data-copy-category]');
  if (!button) return;

  const key = button.dataset.copyCategory;
  const textarea = document.querySelector(
    `[data-ooc-category="${key}"]`
  );

  copyOocText(textarea, button);
};


$('#addMessageBtn').onclick = () => addMessageRow('', true);

$('#messageInputs').onclick = e => {
  const btn = e.target.closest('.message-remove-btn');
  if (!btn) return;

  const rows = $$('#messageInputs .message-input-row');
  const row = btn.closest('.message-input-row');

  if (rows.length <= 1) {
    const input = row?.querySelector('.message-line-input');
    if (input) {
      input.value = '';
      input.focus();
    }
    return;
  }

  const nextFocus = row?.nextElementSibling?.querySelector('.message-line-input')
    || row?.previousElementSibling?.querySelector('.message-line-input');
  row?.remove();
  refreshMessageRowNumbers();
  nextFocus?.focus();
};

$('#messageInputs').onkeydown = e => {
  const input = e.target.closest('.message-line-input');
  if (!input) return;

  if (e.key === 'Enter') {
    e.preventDefault();
    addMessageRow('', true, input.closest('.message-input-row'));
    return;
  }

  if (e.key === 'Backspace' && !input.value) {
    const row = input.closest('.message-input-row');
    const rows = $$('#messageInputs .message-input-row');
    if (rows.length <= 1) return;
    const prev = row?.previousElementSibling?.querySelector('.message-line-input');
    row?.remove();
    refreshMessageRowNumbers();
    prev?.focus();
  }
};

$('#messageInputs').onpaste = e => {
  const input = e.target.closest('.message-line-input');
  if (!input) return;

  const text = e.clipboardData?.getData('text') || '';
  const lines = text.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  if (lines.length <= 1) return;

  e.preventDefault();

  const row = input.closest('.message-input-row');
  input.value = lines[0];

  let cursor = row;
  lines.slice(1).forEach(line => {
    cursor = addMessageRow(line, false, cursor);
  });

  cursor?.querySelector('.message-line-input')?.focus();
};

$('#avatarFile').onchange = async e => {
  const f = e.target.files?.[0];
  if (!f) return;
  if (f.size > 10 * 1024 * 1024) return toast('이미지는 10MB 이하로 선택해 주세요.');
  try {
    pendingAvatar = await squareAvatarFromFile(f, 256);
    renderAvatarPreview();
  } catch (err) {
    console.error(err);
    toast('프로필 이미지를 불러오지 못했어요.');
  }
};

$('#characterForm').onsubmit = e => {
  e.preventDefault();
  const id = $('#characterId').value, name = $('#characterName').value.trim(), enabled = $('#characterEnabled').checked;
  if (id) {
    const c = state.characters.find(x => x.id === id);
    Object.assign(c, { name, enabled, avatar: pendingAvatar });
  } else {
    const c = { id: uid(), name, enabled, avatar: pendingAvatar };
    state.characters.push(c);
    state.selectedCharacterId = c.id;
  }
  const savedCharacter = id
    ? state.characters.find(x => x.id === id)
    : state.characters.find(x => x.id === state.selectedCharacterId);
  persist();
  if (savedCharacter?.avatar?.startsWith('data:image/')) cacheAvatar(savedCharacter.id, savedCharacter.avatar);
  else if (savedCharacter) removeCachedAvatar(savedCharacter.id);
  $('#characterDialog').close();
  toast('캐릭터를 저장했어요.');
};

$('#characterList').onclick = e => {
  const s = e.target.dataset.selectChar, ed = e.target.dataset.editChar, del = e.target.dataset.deleteChar;
  if (s) { state.selectedCharacterId = s; persist(); }
  if (ed) openCharacter(state.characters.find(c => c.id === ed));
  if (del) {
    if (state.characters.length === 1) return toast('캐릭터는 최소 한 명 필요해요.');
    const c = state.characters.find(x => x.id === del);
    if (confirm(`“${c.name || '이 캐릭터'}”와 연결된 메시지 그룹도 삭제할까요?`)) {
      state.characters = state.characters.filter(x => x.id !== del);
      state.groups = state.groups.filter(g => g.characterId !== del);
      if (state.selectedCharacterId === del) state.selectedCharacterId = state.characters[0].id;
      persist();
    }
  }
};

$('#groupForm').onsubmit = e => {
  e.preventDefault();
  const ms = getMessageRows();
  if (!ms.length) return toast('대사를 한 개 이상 입력해 주세요.');
  const id = $('#groupId').value;
  const d = {
    id: id || uid(), characterId: state.selectedCharacterId,
    name: $('#groupName').value.trim(), start: $('#startTime').value, end: $('#endTime').value,
    dailyCount: +$('#dailyCount').value, enabled: $('#groupEnabled').checked, messages: ms, sentToday: [],
  };
  if (id) {
    const i = state.groups.findIndex(g => g.id === id);
    d.sentToday = state.groups[i]?.sentToday || [];
    state.groups[i] = d;
  } else state.groups.push(d);
  persist();
  $('#groupDialog').close();
  toast('저장했어요.');
};

$('#groupEditorList').onclick = async e => {
  const ed = e.target.dataset.edit, del = e.target.dataset.delete, p = e.target.dataset.preview;
  if (ed) openGroup(state.groups.find(g => g.id === ed));
  if (del) {
    const g = state.groups.find(x => x.id === del);
    if (confirm(`“${g.name}” 그룹을 삭제할까요?`)) {
      state.groups = state.groups.filter(x => x.id !== del);
      persist();
    }
  }
  if (p) {
    const g = state.groups.find(x => x.id === p);
    if (!g.messages.length) return toast('대사를 먼저 추가해 주세요.');
    if (Notification.permission !== 'granted' && !await permission()) return;
    await notify(g, chooseMessage(g));
  }
};

$('#clearHistoryBtn').onclick = () => {
  if (confirm('받은 메시지 기록을 모두 비울까요?')) { state.history = []; persist(); }
};
$('#avoidRecent').onchange = e => { state.settings.avoidRecent = e.target.checked; persist(); };
$('#recentCount').onchange = e => { state.settings.recentCount = Math.max(0, Math.min(20, +e.target.value || 0)); persist(); };
$('#checkInterval').onchange = e => { state.settings.checkInterval = +e.target.value; persist(); startTimer(); };
$('#timezone').onchange = e => { state.settings.timezone = e.target.value.trim() || 'Asia/Seoul'; persist(); };
$('#subscribePushBtn').onclick = syncPush;
$('#unsubscribePushBtn').onclick = unsubscribePush;

$('#exportBtn').onclick = () => {
  const b = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }), a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = `dearly-message-backup-${todayKey()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$('#importFile').onchange = e => {
  const f = e.target.files?.[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try { state = normalize(JSON.parse(r.result)); persist(); startTimer(); toast('백업을 가져왔어요.'); }
    catch { toast('올바른 백업 파일이 아니에요.'); }
  };
  r.readAsText(f);
};

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  $('#installBtn').hidden = false;
});
$('#installBtn').onclick = async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('#installBtn').hidden = true;
};

if ('serviceWorker' in navigator) {
  let reloadingForUpdate = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    location.reload();
  });

  navigator.serviceWorker.register('./sw.js').then(async reg => {
    try { await reg.update(); } catch (_) {}
    await ensureFirebase();
  }).catch(console.error);
}
resetDailyIfNeeded();
renderAll();
startTimer();
consumePushLog();


// 기존 프로필도 한 번 1:1로 정리해 알림에서 눌리지 않게 유지.
normalizeAndCacheAvatars().catch(console.warn);
