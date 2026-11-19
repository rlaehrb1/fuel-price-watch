import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKUP_APP,
  DETAIL_PER_RUN,
  detailBudget,
  detailFeatures,
  detailQueue,
  emptyState,
  lagText,
  leaderStats,
  makeBackup,
  matchesQuery,
  mergeSnapshot,
  parseDetail,
  priceWaves,
  reactionsTo,
  readBackup,
  slotsLeftToday,
  stationEventText,
  updateRoster
} from '../lib.js';

const kst = (text) => Date.parse(`${text}+09:00`);
const HOUR = 3600e3;
const move = (at, id, from, to, prod = 'B027') => ({ at: kst(at), id, name: id, prod, from, to });

test('같은 제품·같은 방향 변동은 첫 변동에서 3일 안이면 한 흐름으로 묶는다', () => {
  const events = [
    move('2026-11-01T09:10:00', 'A', 1800, 1790),
    move('2026-11-01T12:10:00', 'B', 1810, 1795),
    move('2026-11-01T12:10:00', 'B', 1700, 1690, 'D047'),
    move('2026-11-02T09:10:00', 'A', 1790, 1780), // 같은 흐름에서 두 번째 변동은 세지 않는다
    move('2026-11-03T16:10:00', 'C', 1805, 1800),
    move('2026-11-02T16:10:00', 'C', 1795, 1805), // 방향이 다르면 다른 흐름
    move('2026-11-06T09:10:00', 'B', 1795, 1785) // 3일이 지나면 새 흐름
  ];
  const waves = priceWaves(events, 'B027');
  assert.deepEqual(waves.map((wave) => [wave.dir, wave.moves.map((item) => item.id).join('')]), [
    [-1, 'ABC'],
    [1, 'C'],
    [-1, 'B']
  ]);
});

test('먼저 바꾼 곳·따라간 곳·동시·혼자를 나눠 세고 성향을 붙인다', () => {
  const events = [];
  // A가 먼저 내리고 B가 3시간 뒤, C가 하루 뒤 따라오는 흐름이 3번
  for (const day of ['2026-10-01', '2026-10-10', '2026-10-20']) {
    events.push(move(`${day}T09:10:00`, 'A', 1800, 1790));
    events.push(move(`${day}T12:10:00`, 'B', 1800, 1790));
    const next = new Date(Date.parse(day) + 86400e3).toISOString().slice(0, 10);
    events.push(move(`${next}T09:10:00`, 'C', 1800, 1790));
  }
  // B와 C가 같은 시각에 올림: 순서를 가릴 수 없다
  events.push(move('2026-10-25T09:10:00', 'B', 1790, 1800), move('2026-10-25T09:10:00', 'C', 1790, 1800));
  // D 혼자 바꿈
  events.push(move('2026-10-28T09:10:00', 'D', 1790, 1780));
  const result = leaderStats(events, 'B027');
  const byId = Object.fromEntries(result.rows.map((row) => [row.id, row]));
  assert.equal(result.waves, 4);
  assert.equal(result.down, 3);
  assert.equal(result.up, 1);
  assert.equal(byId.A.lead, 3);
  assert.equal(byId.A.leadDown, 3);
  assert.equal(byId.A.style, 'leader');
  assert.equal(byId.B.follow, 3);
  assert.equal(byId.B.together, 1);
  assert.equal(byId.B.avgLag, 3 * HOUR);
  assert.equal(byId.B.style, 'follower');
  assert.equal(byId.C.avgLag, 24 * HOUR);
  assert.equal(byId.D.solo, 1);
  assert.equal(byId.D.style, 'few');
  assert.equal(result.rows[0].id, 'A');
  // 감시 대상만 넣으면 그 안에서만 따진다
  const only = leaderStats(events, 'B027', new Set(['B', 'C']));
  assert.equal(only.rows.find((row) => row.id === 'B').lead, 3);
});

