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
// 변동 기록은 90일 동안 남긴다. 저장 공간을 지키려고 개수에도 넉넉한 상한을 둔다.
export const EVENT_KEEP_DAYS = 90;
export const MAX_EVENTS = 5000;
// 날짜별 추이(내 가격·감시 주유소 가격·시 평균)는 1년 남긴다.
export const HISTORY_KEEP_DAYS = 400;
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
    roster: {},
    rosterKey: null,
    stationEvents: [],
    unseenStations: 0,
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
  state.events = pruneEvents([...events, ...base.events], now);

  // 반경 안 주유소 명단: 일반 제품의 반경 검색 결과만 쓴다(시 최저가 목록·면세유는 뺀다).
  const regular = Object.keys(fetched.lists || {}).filter((prod) => PRODUCTS[prod]);
  const nearInfo = {};
  let complete = regular.length > 0;
  for (const prod of regular) {
    const near = fetched.lists[prod].near || [];
    if (!near.length) complete = false;
    for (const station of near) {
      if (!nearInfo[station.id]) nearInfo[station.id] = { name: station.name, brand: station.brand };
    }
  }
  let stationEvents = [];
  if (Object.keys(nearInfo).length) {
    const rosterKey = [...regular].sort().join(',');
    const result = updateRoster(base.roster, nearInfo, now, { complete, reseed: base.rosterKey !== rosterKey });
    state.roster = result.roster;
    state.rosterKey = rosterKey;
    stationEvents = result.events;
  }
  state.stationEvents = pruneStationEvents([...stationEvents, ...(base.stationEvents || [])], now);
  state.fetchedAt = now;
  state.lastError = null;
  return { state, events, stationEvents };
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

// 가격표 검색: 띄어쓰기와 대소문자를 무시하고 이름·상표·주소에서 찾는다.
export function matchesQuery(row, query) {
  const squash = (text) => String(text || '').toLowerCase().replace(/\s+/g, '');
  const needle = squash(query);
  if (!needle) return true;
  return [row.name, BRANDS[row.brand] || row.brand, row.addr].some((text) => squash(text).includes(needle));
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

// ───────── 변동 기록 보관 ─────────

// 오늘을 포함해 EVENT_KEEP_DAYS일 안의 변동만 남긴다. 하루 단위로 자르므로 남은 날은 그날 기록이 온전하다.
export function pruneEvents(events, now) {
  const cutoff = shiftDate(kstDate(now), -(EVENT_KEEP_DAYS - 1));
  return events.filter((event) => kstDate(event.at) >= cutoff).slice(0, MAX_EVENTS);
}

// ───────── CSV ─────────

export function toCsv(rows) {
  const cell = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => row.map(cell).join(',')).join('\r\n');
}

export function eventsCsvRows(events, { stations = {}, watched = [], myId = null } = {}) {
  const watchedSet = new Set(watched || []);
  const rows = [['날짜', '시각', '주유소', '상표', '거리(m)', '제품', '이전 가격', '바뀐 가격', '차이', '구분']];
  for (const event of events) {
    const station = stations[event.id] || {};
    const kind = event.id === myId ? '내 주유소' : watchedSet.has(event.id) ? '감시' : '';
    rows.push([
      kstDate(event.at), kstClock(event.at), station.name || event.name || event.id,
      BRANDS[station.brand] || station.brand || '', station.dist ?? '',
      PRODUCT_NAMES[event.prod] || event.prod, event.from, event.to, event.to - event.from, kind
    ]);
  }
  return rows;
}

// ───────── 날짜별 추이 ─────────
// history = {
//   days: { 'YYYY-MM-DD': { 제품: { p: {주유소: 가격}, avg, min } } }  그날 마지막 확인 때의 내 주유소·감시 주유소 가격
//   area: { 'YYYY-MM-DD': { 제품: 평균가격 } }                          오피넷이 확정한 시·군 일일 평균
//   areaCode, areaUpdatedOn, areaBackfillDone, areaTriedAt
// }

