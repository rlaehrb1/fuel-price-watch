import {
  BRANDS,
  DAILY_LIMIT,
  DEFAULT_SETTINGS,
  EVENT_KEEP_DAYS,
  PRODUCTS,
  PRODUCT_NAMES,
  STATION_EVENT_NAMES,
  TAXFREE_PRODUCTS,
  callsToday,
  dailySeries,
  dayLabel,
  dayRange,
  detailFeatures,
  emptyDetails,
  emptyHistory,
  emptyState,
  eventKey,
  eventsCsvRows,
  formatDistance,
  formatKst,
  formatWhen,
  groupEventsByDay,
  kstClock,
  kstDate,
  lagText,
  lastDays,
  leaderStats,
  matchesQuery,
  reactionsTo,
  sortRows,
  summarize,
  toCsv,
  won
} from './lib.js';

const TAXFREE_TAB = 'taxfree';
const ALL_TAB = 'all';
const PREFS_KEY = 'popupPrefs';
const RANGES = [14, 30, 90];
const SVG_NS = 'http://www.w3.org/2000/svg';
const SERIES = [['mine', '내 가격'], ['rival', '감시 최저가'], ['avg', '시 평균']];
const $ = (id) => document.getElementById(id);

const view = {
  settings: { ...DEFAULT_SETTINGS },
  state: emptyState(),
  history: emptyHistory(),
  details: emptyDetails(),
  calls: null,
  paused: false,
  mode: 'prices', // prices | changes | trend | rivals
  tab: null,
  changeTab: ALL_TAB,
  trendTab: null,
  rivalTab: null,
  rivalPart: 'lead', // lead | roster
  leadScope: 'watched', // watched | all
  newStations: 0,
  range: 30,
  trendSeries: [],
  taxfreeProd: null,
  sort: 'price',
  filter: 'all',
  query: '', // 가격표 주유소 검색어
  scope: 'all', // 변동 보기: all | watched
  openRow: null,
  jumpTo: null,
  activeDay: null,
  newKeys: new Set(),
  message: ''
};

// 팝업 보기 선택은 이 브라우저에만 기억한다. 저장소를 못 쓰면 기본값으로 연다.
function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      mode: view.mode, scope: view.scope, range: view.range, rivalPart: view.rivalPart, leadScope: view.leadScope
    }));
  } catch {
    // 기억하지 못해도 화면은 그대로 쓴다.
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

async function load() {
  const stored = await chrome.storage.local.get(['settings', 'state', 'history', 'stationDetails', 'calls', 'paused']);
  view.settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  view.state = { ...emptyState(), ...(stored.state || {}) };
  view.history = { ...emptyHistory(), ...(stored.history || {}) };
  view.details = { ...emptyDetails(), ...(stored.stationDetails || {}) };
  view.calls = stored.calls || null;
  view.paused = stored.paused === true;
  if (!view.tab || (view.tab !== TAXFREE_TAB && !view.settings.products.includes(view.tab))) {
    view.tab = view.settings.products[0] || TAXFREE_TAB;
  }
  if (!view.settings.products.includes(view.trendTab)) view.trendTab = view.settings.products[0] || null;
  if (!view.settings.products.includes(view.rivalTab)) view.rivalTab = view.settings.products[0] || null;
  if (view.changeTab !== ALL_TAB && !changeTabs().some(([code]) => code === view.changeTab)) {
    view.changeTab = ALL_TAB;
  }
  if (!view.settings.taxfreeProducts.includes(view.taxfreeProd)) {
    view.taxfreeProd = view.settings.taxfreeProducts.includes('D147') ? 'D147' : view.settings.taxfreeProducts[0];
  }
  render();
}

function currentProduct() {
  return view.tab === TAXFREE_TAB ? view.taxfreeProd : view.tab;
}

function hasTaxfree() {
  return Boolean(view.settings.taxfreeArea && view.settings.taxfreeProducts.length);
}

function taxfreeLabel() {
  return `면세유(${view.settings.taxfreeArea.name.replace(/시$|군$/, '')})`;
}

function priceTabs() {
  const entries = view.settings.products.map((code) => [code, PRODUCTS[code]]);
  if (hasTaxfree()) entries.push([TAXFREE_TAB, taxfreeLabel()]);
  return entries;
}

function changeTabs() {
  return [[ALL_TAB, '전체'], ...priceTabs()];
}

function trendTabs() {
  return view.settings.products.map((code) => [code, PRODUCTS[code]]);
}

function render() {
  const { settings, state } = view;
  const now = Date.now();
  $('stationName').textContent = settings.station ? settings.station.name : '주유소 가격 감시';
  $('checkedAt').textContent = state.fetchedAt ? `${formatWhen(state.fetchedAt, now)} 확인` : '아직 확인하지 않음';
  renderPause();
  renderNotice();
  renderSwitch(now);
  renderTabs();

  $('pricesView').hidden = view.mode !== 'prices';
  $('changesView').hidden = view.mode !== 'changes';
  $('trendView').hidden = view.mode !== 'trend';
  $('rivalsView').hidden = view.mode !== 'rivals';
  if (view.mode === 'prices') renderPrices(now);
  else if (view.mode === 'changes') renderChanges(now);
  else if (view.mode === 'trend') renderTrend(now);
  else renderRivals(now);

  $('calls').textContent = `오늘 오피넷 호출 ${callsToday(view.calls, now)} / ${DAILY_LIMIT}`;
}

function renderNotice() {
  const notice = $('notice');
  const { settings, state } = view;
  let text = view.message;
  let error = false;
  if (!settings.apiKey || !settings.station) {
    text = '설정에서 API 키와 내 주유소를 먼저 정해 주세요.';
  } else if (!text && state.lastError) {
    text = `${formatKst(state.lastError.at)} 확인 실패: ${state.lastError.message}`;
    error = true;
  }
  notice.hidden = !text;
  notice.textContent = text;
  notice.classList.toggle('error', error);
}

function renderSwitch(now) {
  for (const button of $('viewSwitch').children) {
    const on = button.dataset.view === view.mode;
    button.classList.toggle('on', on);
    button.setAttribute('aria-selected', String(on));
  }
  const badge = $('changeBadge');
  const today = kstDate(now);
  const todayCount = view.state.events.filter((event) => kstDate(event.at) === today).length;
  // 숫자만 짧게 보여준다. 빨간색은 감시 주유소의 새 변동, 회색은 오늘 변동 수.
  if (view.newKeys.size) {
    badge.textContent = String(view.newKeys.size);
    badge.title = `감시 주유소의 새 가격 변동 ${view.newKeys.size}건`;
  } else {
    badge.textContent = String(todayCount);
    badge.title = `오늘 가격 변동 ${todayCount}건`;
  }
  badge.classList.toggle('new', view.newKeys.size > 0);
  badge.hidden = !view.newKeys.size && !todayCount;

  const rivalBadge = $('rivalBadge');
  const unseenStations = view.state.unseenStations || 0;
  rivalBadge.hidden = !unseenStations;
  rivalBadge.textContent = String(unseenStations);
  rivalBadge.title = `주변 주유소 변화 ${unseenStations}건`;
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.replaceChildren();
  const { mode } = view;
  const current = mode === 'changes' ? view.changeTab : mode === 'trend' ? view.trendTab
    : mode === 'rivals' ? view.rivalTab : view.tab;
  const entries = mode === 'changes' ? changeTabs() : mode === 'trend' || mode === 'rivals' ? trendTabs() : priceTabs();
  tabs.hidden = mode === 'rivals' && view.rivalPart === 'roster';
  for (const [code, label] of entries) {
    const button = el('button', code === current ? 'on' : '', label);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(code === current));
    button.addEventListener('click', () => {
      if (mode === 'changes') view.changeTab = code;
      else if (mode === 'trend') view.trendTab = code;
      else if (mode === 'rivals') view.rivalTab = code;
      else view.tab = code;
      view.openRow = null;
      render();
    });
    tabs.append(button);
  }

  const sub = $('subTabs');
  sub.hidden = mode !== 'prices' || view.tab !== TAXFREE_TAB;
  sub.replaceChildren();
  for (const code of view.settings.taxfreeProducts) {
    const button = el('button', code === view.taxfreeProd ? 'on' : '', TAXFREE_PRODUCTS[code]);
    button.type = 'button';
    button.addEventListener('click', () => {
      view.taxfreeProd = code;
      view.openRow = null;
      render();
    });
    sub.append(button);
  }
}