test('내가 바꾼 뒤 3일 안에 같은 방향으로 따라온 곳을 센다', () => {
  const events = [
    move('2026-11-01T09:10:00', 'ME', 1800, 1790),
    move('2026-11-01T09:10:00', 'X', 1800, 1790), // 같은 시각은 따라온 것이 아니다
    move('2026-11-01T16:10:00', 'A', 1800, 1790),
    move('2026-11-02T09:10:00', 'A', 1790, 1785), // 두 번째는 세지 않는다
    move('2026-11-05T09:10:00', 'B', 1800, 1790), // 3일이 넘음
    move('2026-11-10T09:10:00', 'ME', 1790, 1800),
    move('2026-11-10T12:10:00', 'B', 1790, 1800)
  ];
  const result = reactionsTo(events, 'B027', 'ME', ['ME', 'A', 'B', 'X']);
  assert.deepEqual(result.count, { up: 1, down: 1 });
  const byId = Object.fromEntries(result.rows.map((row) => [row.id, row]));
  assert.equal(byId.A.down.followed, 1);
  assert.equal(byId.A.down.avgLag, 7 * HOUR);
  assert.equal(byId.B.down.followed, 0);
  assert.equal(byId.B.up.followed, 1);
  assert.equal(byId.X.down.followed, 0);
  assert.equal(lagText(7 * HOUR), '7시간');
  assert.equal(lagText(36 * HOUR), '1.5일');
});

test('반경 안 명단: 새로 생김, 상표·상호 변경, 이틀 넘게 안 나오면 사라짐, 다시 나타남', () => {
  const t0 = kst('2026-11-01T09:10:00');
  const first = updateRoster({}, { A: { name: '가', brand: 'GSC' }, B: { name: '나', brand: 'SKE' } }, t0);
  assert.equal(first.events.length, 0); // 처음에는 알림 없이 명단만 만든다

  const t1 = t0 + 3 * HOUR;
  const second = updateRoster(first.roster, { A: { name: '가', brand: 'RTO' }, C: { name: '다', brand: 'SOL' } }, t1);
  assert.deepEqual(second.events.map((event) => event.kind), ['brand', 'new']);
  assert.equal(second.roster.B.gone, undefined); // 한 번 빠진 것은 아직 사라진 것으로 보지 않는다

  const t2 = t0 + 49 * HOUR;
  const third = updateRoster(second.roster, { A: { name: '가셀프', brand: 'RTO' }, C: { name: '다', brand: 'SOL' } }, t2);
  assert.deepEqual(third.events.map((event) => event.kind), ['rename', 'gone']);
  assert.equal(third.roster.B.gone, t2);

  // 응답이 덜 온 확인에서는 사라짐을 따지지 않는다
  const partial = updateRoster(third.roster, { A: { name: '가셀프', brand: 'RTO' } }, t2 + 72 * HOUR, { complete: false });
  assert.equal(partial.events.length, 0);

  const back = updateRoster(third.roster, { B: { name: '나', brand: 'SKE' } }, t2 + HOUR, { complete: false });
  assert.deepEqual(back.events.map((event) => event.kind), ['back']);
  assert.equal(back.roster.B.gone, undefined);

  // 제품 구성이 바뀌면 알림 없이 다시 만든다
  const reseed = updateRoster(third.roster, { Z: { name: '라', brand: 'GSC' } }, t2 + HOUR, { reseed: true });
  assert.equal(reseed.events.length, 0);
  assert.deepEqual(Object.keys(reseed.roster), ['Z']);

  assert.equal(stationEventText(second.events[0]), '가 상표 변경: GS칼텍스 → 알뜰');
});

test('명단은 일반 제품 반경 검색만 쓰고 면세유·시 최저가 목록은 넣지 않는다', () => {
  const station = (id, price) => ({ id, name: id, brand: 'GSC', addr: '', price, dist: 100 });
  const fetched = {
    lists: {
      B027: { near: [station('N1', 1800)], top: [station('T1', 1700)] },
      D047: { near: [station('N2', 1700)], top: [] },
      D147: { near: [], top: [station('F1', 1200)] }
    },
    average: {}
  };
  const first = mergeSnapshot(emptyState(), fetched, kst('2026-11-01T09:10:00'));
  assert.deepEqual(Object.keys(first.state.roster).sort(), ['N1', 'N2']);
  assert.equal(first.state.rosterKey, 'B027,D047');
  const later = {
    ...fetched,
    lists: { ...fetched.lists, B027: { near: [station('N1', 1800), station('N3', 1790)], top: [station('T2', 1690)] } }
  };
  const second = mergeSnapshot(first.state, later, kst('2026-11-01T12:10:00'));
  assert.deepEqual(second.stationEvents.map((event) => [event.kind, event.id]), [['new', 'N3']]);
  assert.equal(second.state.stationEvents.length, 1);
});

