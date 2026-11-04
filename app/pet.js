'use strict';
// 宠物渲染层：把立绘当成一块有弹性的布，用网格变形驱动动作。
// 单张静态图如果只用 CSS 缩放/平移，永远只能整体晃动；切成网格按部位推拉顶点，
// 才有「头转过来看你」的观感，而且 1025 只共用同一套引擎，不需要逐只做素材。
//
// 关键约束：所有形变都是「时间的纯函数」或「会衰减到 0 的瞬时值」，
// 绝不把上一帧的结果叠到下一帧，否则连点几次就会越变越大。

const TYPE_COLORS = {
  一般: '#A8A77A', 火: '#EE8130', 水: '#6390F0', 电: '#F7D02C', 草: '#7AC74C',
  冰: '#96D9D6', 格斗: '#C22E28', 毒: '#A33EA1', 地面: '#E2BF65', 飞行: '#A98FF3',
  超能力: '#F95587', 虫: '#A6B91A', 岩石: '#B6A136', 幽灵: '#735797', 龙: '#6F35FC',
  恶: '#705746', 钢: '#B7B7CE', 妖精: '#D685AD',
};

const W = 640;
const H = 360;

const $ = (id) => document.getElementById(id);
const els = {};

let box = [226, 154, 414, 330];   // 精灵在 640x360 舞台里的包围盒（只用来算影子宽度）
// PMD 动作集：每个动作是「N 帧 × 8 方向」的雪碧图，这里按帧表逐帧播
const PMD = {
  meta: null,
  imgs: {},
  k: 5,
  anim: '',
  dir: 'S',
  fi: 0,
  acc: 0,
  once: false,
  lastTouch: 0,
  sleepAfter: 20000,   // 20 秒没人理就打瞌睡
  sitUntil: 0,
  forced: false,       // 录演示时由主进程指定动作，状态机不插手
};
let pmdMode = false;
let debugLog = false;   // 主进程给了 debug 才写状态日志
const BASELINE_Y = 330;
let img = null;
let imgReady = false;
let rafId = null;

const dpr = Math.max(1, window.devicePixelRatio || 1);
let ctx = null;