/* ───────── 가격표 ───────── */

function renderPrices(now) {
  const { settings, state } = view;
  const taxfree = view.tab === TAXFREE_TAB;
  const prod = currentProduct();
  const myId = settings.station ? settings.station.id : null;
  const summary = summarize(state, prod, myId, settings.watched);
  renderSummary(summary, taxfree);

  const cityName = taxfree
    ? (settings.taxfreeArea ? settings.taxfreeArea.name : '')
    : (settings.city ? settings.city.name : '');
  $('filterTop').textContent = cityName ? `${cityName} 최저 20` : '최저 20';
  $('filterTop').hidden = taxfree;
  if (taxfree && view.filter === 'top') view.filter = 'all';
  for (const button of $('sortSeg').children) button.classList.toggle('on', button.dataset.sort === view.sort);
  for (const button of $('filterSeg').children) button.classList.toggle('on', button.dataset.filter === view.filter);

  renderRows(summary, prod, now);
}

function stat(label, value, unit, sub) {
  const box = el('div', 'stat');
  box.append(el('div', 'label', label));
  const main = el('div', 'value', value);
  if (unit) main.append(el('small', '', ` ${unit}`));
  box.append(main);
  box.append(el('div', 'sub', sub || ' '));
  return box;
}

function renderSummary(summary, taxfree) {
  const box = $('summary');
  box.replaceChildren();
  const lowest = summary.lowest;
  if (taxfree) {
    const area = view.settings.taxfreeArea ? view.settings.taxfreeArea.name : '';
    box.append(
      stat(`${area} 최저가`, lowest ? won(lowest.price) : '-', lowest ? '원' : '', lowest ? lowest.name : ''),
      stat('최저 20곳 평균', summary.listAverage ? won(summary.listAverage) : '-', summary.listAverage ? '원' : ''),
      stat('목록', String(summary.count), '곳', '싼 순서 20곳까지')
    );
    return;
  }
  const city = view.settings.city ? view.settings.city.name : '시';
  const mine = summary.mine;
  const average = summary.cityAverage;
  const gap = mine !== null && average ? Math.round(mine - average.price) : null;
  const lowestGap = mine !== null && lowest ? mine - lowest.price : null;
  box.append(
    stat('내 가격', mine !== null ? won(mine) : '-', mine !== null ? '원' : '',
      summary.rank ? `${summary.count}곳 중 ${summary.rank}번째로 쌈` : '가격 정보 없음'),
    stat(`${city} 평균`, average ? won(average.price) : '-', average ? '원' : '',
      gap === null ? '' : gap === 0 ? '평균과 같음' : `내가 ${won(Math.abs(gap))}원 ${gap > 0 ? '비쌈' : '쌈'}`),
    stat('목록 최저가', lowest ? won(lowest.price) : '-', lowest ? '원' : '',
      !lowest ? '' : lowest.mine ? '내 주유소' : `${lowestGap ? `${won(lowestGap)}원 쌈 · ` : ''}${lowest.name}`)
  );
}

