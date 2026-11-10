import { DEFAULT_SETTINGS, PRODUCTS, TAXFREE_PRODUCTS, UPDATE_HOURS, callsPerCheck } from './lib.js';

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULT_SETTINGS };
let pickedStation = null;
let centers = [];

function option(value, label) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function fillChecks(box, names, selected) {
  box.replaceChildren();
  for (const [code, name] of Object.entries(names)) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = code;
    input.checked = selected.includes(code);
    input.addEventListener('change', updateCost);
    label.append(input, ` ${name}`);
    box.append(label);
  }
}

function checked(box) {
  return [...box.querySelectorAll('input:checked')].map((input) => input.value);
}

function fillAreaSelect(select, areas, current) {
  select.replaceChildren(option('', '사용 안 함'));
  const list = [...areas];
  if (current && !list.some((area) => area.code === current.code)) list.unshift(current);
  for (const area of list) select.append(option(area.code, area.name));
  select.value = current ? current.code : '';
}

function areaFrom(select) {
  if (!select.value) return null;
  return { code: select.value, name: select.selectedOptions[0].textContent };
}

function showStation() {
  const station = pickedStation;
  $('currentStation').textContent = station ? `지금: ${station.name} (${station.id})` : '아직 정하지 않았습니다.';
}

function showCenters() {
  const box = $('centers');
  box.replaceChildren();
  if (!centers.length) {
    box.append(Object.assign(document.createElement('li'), { className: 'muted', textContent: '추가한 곳이 없습니다. 위에서 주유소를 찾아 추가해 주세요.' }));
    return;
  }
  for (const center of centers) {
    const item = document.createElement('li');
    const text = Object.assign(document.createElement('div'), { textContent: `${center.name} (${center.id})` });
    const remove = Object.assign(document.createElement('button'), { className: 'btn', type: 'button', textContent: '빼기' });
    remove.addEventListener('click', () => {
      centers = centers.filter((other) => other.id !== center.id);
      showCenters();
      updateCost();
    });
    item.append(text, remove);
    box.append(item);
  }
}

function updateCost() {
  const perCheck = callsPerCheck({
    products: checked($('products')),
    extraCenters: centers,
    city: $('city').value || null,
    taxfreeArea: $('taxfreeArea').value || null,
    taxfreeProducts: checked($('taxfreeProducts'))
  });
  $('perCheck').textContent = String(perCheck);
  $('perDay').textContent = String(perCheck * UPDATE_HOURS.length);
}

async function loadAreas() {
  const sido = pickedStation && pickedStation.sigun
    ? pickedStation.sigun.slice(0, 2)
    : (settings.city ? settings.city.code.slice(0, 2) : '');
  if (!sido || !settings.apiKey) {
    fillAreaSelect($('city'), [], settings.city);
    fillAreaSelect($('taxfreeArea'), [], settings.taxfreeArea);
    $('areaHint').textContent = '다른 시·군을 고르려면 API 키를 저장하고 내 주유소를 먼저 정해 주세요.';
    return;
  }
  const { areas: cached } = await chrome.storage.local.get('areas');
  let areas = cached && cached.sido === sido ? cached.list : null;
  if (!areas) {
    const result = await chrome.runtime.sendMessage({ type: 'listAreas', sido });
    areas = result.ok ? result.areas : [];
    if (areas.length) await chrome.storage.local.set({ areas: { sido, list: areas } });
  }
  fillAreaSelect($('city'), areas, settings.city);
  fillAreaSelect($('taxfreeArea'), areas, settings.taxfreeArea);
  $('areaHint').textContent = '';
}

async function load() {
  const stored = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  pickedStation = settings.station;
  centers = [...(settings.extraCenters || [])];
  showCenters();
  $('apiKey').value = settings.apiKey;
  $('radius').value = String(settings.radius);
  $('notify').checked = settings.notify;
  fillChecks($('products'), PRODUCTS, settings.products);
  fillChecks($('taxfreeProducts'), TAXFREE_PRODUCTS, settings.taxfreeProducts);
  showStation();
  await loadAreas();
  updateCost();
}