// ---------- 动态状态（全部会被衰减，不累积） ----------
const st = {
  squash: 0, squashV: 0,       // 点击压扁：弹簧量，会回 0
  hop: 0, hopV: 0,             // 点击弹跳
  t0: performance.now(),
  hasCursor: false,
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function gradientFor(types) {
  const list = (types && types.length ? types : ['一般']).map((t) => TYPE_COLORS[t] || '#8A8F98');
  if (list.length === 1) return `linear-gradient(160deg, ${list[0]}, ${shade(list[0], -18)})`;
  return `linear-gradient(160deg, ${list[0]}, ${list[1]})`;
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const out = c.map((v) => Math.max(0, Math.min(255, v + amt)));
  return '#' + out.map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ---------- PMD 动作播放 ----------

function pmdLoad(meta) {
  PMD.meta = meta;
  PMD.imgs = {};
  for (const dirs of Object.values(meta.anims)) {
    for (const v of Object.values(dirs)) {
      const im = new Image();
      im.src = v.url;
      PMD.imgs[v.file] = im;
    }
  }
}

function pmdCur() {
  if (!PMD.meta) return null;
  const a = PMD.meta.anims[PMD.anim];
  if (!a) return null;
  const v = a[PMD.dir] || a.S;
  const img = v && PMD.imgs[v.file];
  return v && img && img.complete && img.naturalWidth ? { v, img } : null;
}

function pmdPlay(name, dir = 'S', once = false) {
  // 没有这个动作就退回待机。否则 PMD.anim 指到一个不存在/没加载完的动作，
  // pmdCur() 返回 null，画布直接空掉——拖拽时播 Hurt 就是这么把宠物弄没的。
  if (!pmdHas(name, dir)) {
    if (name !== 'Idle') return pmdPlay('Idle', 'S', once);
    if (!pmdHas('Idle', 'S')) return;
  }
  if (PMD.anim === name && PMD.dir === dir) return;
  PMD.anim = name;
  PMD.dir = dir;
  PMD.fi = 0;
  PMD.acc = 0;
  PMD.once = once;
}

/**
 * 这个动作+方向在素材里到底有没有。
 * 只查元数据，不查图片解码状态——刚 apply 时图片必然还没解码完，
 * 若把「没解码完」也当成「没有」，pmdPlay('Idle') 会被挡掉，PMD.anim 永远为空，
 * 结果就是宠物一直不画、状态机也永远卡在第一步。
 */
function pmdHas(name, dir) {
  if (!PMD.meta) return false;
  const a = PMD.meta.anims[name];
  if (!a) return false;
  return !!(a[dir] || a.S);
}

function pmdTouch() {
  PMD.lastTouch = performance.now();
  if (PMD.anim === 'Sleep') { pmdPlay('Wake', 'S', true); playCry(); }
  else if (PMD.anim !== 'Walk') pmdPlay('Idle', 'S');
}

/**
 * 只推进帧号，不画。省电的关键：空闲时帧号没变就不用重画。
 * 返回当前该画哪一帧（拿不到图返回 null）。
 */
function pmdAdvance(dtMs) {
  const c = pmdCur();
  if (!c) return null;
  PMD.acc += dtMs;
  let ms = c.v.frameMs[PMD.fi] || 100;
  let guard = 0;
  while (PMD.acc >= ms && guard++ < 8) {
    PMD.acc -= ms;
    PMD.fi += 1;
    if (PMD.fi >= c.v.frames) {
      if (PMD.once) {
        PMD.fi = c.v.frames - 1;
        PMD.once = false;
        pmdPlay('Idle', 'S');
        return pmdCur();
      }
      PMD.fi = 0;
    }
    ms = c.v.frameMs[PMD.fi] || 100;
  }
  return c;
}

/** 真正把当前帧画到画布上。 */
function pmdPaint(c) {
  const k = PMD.k;
  const fw = c.v.fw;
  const sh = c.v.h;                                  // 单方向条的高度
  const srcY = (c.v.row || 0) * (c.v.rowH || sh);    // 四方向打包图：按行取
  const w = fw * k;
  const h = sh * k;
  const x = Math.round(W / 2 - w / 2);
  const y = Math.round(BASELINE_Y - h);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(c.img, PMD.fi * fw, srcY, fw, sh, x, y, w, h);
  PMD.rect = { x, y, w, h };   // 喂食要用这个矩形算「嘴边」的位置
}


// ---------- 喂食：不依赖任何动作素材的通用反馈 ----------
// 果停在嘴边 0.6s → 缩小消失 → 头顶冒爱心 → 叫一声。
// 有 Eat 动作的宝可梦（全库约 23%）额外播一遍吃东西，算奖励；没有就纯靠这套反馈。
const FEED = { on: false, img: null, name: '', t0: 0, cried: false };
const FEED_HOLD = 600;
const FEED_SHRINK = 400;
const FEED_BUBBLE = 1100;
const FEED_TOTAL = FEED_HOLD + FEED_SHRINK + FEED_BUBBLE;

function startFeed({ name, url }) {
  if (!url) return;
  const im = new Image();
  im.onload = () => { if (FEED.on) FEED.img = im; };
  im.onerror = () => { FEED.on = false; };
  im.src = url;
  FEED.img = null;
  FEED.on = true;
  FEED.name = name || '';
  FEED.t0 = performance.now();
  FEED.cried = false;
  if (pmdMode) {
    PMD.forced = false;
    PMD.anim = '';
    pmdPlay('Eat', 'S', true);   // 没有 Eat 时会自己退回 Idle
  }
  window.bridge.log(`喂食开始 ${FEED.name}`);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawFeed(now) {
  if (!FEED.on) return;
  const el = now - FEED.t0;
  if (el > FEED_TOTAL) { FEED.on = false; return; }
  const r = PMD.rect || { x: Math.round(W / 2) - 60, y: BASELINE_Y - 120, w: 120, h: 120 };

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const elCss = el;

  // 1) 食物停在嘴边，然后缩小消失
  if (elCss < FEED_HOLD + FEED_SHRINK && FEED.img) {
    const tRaw = (elCss - FEED_HOLD) / FEED_SHRINK;
    const t = clamp01(tRaw);
    const scale = 1 - t * t;
    const base = Math.max(26, Math.round((r.h * 0.30) / 2) * 2);
    const size = Math.round(base * scale);
    if (size >= 4) {
      const bob = Math.sin(elCss / 90) * 2;      // 轻微上下晃，像被叼着
      // 嘴的位置固定：横向取脸的中间，纵向在眼睛下面一点。
      // 缩小时只缩尺寸、位置不动，所以消失点就是嘴心（以前按 0.76 宽 + 上飘 10px 会跑到耳朵上）。
      const cxp = r.x + r.w * 0.49;
      const cyp = r.y + r.h * 0.68 + bob * (1 - t);  // 越接近消失越不晃，收得干净
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = 1 - t * 0.4;
      ctx.drawImage(FEED.img, Math.round(cxp - size / 2), Math.round(cyp - size / 2), size, size);
      ctx.globalAlpha = 1;
    }
  }

  // 2) 食物消失那一刻：叫一声（只一次）
  if (!FEED.cried && elCss >= FEED_HOLD + FEED_SHRINK) {
    FEED.cried = true;
    playCry();
  }

  // 3) 头顶爱心气泡
  const bubT = (elCss - (FEED_HOLD + FEED_SHRINK)) / FEED_BUBBLE;
  if (bubT >= 0 && bubT <= 1) {
    const rise = Math.sin(Math.min(1, bubT / 0.35) * (Math.PI / 2)) * 10 - bubT * 6;
    const alpha = bubT > 0.75 ? 1 - (bubT - 0.75) / 0.25 : 1;
    const bx = Math.round(r.x + r.w * 0.52);
    const by = Math.round(r.y - 6 + rise);
    ctx.globalAlpha = clamp01(alpha);
    // 白气泡
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    roundRect(bx - 17, by - 26, 34, 30, 9);
    ctx.fill();
    ctx.strokeStyle = 'rgba(60,60,70,0.18)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // 小尾巴
    ctx.beginPath();
    ctx.moveTo(bx - 5, by + 3);
    ctx.lineTo(bx + 1, by + 10);
    ctx.lineTo(bx + 6, by + 3);
    ctx.closePath();
    ctx.fill();
    // 爱心
    ctx.fillStyle = '#ff4d7d';
    ctx.font = 'bold 19px "Segoe UI Symbol","Apple Color Emoji",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('\u2665', bx, by - 10);
    ctx.globalAlpha = 1;
  }
}

// ---------- 行为状态机：闲着 -> 抽签 -> 溜达 / 睡觉 ----------
// 「睡」和「溜达」是平级的：同一张签的两个结果，不是先后关系。
const BEH = {
  idleBefore: 50,      // 闲多少秒开始抽签
  sleepPct: 45,        // 抽到睡觉的概率（%）
  sleepMin: 90,        // 睡多久自己醒（秒）
  sleepMax: 200,
  wanderTimes: 2,      // 一次溜达走几段
  wanderEnabled: true,
  sleepAfter: 180,     // 用户多久没碰键鼠才可能打瞌睡（秒）
};

let behState = 'awake';      // awake | wander | sleep
let cooldownUntil = 0;       // 冷却到期时间（防止连续抽签/连续趴下）
let sleepUntil = 0;
let sysIdle = 999;           // 用户多久没碰键鼠（秒），主进程每 2 秒更新一次

const randBetween = (a, b) => a + Math.random() * (b - a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function applyBehavior(b) {
  if (!b) return;
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  BEH.idleBefore = n(b.idleBefore, BEH.idleBefore);
  BEH.sleepPct = n(b.sleepPct, BEH.sleepPct);
  BEH.sleepMin = n(b.sleepMin, BEH.sleepMin);
  BEH.sleepMax = n(b.sleepMax, BEH.sleepMax);
  BEH.wanderTimes = n(b.wanderTimes, BEH.wanderTimes);
  BEH.wanderEnabled = b.wanderEnabled !== false;
  BEH.sleepAfter = n(b.sleepAfter, BEH.sleepAfter);
  // 改了参数就重新计时，别让改之前攒下的「已经闲了很久」立刻触发一次抽签
  PMD.lastTouch = performance.now();
}

async function refreshIdle() {
  try { sysIdle = await window.bridge.idleSeconds(); } catch { sysIdle = 999; }
}

function startSleep(now) {
  behState = 'sleep';
  sleepUntil = now + randBetween(BEH.sleepMin, BEH.sleepMax) * 1000;
  pmdPlay('Sleep', 'S');
}

function wakeUp(now) {
  behState = 'awake';
  cooldownUntil = now + 30000;   // 刚醒别马上又睡
  PMD.lastTouch = now;
  pmdTouch();                    // 播一遍 Wake 再回 Idle
}

async function startWander(now) {
  behState = 'wander';
  const times = Math.max(1, Math.min(6, Math.round(BEH.wanderTimes) || 1));
  for (let i = 0; i < times; i++) {
    let ok = false;
    try { ok = await window.bridge.wander(); } catch { ok = false; }
    if (!ok) break;              // 被用户打断（拖动 / 跟随）就收工
    PMD.lastTouch = performance.now();
    if (i < times - 1) await wait(randBetween(2000, 6000));
  }
  behState = 'awake';
  cooldownUntil = performance.now() + 15000;
  pmdPlay('Idle', 'S');
}

function tickBehavior(now) {
  // 每 3 秒往日志里写一行状态（仅调试时）——常驻写会把 boot.log 撑大
  if (debugLog && now - (tickBehavior.lastLog || 0) > 3000) {
    tickBehavior.lastLog = now;
    const msg = `state=${behState} anim=${PMD.anim} sysIdle=${sysIdle} idleMs=${Math.round(now - PMD.lastTouch)} need=${BEH.idleBefore * 1000} meta=${PMD.meta ? Object.keys(PMD.meta.anims || {}).join(',') : 'none'} forced=${PMD.forced}`;
    if (window.bridge.log) window.bridge.log(msg);
  }
  // 它睡着了：只有「同一个人回来了」或睡够了才醒
  if (behState === 'sleep') {
    if (now > sleepUntil) { wakeUp(now); return; }
    if (sysIdle < 5) { wakeUp(now); return; }   // 你一动，它就知道你回来了
    return;
  }
  if (behState === 'wander') return;
  if (now < cooldownUntil) return;

  // 你正在用电脑：它不睡也不乱跑，就站那儿。顺手把计时器往后推，免得你一停下就立刻抽签
  if (sysIdle < 5) { PMD.lastTouch = now; return; }

  if (PMD.anim !== 'Idle') return;
  if (now - PMD.lastTouch < BEH.idleBefore * 1000) return;

  // 抽签：短空闲时只会去溜达；「很久没理它」（sysIdle ≥ sleepAfter）才有资格抽到睡觉。
  // 关掉溜达就只剩睡觉（且仍要等 sleepAfter），关掉睡觉就只溜达。
  const canDoze = sysIdle >= BEH.sleepAfter;
  const wanderOn = BEH.wanderEnabled !== false;
  const wantSleep = canDoze && (!wanderOn || Math.random() * 100 < BEH.sleepPct);
  if (wantSleep) { startSleep(now); return; }
  if (wanderOn) { startWander(now); return; }
  // 两个都关了：这次就什么都不做，隔一会儿再抽
  PMD.lastTouch = now;
  cooldownUntil = now + 15000;
}

// ---------- 插播的小动作：偶尔放电 ----------
// 不进状态机，只在「站着没事干」时插一遍就回 Idle，所以不会和溜达/睡觉打架。
let nextShockAt = 0;

function tickMicro(now) {
  if (!pmdMode || PMD.forced || behState !== 'awake' || PMD.anim !== 'Idle') return;

  // 放电：很久没人理的时候低概率来一下（200~480 秒一次）
  if (!nextShockAt) nextShockAt = now + randBetween(200, 480) * 1000;
  if (now > nextShockAt) {
    nextShockAt = now + randBetween(200, 480) * 1000;
    if (pmdHas('Shock', 'S')) {
      PMD.anim = '';
      pmdPlay('Shock', 'S', true);
    }
  }
}

// 空闲省电：实测待机时 GPU 进程约占 32% 单核、渲染进程 16%——
// 全是「每帧把同一张图重画一遍」和「每帧改一次影子样式」造成的。
// 帧号没变、弹簧也静止时，直接跳过清屏+重绘；影子样式的更新降到 10fps。
let lastPaintKey = '';
let lastShadowAt = 0;

function draw(now) {
  rafId = requestAnimationFrame(draw);
  const t = (now - st.t0) / 1000;

  // 压扁弹簧：k=0.55, 阻尼 0.86 —— 单调衰减，不会自激
  st.squashV += -st.squash * 0.55;
  st.squashV *= 0.86;
  st.squash = clamp(st.squash + st.squashV, -0.5, 1);

  // 弹跳弹簧
  st.hopV += -st.hop * 0.30;
  st.hopV *= 0.90;
  st.hop = clamp(st.hop + st.hopV, -20, 20);

  // 弹簧还在明显动的时候必须逐帧画，否则弹跳会一顿一顿
  const springLive = Math.abs(st.hop) > 0.05 || Math.abs(st.hopV) > 0.05
    || Math.abs(st.squash) > 0.004 || Math.abs(st.squashV) > 0.004;

  if (pmdMode) {
    tickMicro(now);
    // 录演示时由主进程强制指定动作，状态机让位
    if (!PMD.forced) {
      if (PMD.anim === 'Sit' && now > PMD.sitUntil) pmdPlay('Idle', 'S');
      else if (!FEED.on) tickBehavior(now);   // 吃东西的时候不抽签、不溜达
    }
    const c = pmdAdvance(now - (draw.prev || now));
    draw.prev = now;

    // 偶尔自言自语叫一声（90~240 秒一次），只有待机时才叫
    if (now > nextChatter) {
      nextChatter = now + 90000 + Math.random() * 150000;
      if (PMD.anim === 'Idle') playCry();
    }

    if (c) {
      const key = `${PMD.anim}|${PMD.dir}|${c.v.file}|${PMD.fi}|${FEED.on ? 1 : 0}`;
      if (FEED.on || springLive || key !== lastPaintKey) {
        lastPaintKey = key;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W * dpr, H * dpr);
        pmdPaint(c);
        drawFeed(now);
      }
    }
    // 图还没解码完时不要擦画布，保持上一帧
    if (now - lastShadowAt > 100) { lastShadowAt = now; updateShadow(t); }
    return;
  }

  // 兜底：没有 PMD 动作集的宝可梦，只画一张静态立绘（不再做网格变形）。
  // 素材是 640x360 整幅 PNG（构建期已按 BASELINE=330 摆好），直接原样贴回即可。
  if (!imgReady) {
    if (now - lastShadowAt > 100) { lastShadowAt = now; updateShadow(t); }
    return;
  }
  if (lastPaintKey !== 'static') {
    lastPaintKey = 'static';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W * dpr, H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, W, H);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  if (now - lastShadowAt > 100) { lastShadowAt = now; updateShadow(t); }
}

function updateShadow(t) {
  const br = Math.sin(t * 1.85);
  els.shadow.style.opacity = (0.9 - br * 0.08).toFixed(3);
  els.shadow.style.transform = `translateY(${st.hop * 0.2}px) scaleX(${(1 + br * 0.02).toFixed(3)})`;
}

// ---------- 数据应用 ----------

// ---------- 叫声 ----------
// 一只宝可梦一个音频文件（0.6~1 秒、6~7KB），切换时只换 src，不重建元素。
let cryEl = null;
let crySrc = '';
let muted = false;
let lastCry = 0;
let nextChatter = 0;

function setCry(data) {
  muted = data.sound === false;
  if (!data.cry) { crySrc = ''; return; }
  if (data.cry === crySrc) return;
  crySrc = data.cry;
  if (!cryEl) {
    cryEl = new Audio();
    cryEl.preload = 'auto';
    cryEl.volume = 0.55;
  }
  cryEl.src = data.cry;
  try { cryEl.load(); } catch {}
  nextChatter = performance.now() + 60000 + Math.random() * 90000;
}

/** 叫一声。连点时不叠音，700ms 内只放一次。 */
function playCry() {
  if (muted || !cryEl || !crySrc) return;
  const now = performance.now();
  if (now - lastCry < 700) return;
  lastCry = now;
  try { cryEl.currentTime = 0; } catch {}
  // 被打断、还没解码完、或者被静音策略拦，都会 reject；叫声丢了不致命，直接吞掉
  const p = cryEl.play();
  if (p && p.catch) p.catch(() => {});
}

function apply(data) {
  debugLog = !!data.debug;
  box = data.box || [226, 154, 414, 330];
  setCry(data);
  if (data.behavior) applyBehavior(data.behavior);

  // PMD 动作集：唯一的主渲染路径（走路 / 睡觉 / 坐下 / 被打醒，全是真帧）
  if (data.pmd && data.preferPmd) {
    pmdMode = true;
    els.canvas.style.display = 'block';
    els.card.hidden = true;
    imgReady = false;
    img = null;
    PMD.k = data.pixelScale || 5;
    pmdLoad(data.pmd);
    lastPaintKey = '';
    PMD.anim = '';
    PMD.lastTouch = performance.now();
    pmdPlay('Idle', 'S');
    layShadow();
    return;
  }
  pmdMode = false;

  // 没有 PMD 素材的宝可梦：退回一张静态立绘（原网格变形已删除）
  els.canvas.style.display = 'block';
  if (data.url) {
    els.card.hidden = true;
    const im = new Image();
    im.onload = () => { img = im; imgReady = true; };
    im.onerror = () => { imgReady = false; };
    im.src = data.url;
    lastPaintKey = '';
    box = data.box || [226, 154, 414, 330];
  } else {
    imgReady = false;
    img = null;
    els.card.hidden = false;
    lastPaintKey = '';
    const it = data.item || { no: '???', zh: '未知', heightM: 0, types: [] };
    els.cardNo.textContent = '#' + (it.no || '???');
    els.cardName.textContent = it.zh || it.en || '';
    els.cardSub.textContent = it.heightM ? it.heightM + ' m · ' + (it.types || []).join(' / ') : '';
    els.card.style.background = gradientFor(it.types);
    box = [220, 116, 420, 330];
  }

  layShadow();
}

/** 影子宽度：PMD 按当前帧实际宽度，兜底立绘按包围盒宽度。 */
function layShadow() {
  let w;
  let cx;
  if (pmdMode && PMD.rect) {
    w = Math.max(40, PMD.rect.w * 0.62);
    cx = PMD.rect.x + PMD.rect.w / 2;
  } else {
    const [x0, , x1] = box;
    w = Math.max(46, (x1 - x0) * 0.55);
    cx = (x0 + x1) / 2;
  }
  els.shadow.style.width = Math.round(w) + 'px';
  els.shadow.style.left = Math.round(cx - w / 2) + 'px';
}

// ---------- 交互 ----------

function onCursor(p) {
  st.hasCursor = true;
  st.curX = p.x;
  st.curY = p.y;
}

function poke() {
  // 摸头：压扁 + 弹一下。两个都是弹簧量，重复触发只会叠加到上限，不会持续变大。
  st.squash = clamp(st.squash + 0.55, -0.5, 1);
  st.squashV += 0.16;
  st.hop = clamp(st.hop + 5, -20, 12);
  st.hopV += 1.2;

  playCry();

  if (!pmdMode) return;
  // 被摸一下就算「刚刚互动过」，把状态机拉回清醒并进入冷却
  behState = 'awake';
  cooldownUntil = performance.now() + 15000;
  sleepUntil = 0;
  if (PMD.anim === 'Sleep') {
    pmdTouch();                       // 睡着被摸 → 播一遍 Wake 再回 Idle
  } else if (PMD.anim === 'Sit') {
    pmdPlay('Idle', 'S');             // 再点一下站起来
  } else {
    PMD.lastTouch = performance.now();
    // 点一下 → 点头（像应你一声）。坐下、蹦一下都不再占左键，只能从右键「动作」里试播。
    if (pmdHas('Nod', 'S')) {
      PMD.anim = '';
      pmdPlay('Nod', 'S', true);
    } else {
      pmdPlay('Sit', 'S');            // 没有点头的宝可梦退回老行为
      PMD.sitUntil = performance.now() + 2500;
    }
  }
}

function wireInput() {
  // 按下先不算拖拽：手指在鼠标上抖 1px 就把窗口拽走、还会触发尺寸取整漂移。
  // 超过 4px 才当成拖拽，否则就只是「摸头」。
  let pressed = false;
  let dragging = false;
  let start = null;

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    pressed = true;
    dragging = false;
    start = { x: e.screenX, y: e.screenY };
    poke();
  });

  window.addEventListener('mousemove', (e) => {
    if (!pressed || dragging || !start) return;
    if (Math.hypot(e.screenX - start.x, e.screenY - start.y) < 4) return;
    dragging = true;
    document.body.classList.add('grabbing');
    if (pmdMode) pmdPlay('Hurt', 'S');
    window.bridge.dragStart();
  });

  window.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    pressed = false;
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('grabbing');
    if (pmdMode) pmdPlay('Idle', 'S');
    window.bridge.dragEnd();
  });

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.bridge.menu();
  });

  // 双击不再开选宠器：连点两下就弹窗太容易误触。
  // 换宝可梦只从右键菜单走，点多少下都只当摸头。

  // 万一 mouseup 丢在别的进程上，别让拖拽状态卡死
  window.addEventListener('blur', () => {
    pressed = false;
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('grabbing');
    window.bridge.dragEnd();
  });
}