export function emptyHistory() {
  return { days: {}, area: {}, areaCode: null, areaUpdatedOn: null, areaBackfillDone: false, areaTriedAt: 0 };
}

function pruneDates(map, keepFrom) {
  return Object.fromEntries(Object.entries(map || {}).filter(([date]) => date >= keepFrom));
}

// 확인할 때마다 오늘 칸을 덮어쓴다. 하루가 지나면 그날 마지막 값이 남는다.
export function recordDay(history, state, settings, now) {
  const base = { ...emptyHistory(), ...(history || {}) };
  const today = kstDate(now);
  const myId = settings.station ? settings.station.id : null;
  const ids = [myId, ...(settings.watched || [])].filter(Boolean);
  const day = { ...(base.days[today] || {}) };
  for (const prod of settings.products || []) {
    const prices = state.prices[prod];
    if (!prices || !Object.keys(prices).length) continue;
    const p = {};
    for (const id of ids) if (prices[id] !== undefined) p[id] = prices[id];
    day[prod] = {
      p,
      avg: state.average[prod] ? state.average[prod].price : null,
      min: Math.min(...Object.values(prices))
    };
  }
  const keepFrom = shiftDate(today, -(HISTORY_KEEP_DAYS - 1));
  return {
    ...base,
    days: pruneDates({ ...base.days, [today]: day }, keepFrom),
    area: pruneDates(base.area, keepFrom)
  };
}