function renderRows(summary, prod, now) {
  const body = $('rows');
  body.replaceChildren();
  let rows = summary.rows;
  if (view.filter === 'watched') rows = rows.filter((row) => row.watched || row.mine);
  if (view.filter === 'top') rows = rows.filter((row) => row.topRank || row.mine);
  const query = view.query.trim();
  if (query) rows = rows.filter((row) => matchesQuery(row, query));
  rows = sortRows(rows, view.sort);
  $('empty').hidden = rows.length > 0;
  $('empty').textContent = !summary.rows.length ? '아직 받은 가격이 없습니다.'
    : query ? `"${query}"와 맞는 주유소가 없습니다.` : '조건에 맞는 주유소가 없습니다.';

  let jumpRow = null;
  for (const row of rows) {
    const tr = el('tr', `row${row.mine ? ' mine' : ''}`);
    tr.dataset.id = row.id;

    const starCell = el('td', 'star');
    if (!row.mine) {
      const star = el('button', `star-btn${row.watched ? ' on' : ''}`, row.watched ? '★' : '☆');
      star.type = 'button';
      star.title = row.watched ? '감시 해제' : '감시하기';
      star.setAttribute('aria-label', `${row.name} ${star.title}`);
      star.addEventListener('click', async (event) => {
        event.stopPropagation();
        await send({ type: 'toggleWatch', id: row.id });
      });
      starCell.append(star);
    }

    const nameCell = el('td', 'name');
    const title = el('div', 'title', row.name);
    if (row.mine) title.append(el('span', 'tag me', '내 주유소'));
    if (row.topRank && view.tab !== TAXFREE_TAB) title.append(el('span', 'tag', `최저 ${row.topRank}위`));
    const meta = [BRANDS[row.brand] || row.brand, formatDistance(row.dist)].filter(Boolean).join(' · ');
    nameCell.append(title, el('div', 'meta', meta));

    const priceCell = el('td', 'num price', won(row.price));

    const diffCell = el('td', 'num');
    if (!row.mine && row.diff !== null) {
      const text = row.diff === 0 ? '같음' : `${row.diff > 0 ? '+' : '−'}${won(Math.abs(row.diff))}`;
      diffCell.append(el('span', 'muted', text));
    }

    const changeCell = el('td', 'num last change');
    if (row.change) {
      const delta = row.price - row.change.from;
      const mark = el('div', delta > 0 ? 'up' : 'down', `${delta > 0 ? '▲' : '▼'}${won(Math.abs(delta))}`);
      changeCell.append(mark, el('div', 'muted', formatWhen(row.change.at, now)));
    }

    tr.append(starCell, nameCell, priceCell, diffCell, changeCell);
    tr.addEventListener('click', () => {
      view.openRow = view.openRow === row.id ? null : row.id;
      render();
    });
    body.append(tr);
    if (view.jumpTo === row.id) jumpRow = tr;

    if (view.openRow === row.id) body.append(historyRow(row, prod, now));
  }

  if (view.jumpTo) {
    view.jumpTo = null;
    if (jumpRow) jumpRow.scrollIntoView({ block: 'nearest' });
  }
}

function historyRow(row, prod, now) {
  const tr = el('tr', 'history');
  const td = el('td');
  td.colSpan = 5;
  const past = view.state.events.filter((event) => event.id === row.id && event.prod === prod).slice(0, 8);
  if (row.addr) td.append(el('div', 'muted', row.addr));
  const detail = view.details.items[row.id];
  if (detail && !detail.missing) {
    const line = el('div', 'detail-line');
    for (const feature of detailFeatures(detail)) line.append(el('span', 'chip', feature));
    if (detail.tel) line.append(el('span', 'muted', `☎ ${detail.tel}`));
    if (line.children.length) td.append(line);
  }
  if (!past.length) {
    td.append(el('div', 'muted', '설치한 뒤로 가격 변동이 없습니다.'));
  } else {
    const list = el('ul');
    for (const event of past) {
      const delta = event.to - event.from;
      const item = el('li', '', `${formatWhen(event.at, now)}  ${won(event.from)} → ${won(event.to)} `);
      item.append(el('span', delta > 0 ? 'up' : 'down', `${delta > 0 ? '▲' : '▼'}${won(Math.abs(delta))}`));
      list.append(item);
    }
    td.append(list);
  }
  tr.append(td);
  return tr;
}

/* ───────── 가격 변동(날짜별) ───────── */

function isTaxfreeProd(prod) {
  return Object.prototype.hasOwnProperty.call(TAXFREE_PRODUCTS, prod);
}

function filteredEvents() {
  const { settings, state } = view;
  const watched = new Set(settings.watched || []);
  const myId = settings.station ? settings.station.id : null;
  return state.events.filter((event) => {
    if (view.changeTab === TAXFREE_TAB && !isTaxfreeProd(event.prod)) return false;
    if (view.changeTab !== TAXFREE_TAB && view.changeTab !== ALL_TAB && event.prod !== view.changeTab) return false;
    if (view.scope === 'watched' && !watched.has(event.id) && event.id !== myId) return false;
    return true;
  });
}

function renderChanges(now) {
  for (const button of $('scopeSeg').children) button.classList.toggle('on', button.dataset.scope === view.scope);
  const days = groupEventsByDay(filteredEvents());
  view.activeDay = days.length ? days[0].date : null;
  renderDayChart(days, now);
  renderFeed(days, now);

  const totals = $('changeTotals');
  totals.replaceChildren();
  if (days.length) {
    const up = days.reduce((sum, day) => sum + day.up, 0);
    const down = days.reduce((sum, day) => sum + day.down, 0);
    totals.append(`${days.length}일 · `, el('span', 'up', `▲${up}`), ' ', el('span', 'down', `▼${down}`));
  }
}

function renderDayChart(days, now) {
  const cols = $('dayCols');
  cols.replaceChildren();
  const byDate = new Map(days.map((day) => [day.date, day]));
  const oldest = days.length ? days[days.length - 1].date : null;
  const range = dayRange(oldest, now);
  $('chartSpan').textContent = `최근 ${range.length}일`;
  const peak = Math.max(1, ...range.map((date) => {
    const day = byDate.get(date);
    return day ? Math.max(day.up, day.down) : 0;
  }));
  const barHeight = (count) => (count ? Math.max(3, Math.round((count / peak) * 20)) : 0);

  for (const date of range) {
    const day = byDate.get(date);
    const label = dayLabel(date, now);
    const button = el('button', 'dcol');
    button.type = 'button';
    button.dataset.date = date;
    if (label.relative === '오늘') button.classList.add('today');
    if (label.weekend) button.classList.add(label.weekend);
    const bars = el('div', 'bars');
    if (day) {
      if (day.up) {
        const bar = el('div', 'bar up');
        bar.style.height = `${barHeight(day.up)}px`;
        bars.append(bar);
      }
      if (day.down) {
        const bar = el('div', 'bar down');
        bar.style.height = `${barHeight(day.down)}px`;
        bars.append(bar);
      }
      button.title = `${label.text}${label.relative ? ` ${label.relative}` : ''} · ${day.stations}곳 · 인상 ${day.up} · 인하 ${day.down}`;
      button.addEventListener('click', () => scrollToDay(date));
    } else {
      button.disabled = true;
      button.title = `${label.text} · 변동 없음`;
    }
    const number = label.relative === '오늘' ? '오늘' : label.day === 1 ? `${label.month}/1` : String(label.day);
    button.append(bars, el('span', 'dnum', number), el('span', 'dwk', label.weekday));
    cols.append(button);
  }
  markActiveDay();
}

