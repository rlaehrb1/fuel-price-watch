// 미리보기용 표본을 만든다: node tools/make-sample.mjs <오피넷 응답을 저장한 폴더>
// 폴더에는 around_b027.json, top_b027.json, around_d047.json, top_d047.json, tax_d147.json, tax_c104.json이 있어야 한다.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, defaultWatched, emptyState, mergeSnapshot, parseStations, watchedEvents } from '../lib.js';

const dir = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
const local = JSON.parse(readFileSync(join(here, '..', 'local-config.json'), 'utf8'));
const origin = { x: local.station.x, y: local.station.y };
const read = (name, from) => parseStations(JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')), from);

const lists = {
  B027: { near: read('around_b027'), top: read('top_b027', origin) },
  D047: { near: read('around_d047'), top: read('top_d047', origin) },
  D147: { near: [], top: read('tax_d147', origin) },
  C104: { near: [], top: read('tax_c104', origin) }
};
// 추가 조사 중심의 응답(around2_*.json)이 있으면 뒤에 붙인다.
for (const [prod, file] of [['B027', 'around2_b027'], ['D047', 'around2_d047']]) {
  if (existsSync(join(dir, `${file}.json`))) lists[prod].near.push(...read(file, origin));
}
const average = { B027: { price: 1832.77, diff: 1.42 }, D047: { price: 1822.36, diff: 1.3 } };

// 실제 응답을 "지금"으로 두고, 세 시간 전에는 몇 곳의 가격이 달랐다고 가정해 변동을 만든다.
const now = Date.now();
const earlier = structuredClone(lists);
const bump = { 1: 10, 3: -20, 6: 15 };
for (const [index, delta] of Object.entries(bump)) {
  const station = lists.B027.near[index];
  for (const list of [earlier.B027.near, earlier.B027.top]) {
    const same = list.find((item) => item.id === station.id);
    if (same) same.price += delta;
  }
}
const first = mergeSnapshot(emptyState(), { lists: earlier, average }, now - 3 * 3600 * 1000).state;
const { state, events } = mergeSnapshot(first, { lists, average }, now - 4 * 60 * 1000);
const watched = defaultWatched(state, local.station.id);
state.unseen = watchedEvents(events, watched).length;

const settings = { ...DEFAULT_SETTINGS, ...local, apiKey: 'PREVIEW', watched };
writeFileSync(join(here, 'sample.json'), JSON.stringify({ settings, state, calls: null }));
console.log('sample written', Object.keys(state.stations).length, 'stations', events.length, 'events');
