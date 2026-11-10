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