function markActiveDay() {
  for (const button of $('dayCols').children) {
    const on = button.dataset.date === view.activeDay;
    button.classList.toggle('on', on);
    button.setAttribute('aria-current', on ? 'date' : 'false');
  }
}

function entryOrder(entry, myId, watched) {
  if (entry.id === myId) return 0;
  return watched.has(entry.id) ? 1 : 2;
}

function renderFeed(days, now) {
  const { settings, state } = view;
  const feed = $('feed');
  const wrap = $('feedWrap');
  feed.replaceChildren();
  wrap.scrollTop = 0;
  const watched = new Set(settings.watched || []);
  const myId = settings.station ? settings.station.id : null;
  const showProd = view.changeTab === ALL_TAB || view.changeTab === TAXFREE_TAB;

  const empty = $('feedEmpty');
  empty.hidden = days.length > 0;
  if (!state.events.length) {
    empty.textContent = '아직 가격 변동이 없습니다. 주변 주유소가 가격을 바꾸면 여기에 날짜별로 쌓입니다.';
  } else if (view.scope === 'watched') {
    empty.textContent = '감시 중인 주유소의 가격 변동이 없습니다.';
  } else {
    empty.textContent = '이 제품의 가격 변동이 없습니다.';
  }
  if (!days.length) return;

  for (const day of days) {
    const label = dayLabel(day.date, now);
    const section = el('section', 'day');
    section.dataset.date = day.date;

    const head = el('div', 'day-head');
    head.append(el('span', 'date', label.text));
    if (label.relative) head.append(el('span', 'rel', label.relative));
    const sum = el('span', 'sum', `${day.stations}곳`);
    if (day.up) sum.append(el('b', 'up', `▲${day.up}`));
    if (day.down) sum.append(el('b', 'down', `▼${day.down}`));
    head.append(sum);
    section.append(head);

    for (const slot of day.slots) {
      const block = el('div', 'slot');
      block.append(el('div', 'slot-time', kstClock(slot.at)));
      const list = el('ul', 'entries');
      const entries = [...slot.entries].sort((a, b) =>
        entryOrder(a, myId, watched) - entryOrder(b, myId, watched)
        || ((state.stations[a.id] || {}).dist ?? Infinity) - ((state.stations[b.id] || {}).dist ?? Infinity));
      for (const entry of entries) list.append(feedEntry(entry, { myId, watched, showProd }));
      block.append(list);
      section.append(block);
    }
    feed.append(section);
  }
  feed.append(el('p', 'feed-note muted', `변동 기록은 ${EVENT_KEEP_DAYS}일 동안 남습니다.`));
}

function feedEntry(entry, { myId, watched, showProd }) {
  const station = view.state.stations[entry.id] || {};
  const mine = entry.id === myId;
  const isNew = entry.changes.some((change) => view.newKeys.has(change.key));
  const item = el('li', `entry${mine ? ' mine' : ''}`);
  item.title = '가격표에서 보기';

  const who = el('div', 'who');
  const name = el('div', 'nm');
  if (watched.has(entry.id)) name.append(el('span', 'star-mark', '★'));
  name.append(el('span', 'label', station.name || entry.name || entry.id));
  if (mine) name.append(el('span', 'tag me', '내 주유소'));
  if (isNew) name.append(el('span', 'tag new', '새'));
  const meta = [BRANDS[station.brand] || station.brand, formatDistance(station.dist)].filter(Boolean).join(' · ');
  who.append(name, el('div', 'meta', meta || ' '));

  const moves = el('div', 'moves');
  for (const change of entry.changes) {
    const move = el('div', 'move');
    if (showProd) move.append(el('span', 'prod', PRODUCT_NAMES[change.prod] || change.prod));
    const direction = change.delta > 0 ? 'up' : 'down';
    move.append(
      el('span', 'from', won(change.from)),
      el('span', 'arrow', '→'),
      el('span', 'to', won(change.to)),
      el('span', `pill ${direction}`, `${change.delta > 0 ? '▲' : '▼'}${won(Math.abs(change.delta))}`)
    );
    moves.append(move);
  }

  item.append(who, moves);
  item.addEventListener('click', () => jumpToStation(entry.id, entry.changes[0].prod));
  return item;
}

// 변동 목록에서 주유소를 누르면 가격표의 그 제품 탭으로 가서 기록을 펼친다.
function jumpToStation(id, prod) {
  const { settings } = view;
  if (view.mode === 'changes' && view.changeTab !== ALL_TAB && view.changeTab !== TAXFREE_TAB) prod = view.changeTab;
  if (isTaxfreeProd(prod)) {
    if (!hasTaxfree() || !settings.taxfreeProducts.includes(prod)) return;
    view.tab = TAXFREE_TAB;
    view.taxfreeProd = prod;
  } else if (settings.products.includes(prod)) {
    view.tab = prod;
  } else {
    return;
  }
  view.mode = 'prices';
  view.filter = 'all';
  setQuery('');
  view.openRow = id;
  view.jumpTo = id;
  savePrefs();
  render();
}

/* ───────── 날짜별 추이 ───────── */

function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function gapText(gap) {
  const rounded = Math.round(gap);
  return rounded === 0 ? '같음' : `${won(Math.abs(rounded))}원 ${rounded > 0 ? '비쌈' : '쌈'}`;
}

function signed(value) {
  const rounded = Math.round(value);
  return rounded === 0 ? '0' : `${rounded > 0 ? '+' : '−'}${won(Math.abs(rounded))}`;
}

function cityName() {
  return view.settings.city ? view.settings.city.name : '시';
}

function stationName(id) {
  return id ? ((view.state.stations[id] || {}).name || id) : '';
}

function renderTrend(now) {
  for (const button of $('rangeSeg').children) button.classList.toggle('on', Number(button.dataset.range) === view.range);
  const { settings, state, history } = view;
  const myId = settings.station ? settings.station.id : null;
  const series = view.trendTab
    ? dailySeries(state, history, view.trendTab, { myId, watched: settings.watched, dates: lastDays(now, view.range), now })
    : [];
  view.trendSeries = series;
  $('avgLegend').textContent = `${cityName()} 평균`;
  $('avgHead').textContent = `${cityName()} 평균`;
  drawTrendChart(series, now);
  renderTrendSummary(series);
  renderTrendTable(series, now);
}

