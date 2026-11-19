import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOT_DELAY_MS,
  areaBackfillDate,
  dailySeries,
  eventsCsvRows,
  lastDays,
  mergeArea,
  parseAreaDaily,
  pruneEvents,
  recordDay,
  toCsv,
  badgeInfo,
  bumpCalls,
  callsPerCheck,
  callsToday,
  dayLabel,
  dayRange,
  defaultWatched,
  emptyState,
  eventText,
  formatKst,
  formatWhen,
  groupEventsByDay,
  latestSlotAt,
  mergeSnapshot,
  parseAverages,
  parseStations,
  shouldFetch,
  sortRows,
  summarize,
  watchedEvents
} from '../lib.js';

// 한국 시간으로 적은 시각을 밀리초로 바꾼다.
const kst = (text) => Date.parse(`${text}+09:00`);

const ME = 'A1';
const near = (id, price, dist, name = id) => ({ id, name, brand: 'GSC', addr: '', price, dist });

function firstSnapshot() {
  const fetched = {
    lists: {
      B027: {
        near: [near(ME, 1799, 0, '내 주유소'), near('A2', 1787, 226, '가까운 곳'), near('A3', 1829, 1075), near('A4', 1850, 3000)],
        top: [near('A2', 1787, 226, '가까운 곳'), near('A9', 1790, 7200, '먼 곳')]
      }
    },
    average: { B027: { price: 1832.77, diff: 1.42 } }
  };
  return mergeSnapshot(emptyState(), fetched, kst('2026-11-10T09:10:00'));
}

test('확인 시각은 오피넷 갱신 시각의 10분 뒤다', () => {
  assert.equal(latestSlotAt(kst('2026-11-10T09:05:00')), kst('2026-11-10T02:00:00') + SLOT_DELAY_MS);
  assert.equal(latestSlotAt(kst('2026-11-10T09:10:00')), kst('2026-11-10T09:10:00'));
  assert.equal(latestSlotAt(kst('2026-11-10T15:59:00')), kst('2026-11-10T12:10:00'));
  assert.equal(latestSlotAt(kst('2026-11-10T00:30:00')), kst('2026-11-09T19:10:00'));
});

test('같은 갱신 구간 안에서는 다시 받지 않는다', () => {
  const fetchedAt = kst('2026-11-10T12:15:00');
  assert.equal(shouldFetch(0, kst('2026-11-10T12:15:00')), true);
  assert.equal(shouldFetch(fetchedAt, kst('2026-11-10T15:00:00')), false);
  assert.equal(shouldFetch(fetchedAt, kst('2026-11-10T16:10:00')), true);
});

test('호출 수는 한국 날짜가 바뀌면 다시 센다', () => {
  let calls = bumpCalls(null, kst('2026-11-10T23:50:00'));
  calls = bumpCalls(calls, kst('2026-11-10T23:55:00'));
  assert.deepEqual(calls, { date: '2026-11-10', count: 2 });
  assert.equal(callsToday(calls, kst('2026-11-10T23:59:00')), 2);
  assert.equal(callsToday(calls, kst('2026-11-11T00:01:00')), 0);
  assert.deepEqual(bumpCalls(calls, kst('2026-11-11T00:01:00')), { date: '2026-11-11', count: 1 });
});

test('오피넷 응답을 읽고, 거리가 없으면 좌표로 계산한다', () => {
  const around = parseStations({ RESULT: { OIL: [
    { UNI_ID: 'A1', POLL_DIV_CD: 'GSC', OS_NM: ' 가 ', PRICE: 1799, DISTANCE: 0, GIS_X_COOR: 100, GIS_Y_COOR: 100 },
    { UNI_ID: 'A2', POLL_DIV_CD: 'SKE', OS_NM: '나', PRICE: 0, DISTANCE: 50 }
  ] } });
  assert.deepEqual(around, [{ id: 'A1', name: '가', brand: 'GSC', addr: '', price: 1799, dist: 0 }]);

  const top = parseStations({ RESULT: { OIL: [
    { UNI_ID: 'A3', POLL_DIV_CD: 'SOL', OS_NM: '다', PRICE: 1700, NEW_ADR: '전주', GIS_X_COOR: 400, GIS_Y_COOR: 500 }
  ] } }, { x: 100, y: 100 });
  assert.equal(top[0].dist, 500);
  assert.equal(top[0].addr, '전주');
  assert.deepEqual(parseStations({ RESULT: {} }), []);
  assert.deepEqual(parseAverages({ RESULT: { OIL: [{ PRODCD: 'B027', PRICE: 1832.77, DIFF: 1.42 }] } }),
    { B027: { price: 1832.77, diff: 1.42 } });
});

