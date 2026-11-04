'use strict';
// 选宠器：1025 条全在本地索引里，断网也能搜；有图的显示缩略图，没图的显示属性色编号牌。

const TYPE_COLORS = {
  一般: '#A8A77A', 火: '#EE8130', 水: '#6390F0', 电: '#F7D02C', 草: '#7AC74C',
  冰: '#96D9D6', 格斗: '#C22E28', 毒: '#A33EA1', 地面: '#E2BF65', 飞行: '#A98FF3',
  超能力: '#F95587', 虫: '#A6B91A', 岩石: '#B6A136', 幽灵: '#735797', 龙: '#6F35FC',
  恶: '#705746', 钢: '#B7B7CE', 妖精: '#D685AD',
};

const $ = (id) => document.getElementById(id);
const cards = [];        // { el, star, text, id, hasImage }
let current = 0;
let visible = [];
let favs = new Set();    // 收藏的 id
let PY = {};             // id -> [全拼, 首字母]，来自主进程的 pinyin.json

const pad = (n) => String(n).padStart(3, '0');

const STAR = '\u2605';   // ★
const STAR_OFF = '\u2606'; // ☆

function typeColor(types) {
  for (const t of types || []) if (TYPE_COLORS[t]) return TYPE_COLORS[t];
  return '#8A8F98';
}

function buildCard(item, cardBase, hasImage) {
  const el = document.createElement('div');
  el.className = 'card' + (hasImage ? '' : ' none');
  el.dataset.id = String(item.id);

  const thumb = document.createElement('div');
  thumb.className = 'thumb' + (hasImage ? '' : ' ph');
  if (hasImage) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    // 卡片图是构建期生成的小图（64px 高）：像素是 2 倍最近邻，水彩是裁紧后缩放。
    // 曾经直接加载 640×360 立绘，浏览器按原始尺寸解码 ≈ 921KB/张，1025 张要 1GB。
    img.src = `${cardBase}${pad(item.id)}.png`;
    img.style.imageRendering = 'pixelated';
    img.alt = item.zh || item.en;
    thumb.appendChild(img);
  } else {
    thumb.textContent = '#' + item.no;
    thumb.style.background = `linear-gradient(160deg, ${typeColor(item.types)}, rgba(0,0,0,.35))`;
  }

  const no = document.createElement('div');
  no.className = 'no';
  no.textContent = '#' + item.no;

  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = item.zh || item.en || '';

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = [item.heightM ? item.heightM + 'm' : '', (item.types || []).join('/')]
    .filter(Boolean).join(' · ');

  // 收藏星标：点它只切换收藏，不选宠（stopPropagation）
  const star = document.createElement('div');
  star.className = 'star';
  star.title = '收藏 / 取消收藏';
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFav(item.id);
  });

  el.append(thumb, no, nm, meta, star);
  el.addEventListener('click', () => choose(item.id));

  // 搜索文本一次算好：编号（带前导零和不带都要能命中）+ 简繁中文 + 日文 + 英文 + 属性 + 拼音
  const py = PY[String(item.id)] || [];
  const text = [
    item.no, String(item.id), '#' + item.no,
    item.zh, item.zhHant, item.ja, item.romaji, item.en, item.slug,
    (item.types || []).join(' '), (item.typesEn || []).join(' '),
    ...py,
  ].filter(Boolean).join(' ').toLowerCase();

  return { el, star, text, id: item.id, hasImage };
}

function paintStar(c) {
  const on = favs.has(c.id);
  c.star.textContent = on ? STAR : STAR_OFF;
  c.star.classList.toggle('on', on);
  c.el.classList.toggle('fav', on);
}

async function toggleFav(id) {
  const on = !favs.has(id);
  if (on) favs.add(id); else favs.delete(id);
  const c = cards.find((x) => x.id === id);
  if (c) paintStar(c);
  render();                                  // 收藏筛选开着时要立刻把卡片撤掉
  try {
    const list = await window.pickerBridge.fav(id, on);
    if (Array.isArray(list)) {
      favs = new Set(list.map(Number));
      for (const cc of cards) paintStar(cc);
      render();
    }
  } catch { /* 落盘失败就保持界面上的状态，下次启动会以文件为准 */ }
}

function render() {
  const q = $('q').value.trim().toLowerCase();
  const onlyHave = $('onlyHave').checked;
  const onlyFav = $('onlyFav').checked;
  const terms = q.split(/\s+/).filter(Boolean);

  visible = [];
  const frag = document.createDocumentFragment();
  for (const c of cards) {
    const ok = (!onlyHave || c.hasImage)
      && (!onlyFav || favs.has(c.id))
      && terms.every((t) => c.text.includes(t));
    if (ok) visible.push(c);
  }
  // 只把命中的重新挂上去，避免 1025 个节点反复隐藏/显示
  $('grid').textContent = '';
  for (const c of visible) frag.appendChild(c.el);
  $('grid').appendChild(frag);

  $('count').textContent = `${visible.length} / ${cards.length}`;
  $('empty').hidden = visible.length > 0;
  $('favHint').hidden = !(onlyFav && favs.size === 0);
  if (!$('favHint').hidden) $('empty').hidden = true;
}

function choose(id) {
  current = id;
  window.pickerBridge.choose(id);
}

async function boot() {
  const data = await window.pickerBridge.init();
  current = data.current;
  const have = new Set((data.have || []).map(Number));
  favs = new Set((data.fav || []).map(Number));
  PY = data.pinyin || {};
  console.log(`拼音索引 ${Object.keys(PY).length} 条`);

  const frag = document.createDocumentFragment();
  for (const item of data.items) {
    const c = buildCard(item, data.cardBase, have.has(item.id));
    if (item.id === current) c.el.classList.add('current');
    paintStar(c);
    cards.push(c);
    frag.appendChild(c.el);
  }
  $('grid').appendChild(frag);
  render();
  console.log(`收藏 ${favs.size} 个，星标 ${document.querySelectorAll('.star.on').length} 个`);

  let timer = null;
  $('q').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(render, 90);
  });
  $('onlyHave').addEventListener('change', render);
  $('onlyFav').addEventListener('change', render);

  $('q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && visible.length) choose(visible[0].id);
    if (e.key === 'Escape') window.close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.close();
  });
}

boot();