// 눈금 간격: 값 범위에 눈금이 3~5개 들어가도록 고른다.
function tickStep(span) {
  for (const step of [5, 10, 20, 25, 50, 100, 200, 500]) if (span / step <= 4) return step;
  return 1000;
}

function drawTrendChart(series, now) {
  const svg = $('trendSvg');
  svg.replaceChildren();
  $('trendTip').hidden = true;
  const width = svg.clientWidth || 432;
  const height = 168;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const pad = { l: 38, r: 46, t: 8, b: 20 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const values = series.flatMap((row) => SERIES.map(([key]) => row[key])).filter((value) => value !== null);
  if (!values.length) {
    svg.append(svgEl('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'nodata' }, '아직 쌓인 기록이 없습니다.'));
    return;
  }

  const rawLo = Math.min(...values);
  const rawHi = Math.max(...values);
  const step = tickStep(Math.max(rawHi - rawLo, 10));
  let lo = Math.floor(rawLo / step) * step;
  let hi = Math.ceil(rawHi / step) * step;
  if (rawLo - lo < step * 0.15) lo -= step;
  if (hi - rawHi < step * 0.15) hi += step;
  const n = series.length;
  const x = (index) => pad.l + (n === 1 ? plotW / 2 : (index * plotW) / (n - 1));
  const y = (value) => pad.t + ((hi - value) / (hi - lo)) * plotH;

  for (let tick = lo; tick <= hi; tick += step) {
    svg.append(
      svgEl('line', { x1: pad.l, x2: width - pad.r, y1: y(tick), y2: y(tick), class: 'gridline' }),
      svgEl('text', { x: pad.l - 6, y: y(tick) + 3, 'text-anchor': 'end', class: 'axis' }, won(tick))
    );
  }

  // 날짜 눈금: 오늘부터 거꾸로 같은 간격으로 5개 안팎.
  const every = Math.max(1, Math.ceil(n / 5));
  for (let index = n - 1; index >= 0; index -= every) {
    const [, m, d] = series[index].date.split('-').map(Number);
    const anchor = index === n - 1 ? 'end' : index === 0 ? 'start' : 'middle';
    const label = index === n - 1 ? '오늘' : `${m}/${d}`;
    svg.append(svgEl('text', { x: x(index) + (anchor === 'end' ? 4 : 0), y: height - 4, 'text-anchor': anchor, class: 'axis' }, label));
  }

  const ends = [];
  for (const [key] of SERIES) {
    let path = '';
    let pen = false;
    series.forEach((row, index) => {
      if (row[key] === null) {
        pen = false;
        return;
      }
      path += `${pen ? 'L' : 'M'}${x(index).toFixed(1)},${y(row[key]).toFixed(1)}`;
      pen = true;
    });
    if (path) svg.append(svgEl('path', { d: path, class: `series ${key}` }));
    const last = series[n - 1][key];
    if (last !== null) ends.push({ key, value: last, y: y(last) });
  }

  // 끝 값 표시: 겹치면 아래로 밀고 짧은 선으로 잇는다.
  ends.sort((a, b) => a.y - b.y);
  let floor = pad.t;
  for (const end of ends) {
    end.labelY = Math.max(end.y, floor);
    floor = end.labelY + 12;
  }
  const overflow = ends.length ? ends[ends.length - 1].labelY - (height - pad.b) : 0;
  if (overflow > 0) for (const end of ends) end.labelY -= overflow;
  const endX = x(n - 1);
  for (const end of ends) {
    if (Math.abs(end.labelY - end.y) > 2) {
      svg.append(svgEl('line', { x1: endX + 5, y1: end.y, x2: endX + 9, y2: end.labelY, class: 'leader' }));
    }
    svg.append(
      svgEl('circle', { cx: endX, cy: end.y, r: 4, class: `end-dot ${end.key}` }),
      svgEl('text', { x: endX + 11, y: end.labelY + 3.5, class: 'end-label' }, won(end.value))
    );
  }

  // 마우스를 올리면 그 날짜의 값을 보여준다.
  const hover = svgEl('g');
  const hit = svgEl('rect', { x: pad.l - 6, y: 0, width: plotW + 12, height, fill: 'transparent' });
  svg.append(hover, hit);
  const show = (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    const index = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / plotW) * (n - 1))));
    showTrendPoint(index, { hover, x, y, pad, height, now });
  };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', () => {
    hover.replaceChildren();
    $('trendTip').hidden = true;
    markTrendRow(null);
  });
}

function showTrendPoint(index, { hover, x, y, pad, height, now }) {
  const row = view.trendSeries[index];
  hover.replaceChildren(svgEl('line', { x1: x(index), x2: x(index), y1: pad.t, y2: height - pad.b, class: 'crosshair' }));
  for (const [key] of SERIES) {
    if (row[key] !== null) hover.append(svgEl('circle', { cx: x(index), cy: y(row[key]), r: 4, class: `hover-dot ${key}` }));
  }

  const tip = $('trendTip');
  tip.replaceChildren();
  const label = dayLabel(row.date, now);
  tip.append(el('div', 'tip-date', `${label.text}${label.relative ? ` ${label.relative}` : ''}`));
  for (const [key, name] of SERIES) {
    const line = el('div', 'tip-row');
    line.append(el('i', key), el('span', '', key === 'avg' ? `${cityName()} 평균` : name), el('b', '', row[key] === null ? '–' : won(row[key])));
    tip.append(line);
    if (key === 'rival' && row.rivalId) tip.append(el('div', 'tip-sub', stationName(row.rivalId)));
  }
  if (row.mine !== null && row.rival !== null) {
    tip.append(el('div', 'tip-sub', `내 가격이 ${gapText(row.mine - row.rival)}`));
  }
  tip.hidden = false;
  const chartWidth = $('trendChart').clientWidth;
  const left = x(index) + 14 + 12;
  tip.style.left = `${left + tip.offsetWidth > chartWidth - 4 ? Math.max(4, left - tip.offsetWidth - 24) : left}px`;
  markTrendRow(row.date);
}

function markTrendRow(date) {
  for (const tr of $('trendRows').children) tr.classList.toggle('on', tr.dataset.date === date);
}