test('주유소 상세 정보를 읽고, 받을 순서와 이번에 받을 수를 정한다', () => {
  const now = kst('2026-11-19T12:20:00');
  const detail = parseDetail({ RESULT: { OIL: [{
    UNI_ID: 'A', TEL: '063-000-0000', CAR_WASH_YN: 'Y', CVS_YN: 'N', MAINT_YN: 'Y', KPETRO_YN: 'Y', GOOD_YN: 'Y', GOOD_YN5: 'N', LPG_YN: 'C', POLL_DIV_CD: 'GSC'
  }] } }, now);
  assert.deepEqual(detailFeatures(detail), ['세차', '경정비', 'LPG 충전', '품질인증', '착한주유소']);
  assert.equal(detail.tel, '063-000-0000');
  assert.equal(parseDetail({ RESULT: { OIL: [] } }, now), null);

  const roster = {
    FAR: { brand: 'GSC' }, NEAR: { brand: 'GSC' }, WATCH: { brand: 'SKE' }, DONE: { brand: 'GSC' },
    CHANGED: { brand: 'RTO' }, GONE: { brand: 'GSC', gone: now }, MISS: { brand: 'GSC' }
  };
  const items = {
    DONE: { at: now - 10 * 86400e3, brand: 'GSC' },
    CHANGED: { at: now - 86400e3, brand: 'GSC' },
    MISS: { at: now - 86400e3, missing: true }
  };
  const stations = { FAR: { dist: 4000 }, NEAR: { dist: 300 }, WATCH: { dist: 2000 }, CHANGED: { dist: 1000 } };
  assert.deepEqual(detailQueue(roster, items, { watched: ['WATCH'], stations, now }), ['WATCH', 'NEAR', 'CHANGED', 'FAR']);

  // 12:20이면 16시·19시 정기 확인 두 번이 남는다
  assert.equal(slotsLeftToday(now), 2);
  assert.equal(detailBudget({ callsToday: 60, detailsToday: 0, perCheck: 16, now }), DETAIL_PER_RUN);
  assert.equal(detailBudget({ callsToday: 60, detailsToday: 55, perCheck: 16, now }), 5);
  // 280 - 220 - (16*3+10) = 2
  assert.equal(detailBudget({ callsToday: 220, detailsToday: 0, perCheck: 16, now }), 2);
  assert.equal(detailBudget({ callsToday: 260, detailsToday: 0, perCheck: 16, now }), 0);
});

test('백업 파일을 만들고 다시 읽는다', () => {
  const now = kst('2026-11-19T12:00:00');
  const stored = {
    settings: { apiKey: 'K', station: { id: 'A', name: '내 주유소' } },
    state: { ...emptyState(), events: [{ at: now }], roster: { A: {}, B: {} } },
    history: { days: { '2026-11-18': {}, '2026-11-19': {} } },
    calls: { date: '2026-11-19', count: 3 }
  };
  const backup = makeBackup(stored, { version: '1.5.0', now });
  assert.equal(backup.app, BACKUP_APP);
  assert.equal(backup.data.calls, undefined); // 오늘 호출 수는 옮기지 않는다
  const { data, summary } = readBackup(`﻿${JSON.stringify(backup)}`);
  assert.equal(data.settings.apiKey, 'K');
  assert.deepEqual([summary.station, summary.events, summary.days, summary.stations], ['내 주유소', 1, 2, 2]);
  assert.throws(() => readBackup('not json'), /읽지 못했습니다/);
  assert.throws(() => readBackup(JSON.stringify({ app: 'other', data: {} })), /백업 파일이 아닙니다/);
  assert.throws(() => readBackup(JSON.stringify({ app: BACKUP_APP, data: {} })), /설정이 없습니다/);
});

test('가격표 검색은 띄어쓰기·대소문자를 무시하고 이름·상표·주소에서 찾는다', () => {
  const row = { name: '우문self주유소', brand: 'SKE', addr: '전북 전주시 덕진구 동부대로 1273' };
  assert.equal(matchesQuery(row, '우문 SELF'), true);
  assert.equal(matchesQuery(row, 'sk에너지'), true);
  assert.equal(matchesQuery(row, '동부대로'), true);
  assert.equal(matchesQuery(row, '  '), true);
  assert.equal(matchesQuery(row, '송천'), false);
});