async function boot() {
  els.canvas = $('pet');
  els.card = $('card');
  els.cardNo = $('cardNo');
  els.cardName = $('cardName');
  els.cardSub = $('cardSub');
  els.shadow = $('shadow');

  els.canvas.width = Math.round(W * dpr);
  els.canvas.height = Math.round(H * dpr);
  els.canvas.style.width = W + 'px';
  els.canvas.style.height = H + 'px';
  ctx = els.canvas.getContext('2d', { alpha: true });

  wireInput();
  if (window.bridge.onCursor) window.bridge.onCursor(onCursor);
  if (window.bridge.onWalk) {
    window.bridge.onWalk((p) => {
      if (!pmdMode) return;
      PMD.lastTouch = performance.now();
      if (p && p.stop) {
        // 跟随停下时转个身看你（Rotate 只有 9 帧，播完自己回 Idle）
        if (p.turn && pmdHas('Rotate', 'S')) {
          PMD.anim = '';
          pmdPlay('Rotate', 'S', true);
        } else {
          pmdPlay('Idle', 'S');
        }
      } else {
        pmdPlay('Walk', (p && p.dir) || 'S');
      }
    });
  }
  if (window.bridge.onForce) {
    window.bridge.onForce((p) => {
      if (!pmdMode) return;
      if (p && p.stop) {
        // 退出「试动作」：交还给状态机
        PMD.forced = false;
        PMD.anim = '';
        PMD.sitUntil = 0;
        PMD.lastTouch = performance.now();
        pmdPlay('Idle', 'S');
        return;
      }
      PMD.forced = true;
      PMD.anim = '';                 // 清掉名字，换同一个动作也能从头播
      pmdPlay(p.name, p.dir || 'S');
      PMD.sitUntil = Infinity;
    });
  }
  window.bridge.onSet(apply);
  if (window.bridge.onFeed) {
    window.bridge.onFeed((p) => startFeed(p || {}));
  }
  if (window.bridge.onConfig) {
    window.bridge.onConfig((b) => {
      applyBehavior(b);
      if (b && b.sound !== undefined) muted = b.sound === false;
    });
  }
  // 主进程那边才是「用户多久没碰键鼠」的唯一来源，2 秒刷新一次就够
  refreshIdle();
  setInterval(refreshIdle, 2000);

  const data = await window.bridge.init();
  try {
    apply(data);
    if (window.bridge.log) window.bridge.log(`apply 完成 anim=${PMD.anim} pmd=${pmdMode} meta=${!!PMD.meta}`);
  } catch (e) {
    if (window.bridge.log) window.bridge.log('apply 失败: ' + ((e && e.stack) || String(e)));
  }
  rafId = requestAnimationFrame(draw);
}

boot();