function renderTrendSummary(series) {
  const box = $('trendSummary');
  box.replaceChildren();
  const withMine = series.filter((row) => row.mine !== null);
  if (!withMine.length) {
    box.textContent = '내 가격 기록이 아직 없습니다. 확인할 때마다 날짜별로 쌓입니다.';
    return;
  }
  const lines = [];
  const first = withMine[0];
  const last = withMine[withMine.length - 1];
  const moved = last.mine - first.mine;
  lines.push(['내 가격 ', el('b', '', `${won(first.mine)} → ${won(last.mine)}`),
    moved ? ` (${moved > 0 ? '▲' : '▼'}${won(Math.abs(moved))})` : ' (변동 없음)']);
  for (const [key, name] of [['rival', '감시 최저가'], ['avg', `${cityName()} 평균`]]) {
    const both = series.filter((row) => row.mine !== null && row[key] !== null);
    if (!both.length) continue;
    const latest = both[both.length - 1];
    const average = both.reduce((sum, row) => sum + row.mine - row[key], 0) / both.length;
    lines.push([`${name}보다 지금 `, el('b', '', gapText(latest.mine - latest[key])), ` · 기간 평균 ${gapText(average)}`]);
  }
  lines.forEach((parts, index) => {
    if (index) box.append(el('br'));
    box.append(...parts);
  });
}

function renderTrendTable(series, now) {
  const body = $('trendRows');
  body.replaceChildren();
  for (const row of [...series].reverse()) {
    const label = dayLabel(row.date, now);
    const tr = el('tr');
    tr.dataset.date = row.date;
    const dateCell = el('td', label.weekend === 'sun' ? 'sun' : '', `${label.month}/${label.day} (${label.weekday})`);
    const rivalCell = el('td', '', row.rival === null ? '–' : won(row.rival));
    if (row.rivalId) rivalCell.title = stationName(row.rivalId);
    const gap = row.mine !== null && row.rival !== null ? row.mine - row.rival : null;
    const gapCell = el('td', gap > 0 ? 'gap-up' : '', gap === null ? '–' : signed(gap));
    if (gap !== null) gapCell.title = `내 가격이 감시 최저가보다 ${gapText(gap)}`;
    tr.append(
      dateCell,
      el('td', '', row.mine === null ? '–' : won(row.mine)),
      rivalCell,
      gapCell,
      el('td', '', row.avg === null ? '–' : won(row.avg))
    );
    body.append(tr);
  }
}

/* ───────── 경쟁사: 누가 먼저 · 주유소 변화 ───────── */

const STYLE_NAMES = { leader: '먼저 움직임', middle: '그때그때', follower: '따라가는 편', few: '기록 부족' };

function myStationId() {
  return view.settings.station ? view.settings.station.id : null;
}

// 분석에 넣을 주유소: 감시만이면 감시 주유소와 내 주유소, 반경 전체면 반경 안 명단(면세유·시 최저가 목록만 나온 곳 제외).
function leadIds(prod) {
  const { settings, state } = view;
  const myId = myStationId();
  if (view.leadScope === 'watched') return new Set([myId, ...(settings.watched || [])].filter(Boolean));
  const roster = Object.keys(state.roster || {});
  const ids = roster.length ? roster : Object.keys(state.prices[prod] || {});
  return new Set([...ids, myId].filter(Boolean));
}

function stationCell(id) {
  const td = el('td');
  const line = el('div', 'nm');
  if ((view.settings.watched || []).includes(id)) line.append(el('span', 'star-mark', '★'));
  line.append(el('span', 'label', stationName(id)));
  if (id === myStationId()) line.append(el('span', 'tag me', '나'));
  td.append(line);
  const station = view.state.stations[id] || {};
  const meta = [BRANDS[station.brand] || station.brand, formatDistance(station.dist)].filter(Boolean).join(' · ');
  if (meta) td.append(el('div', 'meta', meta));
  return td;
}

function valueCell(main, sub) {
  const td = el('td', main === '–' ? 'none' : '');
  td.append(el('div', '', main));
  if (sub) td.append(el('div', 'sub', sub));
  return td;
}

function renderRivals(now) {
  for (const button of $('rivalSeg').children) button.classList.toggle('on', button.dataset.part === view.rivalPart);
  for (const button of $('leadScopeSeg').children) button.classList.toggle('on', button.dataset.scope === view.leadScope);
  const count = $('rosterCount');
  count.hidden = !view.newStations;
  count.textContent = String(view.newStations);
  $('leadScopeSeg').hidden = view.rivalPart !== 'lead';
  $('leadPart').hidden = view.rivalPart !== 'lead';
  $('rosterPart').hidden = view.rivalPart !== 'roster';
  if (view.rivalPart === 'lead') renderLead();
  else renderRoster(now);
}

function renderLead() {
  const { state } = view;
  const prod = view.rivalTab;
  const myId = myStationId();
  const ids = leadIds(prod);
  const all = view.leadScope === 'all';

  // 내가 바꾼 뒤 따라온 곳
  const reactions = reactionsTo(state.events, prod, myId, [...ids]);
  const { count } = reactions;
  const mineMoves = count.up + count.down;
  $('reactSpan').textContent = mineMoves ? `내 변동: 인하 ${count.down}번 · 인상 ${count.up}번` : '';
  let reactRows = reactions.rows;
  if (all) reactRows = reactRows.filter((row) => row.up.followed + row.down.followed > 0).slice(0, 15);
  const reactBody = $('reactRows');
  reactBody.replaceChildren();
  $('reactTable').hidden = !mineMoves || !reactRows.length;
  $('reactEmpty').hidden = mineMoves > 0 && reactRows.length > 0;
  $('reactEmpty').textContent = !mineMoves
    ? `최근 90일 동안 내 ${PRODUCTS[prod] || ''} 가격을 바꾼 기록이 없습니다.`
    : all ? '내가 바꾼 뒤 3일 안에 같은 방향으로 따라 바꾼 곳이 없습니다.' : '감시 주유소가 없습니다. 가격표에서 ☆를 눌러 감시할 곳을 고르세요.';
  const reactCell = (part, total) => {
    if (!total) return valueCell('–');
    return valueCell(`${part.followed}/${total}번`, part.followed ? `평균 ${lagText(part.avgLag)} 뒤` : '안 따라옴');
  };
  for (const row of reactRows) {
    const tr = el('tr');
    tr.append(stationCell(row.id), reactCell(row.down, count.down), reactCell(row.up, count.up));
    tr.title = '가격표에서 보기';
    tr.addEventListener('click', () => jumpToStation(row.id, prod));
    reactBody.append(tr);
  }

  // 먼저 바꾼 곳
  const lead = leaderStats(state.events, prod, ids);
  $('leadSpan').textContent = lead.waves ? `함께 움직인 흐름 ${lead.waves}번 (인상 ${lead.up} · 인하 ${lead.down})` : '';
  let leadRows = lead.rows.filter((row) => row.joined > 0);
  if (all) leadRows = leadRows.slice(0, 20);
  const leadBody = $('leadRows');
  leadBody.replaceChildren();
  $('leadTable').hidden = !leadRows.length;
  $('leadEmpty').hidden = leadRows.length > 0;
  $('leadEmpty').textContent = '여러 주유소가 함께 가격을 바꾼 기록이 아직 없습니다. 변동 기록이 쌓이면 나타납니다.';
  for (const row of leadRows) {
    const tr = el('tr', row.id === myId ? 'mine' : '');
    const split = [row.leadUp ? `인상 ${row.leadUp}` : '', row.leadDown ? `인하 ${row.leadDown}` : ''].filter(Boolean).join(' · ');
    const styleCell = el('td');
    styleCell.append(el('span', `style-tag ${row.style}`, STYLE_NAMES[row.style]));
    tr.append(
      stationCell(row.id),
      valueCell(`${row.lead}/${row.joined}번`, split),
      valueCell(row.follow ? `${row.follow}번` : '–', row.follow ? `평균 ${lagText(row.avgLag)} 뒤` : ''),
      styleCell
    );
    tr.title = '가격표에서 보기';
    tr.addEventListener('click', () => jumpToStation(row.id, prod));
    leadBody.append(tr);
  }
}

