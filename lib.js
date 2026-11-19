// 화면과 백그라운드가 함께 쓰는 순수 계산 함수. chrome API를 쓰지 않아 node에서 바로 테스트한다.

export const PRODUCTS = {
  B027: '휘발유',
  D047: '경유',
  B034: '고급휘발유',
  C004: '등유'
};

export const TAXFREE_PRODUCTS = {
  B127: '면세휘발유',
  D147: '면세경유',
  C104: '면세등유'
};

export const PRODUCT_NAMES = { ...PRODUCTS, ...TAXFREE_PRODUCTS };

export const BRANDS = {
  SKE: 'SK에너지',
  GSC: 'GS칼텍스',
  HDO: 'HD현대오일뱅크',
  SOL: 'S-OIL',
  RTO: '알뜰',
  RTX: '알뜰(ex)',
  NHO: 'NH-OIL',
  ETC: '자가상표'
};

// 오피넷이 현재 판매가격을 갱신하는 시각(한국 시간). 갱신 뒤 10분 여유를 두고 확인한다.
export const UPDATE_HOURS = [1, 2, 9, 12, 16, 19];
export const SLOT_DELAY_MS = 10 * 60 * 1000;
export const DAILY_LIMIT = 300;
export const SAFE_LIMIT = 280;
export const MAX_EVENTS = 300;
export const DEFAULT_WATCH_RADIUS = 1500;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_SETTINGS = {
  apiKey: '',
  station: null, // {id, name, x, y}
  radius: 5000,
  extraCenters: [], // 내 주유소 말고 주변을 더 조사할 중심 [{id, name, x, y}]
  city: null, // {code, name}
  taxfreeArea: null, // {code, name}
  products: ['B027', 'D047', 'B034', 'C004'],
  taxfreeProducts: ['B127', 'D147', 'C104'],
  notify: true,
  watched: null // null이면 첫 수집 때 가까운 주유소로 채운다
};

export function emptyState() {
  return {
    fetchedAt: 0,
    stations: {},
    prices: {},
    changes: {},
    top: {},
    average: {},
    events: [],
    unseen: 0,
    lastError: null
  };
}

export function kstDate(ms) {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function formatKst(ms) {
  const iso = new Date(ms + KST_OFFSET_MS).toISOString();
  return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))} ${iso.slice(11, 16)}`;
}

export function kstClock(ms) {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(11, 16);
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function shiftDate(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function relativeDay(date, now) {
  if (date === kstDate(now)) return '오늘';
  if (date === kstDate(now - DAY_MS)) return '어제';
  return '';
}

// 'YYYY-MM-DD'(한국 날짜)의 이름표. now 기준으로 오늘·어제를 붙인다.
export function dayLabel(date, now) {
  const [y, m, d] = date.split('-').map(Number);
  const weekdayIndex = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const weekday = WEEKDAYS[weekdayIndex];
  return {
    date,
    month: m,
    day: d,
    weekday,
    weekend: weekdayIndex === 0 ? 'sun' : weekdayIndex === 6 ? 'sat' : '',
    relative: relativeDay(date, now),
    text: `${m}월 ${d}일 (${weekday})`
  };
}

// 짧은 시각: 오늘 09:10, 어제 19:10, 11/17 09:10
export function formatWhen(ms, now) {
  const date = kstDate(ms);
  const prefix = relativeDay(date, now) || `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  return `${prefix} ${kstClock(ms)}`;
}

// 오늘에서 끝나는 날짜 칸. 가장 오래된 변동 날짜까지 늘리되 min~max일 사이로 둔다. 오래된 날이 앞이다.
export function dayRange(oldest, now, { min = 7, max = 14 } = {}) {
  const today = kstDate(now);
  let span = min;
  if (oldest && oldest < today) {
    const between = Math.round((Date.parse(today) - Date.parse(oldest)) / DAY_MS) + 1;
    span = Math.min(max, Math.max(min, between));
  }
  return Array.from({ length: span }, (_, index) => shiftDate(today, index - span + 1));
}

export function eventKey(event) {
  return `${event.at}|${event.id}|${event.prod}`;
}

