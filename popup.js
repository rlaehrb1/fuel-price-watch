import {
  BRANDS,
  DAILY_LIMIT,
  DEFAULT_SETTINGS,
  PRODUCTS,
  TAXFREE_PRODUCTS,
  callsToday,
  emptyState,
  eventText,
  formatDistance,
  formatKst,
  sortRows,
  summarize,
  won
} from './lib.js';

const TAXFREE_TAB = 'taxfree';
const $ = (id) => document.getElementById(id);

const view = {
  settings: { ...DEFAULT_SETTINGS },
  state: emptyState(),
  calls: null,
  paused: false,
  tab: null,
  taxfreeProd: null,
  sort: 'price',
  filter: 'all',
  openRow: null,
  message: ''
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function load() {
  const stored = await chrome.storage.local.get(['settings', 'state', 'calls', 'paused']);
  view.settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  view.state = { ...emptyState(), ...(stored.state || {}) };
  view.calls = stored.calls || null;
  view.paused = stored.paused === true;
  if (!view.tab || (view.tab !== TAXFREE_TAB && !view.settings.products.includes(view.tab))) {
    view.tab = view.settings.products[0] || TAXFREE_TAB;
  }
  if (!view.settings.taxfreeProducts.includes(view.taxfreeProd)) {
    view.taxfreeProd = view.settings.taxfreeProducts.includes('D147') ? 'D147' : view.settings.taxfreeProducts[0];
  }
  render();
}

function currentProduct() {
  return view.tab === TAXFREE_TAB ? view.taxfreeProd : view.tab;
}

function render() {
  const { settings, state } = view;
  const taxfree = view.tab === TAXFREE_TAB;
  $('stationName').textContent = settings.station ? settings.station.name : '주유소 가격 감시';
  $('checkedAt').textContent = state.fetchedAt ? `${formatKst(state.fetchedAt)} 확인` : '아직 확인하지 않음';
  renderPause();

  renderNotice();
  renderTabs();

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

  renderRows(summary, prod);
  renderEvents();
  $('calls').textContent = `오늘 오피넷 호출 ${callsToday(view.calls, Date.now())} / ${DAILY_LIMIT}`;
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

function renderTabs() {
  const tabs = $('tabs');
  tabs.replaceChildren();
  const entries = view.settings.products.map((code) => [code, PRODUCTS[code]]);
  if (view.settings.taxfreeArea && view.settings.taxfreeProducts.length) {
    entries.push([TAXFREE_TAB, `면세유(${view.settings.taxfreeArea.name.replace(/시$|군$/, '')})`]);
  }
  for (const [code, label] of entries) {
    const button = el('button', code === view.tab ? 'on' : '', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      view.tab = code;
      view.openRow = null;
      render();
    });
    tabs.append(button);
  }

  const sub = $('subTabs');
  sub.hidden = view.tab !== TAXFREE_TAB;
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

function stat(label, value, unit, sub) {
  const box = el('div', 'stat');
  box.append(el('div', 'label', label));
  const main = el('div', 'value', value);
  if (unit) main.append(el('small', '', ` ${unit}`));
  box.append(main);
  box.append(el('div', 'sub', sub || ' '));
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

function renderRows(summary, prod) {
  const body = $('rows');
  body.replaceChildren();
  let rows = summary.rows;
  if (view.filter === 'watched') rows = rows.filter((row) => row.watched || row.mine);
  if (view.filter === 'top') rows = rows.filter((row) => row.topRank || row.mine);
  rows = sortRows(rows, view.sort);
  $('empty').hidden = rows.length > 0;
  $('empty').textContent = summary.rows.length ? '조건에 맞는 주유소가 없습니다.' : '아직 받은 가격이 없습니다.';

  for (const row of rows) {
    const tr = el('tr', `row${row.mine ? ' mine' : ''}`);

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
      changeCell.append(mark, el('div', 'muted', formatKst(row.change.at)));
    }

    tr.append(starCell, nameCell, priceCell, diffCell, changeCell);
    tr.addEventListener('click', () => {
      view.openRow = view.openRow === row.id ? null : row.id;
      render();
    });
    body.append(tr);

    if (view.openRow === row.id) body.append(historyRow(row, prod));
  }
}

function historyRow(row, prod) {
  const tr = el('tr', 'history');
  const td = el('td');
  td.colSpan = 5;
  const past = view.state.events.filter((event) => event.id === row.id && event.prod === prod).slice(0, 8);
  if (row.addr) td.append(el('div', 'muted', row.addr));
  if (!past.length) {
    td.append(el('div', 'muted', '설치한 뒤로 가격 변동이 없습니다.'));
  } else {
    const list = el('ul');
    for (const event of past) {
      const delta = event.to - event.from;
      const item = el('li', '', `${formatKst(event.at)}  ${won(event.from)} → ${won(event.to)} `);
      item.append(el('span', delta > 0 ? 'up' : 'down', `${delta > 0 ? '▲' : '▼'}${won(Math.abs(delta))}`));
      list.append(item);
    }
    td.append(list);
  }
  tr.append(td);
  return tr;
}

function renderEvents() {
  const list = $('events');
  list.replaceChildren();
  const events = view.state.events.slice(0, 30);
  $('eventCount').textContent = events.length ? `${view.state.events.length}건` : '없음';
  const watched = new Set(view.settings.watched || []);
  for (const event of events) {
    const item = el('li');
    item.append(el('span', 'when', formatKst(event.at)));
    const text = el('span', '', `${watched.has(event.id) ? '★ ' : ''}${eventText(event)}`);
    item.append(text);
    list.append(item);
  }
}

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

$('sortSeg').addEventListener('click', (event) => {
  const mode = event.target.dataset.sort;
  if (!mode) return;
  view.sort = mode;
  render();
});

$('filterSeg').addEventListener('click', (event) => {
  const mode = event.target.dataset.filter;
  if (!mode) return;
  view.filter = mode;
  render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') void load();
});

await load();
$('eventsBox').open = view.state.unseen > 0;
void send({ type: 'seen' });