function brandName(code) {
  return BRANDS[code] || code || '상표 없음';
}

function stationEventDesc(event) {
  const station = view.state.stations[event.id] || {};
  switch (event.kind) {
    case 'new':
      return [brandName(event.to || station.brand), formatDistance(station.dist)].filter(Boolean).join(' · ');
    case 'gone':
      return '이틀 넘게 반경 검색에 나오지 않습니다(휴업·폐업 또는 가격 미등록).';
    case 'back':
      return '다시 반경 검색에 나옵니다.';
    case 'brand':
      return `${brandName(event.from)} → ${brandName(event.to)}`;
    case 'rename':
      return `${event.from} → ${event.to}`;
    default:
      return '';
  }
}

function hasRegularPrice(id) {
  return view.settings.products.find((prod) => (view.state.prices[prod] || {})[id] !== undefined) || null;
}

function renderRoster(now) {
  const { state, details } = view;
  const roster = state.roster || {};
  const active = Object.keys(roster).filter((id) => !roster[id].gone);
  const got = active.filter((id) => details.items[id] && !details.items[id].missing).length;
  const summary = $('rosterSummary');
  summary.replaceChildren();
  if (!active.length) {
    summary.textContent = '다음 확인 때 반경 안 주유소 명단을 만들고, 그 뒤로 새로 생기거나 사라진 곳, 상표가 바뀐 곳을 알려 드립니다.';
  } else {
    summary.append('반경 안 주유소 ', el('b', '', `${active.length}곳`), ' · 상세 정보 ', el('b', '', `${got}곳`), ' 받음');
    if (got < active.length) summary.append(` · 나머지 ${active.length - got}곳은 확인할 때마다 조금씩(하루 60곳까지) 받습니다.`);
  }

  const list = $('stationFeed');
  list.replaceChildren();
  const events = state.stationEvents || [];
  $('stationEmpty').hidden = events.length > 0;
  $('stationEmpty').textContent = '아직 바뀐 곳이 없습니다. 면세유 주유소와 시 최저가 목록에만 나온 곳은 보지 않습니다.';
  events.forEach((event, index) => {
    const prod = hasRegularPrice(event.id);
    const item = el('li', prod ? 'link' : '');
    item.append(el('div', 'when', formatWhen(event.at, now)));
    const body = el('div', 'body');
    const name = el('div', 'nm');
    name.append(el('span', `kind ${event.kind}`, STATION_EVENT_NAMES[event.kind] || event.kind), el('span', '', event.name));
    if (index < view.newStations) name.append(el('span', 'tag new', '새'));
    body.append(name, el('div', 'desc', stationEventDesc(event)));
    item.append(body);
    if (prod) {
      item.title = '가격표에서 보기';
      item.addEventListener('click', () => jumpToStation(event.id, prod));
    }
    list.append(item);
  });
}

// 경쟁사 보기에 들어오면 새 주유소 변화를 본 것으로 표시한다(목록에는 "새"를 남겨 둔다).
function enterRivals() {
  const unseen = view.state.unseenStations || 0;
  if (!unseen) return;
  view.newStations = unseen;
  view.rivalPart = 'roster';
  view.state.unseenStations = 0;
  void send({ type: 'seenStations' });
}

$('rivalSeg').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-part]');
  if (!button || button.dataset.part === view.rivalPart) return;
  view.rivalPart = button.dataset.part;
  savePrefs();
  render();
});

$('leadScopeSeg').addEventListener('click', (event) => {
  const scope = event.target.dataset.scope;
  if (!scope || scope === view.leadScope) return;
  view.leadScope = scope;
  savePrefs();
  render();
});

/* ───────── CSV 저장 ───────── */

