'use strict';
// 桌面宠物主进程：一个透明置顶窗 + 一个选宠窗。
// 关键点全在“窗口怎么摆、什么时候该接鼠标”上，渲染逻辑尽量留给前端。

const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, powerMonitor, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
// 选宠器卡片图：构建期生成，PMD 像素优先、没有才退回水彩缩略图
const CARD = path.join(ASSETS, 'card');
const DATA = path.join(ROOT, 'data');
const CONFIG = path.join(DATA, 'config.json');

const W = 640;          // 舞台画布尺寸，和归一化脚本保持一致
const H = 360;
const BASELINE_Y = 330; // 脚底线，和 pet.js 的 BASELINE_Y 必须一致
const POLL_MS = 60;     // 鼠标位置轮询间隔（Electron 的 forward 钩子在 Windows 上会静默失效）
const SNAP = 6;         // 命中区外扩，手抖也能抓住

// 当前宝可梦的实际命中盒（窗口内 CSS px）。有 PMD 素材时按 Idle 帧的 alpha 包围盒算，
// 没有才退回水彩立绘那套预计算盒子。
let hitRect = null;

/** 把 PMD 的源像素包围盒换算成窗口坐标。画法和 pet.js 的 drawPmd 必须完全一致。 */
function computeHitRect(pmd) {
  const h = pmd && pmd.hit;
  if (!h) return null;
  const k = Number(process.env.POKEPET_PIXEL_SCALE || 0) || 5;
  const ow = h.fw * k;
  const oh = h.stripH * k;
  const ox = Math.round(W / 2 - ow / 2);
  const oy = Math.round(BASELINE_Y - oh);
  return [
    ox + h.x0 * k,
    oy + h.y0 * k,
    ox + h.x1 * k,
    oy + h.y1 * k,
  ];
}

// Electron 是 GUI 子系统程序，控制台里看不到任何输出，所以自己写日志文件
const LOG = path.join(DATA, 'boot.log');
function log(...args) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${args.join(' ')}\n`, 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}
log('--- 启动 ---', `electron ${process.versions.electron}`, process.argv.slice(1).join(' '));
process.on('uncaughtException', (e) => log('未捕获异常', (e && e.stack) || String(e)));

// 它自己怎么安排时间。这些数字不让人填 —— 每次启动在合理区间里随机（见 rollParams），
// 抽到就落盘到 data/config.json，本次运行期间不再变。
const BEHAVIOR_DEFAULT = {
  idleBefore: 50,        // 闲着多久（秒）开始抽签，决定「睡」还是「溜达」
  sleepPct: 45,          // 抽到睡觉的概率（%），剩下的是溜达
  sleepMin: 90,          // 睡多久自己醒（秒，最短）
  sleepMax: 200,         // 睡多久自己醒（秒，最长）
  wanderTimes: 2,        // 一次溜达走几段
  wanderEnabled: true,   // 允许溜达（右键菜单可勾）
  sleepAfter: 180,       // 用户多久没碰键鼠才可能打瞌睡（秒），由性格决定
};

let petWin = null;
let pickerWin = null;
let cfg = { id: 25, x: null, y: null, sound: true, fav: [], ...BEHAVIOR_DEFAULT };
if (!Array.isArray(cfg.fav)) cfg.fav = [];   // 老配置没有这个字段
let boxes = {};         // id -> [x0,y0,x1,y1] 精灵在画布内的包围盒
let dex = [];           // 图鉴条目
let cardIds = new Set(); // 有卡片图的 id
let pinyin = {};         // id -> [全拼, 首字母]，给选宠器做拼音搜索

let ignoring = null;    // 当前穿透状态（Electron 没有读取接口，只能自己记）
let dragging = false;
let dragOffset = { x: 0, y: 0 };
let dragTimer = null;
let walkTimer = null;
let following = false;    // 是否正在跟着鼠标走
let previewing = null;    // 正在试播的动作名（右键「动作」菜单）
let menuOpen = false;     // 右键菜单是否弹着（弹着时不动穿透、临时允许聚焦）
let walkNow = () => {};   // 调试用：把 wireIpc 里的 startFollow 暴露出来
let debugReset = () => {};   // 调试用：把 wireIpc 里的 resetPosition 暴露出来
let followStop = () => {};   // 托盘菜单用：把 wireIpc 里的 stopFollow 暴露出来
let pollTimer = null;
let demoMode = false;   // 录制演示动画时接管光标，避免真实鼠标把视线拽走

// 「用户多久没动」只能靠光标自己数：这台机器上 powerMonitor.getSystemIdleTime()
// 一直返回 0（有虚拟设备在不停注入输入），用它当闸门会导致宠物永远不动。
let cursorMovedAt = Date.now();
let lastCursorPt = null;
let moveAccum = 0;         // 1 秒窗口内光标累计移动了多少像素
let moveWindowAt = Date.now();

// ---------- 数据 ----------

function readJson(p, fallback) {
  try {
    // 记事本 / PowerShell 的 Set-Content 会写入 BOM，JSON.parse 遇到 \uFEFF 直接抛错，
    // 结果就是「配置文件明明有内容，程序却当成空的」——先剥掉。
    return JSON.parse(String(fs.readFileSync(p, 'utf8')).replace(/^\uFEFF/, ''));
  } catch { return fallback; }
}

function loadAssets() {
  dex = readJson(path.join(ASSETS, 'pokedex.json'), { items: [] }).items || [];
  boxes = readJson(path.join(ASSETS, 'sizes.json'), {});
  // 哪些宝可梦有卡片图（卡片图里已经包含了「像素优先、水彩兜底」的取舍）
  try {
    cardIds = new Set(fs.readdirSync(CARD)
      .filter((f) => f.endsWith('.png'))
      // 不能写 f.slice(0,3)：四位数 id（1000~1025）会被截成 100~125 全撞车
      .map((f) => parseInt(f, 10))
      .filter((n) => Number.isFinite(n)));
  } catch { cardIds = new Set(); }
  log(`卡片图 ${cardIds.size} 张 / 图鉴 ${dex.length} 条`);
  pinyin = readJson(path.join(ASSETS, 'pinyin.json'), {});
  log(`拼音索引 ${Object.keys(pinyin).length} 条`);
  const saved = readJson(CONFIG, null);
  if (saved && typeof saved.id === 'number') cfg = { ...cfg, ...saved };
  // 调试用：POKEPET_ID=25 强制指定宝可梦，POKEPET_RESET=1 忽略存档位置
  if (process.env.POKEPET_ID) cfg.id = Number(process.env.POKEPET_ID) || cfg.id;
  if (process.env.POKEPET_RESET === '1') { cfg.x = null; cfg.y = null; }
}

function saveConfig() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 1), 'utf8');
  } catch (e) { console.error('保存配置失败', e); }
}

function pmdData(id) {
  const base = path.join(__dirname, 'pmd', String(id).padStart(3, '0'));
  const meta = `${base}.json`;
  if (!fs.existsSync(meta)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    const anims = {};
    for (const [name, dirs] of Object.entries(m.anims || {})) {
      anims[name] = {};
      for (const [dir, v] of Object.entries(dirs)) {
        anims[name][dir] = { ...v, url: pathToFileURL(path.join(__dirname, 'pmd', v.file)).href };
      }
    }
    return { anims, idleH: m.idleH || 30, hit: m.hit || null };
  } catch {
    return null;
  }
}

/** 叫声：app/cries/NNN.mp3 或 .ogg（仓库里 latest 那批后缀写 .ogg 其实是 mp3，两种都认）。 */
function cryUrl(id) {
  const no = String(id).padStart(3, '0');
  for (const ext of ['mp3', 'ogg']) {
    const f = path.join(__dirname, 'cries', `${no}.${ext}`);
    if (fs.existsSync(f)) return pathToFileURL(f).href;
  }
  return null;
}

// ---------- 随机参数 ----------
// 不让用户填数字，也不给性格分类：每次启动在「合理区间」里各抽一个值，
// 抽到了就写进 config.json，本次运行期间不再变（否则你一摸它就换脾气）。
const RANGE = {
  idleBefore: [20, 110],   // 闲着多久开始抽签（秒）
  sleepPct: [20, 80],      // 抽到睡觉的概率（%）
  sleepAfter: [60, 360],   // 你离开多久之后它才可能睡（秒）
  sleepMin: [45, 300],     // 一觉最短（秒）
  wanderTimes: [1, 3],     // 一次溜达走几段
};

/** 在 [a,b] 区间里随机一个整数。 */
function randInt(a, b) {
  return Math.round(a + Math.random() * (b - a));
}

/** 重抽一组参数，写进 cfg 并落盘。启动时调用一次。 */
function rollParams() {
  cfg.idleBefore = randInt(...RANGE.idleBefore);
  cfg.sleepPct = randInt(...RANGE.sleepPct);
  cfg.sleepAfter = randInt(...RANGE.sleepAfter);
  cfg.sleepMin = randInt(...RANGE.sleepMin);
  // 一觉最长在「最短的 1.4~2.6 倍」之间，但不超过 6 分钟，也不会比最短还短
  cfg.sleepMax = Math.max(cfg.sleepMin, Math.min(360, Math.round(cfg.sleepMin * (1.4 + Math.random() * 1.2))));
  cfg.wanderTimes = randInt(...RANGE.wanderTimes);
  delete cfg.personality;   // 旧版本留下的字段，一并清掉
  delete cfg.sleepEnabled;  // 同上（睡觉已经改成「你离开多久」触发）
  saveConfig();
  log(`随机参数：闲 ${cfg.idleBefore}s 抽签 / 睡 ${cfg.sleepPct}% / 一觉 ${cfg.sleepMin}~${cfg.sleepMax}s / 一次 ${cfg.wanderTimes} 段 / 你离开 ${cfg.sleepAfter}s 后才睡`);
}

function behaviorOf() {
  const n = (v, d, lo, hi) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d;
  };
  const b = {
    idleBefore: n(cfg.idleBefore, 20, 3, 600),
    sleepPct: n(cfg.sleepPct, 50, 0, 100),
    sleepMin: n(cfg.sleepMin, 60, 10, 900),
    sleepMax: n(cfg.sleepMax, 180, 10, 900),
    wanderTimes: n(cfg.wanderTimes, 2, 1, 6),
    wanderEnabled: cfg.wanderEnabled !== false,
    sleepAfter: n(cfg.sleepAfter, 180, 60, 900),
  };
  if (b.sleepMax < b.sleepMin) b.sleepMax = b.sleepMin;
  return b;
}

/** 「皮卡丘 #025」——菜单里用来显示当前是谁，比只给编号好读。 */
function petName(id) {
  const item = dex.find((d) => d.id === id);
  const no = `#${String(id).padStart(3, '0')}`;
  return item && item.zh ? `${item.zh} ${no}` : no;
}