// 최신순 변동 기록을 날짜 → 확인 시각 → 주유소로 묶는다.
// 한 번 확인할 때 한 주유소가 여러 제품을 바꿨으면 한 항목에 모은다.
export function groupEventsByDay(events) {
  const days = [];
  for (const event of events) {
    const date = kstDate(event.at);
    let day = days[days.length - 1];
    if (!day || day.date !== date) {
      day = { date, slots: [], up: 0, down: 0, stations: 0, ids: new Set() };
      days.push(day);
    }
    let slot = day.slots[day.slots.length - 1];
    if (!slot || slot.at !== event.at) {
      slot = { at: event.at, entries: [] };
      day.slots.push(slot);
    }
    let entry = slot.entries.find((item) => item.id === event.id);
    if (!entry) {
      entry = { id: event.id, name: event.name, changes: [] };
      slot.entries.push(entry);
    }
    const delta = event.to - event.from;
    entry.changes.push({ prod: event.prod, from: event.from, to: event.to, delta, key: eventKey(event) });
    if (delta > 0) day.up += 1;
    else if (delta < 0) day.down += 1;
    day.ids.add(event.id);
  }
  const order = Object.keys(PRODUCT_NAMES);
  const rank = (prod) => (order.includes(prod) ? order.indexOf(prod) : order.length);
  for (const day of days) {
    day.stations = day.ids.size;
    delete day.ids;
    for (const slot of day.slots) {
      for (const entry of slot.entries) entry.changes.sort((a, b) => rank(a.prod) - rank(b.prod));
    }
  }
  return days;
}

// now 이전에 지나간 가장 최근 확인 시각.
export function latestSlotAt(now) {
  const shifted = now + KST_OFFSET_MS;
  const dayStart = Math.floor(shifted / DAY_MS) * DAY_MS - KST_OFFSET_MS;
  let latest = 0;
  for (const base of [dayStart - DAY_MS, dayStart]) {
    for (const hour of UPDATE_HOURS) {
      const slot = base + hour * HOUR_MS + SLOT_DELAY_MS;
      if (slot <= now && slot > latest) latest = slot;
    }
  }
  return latest;
}

export function shouldFetch(fetchedAt, now) {
  return !fetchedAt || fetchedAt < latestSlotAt(now);
}

export function bumpCalls(calls, now, amount = 1) {
  const date = kstDate(now);
  const count = calls && calls.date === date ? calls.count : 0;
  return { date, count: count + amount };
}

export function callsToday(calls, now) {
  return calls && calls.date === kstDate(now) ? calls.count : 0;
}

export function distanceBetween(a, b) {
  if (!a || !b) return null;
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  return Math.round(Math.hypot(dx, dy));
}

// 오피넷 응답(반경 내 검색, 최저가 20곳, 면세유 최저가 20곳)을 같은 모양으로 바꾼다.
export function parseStations(json, origin = null) {
  const list = json && json.RESULT && json.RESULT.OIL;
  if (!Array.isArray(list)) return [];
  const result = [];
  for (const raw of list) {
    const id = String(raw.UNI_ID || '').trim();
    const price = Number(raw.PRICE);
    if (!id || !Number.isFinite(price) || price <= 0) continue;
    const x = Number(raw.GIS_X_COOR);
    const y = Number(raw.GIS_Y_COOR);
    const reported = Number(raw.DISTANCE);
    // origin을 주면 응답의 거리(조사 중심 기준) 대신 내 주유소 기준 거리를 좌표로 다시 잰다.
    const dist = !origin && raw.DISTANCE !== undefined && Number.isFinite(reported)
      ? Math.round(reported)
      : distanceBetween(origin, { x, y });
    result.push({
      id,
      name: String(raw.OS_NM || '').trim(),
      brand: String(raw.POLL_DIV_CD || '').trim(),
      addr: String(raw.NEW_ADR || raw.VAN_ADR || '').trim(),
      price,
      dist
    });
  }
  return result;
}

// 한 번 확인할 때 쓰는 오피넷 호출 수.
export function callsPerCheck(settings) {
  const regular = (settings.products || []).length;
  const centers = 1 + (settings.extraCenters || []).length;
  const taxfree = settings.taxfreeArea ? (settings.taxfreeProducts || []).length : 0;
  return regular * (centers + (settings.city ? 1 : 0)) + taxfree + (settings.city ? 1 : 0);
}

export function parseAverages(json) {
  const list = json && json.RESULT && json.RESULT.OIL;
  const result = {};
  if (!Array.isArray(list)) return result;
  for (const raw of list) {
    const price = Number(raw.PRICE);
    if (!raw.PRODCD || !Number.isFinite(price)) continue;
    result[raw.PRODCD] = { price, diff: Number(raw.DIFF) || 0 };
  }
  return result;
}

