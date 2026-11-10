import {
  DEFAULT_SETTINGS,
  SAFE_LIMIT,
  badgeInfo,
  bumpCalls,
  callsToday,
  defaultWatched,
  emptyState,
  eventText,
  mergeSnapshot,
  parseAverages,
  parseStations,
  shouldFetch,
  watchedEvents
} from './lib.js';

const API_BASE = 'https://www.opinet.co.kr/api/';
const ALARM_NAME = 'price-check';
const ALARM_PERIOD_MINUTES = 15;
const MANUAL_GAP_MS = 5 * 60 * 1000;
const NOTIFICATION_ID = 'price-change';

let inflight = null;

chrome.runtime.onInstalled.addListener(() => { void start(); });
chrome.runtime.onStartup.addListener(() => { void start(); });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) refresh({ force: false }).catch(() => {});
});

chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  chrome.action.openPopup().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: describe(error) }));
  return true;
});

async function handleMessage(message) {
  switch (message && message.type) {
    case 'refresh':
      return refresh({ force: true });
    case 'seen':
      return markSeen();
    case 'toggleWatch':
      return toggleWatch(message.id);
    case 'searchStation':
      return { stations: await searchStation(message.name) };
    case 'listAreas':
      return { areas: await listAreas(message.sido) };
    case 'settingsChanged':
      if (message.reset) await chrome.storage.local.set({ state: emptyState() });
      return refresh({ force: true, ignoreGap: true });
    default:
      throw new Error('알 수 없는 요청입니다.');
  }
}

async function start() {
  await ensureSettings();
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  await refresh({ force: false }).catch(() => {});
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function getState() {
  const { state } = await chrome.storage.local.get('state');
  return { ...emptyState(), ...(state || {}) };
}

// 처음 설치했을 때 local-config.json(저장소에 올리지 않는 파일)이 있으면 그 값으로 시작한다.
async function ensureSettings() {
  const settings = await getSettings();
  const { settings: saved } = await chrome.storage.local.get('settings');
  // 조사 중심 항목이 없던 이전 버전의 설정이면 local-config.json의 값을 한 번 가져온다.
  const centersUnset = !saved || saved.extraCenters === undefined;
  if (settings.apiKey && settings.station && !centersUnset) return settings;
  try {
    const response = await fetch(chrome.runtime.getURL('local-config.json'));
    const local = response.ok ? await response.json() : {};
    const merged = { ...settings };
    for (const key of ['apiKey', 'station', 'city', 'taxfreeArea', 'radius']) {
      if (!merged[key] && local[key]) merged[key] = local[key];
    }
    if (centersUnset && Array.isArray(local.extraCenters)) merged.extraCenters = local.extraCenters;
    await chrome.storage.local.set({ settings: merged });
    return merged;
  } catch {
    return settings;
  }
}

async function callApi(path, params, apiKey) {
  const now = Date.now();
  const { calls } = await chrome.storage.local.get('calls');
  if (callsToday(calls, now) >= SAFE_LIMIT) {
    throw new Error(`오늘 오피넷 호출이 ${SAFE_LIMIT}건을 넘어 내일까지 멈춥니다.`);
  }
  await chrome.storage.local.set({ calls: bumpCalls(calls, now) });
  const url = new URL(path, API_BASE);
  url.search = new URLSearchParams({ code: apiKey, out: 'json', ...params }).toString();
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`오피넷 응답 오류 (${response.status})`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('오피넷 응답을 읽지 못했습니다. API 키와 호출 한도를 확인해 주세요.');
  }
}

function refresh(options) {
  if (!inflight) {
    inflight = runRefresh(options).finally(() => { inflight = null; });
  }
  return inflight;
}