/** 菜单里「动作」子菜单的分组与中文名。顺序就是显示顺序。 */
const ANIM_GROUPS = [
  ['平时', ['Idle', 'Nod', 'Hop', 'Pose', 'DeepBreath', 'LookUp', 'Rotate']],
  ['走路', ['Walk', 'LeapForth', 'Float', 'Sink']],
  ['坐躺睡', ['Sit', 'Sleep', 'EventSleep', 'Laying', 'Wake']],
  ['吃东西', ['Eat']],
  ['打架', ['Attack', 'QuickStrike', 'Shoot', 'Shock', 'Swing', 'Double', 'Charge', 'Pull', 'Head']],
  ['挨打摔跤', ['Hurt', 'Pain', 'Cringe', 'LostBalance', 'Trip', 'Tumble', 'TumbleBack', 'HitGround', 'Faint']],
];

const ANIM_ZH = {
  Idle: '待机', Nod: '点头', Hop: '蹦一下', Pose: '摆姿势', DeepBreath: '深呼吸',
  LookUp: '抬头', Rotate: '转一圈',
  Walk: '走路', LeapForth: '往前扑', Float: '漂浮', Sink: '下沉',
  Sit: '坐下', Sleep: '睡觉', EventSleep: '昏睡', Laying: '躺平', Wake: '醒来',
  Eat: '吃东西',
  Attack: '冲撞', QuickStrike: '突进', Shoot: '远程放电', Shock: '全身放电',
  Swing: '尾巴横扫', Double: '二连击', Charge: '蓄力', Pull: '往后拉', Head: '头槌',
  Hurt: '被碰到', Pain: '剧痛', Cringe: '畏缩', LostBalance: '站不稳', Trip: '绊倒',
  Tumble: '前滚翻', TumbleBack: '后滚翻', HitGround: '砸地', Faint: '晕倒',
};

/** 让宠物播一个指定动作（试动作菜单用）；name 为空表示退出试动作。 */
function forceAnim(name) {
  if (!petWin || petWin.isDestroyed()) return;
  if (name) {
    petWin.webContents.send('pet:force', { name, dir: name === 'Walk' ? 'S' : 'S' });
    previewing = name;
    log(`试动作 ${name}`);
  } else {
    petWin.webContents.send('pet:force', { stop: true });
    previewing = null;
  }
}

/** 六种「降努力值 + 加亲密度」的树果（第 3 世代引入，官方设定里同时具备这两个效果）。 */
const FOODS = [
  { id: 146, name: '榴石果', ev: 'HP' },
  { id: 147, name: '藻根果', ev: '攻击' },
  { id: 148, name: '比巴果', ev: '防御' },
  { id: 149, name: '哈密果', ev: '特攻' },
  { id: 150, name: '萄葡果', ev: '特防' },
  { id: 151, name: '茄番果', ev: '速度' },
];

function foodUrl(id) {
  const p = path.join(ASSETS, 'food', `${id}.png`);
  return fs.existsSync(p) ? pathToFileURL(p).href : null;
}

/** 「吃东西 ▸」子菜单：六种树果，带 16px 图标。 */
function foodSubmenu() {
  const out = [];
  for (const f of FOODS) {
    const iconPath = path.join(ASSETS, 'food', `${f.id}.png`);
    const icon = nativeImage.createFromPath(iconPath);
    const item = { label: f.name, click: () => feedFood(f) };
    if (!icon.isEmpty()) item.icon = icon.resize({ width: 16, height: 16 });
    out.push(item);
  }
  return out;
}

/** 喂一颗果：素材交给渲染层，动作/反馈全部在那边播。 */
function feedFood(food) {
  if (!petWin || petWin.isDestroyed()) return;
  const url = foodUrl(food.id);
  if (!url) {
    log(`喂食失败：缺素材 ${food.id}`);
    return;
  }
  forceAnim(null);   // 先退出「动作」试播，免得卡在别的动作上
  petWin.webContents.send('pet:feed', { id: food.id, name: food.name, url });
  log(`喂食 ${food.name}`);
}