function downloadCsv(name, rows) {
  // 엑셀이 한글을 바로 읽도록 BOM을 붙인다.
  const blob = new Blob([`\uFEFF${toCsv(rows)}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

$('exportChanges').addEventListener('click', () => {
  const { settings, state } = view;
  const events = filteredEvents();
  if (!events.length) {
    view.message = '저장할 변동 기록이 없습니다.';
    render();
    return;
  }
  const tab = view.changeTab === ALL_TAB ? '전체' : view.changeTab === TAXFREE_TAB ? '면세유' : PRODUCTS[view.changeTab];
  const rows = eventsCsvRows(events, {
    stations: state.stations,
    watched: settings.watched,
    myId: settings.station ? settings.station.id : null
  });
  downloadCsv(`가격변동_${tab}${view.scope === 'watched' ? '_감시' : ''}_${kstDate(Date.now())}.csv`, rows);
});

$('exportTrend').addEventListener('click', () => {
  const series = view.trendSeries;
  if (!series.some((row) => row.mine !== null || row.rival !== null || row.avg !== null)) {
    view.message = '저장할 추이 기록이 없습니다.';
    render();
    return;
  }
  const rows = [['날짜', '내 가격', '감시 주유소 최저가', '최저가 주유소', '차이(내 가격-감시 최저가)', `${cityName()} 평균`]];
  for (const row of series) {
    rows.push([
      row.date, row.mine ?? '', row.rival ?? '', stationName(row.rivalId),
      row.mine !== null && row.rival !== null ? row.mine - row.rival : '',
      row.avg === null ? '' : Math.round(row.avg * 100) / 100
    ]);
  }
  downloadCsv(`가격추이_${PRODUCTS[view.trendTab]}_${view.range}일_${kstDate(Date.now())}.csv`, rows);
});

$('rangeSeg').addEventListener('click', (event) => {
  const range = Number(event.target.dataset.range);
  if (!RANGES.includes(range) || range === view.range) return;
  view.range = range;
  savePrefs();
  render();
});

let programmaticScroll = false;

function scrollToDay(date) {
  const wrap = $('feedWrap');
  const section = $('feed').querySelector(`section.day[data-date="${date}"]`);
  if (!section) return;
  const target = Math.min(section.offsetTop, wrap.scrollHeight - wrap.clientHeight);
  view.activeDay = date;
  markActiveDay();
  if (Math.abs(target - wrap.scrollTop) < 1) return;
  programmaticScroll = true;
  wrap.scrollTo({ top: target, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

// 목록을 굴리면 맨 위에 걸린 날짜를 막대 차트에 표시한다.
$('feedWrap').addEventListener('scroll', () => {
  if (programmaticScroll) return;
  const wrap = $('feedWrap');
  const top = wrap.scrollTop + 4;
  let current = null;
  for (const section of $('feed').querySelectorAll('section.day')) {
    if (current && section.offsetTop > top) break;
    current = section.dataset.date;
  }
  if (current && current !== view.activeDay) {
    view.activeDay = current;
    markActiveDay();
  }
}, { passive: true });

$('feedWrap').addEventListener('scrollend', () => { programmaticScroll = false; });

/* ───────── 버튼 ───────── */

$('refresh').addEventListener('click', async () => {
  const button = $('refresh');
  button.disabled = true;
  button.textContent = '확인 중…';
  view.message = '';
  try {
    const result = await send({ type: 'refresh' });
    if (!result.ok) view.message = '';
    else if (result.skipped && result.reason) view.message = result.reason;
    else if (!result.skipped) view.message = result.changed ? `가격 변동 ${result.changed}건을 찾았습니다.` : '가격이 바뀐 곳이 없습니다.';
  } finally {
    button.disabled = false;
    button.textContent = '지금 확인';
    await load();
  }
});

$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

function renderPause() {
  const button = $('pauseToggle');
  if (button.disabled) return;
  button.textContent = view.paused ? '조회시작' : '조회중지';
  button.className = `btn ${view.paused ? 'go' : 'stop'}`;
  button.title = view.paused ? '자동 조회를 다시 시작합니다' : '정해진 시각의 자동 조회를 멈춥니다';
  $('autoStatus').classList.toggle('paused', view.paused);
  $('autoText').textContent = view.paused ? '자동 조회 중지됨' : '자동 조회 중';
}

$('pauseToggle').addEventListener('click', async () => {
  const button = $('pauseToggle');
  const next = !view.paused;
  button.disabled = true;
  button.textContent = next ? '중지 중…' : '시작 중…';
  try {
    const result = await send({ type: 'setPaused', paused: next });
    view.message = !result.ok ? result.error
      : next ? '자동 조회를 멈췄습니다. 지금 확인은 계속 쓸 수 있습니다.'
        : result.changed ? `자동 조회를 다시 시작했습니다. 가격 변동 ${result.changed}건을 찾았습니다.`
          : '자동 조회를 다시 시작했습니다.';
  } finally {
    button.disabled = false;
    await load();
  }
});

$('viewSwitch').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-view]');
  if (!button || button.dataset.view === view.mode) return;
  view.mode = button.dataset.view;
  view.openRow = null;
  if (view.mode === 'rivals') enterRivals();
  savePrefs();
  render();
});

$('sortSeg').addEventListener('click', (event) => {
  const mode = event.target.dataset.sort;
  if (!mode) return;
  view.sort = mode;
  render();
});

function setQuery(text) {
  view.query = text;
  $('stationFilter').value = text;
  $('stationFilter').closest('.search').classList.toggle('active', Boolean(text.trim()));
}

$('stationFilter').addEventListener('input', (event) => {
  setQuery(event.target.value);
  view.openRow = null;
  render();
});

$('stationFilter').addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !view.query) return;
  event.preventDefault(); // 팝업이 닫히지 않게 검색어만 지운다
  setQuery('');
  render();
});

$('filterSeg').addEventListener('click', (event) => {
  const mode = event.target.dataset.filter;
  if (!mode) return;
  view.filter = mode;
  render();
});

$('scopeSeg').addEventListener('click', (event) => {
  const scope = event.target.dataset.scope;
  if (!scope || scope === view.scope) return;
  view.scope = scope;
  savePrefs();
  render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') void load();
});

// 팝업을 열 때 아직 안 본 감시 주유소 변동을 기억해 두고 "새"로 표시한다. 새 변동이 있으면 변동 보기로 연다.
const prefs = readPrefs();
view.mode = ['changes', 'trend', 'rivals'].includes(prefs.mode) ? prefs.mode : 'prices';
view.range = RANGES.includes(prefs.range) ? prefs.range : 30;
view.scope = prefs.scope === 'watched' ? 'watched' : 'all';
view.rivalPart = prefs.rivalPart === 'roster' ? 'roster' : 'lead';
view.leadScope = prefs.leadScope === 'all' ? 'all' : 'watched';
const opened = await chrome.storage.local.get(['settings', 'state']);
const unseen = (opened.state && opened.state.unseen) || 0;
if (unseen > 0) {
  const watchedIds = new Set((opened.settings && opened.settings.watched) || []);
  const fresh = ((opened.state && opened.state.events) || []).filter((event) => watchedIds.has(event.id)).slice(0, unseen);
  view.newKeys = new Set(fresh.map(eventKey));
  view.mode = 'changes';
}
await load();
if (view.mode === 'rivals' && view.state.unseenStations) {
  enterRivals();
  render();
}
void send({ type: 'seen' });