test('첫 수집은 변동 없이 가격만 저장한다', () => {
  const { state, events } = firstSnapshot();
  assert.equal(events.length, 0);
  assert.equal(Object.keys(state.prices.B027).length, 5);
  assert.deepEqual(state.top.B027, ['A2', 'A9']);
  assert.equal(state.stations.A2.dist, 226);
  assert.equal(state.average.B027.price, 1832.77);
});

test('가격이 바뀐 주유소만 변동으로 잡는다', () => {
  const first = firstSnapshot().state;
  const at = kst('2026-11-10T12:10:00');
  const { state, events } = mergeSnapshot(first, {
    lists: { B027: { near: [near(ME, 1799, 0), near('A2', 1777, 226, '가까운 곳'), near('A3', 1829, 1075)], top: [near('A2', 1777, 226, '가까운 곳')] } }
  }, at);
  assert.deepEqual(events, [{ at, id: 'A2', name: '가까운 곳', prod: 'B027', from: 1787, to: 1777 }]);
  assert.deepEqual(state.changes.B027.A2, { from: 1787, at });
  assert.equal(state.prices.B027.A4, undefined);
  assert.equal(state.events.length, 1);
  assert.equal(eventText(events[0]), '가까운 곳 휘발유 1,787 → 1,777 (▼10)');
});

test('응답이 빈 제품은 이전 가격을 지우지 않는다', () => {
  const first = firstSnapshot().state;
  const { state, events } = mergeSnapshot(first, { lists: { B027: { near: [], top: [] } } }, kst('2026-11-10T12:10:00'));
  assert.equal(events.length, 0);
  assert.equal(state.prices.B027.A2, 1787);
});

test('요약은 내 순위, 최저가, 시 평균을 낸다', () => {
  const { state } = firstSnapshot();
  const summary = summarize(state, 'B027', ME, ['A2']);
  assert.equal(summary.mine, 1799);
  assert.equal(summary.count, 5);
  assert.equal(summary.rank, 3);
  assert.equal(summary.lowest.id, 'A2');
  assert.equal(summary.cityAverage.price, 1832.77);
  const row = summary.rows.find((item) => item.id === 'A2');
  assert.equal(row.diff, -12);
  assert.equal(row.topRank, 1);
  assert.equal(row.watched, true);
  assert.deepEqual(sortRows(summary.rows, 'price').map((item) => item.id), ['A2', 'A9', ME, 'A3', 'A4']);
  assert.deepEqual(sortRows(summary.rows, 'dist').map((item) => item.id), [ME, 'A2', 'A3', 'A4', 'A9']);
});

test('처음에는 1.5km 안의 주유소를 감시 대상으로 잡는다', () => {
  const { state } = firstSnapshot();
  assert.deepEqual(defaultWatched(state, ME), ['A2', 'A3']);
});

test('알림은 감시 중인 주유소의 변동만 고른다', () => {
  const events = [{ id: 'A2' }, { id: 'A4' }];
  assert.deepEqual(watchedEvents(events, ['A2']), [{ id: 'A2' }]);
  assert.deepEqual(watchedEvents(events, null), []);
});

test('배지는 감시 주유소 최저가와 내 가격의 차이를 보여준다', () => {
  const { state } = firstSnapshot();
  const settings = { products: ['B027'], station: { id: ME }, watched: ['A2', 'A3'] };
  assert.deepEqual(badgeInfo(state, settings), {
    text: '+12', alert: false, title: '휘발유: 감시 주유소 최저가보다 12원 비쌈'
  });
  const alerted = badgeInfo({ ...state, unseen: 2 }, settings);
  assert.equal(alerted.alert, true);
  assert.match(alerted.title, /새 가격 변동 2건/);
  assert.equal(badgeInfo(state, { ...settings, watched: ['A3'] }).text, '-30');
  assert.equal(badgeInfo(state, { ...settings, watched: [] }).text, '');
});

test('시각은 한국 시간으로 적는다', () => {
  assert.equal(formatKst(kst('2026-11-10T16:10:00')), '11/10 16:10');
});