/** 「动作 ▸」子菜单：按分组列出这只宝可梦身上实际有的动作。 */
function animSubmenu() {
  const data = pmdData(cfg.id);
  const have = data ? Object.keys(data.anims || {}) : [];
  if (!have.length) return [{ label: '这只没有动作素材', enabled: false }];

  const items = [];
  for (const [title, names] of ANIM_GROUPS) {
    const avail = names.filter((n) => have.includes(n));
    if (!avail.length) continue;
    if (items.length) items.push({ type: 'separator' });
    for (const n of avail) {
      items.push({
        // 用普通项 + 文字勾标，不用 type:'radio'——radio 在同一个分组里
        // 没有显式勾选时会默认把第一项画成「已选」，看起来像好几个动作都被勾上了。
        label: (previewing === n ? '✓ ' : '　') + (ANIM_ZH[n] || n),
        click: () => forceAnim(n),
      });
    }
  }
  // 万一有分组表里没列到的动作，别漏
  const rest = have.filter((n) => !ANIM_GROUPS.some(([, arr]) => arr.includes(n)));
  if (rest.length) {
    items.push({ type: 'separator' });
    for (const n of rest) {
      items.push({ label: (previewing === n ? '✓ ' : '　') + (ANIM_ZH[n] || n), click: () => forceAnim(n) });
    }
  }
  if (previewing) {
    items.push({ type: 'separator' }, { label: '停止试动作', click: () => forceAnim(null) });
  }
  return items;
}

// ---------- 托盘图标 + 开机自启 ----------
// 托盘的价值：宠物被别的东西挡住、或者你忘了它在哪时，还有个固定的入口能找到它。

let tray = null;

function autostartOn() {
  try {
    // 开发态下必须带上 path/args 一起比对，否则注册表里明明写了、这里却读成 false。
    const opts = app.isPackaged ? undefined : { path: process.execPath, args: [app.getAppPath()] };
    return !!app.getLoginItemSettings(opts).openAtLogin;
  } catch { return false; }
}