async function runRefresh({ force, ignoreGap = false }) {
  const settings = await ensureSettings();
  const state = await getState();
  const now = Date.now();
  if (!settings.apiKey || !settings.station) {
    return { skipped: true, reason: '설정에서 API 키와 내 주유소를 먼저 정해 주세요.' };
  }
  if (!force && !shouldFetch(state.fetchedAt, now)) return { skipped: true };
  if (force && !ignoreGap && state.fetchedAt && now - state.fetchedAt < MANUAL_GAP_MS) {
    return { skipped: true, reason: '방금 확인했습니다. 5분 뒤에 다시 눌러 주세요.' };
  }

  try {
    const fetched = await fetchAll(settings);
    const hasData = Object.values(fetched.lists).some((lists) => lists.near.length || lists.top.length);
    if (!hasData) throw new Error('오피넷에서 가격을 받지 못했습니다. API 키와 호출 한도를 확인해 주세요.');

    const { state: next, events } = mergeSnapshot(state, fetched, now);
    let watched = settings.watched;
    if (!Array.isArray(watched)) {
      watched = defaultWatched(next, settings.station.id);
      await chrome.storage.local.set({ settings: { ...settings, watched } });
    }
    const alerts = watchedEvents(events, watched);
    next.unseen = (state.unseen || 0) + alerts.length;
    await chrome.storage.local.set({ state: next });
    await updateBadge(next, { ...settings, watched });
    if (settings.notify && alerts.length) notify(alerts);
    return { changed: events.length };
  } catch (error) {
    const failed = { ...(await getState()), lastError: { at: now, message: describe(error) } };
    await chrome.storage.local.set({ state: failed });
    throw error;
  }
}

async function fetchAll(settings) {
  const { apiKey, station } = settings;
  const origin = { x: station.x, y: station.y };
  const lists = {};
  for (const prod of settings.products) {
    const near = parseStations(await callApi('aroundAll.do', {
      x: station.x, y: station.y, radius: settings.radius, sort: 2, prodcd: prod
    }, apiKey));
    // 추가 조사 중심의 결과는 뒤에 붙인다. 겹치는 주유소는 합칠 때 앞의 것만 쓴다.
    for (const center of settings.extraCenters || []) {
      near.push(...parseStations(await callApi('aroundAll.do', {
        x: center.x, y: center.y, radius: settings.radius, sort: 2, prodcd: prod
      }, apiKey), origin));
    }
    const top = settings.city
      ? parseStations(await callApi('lowTop10.do', { prodcd: prod, area: settings.city.code, cnt: 20 }, apiKey), origin)
      : [];
    lists[prod] = { near, top };
  }
  if (settings.taxfreeArea) {
    for (const prod of settings.taxfreeProducts) {
      const top = parseStations(await callApi('taxfreeLowTop20.do', {
        prodcd: prod, area: settings.taxfreeArea.code, cnt: 20
      }, apiKey), origin);
      lists[prod] = { near: [], top };
    }
  }
  let average = {};
  if (settings.city) {
    const code = settings.city.code;
    average = parseAverages(await callApi('avgSigunPrice.do', { sido: code.slice(0, 2), sigun: code }, apiKey));
  }
  return { lists, average };
}

async function updateBadge(state, settings) {
  const badge = badgeInfo(state, settings);
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: badge.alert ? '#c5221f' : '#5f6368' });
  await chrome.action.setTitle({ title: badge.title });
}

function notify(alerts) {
  const lines = alerts.slice(0, 4).map(eventText);
  if (alerts.length > 4) lines.push(`외 ${alerts.length - 4}건`);
  chrome.notifications.create(NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `가격 변동 ${alerts.length}건`,
    message: lines.join('\n'),
    priority: 1
  });
}

async function markSeen() {
  const state = await getState();
  if (state.unseen) {
    state.unseen = 0;
    await chrome.storage.local.set({ state });
  }
  await updateBadge(state, await getSettings());
  return {};
}

async function toggleWatch(id) {
  const settings = await getSettings();
  const watched = new Set(settings.watched || []);
  if (watched.has(id)) watched.delete(id);
  else watched.add(id);
  const next = { ...settings, watched: [...watched] };
  await chrome.storage.local.set({ settings: next });
  await updateBadge(await getState(), next);
  return { watched: next.watched };
}

async function searchStation(name) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('API 키를 먼저 저장해 주세요.');
  const json = await callApi('searchByName.do', { osnm: String(name || '').trim() }, settings.apiKey);
  const list = (json.RESULT && json.RESULT.OIL) || [];
  return list.map((raw) => ({
    id: raw.UNI_ID,
    name: String(raw.OS_NM || '').trim(),
    addr: String(raw.NEW_ADR || raw.VAN_ADR || '').trim(),
    sigun: raw.SIGUNCD,
    x: Number(raw.GIS_X_COOR),
    y: Number(raw.GIS_Y_COOR)
  }));
}

async function listAreas(sido) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('API 키를 먼저 저장해 주세요.');
  const json = await callApi('areaCode.do', sido ? { area: sido } : {}, settings.apiKey);
  const list = (json.RESULT && json.RESULT.OIL) || [];
  return list.map((raw) => ({ code: raw.AREA_CD, name: String(raw.AREA_NM || '').trim() }));
}

function describe(error) {
  return error && error.message ? error.message : String(error);
}