test('추가 조사 중심의 결과는 내 주유소 기준 거리로 바꾸고 겹치는 곳은 한 번만 넣는다', () => {
  const origin = { x: 0, y: 0 };
  const fromCenter = parseStations({ RESULT: { OIL: [
    { UNI_ID: 'A2', POLL_DIV_CD: 'SKE', OS_NM: '겹치는 곳', PRICE: 1787, DISTANCE: 4800, GIS_X_COOR: 0, GIS_Y_COOR: 226 },
    { UNI_ID: 'B1', POLL_DIV_CD: 'SOL', OS_NM: '먼 곳', PRICE: 1770, DISTANCE: 100, GIS_X_COOR: 6000, GIS_Y_COOR: 8000 }
  ] } }, origin);
  assert.deepEqual(fromCenter.map((station) => station.dist), [226, 10000]);

  const mine = [near(ME, 1799, 0), near('A2', 1787, 226, '겹치는 곳')];
  const { state } = mergeSnapshot(emptyState(), { lists: { B027: { near: [...mine, ...fromCenter], top: [] } } }, 1);
  assert.deepEqual(Object.keys(state.prices.B027).sort(), ['A1', 'A2', 'B1']);
  assert.equal(state.stations.B1.dist, 10000);
  assert.equal(summarize(state, 'B027', ME).lowest.id, 'B1');
});

test('호출 수는 조사 중심과 제품 수로 정해진다', () => {
  const base = {
    products: ['B027', 'D047', 'B034', 'C004'], extraCenters: [],
    city: { code: '0601' }, taxfreeArea: { code: '0606' }, taxfreeProducts: ['B127', 'D147', 'C104']
  };
  assert.equal(callsPerCheck(base), 12);
  assert.equal(callsPerCheck({ ...base, extraCenters: [{ id: 'X' }] }), 16);
  assert.equal(callsPerCheck({ ...base, city: null, taxfreeArea: null }), 4);
});

test('변동 기록은 날짜, 확인 시각, 주유소 순으로 묶는다', () => {
  const at1 = kst('2026-11-19T09:10:00');
  const at2 = kst('2026-11-19T01:10:00');
  const at3 = kst('2026-11-18T19:10:00');
  const events = [
    { at: at1, id: 'A2', name: '가', prod: 'D047', from: 1650, to: 1640 },
    { at: at1, id: 'A3', name: '나', prod: 'B027', from: 1779, to: 1799 },
    { at: at1, id: 'A2', name: '가', prod: 'B027', from: 1797, to: 1787 },
    { at: at2, id: 'A3', name: '나', prod: 'B027', from: 1789, to: 1779 },
    { at: at3, id: 'A4', name: '다', prod: 'B027', from: 1800, to: 1810 }
  ];
  const days = groupEventsByDay(events);
  assert.deepEqual(days.map((day) => day.date), ['2026-11-19', '2026-11-18']);
  const [today, yesterday] = days;
  assert.equal(today.slots.length, 2);
  assert.deepEqual(today.slots[0].entries.map((entry) => entry.id), ['A2', 'A3']);
  assert.deepEqual(today.slots[0].entries[0].changes.map((change) => [change.prod, change.delta]), [['B027', -10], ['D047', -10]]);
  assert.deepEqual([today.up, today.down, today.stations], [1, 3, 2]);
  assert.deepEqual([yesterday.up, yesterday.down, yesterday.stations], [1, 0, 1]);
});

test('날짜 이름표와 짧은 시각은 오늘·어제를 붙인다', () => {
  const now = kst('2026-11-19T10:00:00');
  assert.equal(dayLabel('2026-11-19', now).relative, '오늘');
  assert.equal(dayLabel('2026-11-18', now).relative, '어제');
  assert.equal(dayLabel('2026-11-15', now).text, '11월 15일 (일)');
  assert.equal(dayLabel('2026-11-15', now).weekend, 'sun');
  assert.equal(formatWhen(kst('2026-11-19T09:10:00'), now), '오늘 09:10');
  assert.equal(formatWhen(kst('2026-11-18T23:50:00'), now), '어제 23:50');
  assert.equal(formatWhen(kst('2026-11-17T19:10:00'), now), '11/17 19:10');
});

test('날짜 칸은 오늘에서 끝나고 7~14일 사이다', () => {
  const now = kst('2026-11-19T10:00:00');
  const short = dayRange(null, now);
  assert.equal(short.length, 7);
  assert.equal(short[0], '2026-11-13');
  assert.equal(short[6], '2026-11-19');
  assert.equal(dayRange('2026-11-10', now).length, 10);
  const long = dayRange('2026-10-01', now);
  assert.equal(long.length, 14);
  assert.equal(long[0], '2026-11-06');
  assert.equal(dayRange('2026-11-01', kst('2026-11-03T01:00:00'))[0], '2026-10-28');
});