$('stationSearch').addEventListener('click', async () => {
  const name = $('stationQuery').value.trim();
  const box = $('stationResults');
  box.replaceChildren();
  if (name.length < 2) {
    box.append(Object.assign(document.createElement('li'), { textContent: '두 글자 이상 입력해 주세요.' }));
    return;
  }
  const typedKey = $('apiKey').value.trim();
  if (typedKey && typedKey !== settings.apiKey) {
    settings = { ...settings, apiKey: typedKey };
    await chrome.storage.local.set({ settings });
  }
  const result = await chrome.runtime.sendMessage({ type: 'searchStation', name });
  if (!result.ok || !result.stations.length) {
    box.append(Object.assign(document.createElement('li'), { textContent: result.ok ? '찾은 주유소가 없습니다.' : result.error }));
    return;
  }
  for (const station of result.stations) {
    const item = document.createElement('li');
    const text = document.createElement('div');
    text.append(Object.assign(document.createElement('b'), { textContent: station.name }));
    text.append(Object.assign(document.createElement('div'), { className: 'muted', textContent: station.addr }));
    const add = Object.assign(document.createElement('button'), { className: 'btn', type: 'button', textContent: '조사 중심 추가' });
    add.addEventListener('click', () => {
      const isMine = pickedStation && pickedStation.id === station.id;
      if (!isMine && !centers.some((center) => center.id === station.id)) {
        centers = [...centers, { id: station.id, name: station.name, x: station.x, y: station.y }];
      }
      box.replaceChildren();
      showCenters();
      updateCost();
    });
    const pick = Object.assign(document.createElement('button'), { className: 'btn', type: 'button', textContent: '내 주유소로' });
    pick.addEventListener('click', async () => {
      pickedStation = station;
      centers = centers.filter((center) => center.id !== station.id);
      showCenters();
      showStation();
      box.replaceChildren();
      await loadAreas();
      updateCost();
    });
    item.append(text, pick, add);
    box.append(item);
  }
});

for (const id of ['city', 'taxfreeArea']) $(id).addEventListener('change', updateCost);

$('save').addEventListener('click', async () => {
  const products = checked($('products'));
  if (!products.length) {
    $('saved').textContent = '일반 제품을 하나 이상 골라 주세요.';
    return;
  }
  const stationChanged = (pickedStation && pickedStation.id) !== (settings.station && settings.station.id);
  const next = {
    ...settings,
    apiKey: $('apiKey').value.trim(),
    station: pickedStation
      ? { id: pickedStation.id, name: pickedStation.name, x: pickedStation.x, y: pickedStation.y, sigun: pickedStation.sigun }
      : null,
    radius: Number($('radius').value),
    extraCenters: centers,
    city: areaFrom($('city')),
    taxfreeArea: areaFrom($('taxfreeArea')),
    products,
    taxfreeProducts: checked($('taxfreeProducts')),
    notify: $('notify').checked,
    watched: stationChanged ? null : settings.watched
  };
  const reset = stationChanged
    || next.radius !== settings.radius
    || centers.map((center) => center.id).join() !== (settings.extraCenters || []).map((center) => center.id).join()
    || (next.city && next.city.code) !== (settings.city && settings.city.code)
    || (next.taxfreeArea && next.taxfreeArea.code) !== (settings.taxfreeArea && settings.taxfreeArea.code);
  await chrome.storage.local.set({ settings: next });
  settings = next;
  $('saved').textContent = '저장했습니다. 가격을 다시 확인하는 중…';
  const result = await chrome.runtime.sendMessage({ type: 'settingsChanged', reset });
  $('saved').textContent = result.ok ? '저장했습니다.' : `저장했지만 가격 확인에 실패했습니다: ${result.error}`;
});

await load();