function isoDate(text) {
  const digits = String(text || '').replace(/\D/g, '');
  return digits.length === 8 ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` : null;
}

// areaAvgRecentPrice.do / dateAreaAvgRecentPrice.do 응답 → { 날짜: { 제품: 평균 } }
export function parseAreaDaily(json) {
  const list = json && json.RESULT && json.RESULT.OIL;
  const result = {};
  if (!Array.isArray(list)) return result;
  for (const raw of list) {
    const date = isoDate(raw.DATE);
    const price = Number(raw.PRICE);
    if (!date || !PRODUCTS[raw.PRODCD] || !Number.isFinite(price) || price <= 0) continue;
    result[date] = { ...(result[date] || {}), [raw.PRODCD]: price };
  }
  return result;
}

// 시·군이 바뀌면 이전 평균은 버린다.
export function mergeArea(history, daily, areaCode) {
  const base = { ...emptyHistory(), ...(history || {}) };
  const area = base.areaCode === areaCode ? { ...base.area } : {};
  for (const [date, prices] of Object.entries(daily)) area[date] = { ...(area[date] || {}), ...prices };
  const reset = base.areaCode !== areaCode;
  return { ...base, area, areaCode, areaBackfillDone: reset ? false : base.areaBackfillDone };
}

// 과거 평균을 채울 때 다음에 물어볼 날짜(YYYYMMDD). 이미 다 채웠으면 null.
export function areaBackfillDate(history, now, days = EVENT_KEEP_DAYS) {
  if (!history || history.areaBackfillDone) return null;
  const dates = Object.keys(history.area || {}).sort();
  if (!dates.length) return shiftDate(kstDate(now), -1).replace(/-/g, '');
  const target = shiftDate(kstDate(now), -days);
  if (dates[0] <= target) return null;
  return shiftDate(dates[0], -1).replace(/-/g, '');
}

// 한 제품의 날짜별 값. dates는 오래된 날부터.
// 변동 기록이 있는 기간은 지금 가격에서 변동을 거꾸로 되돌려 그날 마지막 가격을 구하고,
// 그보다 오래된 날은 저장해 둔 하루 기록을 쓴다.
export function dailySeries(state, history, prod, { myId, watched = [], dates, now }) {
  const today = kstDate(now);
  const hist = { ...emptyHistory(), ...(history || {}) };
  const rivals = (watched || []).filter((id) => id !== myId);
  const oldestEvent = state.events.length ? kstDate(state.events[state.events.length - 1].at) : null;
  const start = oldestEvent || (state.fetchedAt ? kstDate(state.fetchedAt) : null);
  const events = state.events.filter((event) => event.prod === prod);
  const current = { ...(state.prices[prod] || {}) };
  let index = 0;
  const rows = [];
  for (const date of [...dates].sort().reverse()) {
    if (date > today) continue;
    while (index < events.length && kstDate(events[index].at) > date) {
      current[events[index].id] = events[index].from;
      index += 1;
    }
    const snapshot = (hist.days[date] || {})[prod] || null;
    let prices = null;
    if (start && date >= start && Object.keys(current).length) prices = current;
    else if (snapshot) prices = snapshot.p;
    let rival = null;
    let rivalId = null;
    if (prices) {
      for (const id of rivals) {
        const price = prices[id];
        if (price !== undefined && (rival === null || price < rival)) {
          rival = price;
          rivalId = id;
        }
      }
    }
    const areaAvg = (hist.area[date] || {})[prod];
    const nowAvg = date === today && state.average[prod] ? state.average[prod].price : null;
    rows.push({
      date,
      mine: prices && prices[myId] !== undefined ? prices[myId] : null,
      rival,
      rivalId,
      avg: areaAvg ?? nowAvg ?? (snapshot ? snapshot.avg : null)
    });
  }
  return rows.reverse();
}

// 최근 n일 날짜(오래된 날부터).
export function lastDays(now, count) {
  const today = kstDate(now);
  return Array.from({ length: count }, (_, index) => shiftDate(today, index - count + 1));
}

// ───────── 누가 먼저 움직이나 ─────────
// 같은 제품을 같은 방향으로 바꾼 것이 첫 변동에서 3일 안에 이어지면 한 흐름(wave)으로 본다.
// 첫 확인 시각에 바꾼 곳이 "먼저", 뒤에 바꾼 곳이 "따라감"이다. 한 곳만 바꾼 흐름은 "혼자"로 따로 센다.

export const WAVE_WINDOW_MS = 3 * DAY_MS;

function directionOf(event) {
  return Math.sign(event.to - event.from);
}

export function priceWaves(events, prod, ids = null) {
  const moves = events
    .filter((event) => event.prod === prod && event.to !== event.from && (!ids || ids.has(event.id)))
    .sort((a, b) => a.at - b.at);
  const waves = [];
  const open = {};
  for (const event of moves) {
    const dir = directionOf(event);
    let wave = open[dir];
    if (!wave || event.at - wave.start > WAVE_WINDOW_MS) {
      wave = { dir, start: event.at, moves: [] };
      open[dir] = wave;
      waves.push(wave);
    }
    // 한 흐름 안에서 같은 주유소가 또 바꾸면 처음 것만 센다.
    if (!wave.moves.some((move) => move.id === event.id)) wave.moves.push({ id: event.id, at: event.at });
  }
  return waves;
}

function emptyLeadStats(id) {
  return { id, lead: 0, follow: 0, together: 0, solo: 0, leadUp: 0, leadDown: 0, lagSum: 0 };
}

export function leaderStats(events, prod, ids = null) {
  const waves = priceWaves(events, prod, ids);
  const stats = {};
  const get = (id) => (stats[id] = stats[id] || emptyLeadStats(id));
  let shared = 0;
  for (const wave of waves) {
    if (wave.moves.length === 1) {
      get(wave.moves[0].id).solo += 1;
      continue;
    }
    shared += 1;
    const allTogether = wave.moves.every((move) => move.at === wave.start);
    for (const move of wave.moves) {
      const row = get(move.id);
      if (allTogether) row.together += 1;
      else if (move.at === wave.start) {
        row.lead += 1;
        if (wave.dir > 0) row.leadUp += 1;
        else row.leadDown += 1;
      } else {
        row.follow += 1;
        row.lagSum += move.at - wave.start;
      }
    }
  }
  const rows = Object.values(stats).map((row) => {
    const joined = row.lead + row.follow + row.together;
    const leadRate = joined ? row.lead / joined : 0;
    let style = 'few';
    if (joined >= 3) style = leadRate >= 0.5 ? 'leader' : leadRate <= 0.2 && row.follow >= 2 ? 'follower' : 'middle';
    return { ...row, joined, leadRate, avgLag: row.follow ? row.lagSum / row.follow : null, style };
  });
  const order = { leader: 0, middle: 1, follower: 2, few: 3 };
  rows.sort((a, b) => order[a.style] - order[b.style] || b.leadRate - a.leadRate || b.joined - a.joined);
  return {
    rows,
    waves: shared,
    up: waves.filter((wave) => wave.moves.length > 1 && wave.dir > 0).length,
    down: waves.filter((wave) => wave.moves.length > 1 && wave.dir < 0).length
  };
}

// 내가 가격을 바꾼 뒤 3일 안에 같은 방향으로 따라 바꾼 주유소.
export function reactionsTo(events, prod, myId, ids) {
  const list = events.filter((event) => event.prod === prod && event.to !== event.from).sort((a, b) => a.at - b.at);
  const mine = list.filter((event) => event.id === myId);
  const count = { up: mine.filter((event) => directionOf(event) > 0).length, down: mine.filter((event) => directionOf(event) < 0).length };
  const rows = {};
  for (const id of ids) {
    if (id === myId) continue;
    rows[id] = { id, up: { followed: 0, lagSum: 0 }, down: { followed: 0, lagSum: 0 } };
  }
  for (const move of mine) {
    const dir = directionOf(move);
    const key = dir > 0 ? 'up' : 'down';
    const answered = new Set();
    for (const event of list) {
      if (event.at <= move.at) continue;
      if (event.at - move.at > WAVE_WINDOW_MS) break;
      if (!rows[event.id] || answered.has(event.id) || directionOf(event) !== dir) continue;
      answered.add(event.id);
      rows[event.id][key].followed += 1;
      rows[event.id][key].lagSum += event.at - move.at;
    }
  }
  const result = Object.values(rows).map((row) => ({
    id: row.id,
    up: { followed: row.up.followed, avgLag: row.up.followed ? row.up.lagSum / row.up.followed : null },
    down: { followed: row.down.followed, avgLag: row.down.followed ? row.down.lagSum / row.down.followed : null }
  }));
  result.sort((a, b) => (b.down.followed + b.up.followed) - (a.down.followed + a.up.followed));
  return { count, rows: result };
}

// 3시간, 1.5일
export function lagText(ms) {
  if (ms === null || ms === undefined) return '';
  const hours = ms / HOUR_MS;
  if (hours < 24) return `${Math.max(1, Math.round(hours))}시간`;
  const days = Math.round((hours / 24) * 10) / 10;
  return `${days}일`;
}

// ───────── 반경 안 주유소 변화 ─────────
// state.roster = { id: { name, brand, firstSeen, lastSeen, gone } }
// state.stationEvents = [{ at, id, name, kind, from, to }]  최신순. kind: new | gone | back | brand | rename

export const GONE_AFTER_MS = 2 * DAY_MS;
export const STATION_EVENT_KEEP_DAYS = 365;
const MAX_STATION_EVENTS = 500;

export const STATION_EVENT_NAMES = {
  new: '새 주유소',
  gone: '목록에서 사라짐',
  back: '다시 나타남',
  brand: '상표 변경',
  rename: '상호 변경'
};

// near: { id: { name, brand } }  이번 확인에서 반경 안에 나온 주유소.
// complete: 모든 일반 제품의 반경 검색이 비지 않고 왔을 때만 사라진 곳을 따진다.
// reseed: 제품 구성이 바뀌는 등 비교 기준이 달라졌으면 알림 없이 명단을 새로 만든다.
export function updateRoster(roster, near, now, { complete = true, reseed = false } = {}) {
  const base = roster || {};
  if (reseed || !Object.keys(base).length) {
    const next = {};
    for (const [id, info] of Object.entries(near)) {
      const known = base[id];
      next[id] = {
        name: info.name || (known && known.name) || '',
        brand: info.brand || (known && known.brand) || '',
        firstSeen: known ? known.firstSeen : now,
        lastSeen: now
      };
    }
    return { roster: next, events: [] };
  }
  const next = { ...base };
  const events = [];
  for (const [id, info] of Object.entries(near)) {
    const known = base[id];
    if (!known) {
      next[id] = { name: info.name || '', brand: info.brand || '', firstSeen: now, lastSeen: now };
      events.push({ at: now, id, name: info.name || id, kind: 'new', to: info.brand || '' });
      continue;
    }
    const entry = { ...known, lastSeen: now };
    if (known.gone) {
      delete entry.gone;
      events.push({ at: now, id, name: info.name || known.name || id, kind: 'back' });
    }
    if (info.brand && known.brand && info.brand !== known.brand) {
      events.push({ at: now, id, name: info.name || known.name || id, kind: 'brand', from: known.brand, to: info.brand });
    }
    if (info.name && known.name && info.name !== known.name) {
      events.push({ at: now, id, name: info.name, kind: 'rename', from: known.name, to: info.name });
    }
    entry.name = info.name || known.name || '';
    entry.brand = info.brand || known.brand || '';
    next[id] = entry;
  }
  if (complete) {
    for (const [id, entry] of Object.entries(next)) {
      if (near[id] || entry.gone) continue;
      if (now - entry.lastSeen >= GONE_AFTER_MS) {
        next[id] = { ...entry, gone: now };
        events.push({ at: now, id, name: entry.name || id, kind: 'gone' });
      }
    }
  }
  return { roster: next, events };
}

export function pruneStationEvents(events, now) {
  const cutoff = shiftDate(kstDate(now), -(STATION_EVENT_KEEP_DAYS - 1));
  return events.filter((event) => kstDate(event.at) >= cutoff).slice(0, MAX_STATION_EVENTS);
}

export function stationEventText(event) {
  const label = STATION_EVENT_NAMES[event.kind] || event.kind;
  const brand = (code) => BRANDS[code] || code || '';
  if (event.kind === 'brand') return `${event.name} ${label}: ${brand(event.from)} → ${brand(event.to)}`;
  if (event.kind === 'rename') return `${label}: ${event.from} → ${event.to}`;
  if (event.kind === 'new' && event.to) return `${label}: ${event.name} (${brand(event.to)})`;
  return `${label}: ${event.name}`;
}

// ───────── 주유소 상세 정보(detailById) ─────────
// stationDetails = { items: { id: { at, tel, wash, cvs, maint, kpetro, good, good5, lpg, brand } }, calls: {date, count} }

export const DETAIL_REFRESH_DAYS = 90;
export const DETAIL_RETRY_DAYS = 7;
export const DETAIL_PER_RUN = 12;
export const DETAIL_PER_DAY = 60;

export function emptyDetails() {
  return { items: {}, calls: null };
}

export function parseDetail(json, now) {
  const list = json && json.RESULT && json.RESULT.OIL;
  const raw = Array.isArray(list) ? list[0] : null;
  if (!raw || !raw.UNI_ID) return null;
  const yes = (...values) => values.some((value) => String(value ?? '').trim().toUpperCase() === 'Y');
  return {
    at: now,
    tel: String(raw.TEL || '').trim(),
    wash: yes(raw.CAR_WASH_YN),
    cvs: yes(raw.CVS_YN, raw.CYS_YN),
    maint: yes(raw.MAINT_YN),
    kpetro: yes(raw.KPETRO_YN),
    good: yes(raw.GOOD_YN),
    good5: yes(raw.GOOD_YN_5, raw.GOOD_YN5),
    lpg: String(raw.LPG_YN || '').trim().toUpperCase(),
    brand: String(raw.POLL_DIV_CD || '').trim()
  };
}

export function detailFeatures(detail) {
  if (!detail || detail.missing) return [];
  const list = [];
  if (detail.wash) list.push('세차');
  if (detail.cvs) list.push('편의점');
  if (detail.maint) list.push('경정비');
  if (detail.lpg === 'C') list.push('LPG 충전');
  if (detail.kpetro) list.push('품질인증');
  if (detail.good5) list.push('착하디 착한주유소');
  else if (detail.good) list.push('착한주유소');
  return list;
}

// 상세 정보를 받아야 할 주유소. 감시 주유소 먼저, 그다음 가까운 순.
export function detailQueue(roster, items, { watched = [], stations = {}, now }) {
  const watchedSet = new Set(watched || []);
  const ids = Object.entries(roster || {})
    .filter(([id, entry]) => {
      if (entry.gone) return false;
      const detail = (items || {})[id];
      if (!detail) return true;
      const age = now - detail.at;
      if (detail.missing) return age >= DETAIL_RETRY_DAYS * DAY_MS;
      if (entry.brand && detail.brand && entry.brand !== detail.brand) return true;
      return age >= DETAIL_REFRESH_DAYS * DAY_MS;
    })
    .map(([id]) => id);
  const dist = (id) => ((stations[id] || {}).dist ?? Infinity);
  return ids.sort((a, b) => Number(watchedSet.has(b)) - Number(watchedSet.has(a)) || dist(a) - dist(b));
}

// 오늘 남은 정기 확인 수.
export function slotsLeftToday(now) {
  const dayStart = Math.floor((now + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS;
  return UPDATE_HOURS.filter((hour) => dayStart + hour * HOUR_MS + SLOT_DELAY_MS > now).length;
}

// 이번에 상세 정보를 몇 곳 받을지. 오늘 남은 정기 확인과 수동 확인 한 번, 여유 10건을 먼저 남겨 둔다.
export function detailBudget({ callsToday: used, detailsToday, perCheck, now }) {
  const reserve = perCheck * (slotsLeftToday(now) + 1) + 10;
  return Math.max(0, Math.min(DETAIL_PER_RUN, DETAIL_PER_DAY - detailsToday, SAFE_LIMIT - used - reserve));
}

// ───────── 백업·복원 ─────────

export const BACKUP_APP = 'fuel-price-watch';
export const BACKUP_KEYS = ['settings', 'state', 'history', 'stationDetails', 'paused'];

export function makeBackup(stored, { version, now }) {
  const data = {};
  for (const key of BACKUP_KEYS) if (stored[key] !== undefined) data[key] = stored[key];
  return { app: BACKUP_APP, version, exportedAt: now, data };
}

export function readBackup(text) {
  let json;
  try {
    json = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch {
    throw new Error('백업 파일을 읽지 못했습니다. 이 확장에서 저장한 .json 파일인지 확인해 주세요.');
  }
  if (!json || json.app !== BACKUP_APP || !json.data || typeof json.data !== 'object') {
    throw new Error('이 확장의 백업 파일이 아닙니다.');
  }
  const data = {};
  for (const key of BACKUP_KEYS) if (json.data[key] !== undefined) data[key] = json.data[key];
  if (!data.settings || typeof data.settings !== 'object') throw new Error('백업 파일에 설정이 없습니다.');
  const state = data.state || {};
  const history = data.history || {};
  return {
    data,
    summary: {
      version: json.version || '',
      exportedAt: Number(json.exportedAt) || null,
      station: data.settings.station ? data.settings.station.name : '',
      events: Array.isArray(state.events) ? state.events.length : 0,
      days: Object.keys(history.days || {}).length,
      stations: Object.keys(state.roster || {}).length,
      details: Object.keys((data.stationDetails && data.stationDetails.items) || {}).length
    }
  };
}