test('변동 기록은 90일 동안 남기고 그보다 오래된 날은 지운다', () => {
  const now = kst('2026-11-19T10:00:00');
  const events = [
    { at: kst('2026-11-19T09:10:00'), id: 'A2' },
    { at: kst('2026-08-22T01:10:00'), id: 'A3' },
    { at: kst('2026-08-21T23:59:00'), id: 'A4' }
  ];
  assert.deepEqual(pruneEvents(events, now).map((event) => event.id), ['A2', 'A3']);
});

test('CSV는 따옴표와 쉼표를 지키고 감시 여부를 적는다', () => {
  const rows = eventsCsvRows(
    [{ at: kst('2026-11-19T09:10:00'), id: 'A2', name: '가, 나', prod: 'B027', from: 1797, to: 1787 }],
    { stations: { A2: { name: '가, 나', brand: 'SKE', dist: 226 } }, watched: ['A2'], myId: ME }
  );
  const csv = toCsv(rows);
  assert.equal(csv.split(String.fromCharCode(13, 10))[1], '2026-11-19,09:10,"가, 나",SK에너지,226,휘발유,1797,1787,-10,감시');
});

test('하루 기록은 오늘 칸을 덮어쓰고 내 주유소와 감시 주유소 가격만 남긴다', () => {
  const { state } = firstSnapshot();
  const settings = { products: ['B027'], station: { id: ME }, watched: ['A2'] };
  const history = recordDay(null, state, settings, kst('2026-11-10T09:10:00'));
  assert.deepEqual(history.days['2026-11-10'].B027, { p: { A1: 1799, A2: 1787 }, avg: 1832.77, min: 1787 });
});

test('시·군 일일 평균을 읽고, 지역이 바뀌면 이전 평균을 버린다', () => {
  const daily = parseAreaDaily({ RESULT: { OIL: [
    { DATE: '20261118', PRODCD: 'B027', PRICE: '1830.5' },
    { DATE: '20261118', PRODCD: 'K015', PRICE: '1000' },
    { DATE: '20261117', PRODCD: 'D047', PRICE: 1700 }
  ] } });
  assert.deepEqual(daily, { '2026-11-18': { B027: 1830.5 }, '2026-11-17': { D047: 1700 } });
  const merged = mergeArea(null, daily, '0601');
  assert.equal(merged.area['2026-11-18'].B027, 1830.5);
  assert.deepEqual(mergeArea(merged, {}, '0602').area, {});
  const now = kst('2026-11-19T10:00:00');
  assert.equal(areaBackfillDate(merged, now), '20261116');
  assert.equal(areaBackfillDate(mergeArea(null, { '2026-08-20': { B027: 1 } }, '0601'), now), null);
});

test('날짜별 추이는 지금 가격에서 변동을 되돌려 그날 마지막 가격을 구한다', () => {
  const now = kst('2026-11-19T10:00:00');
  const state = {
    ...emptyState(),
    fetchedAt: now,
    prices: { B027: { A1: 1790, A2: 1780, A3: 1800 } },
    average: { B027: { price: 1825, diff: 0 } },
    events: [
      { at: kst('2026-11-19T09:10:00'), id: 'A2', prod: 'B027', from: 1795, to: 1780 },
      { at: kst('2026-11-18T12:10:00'), id: 'A1', prod: 'B027', from: 1800, to: 1790 },
      { at: kst('2026-11-17T09:10:00'), id: 'A3', prod: 'B027', from: 1790, to: 1800 }
    ]
  };
  const history = {
    days: { '2026-11-15': { B027: { p: { A1: 1810, A2: 1805 }, avg: 1840, min: 1790 } } },
    area: { '2026-11-18': { B027: 1828 } }
  };
  const series = dailySeries(state, history, 'B027', { myId: ME, watched: ['A2', 'A3'], dates: lastDays(now, 5), now });
  assert.deepEqual(series.map((row) => [row.date, row.mine, row.rival, row.rivalId, row.avg]), [
    ['2026-11-15', 1810, 1805, 'A2', 1840],
    ['2026-11-16', null, null, null, null],
    ['2026-11-17', 1800, 1795, 'A2', null],
    ['2026-11-18', 1790, 1795, 'A2', 1828],
    ['2026-11-19', 1790, 1780, 'A2', 1825]
  ]);
});