function setAutostart(on) {
  // 开发态下 execPath 是 electron.exe，必须把 app 目录当参数带上，
  // 否则开机只会启动一个空的 Electron。打包后 execPath 就是自己的 exe，不需要参数。
  const opts = { openAtLogin: !!on };
  if (!app.isPackaged) {
    opts.path = process.execPath;
    opts.args = [app.getAppPath()];
  }
  try {
    app.setLoginItemSettings(opts);
    log(`开机自启 ${on ? '已开启' : '已关闭'}`);
  } catch (e) {
    log('设置开机自启失败', String(e));
  }
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  // 托盘：自启 / 支持 / 关于 / 退出。其余操作都在宠物身上的右键菜单里，不必摆两份。
  tray.setToolTip(`宝可梦桌宠 · ${petName(cfg.id)}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '开机自启', type: 'checkbox', checked: autostartOn(), click: (item) => setAutostart(item.checked) },
    { type: 'separator' },
    { label: '支持一下 ♥', click: () => openInfo('support') },
    { label: '关于', click: () => openInfo('about') },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

// ---- 关于 / 支持 ----
// 这两个窗口只读：读配置与素材，不做任何写操作，也不联网。
const infoWins = { about: null, support: null };
let infoStats = null;

function infoStatsCalc() {
  if (infoStats) return infoStats;
  let pmd = 0;
  let anims = 0;
  try {
    for (const f of fs.readdirSync(path.join(__dirname, 'pmd'))) {
      if (!f.endsWith('.json')) continue;
      pmd += 1;
      const m = readJson(path.join(__dirname, 'pmd', f), null);
      if (m && m.anims) {
        for (const dirs of Object.values(m.anims)) {
          anims += 1;              // 动作名数（同一个动作的多个朝向算一个）
          if (!dirs) continue;
        }
      }
    }
  } catch { /* 没素材就是 0 */ }
  let cries = 0;
  try { cries = fs.readdirSync(path.join(__dirname, 'cries')).length; } catch { /* 同上 */ }
  infoStats = { pmd, anims, cries };
  return infoStats;
}

/** 素材/support 下的可选配置：两张二维码 + 一个赞助页链接（url.txt）。 */
function supportAssets() {
  const dir = path.join(ASSETS, 'support');
  const pick = (name) => {
    const p = path.join(dir, name);
    return fs.existsSync(p) ? pathToFileURL(p).href : null;
  };
  let url = null;
  try { url = fs.readFileSync(path.join(dir, 'url.txt'), 'utf8').trim() || null; } catch { /* 没配 */ }
  return { qrWechat: pick('wechat.png'), qrAlipay: pick('alipay.png'), supportUrl: url };
}

function infoPayload() {
  const s = infoStatsCalc();
  return {
    ...supportAssets(),
    version: app.getVersion(),
    dex: dex.length,
    pmd: s.pmd,
    actions: s.anims,
    cries: s.cries,
    author: '阳阳好梦',
    year: new Date().getFullYear(),
    urlPmd: 'https://github.com/PMDCollab/SpriteCollab',
    urlPokeAPI: 'https://pokeapi.co',
  };
}

// 宠物窗口是 screen-saver 级置顶，会盖住「关于/支持」的正文。
// 处理方式：信息窗口也用同一级置顶并 moveTop 到最前；关掉时把宠物重新顶回来。
function raisePet() {
  if (petWin && !petWin.isDestroyed()) petWin.setAlwaysOnTop(true, 'screen-saver');
}

function openInfo(kind) {
  const key = kind === 'support' ? 'support' : 'about';
  const alive = infoWins[key];
  if (alive && !alive.isDestroyed()) { alive.show(); alive.focus(); alive.moveTop(); return; }
  const isSupport = key === 'support';
  // 支持窗口按内容收放高度，免得一片空白
  let winH = 762;
  if (isSupport) {
    const s = supportAssets();
    const n = (s.qrWechat ? 1 : 0) + (s.qrAlipay ? 1 : 0);
    winH = n >= 2 ? 640 : n === 1 ? 560 : 470;
    if (s.supportUrl) winH += 56;
  }
  const win = new BrowserWindow({
    width: isSupport ? 520 : 560,
    height: winH,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: isSupport ? '支持一下' : '关于',
    backgroundColor: '#12141a',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-info.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  infoWins[key] = win;
  log(`打开窗口 ${key}`);
  win.loadFile(path.join(__dirname, isSupport ? 'support.html' : 'about.html'));
  win.webContents.on('did-fail-load', (_e, code, desc) => log(`窗口 ${key} 加载失败`, code, desc));
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    win.setAlwaysOnTop(true, 'screen-saver');   // 压过同样置顶的宠物窗口
    win.moveTop();
    log(`窗口 ${key} 已显示`, JSON.stringify(win.getBounds()), `visible=${win.isVisible()}`);
  });
  win.on('closed', () => {
    infoWins[key] = null;
    raisePet();
  });
}

let infoIpcReady = false;
function wireInfoIpc() {
  if (infoIpcReady) return;
  infoIpcReady = true;
  ipcMain.handle('info:get', () => infoPayload());
  ipcMain.handle('info:open-url', (_e, url) => {
    // 只放行 http(s)，避免被拼出 file:// 或自定义协议
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('info:close', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && !w.isDestroyed()) w.close();
  });
}


function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-32.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-256.png')) : icon);
  tray.on('click', () => { forceAnim(null); openPicker(); });
  refreshTrayMenu();
}

function petPayload(id) {
  const item = dex.find((d) => d.id === id) || null;
  const pmd = pmdData(id);
  // 命中盒：PMD 有 alpha 包围盒就用它（和水彩立绘那套形状不同），否则退回预计算盒子
  hitRect = computeHitRect(pmd);
  log('命中盒 计算', JSON.stringify(hitRect));
  return {
    id,
    // PMD 动作集是唯一路径；没有素材的宝可梦显示编号占位卡
    pmd,
    preferPmd: !!pmd,
    cry: cryUrl(id),
    sound: cfg.sound !== false,
    behavior: behaviorOf(),
    pixelScale: Number(process.env.POKEPET_PIXEL_SCALE || 0),
    box: boxes[String(id)] || null,
    item,
    debug: !!process.env.POKEPET_DEBUG,
  };
}

// ---------- 宠物窗口 ----------

function createPetWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const start = clampToScreen(
    typeof cfg.x === 'number' ? cfg.x : area.x + area.width - W - 40,
    typeof cfg.y === 'number' ? cfg.y : area.y + area.height - H - 8,
    null,
  );
  const x = start.x;
  const y = start.y;

  petWin = new BrowserWindow({
    width: W,
    height: H,
    x,
    y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,          // 拖动由我们自己在主进程里做，避免和穿透状态打架
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,        // 不抢焦点，点它不会把你正在打字的输入框顶掉
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload-pet.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,   // 被遮挡时默认会暂停渲染，表现成宠物消失
    },
  });

  petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  setIgnore(true);

  petWin.loadFile(path.join(__dirname, 'pet.html'));
  petWin.once('ready-to-show', () => petWin && petWin.showInactive());
  petWin.on('closed', () => { petWin = null; });
  // 窗口尺寸一旦自己变了，宠物就会「越摸越大」，所以留个记录方便定位
  petWin.on('resize', () => {
    if (!petWin || petWin.isDestroyed()) return;
    log('!! 窗口尺寸变化', JSON.stringify(petWin.getBounds()));
  });

  const d = screen.getPrimaryDisplay();
  log('显示信息', `bounds=${JSON.stringify(d.bounds)}`, `workArea=${JSON.stringify(d.workArea)}`,
    `scale=${d.scaleFactor}`, `请求位置=${x},${y}`, `实际位置=${JSON.stringify(petWin.getBounds())}`,
    `命中盒=${JSON.stringify(hitBox())}`);

  // POKEPET_SHOWCASE=<json 路径>：按时间线演一遍，专供录屏
  // 格式 [{"at":3000,"do":"feed","food":146},{"at":9000,"do":"follow"},...]
  if (process.env.POKEPET_SHOWCASE) {
    try {
      const plan = JSON.parse(fs.readFileSync(process.env.POKEPET_SHOWCASE, 'utf8'));
      log('演示脚本', `共 ${plan.length} 步`);
      for (const step of plan) {
        setTimeout(() => {
          try {
            if (step.do === 'feed') {
              feedFood(FOODS.find((f) => f.id === step.food) || FOODS[0]);
            } else if (step.do === 'follow') {
              forceAnim(null); walkNow(0);
            } else if (step.do === 'stopfollow') {
              followStop();
            } else if (step.do === 'anim') {
              forceAnim(step.name);
            } else if (step.do === 'stopanim') {
              forceAnim(null);
            }
            log('演示', `${step.at}ms ${step.do}${step.name ? ' ' + step.name : ''}`);
          } catch (e) { log('演示失败', String(e)); }
        }, step.at);
      }
    } catch (e) { log('演示脚本读取失败', String(e)); }
  }

  if (process.env.POKEPET_DEBUG) {
    setTimeout(async () => {
      if (!petWin || petWin.isDestroyed()) return;
      log('调试', `bounds=${JSON.stringify(petWin.getBounds())}`,
        `content=${JSON.stringify(petWin.getContentBounds())}`,
        `cursor=${JSON.stringify(screen.getCursorScreenPoint())}`,
        `visible=${petWin.isVisible()}`);

      const shot = async (name) => {
        try {
          const img = await petWin.webContents.capturePage();
          fs.writeFileSync(path.join(DATA, name), img.toPNG());
          log('调试', `截图 ${name} ${img.getSize().width}x${img.getSize().height}`);
        } catch (e) { log('截图失败', name, String(e)); }
      };

      await shot('pet-before.png');

      // POKEPET_SNAP=<png 路径>：只做一件事——强制待机，截一张带透明通道的宠物图，然后退出
      if (process.env.POKEPET_SNAP) {
        const out = process.env.POKEPET_SNAP;
        try {
          petWin.webContents.send('pet:force', 'Idle');
        } catch { /* 渲染层可能还没就绪 */ }
        await new Promise((r) => setTimeout(r, 1800));
        try {
          const img = await petWin.webContents.capturePage();
          fs.writeFileSync(out, img.toPNG());
          log('调试', `snap 已保存 ${out}`);
        } catch (e) { log('snap 失败', String(e)); }
        app.quit();
        return;
      }

      // POKEPET_DEBUG=5：按脚本切换 PMD 动作（站→坐→走→睡→醒），逐帧录下来拼成动图
      if (process.env.POKEPET_DEBUG === '5') {
        try {
          demoMode = true;
          const dir = path.join(DATA, 'frames5');
          fs.rmSync(dir, { recursive: true, force: true });
          fs.mkdirSync(dir, { recursive: true });

          // 每个状态停留多久（毫秒），一个状态录一组帧
          const seq = [
            ['Idle', 'S', 900],
            ['Sit', 'S', 900],
            ['Walk', 'E', 700],
            ['Walk', 'S', 700],
            ['Sleep', 'S', 1100],
            ['Wake', 'S', 700],
            ['Idle', 'S', 600],
          ];

          let i = 0;
          for (const [name, dirn, ms] of seq) {
            petWin.webContents.send('pet:force', { name, dir: dirn });
            const frames = Math.max(2, Math.round(ms / 90));
            for (let f = 0; f < frames; f++) {
              const img = await petWin.webContents.capturePage();
              fs.writeFileSync(path.join(dir, `f${String(i).padStart(3, '0')}.png`), img.toPNG());
              i++;
              await new Promise((r) => setTimeout(r, 90));
            }
            log('录帧', `${name}-${dirn} 完成，累计 ${i} 帧`);
          }
          demoMode = false;
          log('调试', `PMD 演示 ${i} 帧 -> ${dir}`);
        } catch (e) { log('录帧失败', String(e)); demoMode = false; }
      }

      // POKEPET_DEBUG=6：验证叫声能不能解码、能不能真的播出来
      if (process.env.POKEPET_DEBUG === '6') {
        try {
          const r = await petWin.webContents.executeJavaScript(`
            (async () => {
              const before = { ready: cryEl ? cryEl.readyState : -1, src: crySrc ? crySrc.slice(-16) : null, muted };
              playCry();
              await new Promise((r) => setTimeout(r, 500));
              return {
                ...before,
                afterReady: cryEl ? cryEl.readyState : -1,
                duration: cryEl ? cryEl.duration : -1,
                paused: cryEl ? cryEl.paused : null,
                currentTime: cryEl ? Number(cryEl.currentTime.toFixed(3)) : null,
                mutedAfter: muted,
              };
            })()
          `);
          log('调试 叫声', JSON.stringify(r));
        } catch (e) { log('叫声测试失败', String(e)); }
      }

      // POKEPET_DEBUG=7：连点 6 下 + 双击，确认不会再弹出选宠器
      if (process.env.POKEPET_DEBUG === '7') {
        try {
          await petWin.webContents.executeJavaScript(`
            (() => {
              for (let i = 0; i < 6; i++) {
                document.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
                window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
                window.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
              }
              return 'clicked 6 + dblclick';
            })()
          `);
          await new Promise((r) => setTimeout(r, 1200));
          log('调试 连点', `选宠器窗口=${pickerWin ? '有（不该有）' : '无（正确）'}`);
        } catch (e) { log('连点测试失败', String(e)); }
      }

      // POKEPET_DEBUG=8：模拟一次拖拽，确认拖动过程中宠物不会消失
      if (process.env.POKEPET_DEBUG === '8') {
        try {
          await petWin.webContents.executeJavaScript(`
            (() => {
              document.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, screenX: 400, screenY: 300 }));
              window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, screenX: 460, screenY: 340 }));
              return 'dragging';
            })()
          `);
          await new Promise((r) => setTimeout(r, 700));
          await shot('pet-drag.png');
          await petWin.webContents.executeJavaScript(`
            window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, screenX: 460, screenY: 340 }))
          `);
          await new Promise((r) => setTimeout(r, 400));
          await shot('pet-drag-end.png');
          log('调试 拖拽', '已截图 pet-drag.png / pet-drag-end.png');
        } catch (e) { log('拖拽测试失败', String(e)); }
      }

      // POKEPET_DEBUG=18：喂一颗果，在 4 个时间点抓图，验证「食物→缩小→爱心→叫声」这条链
      if (process.env.POKEPET_DEBUG === '18') {
        try {
          await new Promise((r) => setTimeout(r, 2200));
          feedFood(FOODS[0]);
          const marks = [320, 780, 1150, 1650];
          let last = 0;
          for (let i = 0; i < marks.length; i += 1) {
            await new Promise((r) => setTimeout(r, marks[i] - last));
            last = marks[i];
            await shot(`feed-${i + 1}.png`);
          }
          log('调试 喂食', `已截图 feed-1..4.png（${FOODS[0].name}）`);

          // 再录一遍密集序列，用来拼动图看整段节奏
          const seqDir = path.join(DATA, 'feedseq');
          fs.mkdirSync(seqDir, { recursive: true });
          for (const f of fs.readdirSync(seqDir)) fs.unlinkSync(path.join(seqDir, f));
          forceAnim(null);
          await new Promise((r) => setTimeout(r, 600));
          feedFood(FOODS[0]);
          for (let i = 0; i < 24; i += 1) {
            await new Promise((r) => setTimeout(r, 110));
            const buf = await petWin.webContents.capturePage();
            fs.writeFileSync(path.join(seqDir, `f${String(i).padStart(3, '0')}.png`), buf.toPNG());
          }
          log('调试 喂食', '密集序列 feedseq/ 24 帧已录完');
        } catch (e) { log('喂食测试失败', String(e)); }
      }

      // POKEPET_DEBUG=13：挨个试 35 个动作，每个抓一张图，验证「动作」菜单那条链路
      if (process.env.POKEPET_DEBUG === '13') {
        try {
          const pm = pmdData(cfg.id);
          const have = pm ? Object.keys(pm.anims || {}) : [];
          const list = [];
          for (const [, names] of ANIM_GROUPS) list.push(...names.filter((n) => have.includes(n)));
          list.push(...have.filter((n) => !list.includes(n)));
          log('调试 动作', `共 ${list.length} 个：${list.join(',')}`);
          let i = 0;
          const timer = setInterval(async () => {
            if (i >= list.length) {
              clearInterval(timer);
              forceAnim(null);
              log('调试 动作', '全部试完，已退出试动作');
              return;
            }
            const name = list[i++];
            forceAnim(name);
            await new Promise((r) => setTimeout(r, 420));
            try {
              const img = await petWin.webContents.capturePage();
              fs.writeFileSync(path.join(DATA, 'act', `${String(i).padStart(2, '0')}-${name}.png`), img.toPNG());
            } catch (e) { log('调试 动作 截图失败', name, String(e)); }
          }, 520);
        } catch (e) { log('动作测试失败', String(e)); }
      }

      // POKEPET_DEBUG=12：先跟随，再归位 —— 验证"归位会顺手停跟随"
      if (process.env.POKEPET_DEBUG === '12') {
        try {
          setTimeout(() => {
            log('调试 归位', '先开始跟随');
            walkNow(0);          // 0 = 一直跟随，直到 stopFollow
            setTimeout(() => {
              const b = petWin.getBounds();
              log('调试 归位', `归位前 ${b.x},${b.y} following=${following}`);
              debugReset();
              setTimeout(() => {
                const b2 = petWin.getBounds();
                log('调试 归位', `归位后 ${b2.x},${b2.y} following=${following}`);
              }, 1200);
            }, 2500);
          }, 1500);
        } catch (e) { log('归位测试失败', String(e)); }
      }

      // POKEPET_DEBUG=9：启动 3 秒后开始跟着鼠标走 6 秒，每 500ms 记一次窗口位置
      if (process.env.POKEPET_DEBUG === '9') {
        try {
          setTimeout(() => {
            log('调试 走路', '开始跟着鼠标走');
            walkNow(6000);
            const t = setInterval(() => {
              if (!petWin || petWin.isDestroyed()) { clearInterval(t); return; }
              const b = petWin.getBounds();
              log('调试 走动位置', `${b.x},${b.y}  光标=${JSON.stringify(screen.getCursorScreenPoint())}`);
            }, 500);
            setTimeout(() => clearInterval(t), 7000);
          }, 3000);
        } catch (e) { log('走路测试失败', String(e)); }
      }

      // POKEPET_DEBUG=10：观察行为状态机（抽签 → 溜达 / 睡觉），每 2 秒记一次状态
      if (process.env.POKEPET_DEBUG === '10') {
        try {
          setTimeout(async () => {
            const b = behaviorOf();
            log('调试 参数', `idle=${b.idleBefore}s sleepPct=${b.sleepPct}% 一觉=${b.sleepMin}~${b.sleepMax}s 段=${b.wanderTimes} 溜达=${b.wanderEnabled} 睡着阈值=${b.sleepAfter}s`);
            for (let i = 0; i < 40; i++) {
              const bb = petWin.getBounds();
              log('调试 行为', `t=${i * 2}s 窗口=${bb.x},${bb.y} 光标空闲=${Math.floor((Date.now() - cursorMovedAt) / 1000)}s`);
              await new Promise((r) => setTimeout(r, 2000));
            }
          }, 3000);
        } catch (e) { log('行为测试失败', String(e)); }
      }

      // POKEPET_DEBUG=17：主动弹出宠物右键菜单，用来验证「点外面会不会自动关」
      if (process.env.POKEPET_DEBUG === '17') {
        setTimeout(() => { log('调试 主动弹菜单'); ipcMain.emit('pet:menu'); }, 3000);
      }

      // POKEPET_DEBUG=15：验证开机自启能不能真的写进注册表（开 → 读回 → 关 → 读回）
      if (process.env.POKEPET_DEBUG === '15') {
        try {
          setTimeout(() => {
            log('自启测试 初始=' + autostartOn());
            setAutostart(true);
            log('自启测试 开后=' + autostartOn() + ' 托盘=' + (tray ? '在' : '无'));
            setAutostart(false);
            log('自启测试 关后=' + autostartOn());
            setAutostart(true);
            log('自启测试 再开=' + autostartOn());
          }, 2500);
        } catch (e) { log('自启测试失败', String(e)); }
      }

      try {
        const { desktopCapturer } = require('electron');
        const px = Math.round(d.bounds.width * d.scaleFactor);
        const py = Math.round(d.bounds.height * d.scaleFactor);
        const srcs = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: px, height: py },
        });
        if (srcs && srcs[0]) {
          const dp = path.join(DATA, 'desktop.png');
          fs.writeFileSync(dp, srcs[0].thumbnail.toPNG());
          const s = srcs[0].thumbnail.getSize();
          log('调试', `整屏截图 ${s.width}x${s.height} (物理应为 ${px}x${py}) -> ${dp}`);
        }
      } catch (e) { log('整屏截图失败', String(e)); }
    }, 1200);
  }

  startPoll();
}

function setIgnore(next) {
  // 菜单弹着的时候不要改穿透状态：把窗口切成穿透，点菜单外面那一下会直接漏到桌面上。
  if (menuOpen) return;
  if (ignoring === next || !petWin || petWin.isDestroyed()) return;
  ignoring = next;
  if (next) petWin.setIgnoreMouseEvents(true, { forward: true });
  else petWin.setIgnoreMouseEvents(false);
  if (process.env.POKEPET_DEBUG === '19') log('穿透', next ? '开(点不到)' : '关(能点到)');
}

function hitBox() {
  if (hitRect) return hitRect;
  const b = boxes[String(cfg.id)];
  if (!b) return [150, 60, 490, 330];
  return b;
}

function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (!petWin || petWin.isDestroyed()) return;
    fixSize();
    if (dragging) { followCursor(); return; }
    const p = screen.getCursorScreenPoint();
    // 「用户在用电脑」= 光标在 1 秒内真实挪了 60px 以上。
    // 这台机器有虚拟输入设备在不停抖 1~2px，直接看「有没有变化」会永远判成在用，
    // 所以只认累计距离。
    if (lastCursorPt) {
      moveAccum += Math.abs(p.x - lastCursorPt.x) + Math.abs(p.y - lastCursorPt.y);
    }
    lastCursorPt = p;
    if (Date.now() - moveWindowAt >= 1000) {
      if (moveAccum >= 60) cursorMovedAt = Date.now();
      moveAccum = 0;
      moveWindowAt = Date.now();
    }
    const b = petWin.getBounds();
    const [x0, y0, x1, y1] = hitBox();
    const lx = p.x - b.x;
    const ly = p.y - b.y;
    const inside = lx >= x0 - SNAP && lx <= x1 + SNAP && ly >= y0 - SNAP && ly <= y1 + SNAP;
    setIgnore(!inside);
    // 把光标坐标喂给渲染层：宠物要能「看着」鼠标，这是活物感最便宜的一半
    if (!demoMode && petWin.webContents && !petWin.webContents.isDestroyed()) {
      petWin.webContents.send('pet:cursor', { x: lx, y: ly, inside });
    }
  }, POLL_MS);
}

function followCursor() {
  if (!petWin || petWin.isDestroyed() || !dragging) return;
  const p = screen.getCursorScreenPoint();
  const pos = clampToScreen(p.x - dragOffset.x, p.y - dragOffset.y, p);
  moveTo(pos.x, pos.y);
}

/**
 * 移动窗口时必须连尺寸一起写死。
 * 只调 setPosition 的话，在 125% 缩放的屏幕上，Windows 每次都会按物理像素重新取整，
 * 窗口会一格一格长大（实测一次 +1px，连点几十次能长到屏幕外）。
 */
function moveTo(x, y) {
  if (!petWin || petWin.isDestroyed()) return;
  petWin.setBounds({ x, y, width: W, height: H }, false);
}

/** 兜底：万一尺寸还是被系统改掉了，下一轮轮询里掰回来。 */
function fixSize() {
  if (!petWin || petWin.isDestroyed()) return;
  if (process.env.POKEPET_NOFIX === '1') return;
  const b = petWin.getBounds();
  const dw = b.width - W;
  const dh = b.height - H;
  // 125% 缩放下差 1~2px 是取整常态，掰它反而会触发下一次取整，形成 60ms 的死循环
  if (Math.abs(dw) <= 2 && Math.abs(dh) <= 2) return;
  log('尺寸被系统改掉，掰回来', `${b.width}x${b.height} -> ${W}x${H}`);
  petWin.setBounds({ x: b.x, y: b.y, width: W, height: H }, false);
}

/** 别让宠物被拖出屏幕外：按精灵包围盒算，保证整只都在显示器可见范围内。 */
function clampToScreen(x, y, near) {
  const display = screen.getDisplayNearestPoint(near || { x, y });
  const a = display.workArea;
  const [x0, y0, x1, y1] = hitBox();
  const minX = a.x - x0;
  const maxX = a.x + a.width - x1;
  const minY = a.y - y0;
  const maxY = a.y + a.height - y1;
  return {
    x: Math.round(Math.min(Math.max(x, minX), Math.max(minX, maxX))),
    y: Math.round(Math.min(Math.max(y, minY), Math.max(minY, maxY))),
  };
}

// ---------- 选宠窗口 ----------

function openPicker() {
  if (pickerWin && !pickerWin.isDestroyed()) {
    pickerWin.show();
    pickerWin.focus();
    return;
  }
  pickerWin = new BrowserWindow({
    width: 940,
    height: 680,
    minWidth: 620,
    minHeight: 460,
    title: '选择宝可梦',
    backgroundColor: '#12141a',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-picker.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  pickerWin.loadFile(path.join(__dirname, 'picker.html'));
  // 选宠器里 console.log 的内容转进 boot.log，方便排查（比如收藏计数）
  pickerWin.webContents.on('console-message', (_e, _lvl, msg) => {
    if (!/Electron Security Warning/.test(msg)) log('[选宠器]', msg);
  });
  pickerWin.once('ready-to-show', () => {
    pickerWin.show();
    pickerWin.focus();

    // POKEPET_SNAP_PICKER=<png 路径>：截图后退出，用来生成 README 配图
    if (process.env.POKEPET_SNAP_PICKER) {
      const out = process.env.POKEPET_SNAP_PICKER;
      setTimeout(async () => {
        try {
          const img = await pickerWin.webContents.capturePage();
          fs.writeFileSync(out, img.toPNG());
          log('调试', `snap 选宠器 ${out}`);
        } catch (e) { log('snap 选宠器失败', String(e)); }
        app.quit();
      }, 1500);
      return;
    }
    // 调试：模拟「点一下星标」，验证 收藏 → 落盘 → 重绘 整条链路
    if (process.env.POKEPET_DEBUG === '19') {
      setTimeout(async () => {
        try {
          const before = cfg.fav.join(',');
          const after = await pickerWin.webContents.executeJavaScript('toggleFav(133).then(() => [...favs].join(","))');
          log('调试 收藏', `点前=${before} 点后=${after} 文件=` + readJson(CONFIG, {}).fav?.join(','));
          const star = await pickerWin.webContents.executeJavaScript(
            'document.querySelector(".star.on") ? document.querySelectorAll(".star.on").length : 0');
          log('调试 收藏', `亮着的星标 ${star} 个`);
          const shown = await pickerWin.webContents.executeJavaScript(
            'document.getElementById("onlyFav").checked = true; render(); document.querySelectorAll("#grid .card").length');
          log('调试 收藏', `勾「只看收藏」后网格剩 ${shown} 张`);
        } catch (e) { log('调试 收藏 失败', String(e)); }
      }, 1200);
    }
    // 调试：POKEPET_PICKER_Q=pkq 打一串搜索词，回报命中数与前几条名字
    if (process.env.POKEPET_PICKER_Q) {
      const q = process.env.POKEPET_PICKER_Q;
      setTimeout(async () => {
        try {
          const r = await pickerWin.webContents.executeJavaScript(`(() => {
            const box = document.getElementById('q');
            box.value = ${JSON.stringify(q)};
            box.dispatchEvent(new Event('input'));
            return new Promise((res) => setTimeout(() => res({
              n: document.querySelectorAll('#grid .card').length,
              names: [...document.querySelectorAll('#grid .nm')].slice(0, 6).map((e) => e.textContent),
            }), 260));
          })()`);
          log('调试 搜索', `q=${q} 命中=${r.n} 前几条=${r.names.join(' / ')}`);
        } catch (e) { log('调试 搜索 失败', String(e)); }
      }, 1400);
    }
  });
  pickerWin.on('closed', () => { pickerWin = null; });
}

function applyPet() {
  if (!petWin || petWin.isDestroyed()) return;
  const payload = petPayload(cfg.id);
  petWin.webContents.send('pet:set', payload);
  setIgnore(true);
  // 换了体型更大的宝可梦，窗口可能已经越界，重新夹一次
  const b = petWin.getBounds();
  const pos = clampToScreen(b.x, b.y, null);
  if (pos.x !== b.x || pos.y !== b.y) {
    moveTo(pos.x, pos.y);
    cfg.x = pos.x;
    cfg.y = pos.y;
    saveConfig();
  }
  refreshTrayMenu();     // 换了宝可梦，托盘的提示和菜单抬头跟着变
}

// ---------- IPC ----------

function wireIpc() {
  ipcMain.handle('pet:init', () => petPayload(cfg.id));

  ipcMain.on('pet:drag-start', () => {
    if (!petWin || petWin.isDestroyed()) return;
    if (following) stopFollow();     // 手动拖了就别再跟着了，否则会跟手抢位置
    const p = screen.getCursorScreenPoint();
    const b = petWin.getBounds();
    dragOffset = { x: p.x - b.x, y: p.y - b.y };
    dragging = true;
    if (!dragTimer) dragTimer = setInterval(followCursor, 16);
  });

  ipcMain.on('pet:drag-end', () => {
    if (!dragging) return;
    dragging = false;
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
    if (petWin && !petWin.isDestroyed()) {
      const b = petWin.getBounds();
      cfg.x = b.x;
      cfg.y = b.y;
      saveConfig();
      setIgnore(true);
    }
  });

/** 跟着鼠标走：一直跟，直到右键选「停止跟随」或者被拖走。
 *  每帧重新读光标，碰到光标（28px 内）就站住不动，光标挪远了再追。 */
function startFollow() {
  if (!petWin || petWin.isDestroyed() || following) return;
  following = true;
  const send = (p) => { if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:walk', p); };
  let moving = false;
  let lastDir = '';

  walkTimer = setInterval(() => {
    if (!petWin || petWin.isDestroyed()) { stopFollow(); return; }

    const pt = screen.getCursorScreenPoint();
    const b = petWin.getBounds();
    // 目标点用「精灵脚底」对齐光标，而不是窗口中心（窗口四周有 231px 透明余量）
    const tx = pt.x - W / 2;
    const ty = pt.y - (H - 30);
    const dx = tx - b.x;
    const dy = ty - b.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 28) {
      if (moving) { send({ stop: true, turn: true }); moving = false; }
      return;                       // 碰到光标了，站着等
    }

    // 朝四个方向走：主要往上下走就用正面/背面，否则用侧面
    const vertical = Math.abs(dy) > Math.abs(dx) * 1.2;
    const dir = vertical ? (dy < 0 ? 'N' : 'S') : (dx >= 0 ? 'E' : 'W');
    if (!moving || dir !== lastDir) { send({ dir }); moving = true; lastDir = dir; }

    const step = Math.min(9, Math.max(2, dist / 12));
    const nx = b.x + (dx / dist) * step;
    const ny = b.y + (dy / dist) * step;
    const c = clampToScreen(nx, ny);
    moveTo(c.x, c.y);
  }, 30);
}

function stopFollow() {
  if (walkTimer) { clearInterval(walkTimer); walkTimer = null; }
  if (!following) return;
  following = false;
  if (petWin && !petWin.isDestroyed()) {
    petWin.webContents.send('pet:walk', { stop: true, turn: true });   // turn：停下时转个身看你
    const b = petWin.getBounds();
    cfg.x = b.x; cfg.y = b.y; saveConfig();
  }
}

walkNow = startFollow;
followStop = stopFollow;

/** 归位：停跟随、掐掉当前溜达，再把人搬到主屏右下角。
 *  注意它必须留在 wireIpc 里面 —— stopFollow / wanderCancel 都是这个函数的局部变量，
 *  放到文件末尾（模块作用域）会变成 ReferenceError，菜单点了毫无反应。 */
function resetPosition() {
  if (!petWin || petWin.isDestroyed()) return;
  const b0 = petWin.getBounds();
  log(`归位 请求 当前 ${b0.x},${b0.y} following=${following} wander=${!!wanderCancel}`);
  // 先停跟随：否则归位后它立刻又被光标拽回去，看起来像"归位失灵"
  stopFollow();
  // 正在溜达的那一段也掐掉（走 finish 路径，让渲染层的 await 能解开）
  if (wanderCancel) wanderCancel();
  const area = screen.getPrimaryDisplay().workArea;
  const pos = clampToScreen(area.x + area.width - W - 40, area.y + area.height - H - 8, null);
  moveTo(pos.x, pos.y);
  // 归位也让它转个圈：跟「跟随停下」用同一条通道（turn），省得再开一个 IPC
  petWin.webContents.send('pet:walk', { stop: true, turn: true });
  cfg.x = pos.x;
  cfg.y = pos.y;
  saveConfig();
  const b1 = petWin.getBounds();
  log(`归位 完成 ${b1.x},${b1.y}`);
}

debugReset = resetPosition;

// ---------- 自己溜达 ----------
// 只沿「任务栏上方那条走廊」走，不往屏幕中间窜，尽量不挡人。
// 一段 = 从当前位置挑一个新点走过去；走完由渲染层决定要不要再来一段。

const FEET_Y = H - 30;          // 精灵脚底在窗口内的 y
let wanderTimer = null;
let wanderCancel = null;        // 外部（归位/退出）打断当前这段溜达用的

function wanderOnce() {
  return new Promise((resolve) => {
    if (!petWin || petWin.isDestroyed() || following || dragging) { resolve(false); return; }
    if (wanderTimer) { clearInterval(wanderTimer); wanderTimer = null; }

    const b0 = petWin.getBounds();
    const disp = screen.getDisplayNearestPoint({ x: b0.x + W / 2, y: b0.y + FEET_Y });
    const area = disp.workArea;

    // 落点：整个工作区随机一个点（全屏溜达）。
    // 想退回「只在底部走廊走」，把 FULL_ROAM 改成 false 即可。
    const FULL_ROAM = true;
    let tx, feetY;
    if (FULL_ROAM) {
      const x0 = area.x + 40;
      const x1 = area.x + area.width - W + 40;
      tx = Math.round(x0 + Math.random() * Math.max(0, x1 - x0));
      const f0 = area.y + 70;
      const f1 = area.y + area.height - 6;
      feetY = Math.round(f0 + Math.random() * Math.max(0, f1 - f0));
    } else {
      // 旧行为：在它现在这一行溜达
      const feetNow = b0.y + FEET_Y;
      const feetMin = area.y + 70;
      const feetMax = area.y + area.height - 6;
      feetY = Math.min(feetMax, Math.max(feetMin, Math.round(feetNow + (Math.random() - 0.5) * 24)));
      const dirSign = Math.random() < 0.5 ? -1 : 1;
      tx = b0.x + dirSign * Math.round(160 + Math.random() * 360);
    }
    const target = clampToScreen(tx, feetY - FEET_Y);
    log(`wander 起点 ${b0.x},${b0.y} → 目标 ${target.x},${target.y}（全屏=${FULL_ROAM} feetY=${feetY}）`);

    const send = (p) => { if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:walk', p); };
    const started = Date.now();
    let lastDir = '';

    const finish = (ok) => {
      if (wanderTimer) { clearInterval(wanderTimer); wanderTimer = null; }
      wanderCancel = null;
      send({ stop: true });
      const b = petWin && !petWin.isDestroyed() ? petWin.getBounds() : { x: 0, y: 0 };
      log(`wander 结束 ok=${ok} 现在 ${b.x},${b.y} 用时 ${Date.now() - started}ms`);
      if (ok) {
        cfg.x = b.x; cfg.y = b.y; saveConfig();
      }
      resolve(ok);
    };

    wanderCancel = () => finish(false);

    wanderTimer = setInterval(() => {
      if (!petWin || petWin.isDestroyed()) { finish(false); return; }
      // 用户一插手就让位
      if (dragging || following) { finish(false); return; }
      if (Date.now() - started > 9000) { finish(false); return; }

      const b = petWin.getBounds();
      const dx = target.x - b.x;
      const dy = target.y - b.y;
      const dist = Math.hypot(dx, dy);

      if (dist <= 5) { moveTo(target.x, target.y); finish(true); return; }

      // 主要往上下走的时候用正面/背面 —— 侧面走路姿势配纵向位移会很怪
      const vertical = Math.abs(dy) > Math.abs(dx) * 1.2;
      const dir = vertical ? (dy < 0 ? 'N' : 'S') : (dx >= 0 ? 'E' : 'W');
      if (dir !== lastDir) { send({ dir }); lastDir = dir; }

      const step = Math.min(7, Math.max(2, dist / 10));
      const c = clampToScreen(b.x + (dx / dist) * step, b.y + (dy / dist) * step);
      moveTo(c.x, c.y);
    }, 30);
  });
}


function showPetMenu() {
    if (!petWin) return;
    const items = [
      { label: `去吧 ${petName(cfg.id)}`, enabled: false },
      { type: 'separator' },
      following
        ? { label: '停止跟随', click: stopFollow }
        : { label: '跟随', click: () => { forceAnim(null); startFollow(); } },
      {
        label: cfg.sound === false ? '打开声音' : '静音',
        click: () => {
          cfg.sound = cfg.sound === false;
          saveConfig();
          applyPet();
        },
      },
      { type: 'separator' },
      {
        label: '允许溜达',
        type: 'checkbox',
        checked: cfg.wanderEnabled !== false,
        click: () => {
          cfg.wanderEnabled = cfg.wanderEnabled === false;
          saveConfig();
          pushBehavior();
        },
      },
      { type: 'separator' },
      { label: '选择宝可梦…', click: () => { forceAnim(null); openPicker(); } },
      { label: previewing ? `动作（正在播 ${ANIM_ZH[previewing] || previewing}）` : '动作', submenu: animSubmenu() },
      { label: '吃东西', submenu: foodSubmenu() },
      { label: '归位', click: () => { forceAnim(null); resetPosition(); } },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ];
    const menu = Menu.buildFromTemplate(items);
    // 这扇窗是 focusable:false 的（不抢别人焦点），代价是 Windows 上的原生弹出菜单
    // 拿不到「点了外面」这件事，菜单会一直挂在桌面上。弹菜单期间临时允许聚焦，
    // 关掉就恢复，配合 setIgnore() 里的 menuOpen 守卫，避免鼠标穿透把菜单点没了。
    menuOpen = true;
    log('右键菜单 打开');
    try { petWin.setFocusable(true); petWin.focus(); } catch { /* 老平台不支持就算了 */ }
    menu.popup({
      window: petWin,
      callback: () => {
        menuOpen = false;
        log('右键菜单 关闭');
        try { petWin.setFocusable(false); } catch { /* 同上 */ }
      },
    });
}

ipcMain.on('pet:menu', showPetMenu);

  ipcMain.on('pet:open-picker', openPicker);

// ---------- 自己溜达 / 系统空闲 / 设置面板 ----------

ipcMain.handle('pet:wander', () => wanderOnce());

ipcMain.on('app:log', (e, msg) => log('[渲染层]', msg));

// 用户多久没碰键鼠（秒）。渲染层据此判断「现在能不能自己动」。
// 用光标静止时长而不是 powerMonitor.getSystemIdleTime()——后者在有虚拟输入设备的
// 机器上恒为 0，会让宠物永远不溜达；光标是我们自己能证明的信号。
ipcMain.handle('app:idle', () => Math.floor((Date.now() - cursorMovedAt) / 1000));

// 把最新的行为参数推给渲染层（改勾选、换性格之后调用）。
function pushBehavior() {
  if (petWin && !petWin.isDestroyed()) {
    const out = { ...behaviorOf(), sound: cfg.sound !== false };
    petWin.webContents.send('pet:config', out);
    log('行为参数已下发', JSON.stringify(out));
  }
}

ipcMain.handle('behavior:get', () => ({ ...behaviorOf(), sound: cfg.sound !== false }));


  ipcMain.handle('picker:init', () => {
    log('选宠器 init', `fav=${cfg.fav.join(',') || '(空)'} 当前=${cfg.id}`);
    return {
      items: dex,
      current: cfg.id,
      pinyin,
      have: [...cardIds],
      fav: cfg.fav.slice(),
        cardBase: pathToFileURL(CARD).href + '/',
    };
  });

  // 收藏：只改内存 + 落盘，不重建窗口
  ipcMain.handle('picker:fav', (e, id, on) => {
    const n = Number(id);
    if (!Number.isFinite(n)) return cfg.fav.slice();
    const set = new Set(cfg.fav);
    if (on) set.add(n); else set.delete(n);
    cfg.fav = [...set];
    saveConfig();
    return cfg.fav.slice();
  });

  ipcMain.handle('picker:choose', (e, id) => {
    if (typeof id !== 'number') return false;
    cfg.id = id;
    saveConfig();
    applyPet();
    if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
    return true;
  });
}

// ---------- 启动 ----------

if (!app.requestSingleInstanceLock()) {
  log('单实例锁被占用，退出');
  app.quit();
} else {
  app.on('second-instance', openPicker);

  app.whenReady().then(() => {
    log('whenReady');
    try {
      loadAssets();
      log(`图鉴 ${dex.length} 条，有包围盒 ${Object.keys(boxes).length} 条`);
      // 每次启动重抽一组参数：闲多久、抽不抽到睡、一觉多久、你离开多久才睡。
      // 加 POKEPET_KEEP_MOOD=1 可以保住上一轮的数值，方便反复调阈值。
      if (process.env.POKEPET_KEEP_MOOD !== '1') rollParams();
      else log('沿用上次参数');
      wireIpc();
      createPetWindow();
      log('宠物窗口已创建');
      createTray();
      log('托盘已创建');
      wireInfoIpc();
      if (process.env.POKEPET_OPEN_PICKER === '1') openPicker();
      if (process.env.POKEPET_OPEN_INFO) openInfo(process.env.POKEPET_OPEN_INFO);
    } catch (e) {
      log('启动失败', (e && e.stack) || String(e));
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createPetWindow();
    });
  });

  app.on('window-all-closed', () => {
    log('所有窗口已关闭');
    app.quit();
  });
  app.on('before-quit', () => {
    if (pollTimer) clearInterval(pollTimer);
    if (dragTimer) clearInterval(dragTimer);
  });
}