// fetched: { lists: {제품: {near: [], top: []}}, average: {제품: {price, diff}} }
// 응답이 비어 있는 제품은 이전 값을 그대로 둔다.
export function mergeSnapshot(prev, fetched, now) {
  const base = { ...emptyState(), ...(prev || {}) };
  const state = {
    ...base,
    stations: { ...base.stations },
    prices: { ...base.prices },
    changes: { ...base.changes },
    top: { ...base.top },
    average: { ...base.average, ...(fetched.average || {}) }
  };
  const events = [];
  for (const [prod, lists] of Object.entries(fetched.lists || {})) {
    const near = lists.near || [];
    const top = lists.top || [];
    if (!near.length && !top.length) continue;
    const before = state.prices[prod] || {};
    const after = {};
    const changes = { ...(state.changes[prod] || {}) };
    for (const station of [...near, ...top]) {
      const known = state.stations[station.id] || {};
      state.stations[station.id] = {
        name: station.name || known.name || '',
        brand: station.brand || known.brand || '',
        addr: station.addr || known.addr || '',
        dist: station.dist ?? known.dist ?? null
      };
      if (after[station.id] !== undefined) continue;
      after[station.id] = station.price;
      const old = before[station.id];
      if (old !== undefined && old !== station.price) {
        changes[station.id] = { from: old, at: now };
        events.push({ at: now, id: station.id, name: station.name, prod, from: old, to: station.price });
      }
    }
    state.prices[prod] = after;
    state.changes[prod] = changes;
    if (top.length) state.top[prod] = top.map((station) => station.id);
  }
  state.events = [...events, ...base.events].slice(0, MAX_EVENTS);
  state.fetchedAt = now;
  state.lastError = null;
  return { state, events };
}

export function defaultWatched(state, myId, radius = DEFAULT_WATCH_RADIUS) {
  return Object.entries(state.stations)
    .filter(([id, station]) => id !== myId && station.dist !== null && station.dist <= radius)
    .sort((a, b) => a[1].dist - b[1].dist)
    .map(([id]) => id);
}

// 한 제품의 표 내용과 요약.
export function summarize(state, prod, myId, watched = []) {
  const prices = state.prices[prod] || {};
  const top = state.top[prod] || [];
  const watchedSet = new Set(watched || []);
  const mine = prices[myId];
  const rows = Object.entries(prices).map(([id, price]) => {
    const station = state.stations[id] || {};
    const topIndex = top.indexOf(id);
    return {
      id,
      name: station.name || id,
      brand: station.brand || '',
      addr: station.addr || '',
      dist: station.dist ?? null,
      price,
      diff: mine === undefined ? null : price - mine,
      change: (state.changes[prod] || {})[id] || null,
      topRank: topIndex < 0 ? null : topIndex + 1,
      mine: id === myId,
      watched: watchedSet.has(id)
    };
  });
  const all = rows.map((row) => row.price);
  const cheaper = mine === undefined ? null : rows.filter((row) => row.price < mine).length;
  const lowest = rows.reduce((best, row) => (!best || row.price < best.price ? row : best), null);
  return {
    rows,
    mine: mine ?? null,
    count: rows.length,
    rank: cheaper === null ? null : cheaper + 1,
    lowest,
    listAverage: all.length ? all.reduce((sum, price) => sum + price, 0) / all.length : null,
    cityAverage: state.average[prod] || null
  };
}

export function sortRows(rows, mode) {
  const copy = [...rows];
  if (mode === 'dist') {
    copy.sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity) || a.price - b.price);
  } else {
    copy.sort((a, b) => a.price - b.price || (a.dist ?? Infinity) - (b.dist ?? Infinity));
  }
  return copy;
}

export function watchedEvents(events, watched) {
  const set = new Set(watched || []);
  return events.filter((event) => set.has(event.id));
}

export function eventText(event) {
  const delta = event.to - event.from;
  const mark = delta > 0 ? `▲${delta}` : `▼${-delta}`;
  return `${event.name} ${PRODUCT_NAMES[event.prod] || event.prod} ${won(event.from)} → ${won(event.to)} (${mark})`;
}

// 툴바 배지: 첫 번째 제품 기준으로 감시 주유소 최저가와 내 가격의 차이.
export function badgeInfo(state, settings) {
  const prod = (settings.products || [])[0];
  const myId = settings.station && settings.station.id;
  const prices = state.prices[prod] || {};
  const mine = prices[myId];
  const rivals = (settings.watched || []).map((id) => prices[id]).filter((price) => price !== undefined);
  const unseen = state.unseen || 0;
  if (mine === undefined || !rivals.length) {
    return { text: unseen ? String(unseen) : '', alert: unseen > 0, title: '주유소 가격 감시' };
  }
  const diff = mine - Math.min(...rivals);
  const name = PRODUCT_NAMES[prod];
  const position = diff > 0 ? `${diff}원 비쌈` : diff < 0 ? `${-diff}원 쌈` : '같음';
  const title = `${name}: 감시 주유소 최저가보다 ${position}` + (unseen ? ` · 새 가격 변동 ${unseen}건` : '');
  return { text: diff > 0 ? `+${diff}` : String(diff), alert: unseen > 0, title };
}

export function won(value) {
  return Math.round(value).toLocaleString('ko-KR');
}

export function formatDistance(meters) {
  if (meters === null || meters === undefined) return '';
  return meters < 1000 ? `${meters}m` : `${(meters / 1000).toFixed(1)}km`;
}
