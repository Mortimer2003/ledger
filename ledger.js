(function () {
  'use strict';


  // ===== 常量 =====
  var CATEGORY_ORDER = ['常规收入', '特殊收入', '常规支出', '特殊支出', '娱乐支出'];
  var UNSET_MONTH = '未标月份';
  var UNSET_CATEGORY = '未分类';
  var UNSET_SUB = '未分子类';
  var NEW_SUB = '__new__';
  var CMP_OTHER = '__other__';   // 对比视图里「月份解析不出年份」的那一档
  var NEW_MONTH = '__new_month__';   // 月度画廊最右那张「新增月份」的占位卡

  // 「新增月份账单」的模板：每月都要有的壳子。
  // 常规项名字里的月号按目标月份生成，房租记的是下个月（9月账单里放「10月房租」），所以用 {下月}。
  // 特殊收入/特殊支出/娱乐支出的明细项每月都不一样，只建空行，名字留着自己填。
  var MONTH_TEMPLATE = [
    { category: '常规收入', item: '{本月}工资' },
    { category: '常规收入', item: '{本月}公积金' },
    { category: '特殊收入' },
    { category: '常规支出', item: '{下月}房租' },
    { category: '特殊支出' },
    { category: '娱乐支出' }
  ];

  var API = 'https://api.notion.com/v1';
  var NOTION_VERSION = '2025-09-03';
  var DEFAULT_DATA_SOURCE = '3ebbd5ec-f393-8185-9009-000b90588287';
  var KEY_TOKEN = 'ledger.token';
  var KEY_DS = 'ledger.dataSourceId';
  var KEY_CACHE = 'ledger.cache';
  var KEY_GALLERY_AT = 'ledger.galleryAt';
  var KEY_CMP_YEAR = 'ledger.cmpYear';
  var KEY_BUDGET_DS = 'ledger.budgetSourceId';
  var DEFAULT_BUDGET_DS = '6a5dce49-5e88-4713-8cda-19925a5cc3fb';
  var KEY_ASSETS_DS = 'ledger.assetsSourceId';
  var DEFAULT_ASSETS_DS = 'aa5d7d6d-9349-4af1-a193-91c2af0eb26f';
  var KEY_ASSET_CACHE = 'ledger.assetCache';
  var KEY_ADJUST_DS = 'ledger.adjustSourceId';
  var DEFAULT_ADJUST_DS = '3d928be4-78b4-471b-9190-99d04b6b0022';
  var KEY_LOCKED = 'ledger.locked';
  var KEY_RANGE = 'ledger.monthRange';
  // 主 tab（财产/收支/预算）落盘，刷新后停在同一级；子 tab 不落盘，仍回各自第一种子视图
  var KEY_VIEW = 'ledger.view';
  // 纠偏超过这个数就提示补充备注：小额差异多半是零头，上千了就得说清来由
  var ADJUST_ALERT = 1000;
  var MAX_RETRY = 3;

  // 视图白名单，顺序跟顶栏按钮一致。
  // 两个主 tab：月度 / 总览。总览下子 tab 常显，收支/财产/预算各自出对比内容；
  // 月度下先停画廊，点进某个月份才露子 tab，切当月不同维度。
  // 子 tab 不落盘：主 tab 一切换就回默认（财产）
  var TABS = ['month', 'overview'];
  var SUBS = ['income', 'assets', 'budget'];
  var DEFAULT_SUB = 'assets';
  // 旧口径里「财产域」的两个 mode，读数和顶栏计数靠它识别
  var ASSET_VIEWS = ['assetMonth', 'assets'];
  // 主 tab 落盘，刷新后停在同一级；没记过或值不认，就回「月度」
  function readView() {
    return localStorage.getItem(KEY_VIEW) === 'overview' ? 'overview' : 'month';
  }
  // 月份区间是全局控件：第一行常驻、处处可选可改；但值只在总览的收支对比、
  // 财产对比里筛选内容。月度是按月看，天然不吃区间
  var RANGE_FILTER_VIEWS = ['compare', 'assets'];

  // 两维视图（主 tab × 子 tab）映射回旧的单维渲染口径 mode，下游逻辑
  // （读数、区间、类名、工具条）全部继续吃 mode，不用各自理解新结构
  function derivedMode() {
    if (state.view === 'overview') {
      return state.sub === 'income' ? 'compare'
        : state.sub === 'assets' ? 'assets' : 'budget';
    }
    // 月度：搜索态铺月份列表（原 tree）；没开月是画廊；开了月按子 tab 看当月维度
    if (!state.search.trim() && state.monthOpen) {
      return state.sub === 'income' ? 'tree'
        : state.sub === 'assets' ? 'assetMonth' : 'budget';
    }
    return 'tree';
  }

  // ---------- 娱乐预算 ----------
  // 每月 1500 打底，每个法定节假日再加 100，结余（含超支）逐月往后累加。
  // 「法定假日」记的是国家法定节假日天数，不是放假调休天数——国庆记 3 天不是 7 天。
  var BUDGET_BASE = 1500;
  var BUDGET_PER_HOLIDAY = 100;
  // 特殊支出本来就是为娱乐花的，一半计入娱乐预算，沿用原来的手算口径
  var SPECIAL_SHARE = 0.5;
  // 链条起点：2026年6月末的结余，值存在「娱乐预算」数据源的「期初」行
  var OPENING_MONTH = '2026年06月';
  var OPENING_TITLE = '期初';
  // 每年国务院公布次年放假安排后补一行。只记法定节假日天数。
  var HOLIDAY_DAYS = {
    2026: { 1: 1, 2: 4, 4: 1, 5: 2, 6: 1, 9: 1, 10: 3 }
  };


  // ===== 全局状态与 DOM 引用 =====
  var settings = {
    token: localStorage.getItem(KEY_TOKEN) || '',
    dataSourceId: localStorage.getItem(KEY_DS) || DEFAULT_DATA_SOURCE,
    budgetSourceId: localStorage.getItem(KEY_BUDGET_DS) || DEFAULT_BUDGET_DS,
    assetsSourceId: localStorage.getItem(KEY_ASSETS_DS) || DEFAULT_ASSETS_DS,
    adjustSourceId: localStorage.getItem(KEY_ADJUST_DS) || DEFAULT_ADJUST_DS
  };

  var state = {
    entries: [],
    expanded: {},   // 记录手动展开的节点，默认全部收起
    cmpCollapsed: {}, // 对比视图里收起的分类（默认展开）
    cmpYear: readCmpYear(), // 对比视图当前看哪一年；null = 跟随最新年份
    // 主 tab 落盘：刷新后停在上次那一级；子 tab 不记忆，一律回各自的第一种子视图
    view: readView(),   // 主 tab：month（月度）/ overview（总览），落盘
    sub: DEFAULT_SUB,   // 子 tab：income / assets / budget，不落盘、主 tab 一切换就回收支
    galleryAt: readGalleryAt(), // 月度画廊里居中的月份；null/失效时用最新一个月
    monthOpen: null,            // 月度详情页在看哪个月；null = 停在画廊
    budget: {},          // 月份 -> { id, specialIn, bonus }
    budgetOpening: { id: null, amount: 0 },
    budgetEdit: null,    // 正在就地编辑的预算格：{ month, field }
    assets: [],          // 财产快照：每行 { id, name, month, app, start, end, note }
    assetsEdit: null,    // 正在就地编辑的财产格：{ id, draft: { end } }
    assetNoteEdit: null, // 正在就地编辑的资产项备注：{ app, name, draft, was }
    adjust: {},          // 月份 -> { id, note }：纠偏归因，独立数据源，只存人工补的那句话
    adjustEdit: null,    // 正在就地编辑的纠偏归因：{ month, draft, was }
    assetsYear: null,    // 财产视图当前看哪一年，就地编辑铺列时按它取范围
    locked: readLocked(),      // 锁定历史月份，默认开：只有各域最新一个月可编辑
    rangeFrom: readRange().from,   // 对比/财产视图的月份区间，默认整年（1–12）
    rangeTo: readRange().to,
    rangeOpen: false,    // 月份区间弹层是否展开
    rangeAnchor: null,   // 区间点了一半时先记下的起点，点第二下才成区间
    rangeHover: null,    // 点区间时鼠标停在哪个月，用来预览要高亮的那一段
    hintOpen: false,     // 预算/财产视图的「说明」面板是否展开，默认收起
    pendingDelete: null,
    editing: null,  // 正在就地编辑的明细行：{ id, field: 'item' | 'amount' }
    search: '',
    sign: -1,
    signLocked: false,
    subOptions: [], // 数据源 schema 里的子类选项：[{ id, name }]
    subDesc: '',    // 子类属性本身的描述，改 schema 时必须原样带回，否则会被清空
    tagEditing: null,
    tagConfirm: null
  };

  var treeEl = document.getElementById('tree');
  var emptyEl = document.getElementById('empty');
  var cmpBarEl = document.getElementById('cmp-bar');
  var rangeBarEl = document.getElementById('range-bar');
  var totalsEl = document.getElementById('totals');
  var countEl = document.getElementById('count');
  var hintWrapEl = document.getElementById('hint-wrap');
  var hintPopEl = document.getElementById('hint-pop');
  var btnHintEl = document.getElementById('btn-hint');
  var btnTagsEl = document.getElementById('btn-tags');
  var barSubEl = document.getElementById('bar-sub');
  var btnFoldAllEl = document.getElementById('btn-fold-all');
  var btnExportEl = document.getElementById('btn-export');
  var modalEl = document.getElementById('modal');
  var setupEl = document.getElementById('setup');
  var tagsEl = document.getElementById('tags');
  var toastEl = document.getElementById('toast');
  var toastMsgEl = document.getElementById('toast-msg');
  var toastActionEl = document.getElementById('toast-action');
  var searchEl = document.getElementById('search');
  var searchClearEl = document.getElementById('search-clear');
  var progressEl = document.getElementById('progress');
  var refreshBtn = document.getElementById('btn-refresh');
  var btnLockEl = document.getElementById('btn-lock');
  var monthMaskEl = document.getElementById('month-mask');
  var monthInputEl = document.getElementById('m-month');
  var tplListEl = document.getElementById('tpl-list');
  var tplNoteEl = document.getElementById('tpl-note');
  var tplProgressEl = document.getElementById('tpl-progress');
  var monthErrEl = document.getElementById('month-err');
  var monthCreateBtn = document.getElementById('month-create');
  var monthCancelBtn = document.getElementById('month-cancel');

  var query = new URLSearchParams(location.search);
  document.documentElement.dataset.theme =
    query.get('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  // ---------- 小工具 ----------

  // ===== 工具函数 =====
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 万分位：每 4 位一个逗号（52,168 写成 5,2168），一眼能读出「5万2168」
  function money(n) {
    var parts = Math.abs(n)
      .toLocaleString('zh-CN', { maximumFractionDigits: 2, useGrouping: false })
      .split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{4})+(?!\d))/g, ',');
    return parts.join('.');
  }

  function signed(n) {
    return (n > 0 ? '+' : n < 0 ? '−' : '') + money(n);
  }

  function tone(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero'; }

  function sum(list) {
    return list.reduce(function (acc, e) { return acc + e.amount; }, 0);
  }

  // 传 Date，得到「2026年10月」这种规范月名；别和下面的 monthLabel（月名 → 「10 月」）混用
  function monthName(date) {
    return date.getFullYear() + '年' + String(date.getMonth() + 1).padStart(2, '0') + '月';
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function highlight(text) {
    var needle = state.search.trim();
    if (!needle || !text) return esc(text);
    var at = text.toLowerCase().indexOf(needle.toLowerCase());
    if (at === -1) return esc(text);
    return esc(text.slice(0, at)) + '<mark>' +
      esc(text.slice(at, at + needle.length)) + '</mark>' + esc(text.slice(at + needle.length));
  }

  var toastTimer;
  function toast(message, ok, action) {
    toastMsgEl.textContent = message;
    if (action) {
      toastActionEl.hidden = false;
      toastActionEl.textContent = action.label;
      toastActionEl.onclick = function () {
        toastActionEl.hidden = true;
        toastEl.className = 'toast';
        clearTimeout(toastTimer);
        action.run();
      };
    } else {
      toastActionEl.hidden = true;
      toastActionEl.onclick = null;
    }
    toastEl.className = 'toast show' + (ok === false ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, action ? 7000 : 2600);
  }

  var loadingCount = 0;
  function setLoading(on) {
    loadingCount += on ? 1 : -1;
    if (loadingCount < 0) loadingCount = 0;
    progressEl.classList.toggle('active', loadingCount > 0);
    refreshBtn.classList.toggle('spin', loadingCount > 0);
  }

  // ---------- Notion 直连 ----------
  function httpMessage(status, data) {
    if (status === 401) return '令牌无效或已失效，请点右上角设置重新填写集成令牌';
    if (status === 404) return '找不到该数据源或记录，请检查数据源 ID，以及页面是否已授权给这个集成';
    if (status === 429) return '请求太频繁，正在重试…';
    return (data && data.message) || ('Notion 接口返回 ' + status);
  }


  // ===== Notion API =====
  function notion(path, options, attempt) {
    options = options || {};
    attempt = attempt || 0;
    return fetch(API + path, {
      method: options.method || 'GET',
      headers: {
        'Authorization': 'Bearer ' + settings.token,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json'
      },
      body: options.body
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (e) { data = {}; }
        if (res.ok) return data;
        var err = new Error(httpMessage(res.status, data));
        err.retryable = res.status >= 500 || res.status === 429;
        throw err;
      });
    }).catch(function (err) {
      var retryable = err.retryable || err.name === 'TypeError';
      if (retryable && attempt < MAX_RETRY) {
        return sleep(500 * Math.pow(2, attempt)).then(function () {
          return notion(path, options, attempt + 1);
        });
      }
      if (err.name === 'TypeError') throw new Error('网络连接失败，请检查网络后重试');
      throw err;
    });
  }

  function selectOf(props, name) {
    var value = props[name] && props[name].select;
    return value ? value.name : null;
  }

  function normalize(page) {
    var props = page.properties;
    var title = (props['明细项'] && props['明细项'].title) || [];
    return {
      id: page.id,
      item: title.map(function (t) { return t.plain_text || ''; }).join(''),
      amount: (props['金额'] && props['金额'].number) || 0,
      category: selectOf(props, '分类'),
      sub: selectOf(props, '子类'),
      month: selectOf(props, '月份')
    };
  }

  function fetchAll() {
    var entries = [];
    function step(cursor) {
      var payload = { page_size: 100 };
      if (cursor) payload.start_cursor = cursor;
      return notion('/data_sources/' + settings.dataSourceId + '/query', {
        method: 'POST',
        body: JSON.stringify(payload)
      }).then(function (page) {
        entries = entries.concat((page.results || []).map(normalize));
        return page.has_more ? step(page.next_cursor) : entries;
      });
    }
    return step(null);
  }

  function buildProps(data) {
    // 明细项留空时传空数组，而不是空字符串的富文本
    var title = String(data.item || '').trim();
    var props = {
      '明细项': { title: title ? [{ text: { content: title } }] : [] }
    };
    if (data.amount !== null && data.amount !== undefined) {
      props['金额'] = { number: data.amount };
    }
    [['分类', 'category'], ['子类', 'sub'], ['月份', 'month']].forEach(function (pair) {
      var name = data[pair[1]];
      props[pair[0]] = { select: name ? { name: name } : null };
    });
    return props;
  }

  // ---------- 子类标签（数据源 schema） ----------
  function applyDataSource(ds) {
    var prop = (ds.properties || {})['子类'] || {};
    var sel = prop.select || {};
    state.subOptions = (sel.options || []).filter(function (o) { return o && o.name; })
      .map(function (o) { return { id: o.id, name: o.name }; });
    state.subDesc = prop.description || '';
  }

  function fetchSubOptions() {
    return notion('/data_sources/' + settings.dataSourceId).then(function (ds) {
      applyDataSource(ds);
      return state.subOptions;
    });
  }

  // 标签全集 = schema 选项 ∪ 条目里出现过的值（历史遗留值也要能管理）
  function subTagNames() {
    var names = [];
    state.subOptions.forEach(function (o) {
      if (names.indexOf(o.name) === -1) names.push(o.name);
    });
    state.entries.forEach(function (e) {
      if (e.sub && names.indexOf(e.sub) === -1) names.push(e.sub);
    });
    names.sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
    return names;
  }

  // select 选项只能整体替换：想保留的必须原样列出来，漏掉的就等于删除
  function putSubTagNames(names) {
    var byName = {};
    state.subOptions.forEach(function (o) { if (o.id) byName[o.name] = o; });
    var prop = {
      select: {
        options: names.map(function (n) {
          var hit = byName[n];
          return hit ? { id: hit.id } : { name: n };
        })
      }
    };
    if (state.subDesc) prop.description = state.subDesc;
    return notion('/data_sources/' + settings.dataSourceId, {
      method: 'PATCH',
      body: JSON.stringify({ properties: { '子类': prop } })
    }).then(function (ds) { applyDataSource(ds); });
  }

  // ---------- 本地缓存 ----------

  // ===== 本地缓存 =====
  function readCache() {
    try {
      var parsed = JSON.parse(localStorage.getItem(KEY_CACHE) || 'null');
      if (!parsed || !Array.isArray(parsed.entries)) return null;
      if (parsed.ds !== settings.dataSourceId) return null;
      return parsed;
    } catch (e) { return null; }
  }

  function writeCache() {
    try {
      localStorage.setItem(KEY_CACHE, JSON.stringify({
        ds: settings.dataSourceId,
        ts: Date.now(),
        entries: state.entries
      }));
    } catch (e) { /* 存储写满时忽略，不影响使用 */ }
  }

  // 财产数据缓存：跟账本同套路，刷新时总资产（含娱乐预算构成行）秒出。
  // 预算期初结余 + 逐月特殊收入计入/偶发加成一起缓存——构成行的推导链
  // 缺了任何一块，刷新瞬间就会先按残缺值算、再被网络数据纠正（数字跳变）
  function readAssetCache() {
    try {
      var parsed = JSON.parse(localStorage.getItem(KEY_ASSET_CACHE) || 'null');
      if (!parsed || !Array.isArray(parsed.assets)) return null;
      if (parsed.ds !== settings.assetsSourceId) return null;
      return parsed;
    } catch (e) { return null; }
  }

  function writeAssetCache() {
    try {
      localStorage.setItem(KEY_ASSET_CACHE, JSON.stringify({
        ds: settings.assetsSourceId,
        ts: Date.now(),
        assets: state.assets,
        budgetOpening: state.budgetOpening,
        budget: state.budget
      }));
    } catch (e) { /* 存储写满时忽略，不影响使用 */ }
  }

  // ---------- 分组 ----------

  // ===== 分组与筛选 =====
  function groupByMonth(entries) {
    var map = new Map();
    entries.forEach(function (e) {
      var key = e.month || UNSET_MONTH;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    });
    var named = [], rest = [];
    map.forEach(function (list, name) {
      (name === UNSET_MONTH ? rest : named).push({ name: name, list: list });
    });
    named.sort(function (a, b) { return a.name < b.name ? 1 : a.name > b.name ? -1 : 0; });
    return named.concat(rest);
  }

  function categoryRank(name) {
    var index = CATEGORY_ORDER.indexOf(name);
    if (index !== -1) return index;
    return name === UNSET_CATEGORY ? 99 : 60;
  }

  function groupByCategory(list) {
    var map = new Map();
    list.forEach(function (e) {
      var key = e.category || UNSET_CATEGORY;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    });
    var out = [];
    map.forEach(function (items, name) { out.push({ name: name, list: items }); });
    out.sort(function (a, b) { return categoryRank(a.name) - categoryRank(b.name); });
    return out;
  }

  function groupBySub(list) {
    var map = new Map();
    list.forEach(function (e) {
      var key = e.sub || UNSET_SUB;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    });
    var out = [];
    map.forEach(function (items, name) { out.push({ name: name, list: items }); });
    out.sort(function (a, b) {
      if (a.name === UNSET_SUB) return 1;
      if (b.name === UNSET_SUB) return -1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    return out;
  }

  function byAmount(a, b) {
    return Math.abs(b.amount) - Math.abs(a.amount) || a.item.localeCompare(b.item, 'zh-CN');
  }

  function visibleEntries() {
    var needle = state.search.trim().toLowerCase();
    if (!needle) return state.entries;
    return state.entries.filter(function (e) {
      return [e.item, e.category, e.sub, e.month, String(e.amount)]
        .filter(Boolean).join(' ').toLowerCase().indexOf(needle) !== -1;
    });
  }

  function isOpen(key) {
    if (state.search.trim()) return true;
    return !!state.expanded[key];
  }

  // 让某条记录在当前视图里看得见：展开它所在的路径，年份不在范围内就把年份切过去
  function expandPath(entry) {
    var month = entry.month || UNSET_MONTH;
    var category = entry.category || UNSET_CATEGORY;
    var sub = entry.sub || UNSET_SUB;
    ['m:' + month, 'c:' + month + '|' + category, 's:' + month + '|' + category + '|' + sub]
      .forEach(function (key) { state.expanded[key] = true; });
    focusYearOf(entry);
  }

  function focusYearOf(entry) {
    var y = yearOf(entry.month);
    var target = y === null ? CMP_OTHER : y;
    var years = cmpYears(state.entries);
    if (years.indexOf(target) === -1) return;
    var active = years.indexOf(state.cmpYear) !== -1 ? state.cmpYear : years[0];
    if (active === target) return;
    state.cmpYear = target;
    localStorage.setItem(KEY_CMP_YEAR, String(target));
  }

  // ---------- 对比视图 ----------
  function monthKey(name) {
    var m = /^(\d{4})年(\d{1,2})月$/.exec(name || '');
    return m ? Number(m[1]) * 100 + Number(m[2]) : 999999;  // 未标月份排到最后
  }

  function monthHead(name) {
    var m = /^(\d{4})年(\d{1,2})月$/.exec(name || '');
    if (!m) return '<span class="mo">' + esc(name) + '</span>';
    return '<span class="yr">' + m[1] + '</span><span class="mo">' + m[2] + '月</span>';
  }

  // 年界：月份能解析出年份才归到某一年，解析不出的单独一档
  function yearOf(name) {
    var m = /^(\d{4})年/.exec(name || '');
    return m ? Number(m[1]) : null;
  }

  // ---------- 月份区间 ----------
  // 起止都按「月号」算（1–12），落在哪一年由年份下拉决定；默认 1–12，即整年不筛
  function readRange() {
    var m = /^(\d{1,2})-(\d{1,2})$/.exec(localStorage.getItem(KEY_RANGE) || '');
    var a = m ? Number(m[1]) : 1, b = m ? Number(m[2]) : 12;
    a = Math.min(12, Math.max(1, a));
    b = Math.min(12, Math.max(1, b));
    return a <= b ? { from: a, to: b } : { from: b, to: a };
  }

  function monthNum(name) {
    var m = /^\d{4}年(\d{1,2})月$/.exec(name || '');
    return m ? Number(m[1]) : null;
  }

  // 只筛规范月名；「未标月份」这类解析不出月号的一律留着，不归区间管
  function inMonthRange(name) {
    var n = monthNum(name);
    return n === null || (n >= state.rangeFrom && n <= state.rangeTo);
  }

  // ---------- 锁定历史月份 ----------
  function readLocked() {
    return localStorage.getItem(KEY_LOCKED) !== '0';   // 默认锁上
  }

  function latestOf(months) {
    var best = null;
    months.forEach(function (name) {
      if (!name || yearOf(name) === null) return;
      if (best === null || monthKey(name) > monthKey(best)) best = name;
    });
    return best;
  }

  function latestEntryMonth() {
    return latestOf(state.entries.map(function (e) { return e.month; }));
  }

  function latestAssetMonth() {
    return latestOf(state.assets.map(function (a) { return a.month; }));
  }

  function latestBudgetMonth() {
    return latestOf(Object.keys(state.budget));
  }

  // 锁着的时候只有各域最新一个月能动，其余月份一律只读。
  // 三个域各看各的最新月：账本、财产、预算的进度不一样，不能用一个全局的最新月去卡
  function monthLocked(month, domain) {
    if (!state.locked) return false;
    var latest = domain === 'assets' ? latestAssetMonth()
      : domain === 'budget' ? latestBudgetMonth()
      : latestEntryMonth();
    return !!latest && monthKey(month) !== monthKey(latest);
  }

  // 点到锁住的历史月份时统一给一句提示，别让操作没反应
  function lockedToast() {
    toast('历史月份已锁定，解锁后可编辑', false);
  }

  // 顶栏那把锁：锁上/解开只动一个开关，图标和提示跟着状态走
  function syncLockButton() {
    if (!btnLockEl) return;
    btnLockEl.classList.toggle('active', state.locked);
    btnLockEl.setAttribute('aria-pressed', state.locked ? 'true' : 'false');
    btnLockEl.title = state.locked ? '已锁定历史月份，点击解锁' : '未锁定，点击锁定历史月份';
    var shackle = btnLockEl.querySelector ? btnLockEl.querySelector('#lock-shackle') : null;
    // 开着锁时把锁梁抬起一角，跟合上的锁一眼分得开
    if (shackle) shackle.setAttribute('d', state.locked
      ? 'M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7'
      : 'M5.5 7V5.2a2.5 2.5 0 0 1 5 0');
  }

  function setLocked(on) {
    state.locked = !!on;
    localStorage.setItem(KEY_LOCKED, state.locked ? '1' : '0');
    syncLockButton();
    render();
    toast(state.locked ? '已锁定历史月份，仅最新一个月可编辑' : '已解锁，所有月份都可编辑');
  }

  // 月份区间：起止都按 1–12 的月号存，跨年由年份下拉负责。
  // 起止反了就换过来，别让用户选出空区间
  function setRange(from, to) {
    var a = Math.min(12, Math.max(1, Number(from) || 1));
    var b = Math.min(12, Math.max(1, Number(to) || 12));
    if (a > b) { var t = a; a = b; b = t; }
    state.rangeFrom = a;
    state.rangeTo = b;
    localStorage.setItem(KEY_RANGE, a + '-' + b);
    render();
  }

  // 'm:2026年09月' / 'c:2026年09月|分类' / 's:2026年09月|分类|子类' → 月份
  function monthOfKey(key) {
    return (String(key).split(':')[1] || '').split('|')[0];
  }

  function entryMonthOf(id) {
    var hit = state.entries.filter(function (e) { return e.id === id; })[0];
    return hit ? (hit.month || UNSET_MONTH) : null;
  }

  function readCmpYear() {
    var raw = localStorage.getItem(KEY_CMP_YEAR);
    if (raw === CMP_OTHER) return CMP_OTHER;
    var n = Number(raw);
    return raw && isFinite(n) ? n : null;   // null = 跟随最新年份
  }

  function readCmpYear() {
    var raw = localStorage.getItem(KEY_CMP_YEAR);
    var n = parseInt(raw, 10);
    return raw && isFinite(n) ? n : null;   // null = 跟随最新年份
  }

  // 画廊里居中的月份：记着上次停在哪一张，重开还在那儿。
  // 统一后只有月度主 tab 一个画廊，记忆只留一份
  function galAt() { return state.galleryAt; }
  function galAtSet(name) {
    state.galleryAt = name;
    localStorage.setItem(KEY_GALLERY_AT, name);
  }
  function readGalleryAt() {
    return localStorage.getItem(KEY_GALLERY_AT) || null;
  }


  // ===== 对比视图 =====
  function cmpYears(entries) {
    var seen = {}, years = [], other = false;
    entries.forEach(function (e) {
      var y = yearOf(e.month);
      if (y === null) { other = true; return; }
      if (!seen[y]) { seen[y] = true; years.push(y); }
    });
    years.sort(function (a, b) { return b - a; });   // 新的年份排在前面
    if (other) years.push(CMP_OTHER);
    return years;
  }

  // 汇总只在一年的范围内做：先把条目裁到某一年，再按月份聚合
  function scopeToYear(entries, year) {
    return entries.filter(function (e) {
      var y = yearOf(e.month);
      return year === CMP_OTHER ? y === null : y === year;
    });
  }

  function monthValues(list, months) {
    return months.map(function (m) {
      return sum(list.filter(function (e) { return (e.month || UNSET_MONTH) === m; }));
    });
  }

  function sumArr(values) {
    return values.reduce(function (acc, v) { return acc + v; }, 0);
  }

  // 行 = 分类 + 子类两层，列 = 该年内的月份（正序，已按区间裁过）+ 合计
  function buildComparison(entries) {
    var seen = {}, months = [];
    entries.forEach(function (e) {
      var m = e.month || UNSET_MONTH;
      if (!seen[m]) { seen[m] = true; months.push(m); }
    });
    months.sort(function (a, b) { return monthKey(a) - monthKey(b); });
    months = months.filter(inMonthRange);

    var rows = groupByCategory(entries).map(function (cat) {
      var subs = cat.list.some(function (e) { return e.sub; })
        ? groupBySub(cat.list).map(function (s) {
            return { name: s.name, values: monthValues(s.list, months) };
          })
        : [];
      return { name: cat.name, values: monthValues(cat.list, months), subs: subs };
    });
    return { months: months, rows: rows };
  }

  function cmpCell(value) {
    if (!value) return '<span class="zero">—</span>';
    return '<span class="' + tone(value) + '">' + signed(value) + '</span>';
  }

  // 纠偏金额：把「补备注」的提示收进金额本身，不再占第二行、也不再摊一句文字。
  //   缺备注 → 金额右上角一颗小点，点一下就能写；
  //   有备注 → 金额下压一道虚线，悬停看全文、双击改。
  //   角标与气泡都绝对定位，宽度高度一律不占，行不会被撑开
  function adjustAmountHtml(value, monthName, spanCls, plain) {
    var note = adjustNoteOf(monthName);
    var needs = !note && value != null && Math.abs(value) > ADJUST_ALERT;
    var open = note && !plain;
    var classes = (spanCls ? spanCls + ' ' : '') + 'adj-amt ' + (value ? tone(value) : 'zero') +
      (open ? ' adj-has' : '');
    // 数字单独裹一层 .adj-num：角标相对「数字」的右上角定位，三处（详情/对比/画廊卡）才对得齐
    var num = value ? signed(value) : '—';
    if (!plain && needs) {
      num += '<button type="button" class="adj-mark" data-adjust-alert="' + esc(monthName) +
        '" aria-label="差额较大，点击补充备注"></button>';
    }
    var inner = '<span class="adj-num">' + num + '</span>';
    if (!plain) {
      if (note) inner += '<span class="tip">' + tipHtml([note]) + '</span>';
      else if (needs) inner += '<span class="tip">差额较大，点击补充备注</span>';
    }
    return '<span class="' + classes + '"' +
      (open ? ' data-adjust-open="' + esc(monthName) + '"' : '') + '>' + inner + '</span>';
  }

  // —— 跨视图共用的渲染零件：骨架只写一份，各处只报自己的数据 ——

  // 空状态提示：各视图文案不同，但都是同一颗 .cmp-hint
  function cmpHint(html) { return '<p class="cmp-hint">' + html + '</p>'; }

  // 对比/财产两张表都有「各月」列头：月份头拼接共用一份，不许各域再复制
  function cmpMonthHead(months) {
    return months.map(function (m) {
      return '<th class="cmp-month">' + monthHead(m) + '</th>';
    }).join('');
  }

  // 一键折叠/展开：渲染可折叠表时先登记该表的所有可折叠键（foldScopeKeys），
  // 按钮文案看有没有任一折叠：有→「全部展开」，无→「全部折叠」；
  // 动作作用于当前登记的那张表的全部可折叠行
  var foldScopeKeys = [];
  function setFoldScope(keys) { foldScopeKeys = keys || []; }
  function foldAllToggle() {
    var folded = foldScopeKeys.some(function (k) { return !!state.cmpCollapsed[k]; });
    foldScopeKeys.forEach(function (k) {
      if (folded) delete state.cmpCollapsed[k]; else state.cmpCollapsed[k] = true;
    });
    render();
  }

  // 就地编辑浮层：一或多行「标签 + 输入框」，账本/预算/财产三处共用这一份骨架
  function editorPanel(fields) {
    return '<span class="editor">' + fields.map(function (f) {
      return '<label><span>' + f.label + '</span><input type="' + f.type + '"' +
        (f.step ? ' step="' + f.step + '"' : '') +
        ' placeholder="' + f.placeholder + '" value="' + f.value + '"' +
        (f.attrs ? ' ' + f.attrs : '') + '></label>';
    }).join('') + '</span>';
  }

  // 纠偏备注的浮层：对比视图的纠偏格和月度详情的纠偏条目共用同一个字段
  function adjustNoteEditor() {
    return editorPanel([{ label: '备注', type: 'text', placeholder: '说明这笔差额的来源',
      value: esc(state.adjustEdit.draft), attrs: 'data-adjust-note="note"' }]);
  }

  // 月度详情的标题栏：返回 + 月份 + 锁定标记 + 各域自己的读数（readouts）。
  // 整条栏一次成型、自己闭合。早先它只吐开标签、要调用方补 </div> 收尾，
  // 漏补就会把下面的表格塞进 flex 栏里，整页散架——所以收尾这件事必须留在函数内
  function mdetailHead(name, locked, backTitle, readouts) {
    return '<div class="mdetail-bar">' +
      '<button type="button" class="icon-btn" data-gallery-back="1" title="' +
        esc(backTitle || '返回画廊') + '">' +
        '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" ' +
        'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M10 3.5 5.5 8 10 12.5"/></svg>' +
      '</button>' +
      '<span class="mdetail-name">' + esc(name) + '</span>' +
      (locked ? '<span class="lock-tag" title="仅最新一个月可编辑，点顶栏锁形按钮解锁">已锁定</span>' : '') +
      (readouts || '') +
    '</div>';
  }

  // 对比视图里的纠偏格：只放金额（角标/虚线挂在金额上）+ 悬停气泡，
  // 不再单开一行写备注，行高和列宽回到跟普通格子一样
  function cmpAdjustCell(monthName, value) {
    var editing = state.adjustEdit && state.adjustEdit.month === monthName;
    var note = adjustNoteOf(monthName);
    var cls = editing ? ' editing'
      : note ? ' has-note'
      : (value != null && Math.abs(value) > ADJUST_ALERT) ? ' needs-note' : '';
    var editor = editing ? adjustNoteEditor() : '';
    return '<td class="cmp-adj' + cls + '">' +
      adjustAmountHtml(value, monthName, '', editing) + editor +
    '</td>';
  }

  // 年份下拉改下拉选择：选项没变就不重建，免得每次 render 都把下拉框的焦点和展开状态弄丢
  function renderCmpBar(years, active) {
    cmpBarEl.hidden = !years.length;
    var sig = years.join(',') + '|' + active;
    if (cmpBarEl.dataset.sig === sig) return;
    cmpBarEl.dataset.sig = sig;
    cmpBarEl.innerHTML = years.length
      ? '<select class="year-select" title="年份">' +
          years.map(function (y) {
            return '<option value="' + esc(String(y)) + '"' + (y === active ? ' selected' : '') + '>' +
              (y === CMP_OTHER ? '未标月份' : y + ' 年') + '</option>';
          }).join('') + '</select>'
      : '';
  }

  // 月份区间条：全局常驻在第一行年份右侧，处处可见可改。
  // 同样按签名重建，避免重绘把弹层的开合和焦点弄丢
  function renderRangeBar(months, show) {
    rangeBarEl.hidden = !show;
    var sig = show ? state.rangeFrom + '-' + state.rangeTo + '|' + months.join(',') : '';
    if (rangeBarEl.dataset.sig === sig) return;
    rangeBarEl.dataset.sig = sig;
    // 重建意味着旧弹层已经不在 DOM 里了，开合状态跟着归零
    state.rangeOpen = false;
    state.rangeAnchor = null;
    state.rangeHover = null;
    rangeBarEl.innerHTML = show ? monthRangePick(months) : '';
  }

  // 月份条只摆「这一年真有数据的月份」：没数据的月份选了也是空表，摆上去只会让人白点一下。
  // 财产对比看财产数据源，其余视图看账本
  function rangeMonths(mode, year, yearEntries) {
    var names = mode === 'assets'
      ? assetMonths(year)
      : yearEntries.map(function (e) { return e.month || UNSET_MONTH; });
    var seen = {}, out = [];
    names.forEach(function (name) {
      var n = monthNum(name);
      if (n !== null && !seen[n]) { seen[n] = true; out.push(n); }
    });
    return out.sort(function (a, b) { return a - b; });
  }

  // 区间在胶囊上的写法：整年只说「全年」，单月说「8 月」，其余「7–9 月」
  function rangeLabel() {
    if (state.rangeFrom === 1 && state.rangeTo === 12) return '全年';
    return state.rangeFrom === state.rangeTo
      ? state.rangeFrom + ' 月'
      : state.rangeFrom + '–' + state.rangeTo + ' 月';
  }

  // 月份区间：一颗胶囊顶着当前区间，点开是一条月份条，两下成区间（点起、点止）。
  // 条上只铺这个视图真有数据的月份；弹层常驻 DOM，开合只翻 hidden，不整页重绘
  function monthRangePick(months) {
    var full = state.rangeFrom === 1 && state.rangeTo === 12;
    var cells = months.map(function (n) {
      return '<button type="button" class="rm" data-rm="' + n + '" aria-label="' + n + ' 月">' + n + '</button>';
    }).join('');
    return '<div class="range-pick">' +
      '<button type="button" class="range-btn" data-range-toggle aria-haspopup="true" aria-expanded="false">' +
        '<span class="range-text">' + esc(rangeLabel()) + '</span>' +
        '<svg class="range-caret" viewBox="0 0 12 12" width="10" height="10" fill="none" ' +
          'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M3 4.6 6 7.6 9 4.6"/></svg>' +
      '</button>' +
      '<div class="range-pop" data-range-pop hidden>' +
        '<div class="range-grid">' + cells + '</div>' +
        '<button type="button" class="range-all' + (full ? ' active' : '') + '" data-range-all>全年</button>' +
      '</div>' +
    '</div>';
  }

  // 月份条的高亮：点到一半时，铺「起点 → 鼠标」这一段的预览；成区间后铺已选的那段。
  // 整年时整条不铺——默认态就让它安安静静，免得 12 格全亮看不出重点
  function paintRange() {
    var full = state.rangeFrom === 1 && state.rangeTo === 12;
    var lo, hi, show = true;
    if (state.rangeAnchor !== null) {
      var h = state.rangeHover === null ? state.rangeAnchor : state.rangeHover;
      lo = Math.min(state.rangeAnchor, h);
      hi = Math.max(state.rangeAnchor, h);
    } else if (full) {
      show = false; lo = hi = 0;
    } else {
      lo = state.rangeFrom; hi = state.rangeTo;
    }
    var cells = document.querySelectorAll('[data-rm]');
    Array.prototype.forEach.call(cells, function (cell) {
      var n = Number(cell.dataset.rm);
      var on = show && n >= lo && n <= hi;
      cell.classList.toggle('in', on && n !== lo && n !== hi);
      cell.classList.toggle('edge', on && (n === lo || n === hi));
    });
  }

  function openRange() {
    state.rangeOpen = true;
    state.rangeAnchor = null;
    state.rangeHover = null;
    var pick = document.querySelector('.range-pick');
    var pop = document.querySelector('[data-range-pop]');
    var btn = document.querySelector('[data-range-toggle]');
    if (pick) pick.classList.add('open');
    if (pop) pop.hidden = false;
    if (btn) btn.setAttribute('aria-expanded', 'true');
    paintRange();
  }

  // 收起弹层，顺手把选到一半的锚点清掉；高亮退回已选区间
  function closeRange() {
    state.rangeOpen = false;
    state.rangeAnchor = null;
    state.rangeHover = null;
    var pick = document.querySelector('.range-pick');
    var pop = document.querySelector('[data-range-pop]');
    var btn = document.querySelector('[data-range-toggle]');
    if (pick) pick.classList.remove('open');
    if (pop) pop.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
    paintRange();
  }

  // entries 已经裁到某一年，这里只负责把该年的月份铺成列
  function renderCompare(entries, realNets) {
    var data = buildComparison(entries);
    // 汇总口径和「净额纠偏」行都得说明白：净额走的是财产差值，不是表内各分类之和
    pendingHint = compareHintText();
    if (!data.months.length) {
      // 搜索没匹配时交给全局那颗提示，别在这儿再说一遍「这一年还没有记账」
      if (state.search.trim()) return '';
      if (entries.length) {
        return cmpHint('该月份区间内没有记录。把「' + esc(rangeLabel()) +
          '」放宽，或在「月度」视图里补记。');
      }
      return cmpHint('这一年还没有记账。对比表按月份铺列，先在「月度」视图录入。');
    }

    var head = '<tr><th class="cmp-item"><span class="cell">项目</span></th>' +
      cmpMonthHead(data.months) +
      '<th class="cmp-total">合计</th></tr>';

    var body = data.rows.map(function (cat) {
      var key = 'c:' + cat.name;
      var hasSub = cat.subs.length > 0;
      var collapsed = hasSub && !!state.cmpCollapsed[key];
      var catRow = '<tr class="cmp-cat' + (hasSub ? ' is-toggle' : '') + '"' +
        (hasSub ? ' data-cmp-toggle="' + esc(key) + '"' : '') + '>' +
        '<th class="cmp-item"><span class="cell">' +
          '<span class="chev' + (collapsed ? '' : ' open') + (hasSub ? '' : ' ghost') + '"></span>' +
          '<span class="name">' + highlight(cat.name) + '</span>' +
        '</span></th>' +
        cat.values.map(function (v) { return '<td>' + cmpCell(v) + '</td>'; }).join('') +
        '<td class="cmp-total">' + cmpCell(sumArr(cat.values)) + '</td>' +
      '</tr>';

      var subRows = collapsed ? '' : cat.subs.map(function (sub) {
        return '<tr class="cmp-sub">' +
          '<th class="cmp-item"><span class="cell">' +
            '<span class="indent"></span>' +
            '<span class="name">' + highlight(sub.name) + '</span>' +
          '</span></th>' +
          sub.values.map(function (v) { return '<td>' + cmpCell(v) + '</td>'; }).join('') +
          '<td class="cmp-total">' + cmpCell(sumArr(sub.values)) + '</td>' +
        '</tr>';
      }).join('');

      return catRow + subRows;
    }).join('');

    // 分类有收有支，同一年内纵向加起来就是当月净额。
    // 财产覆盖到的月份改读真实净额（财产差值），跟顶栏那颗年度净额同一口径——
    // 不这么对齐，表里的净额合计就会比顶栏少掉一个纠偏
    var netValues = data.months.map(function (m, i) {
      var real = realNetOf(m, realNets);
      if (real !== null) return real;
      return sumArr(data.rows.map(function (r) { return r.values[i]; }));
    });
    // 纠偏行：账本净额跟真实净额的差额，只有财产覆盖到的月份才有值。
    // 摆在「净额」上面，这样表里读得通：分类合计 + 纠偏 = 净额
    var adjustValues = data.months.map(function (m, i) {
      var real = realNetOf(m, realNets);
      if (real === null) return 0;
      return real - sumArr(data.rows.map(function (r) { return r.values[i]; }));
    });
    var adjustRow = adjustValues.some(function (v) { return v; })
      ? '<tr class="cmp-adjust">' +
          '<th class="cmp-item"><span class="cell">' +
            '<span class="chev ghost"></span>' +
            '<span class="name">净额纠偏</span>' +
          '</span></th>' +
          data.months.map(function (m, i) { return cmpAdjustCell(m, adjustValues[i]); }).join('') +
          '<td class="cmp-total">' + cmpCell(sumArr(adjustValues)) + '</td>' +
        '</tr>'
      : '';

    var netRow = '<tr class="cmp-net">' +
      '<th class="cmp-item"><span class="cell"><span class="name">净额</span></span></th>' +
      netValues.map(function (v) { return '<td>' + cmpCell(v) + '</td>'; }).join('') +
      '<td class="cmp-total">' + cmpCell(sumArr(netValues)) + '</td>' +
    '</tr>';

    setFoldScope(data.rows.filter(function (r) { return r.subs.length > 0; })
      .map(function (r) { return 'c:' + r.name; }));
    return '<table class="cmp"><thead>' + head + '</thead><tbody>' +
      body + adjustRow + netRow + '</tbody></table>' +
      // 图跟表同视图、也同区间：两根柱就是表里每月的收入合计和支出合计
      '<div class="view-chart">' +
        chartCard('月度收入 / 支出', '', renderIncomeBars(entries.filter(function (e) {
          return inMonthRange(e.month || UNSET_MONTH);
        }), chartWidth())) +
      '</div>';
  }

  function setCmpYear(year) {
    state.cmpYear = year;
    localStorage.setItem(KEY_CMP_YEAR, String(year));
    render();
  }

  // 主 tab 只标「财产 / 收支 / 预算」，子 tab 标当前那一个

  // ===== 视图切换 =====
  // 子 tab 只在两处露：总览常显；月度点开某个月份后出现，切当月不同维度。
  // 月度画廊/搜索态只铺账本，子 tab 收着
  function syncViewButtons() {
    Array.prototype.forEach.call(document.querySelectorAll('#view-parent button'), function (btn) {
      btn.classList.toggle('active', btn.dataset.tab === state.view);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#view-sub button'), function (btn) {
      btn.classList.toggle('active', btn.dataset.sub === state.sub);
    });
    // 子 tab 只在两处露：总览常显；月度点开某个月份后出现。搜索态铺的是月份列表，
    // 也是账本单域，子 tab 一并收起
    document.getElementById('view-sub').hidden =
      state.view === 'month' && (!state.monthOpen || !!state.search.trim());
  }

  // 子视图不留状态：切走再回来一律从头开始——退出月份详情、丢掉正在进行的编辑/表单/确认，
  // 折叠态复原，画廊居中月份回到最新一个月，滚动位置归零。
  // 年份、月份区间、锁定是全局控件，不跟着重置
  function resetViewState() {
    state.monthOpen = null;
    state.editing = null;
    state.pendingDelete = null;
    state.budgetEdit = null;
    state.assetsEdit = null;
    state.assetNoteEdit = null;
    state.adjustEdit = null;
    state.tagEditing = null;
    state.tagConfirm = null;
    state.expanded = {};
    state.cmpCollapsed = {};
    // 画廊的「上次停在几月」连本地记忆一起清，刷新后回最新一个月
    state.galleryAt = null;
    localStorage.removeItem(KEY_GALLERY_AT);
    treeEl.scrollTop = 0;
    treeEl.scrollLeft = 0;
  }

  // 主 tab 切换（月度 / 总览）：子视图不留状态，全量重置，子 tab 回收支。
  // 主 tab 本身落盘，刷新后还停在这一级
  function setTab(tab) {
    var next = TABS.indexOf(tab) === -1 ? 'month' : tab;
    if (next !== state.view) resetViewState();
    state.view = next;
    state.sub = DEFAULT_SUB;
    state.hintOpen = false;   // 换视图就把说明收回去，默认不铺开
    closeRange();             // 月份区间弹层同理，别跨视图挂着
    syncViewButtons();
    render();
    treeEl.scrollTop = 0;     // innerHTML 换过之后滚动位置可能被保留，收尾再归零一次
    treeEl.scrollLeft = 0;
  }

  // 子 tab 切换（收支 / 财产 / 预算）：总览里清视图临时态；
  // 月度详情里保住当前月份——这是「切维度不丢月」的关键
  function setSub(sub) {
    var next = SUBS.indexOf(sub) === -1 ? DEFAULT_SUB : sub;
    if (next === state.sub) return;
    var keep = state.view === 'month' ? state.monthOpen : null;
    resetViewState();
    state.monthOpen = keep;
    state.sub = next;
    state.hintOpen = false;
    closeRange();
    // 收支详情默认把分类树摊开（跟从画廊直接进收支详情一致）；财产/预算详情是平表，没有折叠态
    if (next === 'income' && state.view === 'month' && state.monthOpen) {
      expandMonthByName(state.monthOpen);
    }
    syncViewButtons();
    render();
    treeEl.scrollTop = 0;
    treeEl.scrollLeft = 0;
  }

  // ---------- 娱乐预算 ----------
  // 数字后面跟着的那句说明，悬停时显示，双击时能改

  // ===== 预算视图 =====
  function richText(value) {
    return ((value && value.rich_text) || [])
      .map(function (t) { return t.plain_text || (t.text && t.text.content) || ''; }).join('');
  }

  function normalizeBudget(page) {
    var props = page.properties || {};
    var title = (props['月份'] && props['月份'].title) || [];
    var opening = props['期初结余'] && props['期初结余'].number;
    return {
      id: page.id,
      month: title.map(function (t) { return t.plain_text || ''; }).join(''),
      specialIn: (props['特殊收入计入'] && props['特殊收入计入'].number) || 0,
      noteSpecialIn: richText(props['特殊收入计入说明']),
      bonus: (props['偶发加成'] && props['偶发加成'].number) || 0,
      noteBonus: richText(props['偶发加成说明']),
      opening: opening === undefined ? null : opening
    };
  }

  function applyBudget(list) {
    var map = {};
    var opening = { id: null, amount: 0 };
    list.forEach(function (row) {
      // 带「期初结余」的那行是链条起点，不参与逐月滚动
      if (row.opening !== null) { opening = { id: row.id, amount: row.opening }; return; }
      if (row.month) map[row.month] = row;
    });
    state.budget = map;
    state.budgetOpening = opening;
  }

  function fetchBudget() {
    var rows = [];
    function step(cursor) {
      var payload = { page_size: 100 };
      if (cursor) payload.start_cursor = cursor;
      return notion('/data_sources/' + settings.budgetSourceId + '/query', {
        method: 'POST',
        body: JSON.stringify(payload)
      }).then(function (page) {
        rows = rows.concat((page.results || []).map(normalizeBudget));
        return page.has_more ? step(page.next_cursor) : rows;
      });
    }
    return step(null).then(function (list) { applyBudget(list); return list; });
  }

  function monthAt(name) {
    var m = /^(\d{4})年(\d{1,2})月$/.exec(name || '');
    return m ? Number(m[1]) * 100 + Number(m[2]) : null;
  }

  function holidayDays(monthName) {
    var m = /^(\d{4})年(\d{1,2})月$/.exec(monthName || '');
    if (!m) return 0;
    var table = HOLIDAY_DAYS[Number(m[1])];
    return (table && table[Number(m[2])]) || 0;
  }

  // 本月花销 = 「娱乐支出」分类合计 + 「特殊支出」分类的一半，取正数表示这个月从娱乐池子里花掉多少。
  // 别叫「娱乐支出」：那是账本里的分类名，这一列还混进了特殊支出的一半，同名会把两件事搅在一起
  // 两部分都带出来，悬停时拆给用户看
  function monthSpend(entries, monthName) {
    var list = entries.filter(function (e) { return e.month === monthName; });
    var fun = -sum(list.filter(function (e) { return e.category === '娱乐支出'; }));
    var special = -sum(list.filter(function (e) { return e.category === '特殊支出'; }));
    return {
      fun: fun,
      special: special,
      total: Math.round(fun + special * SPECIAL_SHARE)
    };
  }

  // 气泡里那几行：这笔花销由哪几块凑出来，一行一块
  function spendTip(s) {
    var lines = [];
    if (s.fun) lines.push('娱乐支出 ' + money(s.fun));
    if (s.special) lines.push('特殊支出 ' + money(s.special) + '/2');
    return lines;
  }

  // 说明里几笔钱用户习惯用「+」连着写，悬停时拆成一行一笔。
  // 加号紧跟数字的（如「生日 +500」）是正数符号不是分隔，别拆
  function noteLines(text) {
    return String(text).split(/\s*\+\s*(?=\D)/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s; });
  }

  // 气泡内容：每行单独转义，别让 .map 把数组下标也塞进 esc
  function tipHtml(lines) {
    return lines.map(function (l) { return esc(l); }).join('<br>');
  }

  // 从期初往后逐月滚：
  //   预算 = 1500 + 100 × 法定假日天数 + 上月结余 + 偶发加成
  //   结余 = 预算 − 本月花销 + 特殊收入计入
  function buildBudget(entries, year) {
    if (year === null || year === CMP_OTHER) return null;
    var startKey = monthAt(OPENING_MONTH);
    if (startKey === null) return null;

    var prev = state.budgetOpening.amount;
    var rows = [];
    for (var m = 1; m <= 12; m++) {
      if (year * 100 + m <= startKey) continue;
      var name = year + '年' + String(m).padStart(2, '0') + '月';
      var cfg = state.budget[name] || { id: null, specialIn: 0, bonus: 0 };
      var days = holidayDays(name);
      var budget = BUDGET_BASE + BUDGET_PER_HOLIDAY * days + prev + (cfg.bonus || 0);
      var spend = monthSpend(entries, name);
      var remain = budget - spend.total + (cfg.specialIn || 0);
      rows.push({ month: name, days: days, cfg: cfg, budget: budget,
                  spend: spend, remain: remain });
      prev = remain;
    }

    // 只铺到最后一个「有账或有手动值」的月份；再往后一个月单独当预告
    var lastReal = -1;
    rows.forEach(function (row, i) {
      var hasEntry = entries.some(function (e) { return e.month === row.month; });
      var hasCfg = (row.cfg.specialIn || 0) !== 0 || (row.cfg.bonus || 0) !== 0;
      if (hasEntry || hasCfg) lastReal = i;
    });
    if (lastReal === -1) return { rows: [], preview: null };
    return { rows: rows.slice(0, lastReal + 1), preview: rows[lastReal + 1] || null };
  }

  function monthLabel(name) {
    var m = /^\d{4}年(\d{1,2})月$/.exec(name);
    return m ? Number(m[1]) + ' 月' : name;
  }

  function budgetCell(value) {
    if (!value) return '<span class="zero">—</span>';
    return '<span class="' + tone(value) + '">' + signed(value) + '</span>';
  }

  // 一个预算格里有两个字段：数字 + 说明
  function budgetFieldNames(field) {
    return field === 'bonus'
      ? { num: '偶发加成', note: '偶发加成说明', noteKey: 'noteBonus' }
      : { num: '特殊收入计入', note: '特殊收入计入说明', noteKey: 'noteSpecialIn' };
  }

  // 平时是纯文本，有说明就带虚线下划线（悬停出气泡）；双击展开「数字 + 说明」小面板。
  // 锁着且不是最新月时加 .locked：双击照样认得出，只是会提示先解锁
  // withSign：单月推导链上每个数字都要带 +/− 号（链是「加多少、减多少」的算式），
  // 逐月表那边是并排的指标列，只报数不带号，所以默认不加
  function budgetInput(row, field, withSign) {
    var names = budgetFieldNames(field);
    var value = row.cfg[field] || 0;
    var note = row.cfg[names.noteKey] || '';
    var locked = monthLocked(row.month, 'budget');
    var editing = state.budgetEdit &&
      state.budgetEdit.month === row.month && state.budgetEdit.field === field;

    // 进项走收入色（红）：这两笔都是往池子里加钱
    var shown = '<span class="v ' + tone(value) + '">' +
      (value ? (withSign ? signed(value) : money(value)) : '<span class="zero">—</span>') + '</span>';

    if (editing) {
      return '<td class="cmp-edit editing">' + shown +
        editorPanel([
          { label: '数字', type: 'number', step: '1', placeholder: '0',
            value: value ? esc(String(value)) : '',
            attrs: 'data-budget="' + esc(row.month) + '" data-field="' + field + '"' },
          { label: '说明', type: 'text', placeholder: '这笔钱由什么组成，用 + 分隔',
            value: esc(note),
            attrs: 'data-budget-note="' + esc(row.month) + '" data-field="' + field + '"' }
        ]) + '</td>';
    }

    return '<td class="cmp-edit' + (note ? ' has-note' : '') + (locked ? ' locked' : '') + '"' +
      ' data-budget-open="' + esc(row.month) + '" data-field="' + field + '"' +
      '>' + shown + (note ? '<span class="tip">' + tipHtml(noteLines(note)) + '</span>' : '') + '</td>';
  }

  // 说明收进顶栏的「说明」按钮：点开在按钮下方浮出气泡。
  // 浮层脱离文档流，既不单占一行，也不会把下面的表格顶下去
  function renderHint(html) {
    hintWrapEl.hidden = !html;
    if (!html) {
      state.hintOpen = false;
      hintPopEl.hidden = true;
      btnHintEl.setAttribute('aria-expanded', 'false');
      return;
    }
    hintPopEl.innerHTML = html;
    hintPopEl.hidden = !state.hintOpen;
    btnHintEl.setAttribute('aria-expanded', state.hintOpen ? 'true' : 'false');
  }

  // 只翻气泡，不整页重绘——点一下说明不该让表格闪一下
  function hintToggle() {
    if (hintWrapEl.hidden) return;
    state.hintOpen = !state.hintOpen;
    hintPopEl.hidden = !state.hintOpen;
    btnHintEl.setAttribute('aria-expanded', state.hintOpen ? 'true' : 'false');
  }

  function budgetHintText() {
    return '<p><b>怎么算</b><br>' +
        '本月预算 = 1500 + 100 × 法定假日天数 + 上月结余 + 偶发加成<br>' +
        '本月结余 = 本月预算 − 本月花销 + 特殊收入计入<br>' +
        '本月花销 = 娱乐支出合计 + 特殊支出合计 ÷ 2' +
      '</p><p>' +
        '<b>口径</b>：法定假日按国家法定节假日天数（国庆算 3 天）；表尾虚线行是下月预告，只列预算与结余。' +
      '</p><p>' +
        '<b>怎么改</b>：双击「特殊收入计入」「偶发加成」改数字与说明；数字下带虚线的格子悬停看拆解。' +
      '</p><p>' +
        '<b>下方柱图</b>：每个月三根柱——本月预算、本月花销、本月结余，口径与上面那张表一致；' +
        '结余落在零线以上为有结余（红），以下为超支（绿）。' +
      '</p>';
  }

  function renderBudget(data, year, entries) {
    pendingHint = budgetHintText();
    if (!data || !data.rows.length) {
      if (state.search.trim()) return '';
      return cmpHint((year === null ? '还没有数据。' : year + '年还没有可推算的月份。') +
        '娱乐预算自 ' + esc(OPENING_MONTH) + ' 的结余起逐月推算，先在「月度」视图录入。');
    }

    // 总览›预算只摆逐月表 + 柱图，不再点进单月推导；推导详情只在月度视图里看
    var head = '<tr>' +
      '<th class="cmp-item"><span class="cell"><span class="name">月份</span></span></th>' +
      '<th>法定假日</th><th>特殊收入计入</th><th>偶发加成</th>' +
      '<th>本月预算</th><th>本月花销</th>' +
      '<th class="cmp-total">本月结余</th></tr>';

    var openingRow = '<tr class="cmp-open">' +
      '<th class="cmp-item"><span class="cell"><span class="name">' +
        esc(OPENING_MONTH.slice(5)) + ' 期初</span></span></th>' +
      '<td colspan="5">链条起点，之后每月往后累加</td>' +
      '<td class="cmp-total">' + budgetCell(state.budgetOpening.amount) + '</td></tr>';

    var body = data.rows.map(function (row) {
      return '<tr>' +
        // 月份格是普通文本格；偶发加成、特殊收入计入两格仍归双击编辑
        '<th class="cmp-item"><span class="cell"><span class="name">' +
          esc(monthLabel(row.month)) + '</span></span></th>' +
        '<td>' + (row.days ? row.days + ' 天' : '<span class="zero">—</span>') + '</td>' +
        budgetInput(row, 'specialIn') +
        budgetInput(row, 'bonus') +
        '<td>' + money(row.budget) + '</td>' +
        // 花销走支出色（绿），跟账本里负数支出一个颜色；悬停能看娱乐和特殊各占多少
        '<td class="cmp-spend">' + (row.spend.total
          ? '<span class="v neg">−' + money(row.spend.total) + '</span>' +
            '<span class="tip">' + tipHtml(spendTip(row.spend)) + '</span>'
          : '<span class="zero">—</span>') + '</td>' +
        '<td class="cmp-total">' + budgetCell(row.remain) + '</td>' +
      '</tr>';
    }).join('');

    // 下月预告：只有预算能算出来，还没花没记，所以只填「本月预算」和结余
    var previewRow = data.preview ? '<tr class="preview">' +
      '<th class="cmp-item"><span class="cell"><span class="name">' +
        esc(monthLabel(data.preview.month)) + ' 预告</span></span></th>' +
      '<td>' + (data.preview.days ? data.preview.days + ' 天' : '<span class="zero">—</span>') + '</td>' +
      '<td><span class="zero">—</span></td>' +
      '<td><span class="zero">—</span></td>' +
      '<td>' + money(data.preview.budget) + '</td>' +
      '<td><span class="zero">—</span></td>' +
      '<td class="cmp-total">' + money(data.preview.budget) + '</td></tr>' : '';

    // 表和图并在一屏：上面是逐月明细，下面是同一份数据的柱图，不另挂子 tab
    return '<table class="cmp budget"><thead>' + head + '</thead><tbody>' +
      openingRow + body + previewRow + '</tbody></table>' +
      '<div class="charts">' +
        chartCard('预算 · 花销 · 结余', budgetSub(data), renderBudgetBars(data, chartWidth())) +
      '</div>';
  }

  // 预算推导里某个月在第几行：月度主 tab 的「预算」维度直接按行渲染，先定位
  function budgetMonthIndex(data, month) {
    if (!data) return -1;
    for (var i = 0; i < data.rows.length; i++) {
      if (data.rows[i].month === month) return i;
    }
    return -1;
  }

  // 单月预算详情：把「这个月的预算从哪来、花到哪去」摊成一条推导链，
  // 下面接该月「娱乐支出」的实际条目，读数能落回具体账目。
  // 链条上的偶发加成、特殊收入计入就是逐月表里那两格，沿用同一套就地编辑
  function renderBudgetMonth(data, idx, entries, backTitle) {
    var row = data.rows[idx];
    // 上月结余：链条上个月的结余，头一个月从期初起算，跟 buildBudget 的滚动一致
    var prevRemain = idx === 0 ? state.budgetOpening.amount : data.rows[idx - 1].remain;
    var spend = row.spend;
    var half = Math.round(spend.special * SPECIAL_SHARE);
    var dash = '<span class="zero">—</span>';
    var items = entries.filter(function (e) {
      return e.month === row.month && e.category === '娱乐支出';
    });
    pendingHint = budgetMonthHintText(row.month);

    // 链上的一行：项目 + 金额，金额列沿用合计列的右对齐与等宽数字
    function chainRow(label, value, cls) {
      return '<tr' + (cls ? ' class="' + cls + '"' : '') + '>' +
        '<th class="cmp-item"><span class="cell"><span class="name">' + esc(label) + '</span></span></th>' +
        '<td class="cmp-total">' + value + '</td></tr>';
    }
    function inputRow(label, field) {
      return '<tr><th class="cmp-item"><span class="cell"><span class="name">' + esc(label) + '</span></span></th>' +
        budgetInput(row, field, true) + '</tr>';
    }
    // 链上每一行都是「往池子里加多少 / 从池子里减多少」，颜色跟着方向走：
    // 加项走收入红、减项走支出绿，连小计行（本月预算/本月花销/本月结余）也照这个来。
    // 红绿黑混排最乱——同一列里不许有不上色的数字，也不许有的带 + 有的不带
    function addRow(label, n, cls) {
      return chainRow(label,
        n ? '<span class="' + tone(n) + '">' + signed(n) + '</span>' : dash, cls);
    }
    function subRow(label, n, cls) {
      return chainRow(label, n ? '<span class="neg">−' + money(n) + '</span>' : dash, cls);
    }
    // 结果行按自身正负上色：结余可能为负，不能一律当加项画红
    function netRow(label, n) {
      return chainRow(label,
        n ? '<span class="' + tone(n) + '">' + signed(n) + '</span>' : dash, 'cmp-net');
    }

    return '<div class="mdetail">' +
      mdetailHead(row.month, monthLocked(row.month, 'budget'), backTitle || '返回逐月表',
        '<span class="mdetail-io">' +
          '<span>预算 <b>' + money(row.budget) + '</b></span>' +
          '<span>花销 <b class="neg">−' + money(spend.total) + '</b></span>' +
        '</span>' +
        '<span class="spacer"></span>' +
        '<span class="mdetail-net ' + tone(row.remain) + '">结余 ' + signed(row.remain) + '</span>') +

      '<table class="cmp budget bmonth"><thead><tr>' +
        '<th class="cmp-item"><span class="cell"><span class="name">' +
          esc(monthLabel(row.month)) + ' 推导</span></span></th>' +
        '<th class="cmp-total">金额</th></tr></thead><tbody>' +
        addRow('基础额度', BUDGET_BASE) +
        addRow('法定假日' + (row.days ? ' ' + row.days + ' 天' : ''),
          row.days ? BUDGET_PER_HOLIDAY * row.days : 0) +
        addRow('上月结余', prevRemain) +
        inputRow('偶发加成', 'bonus') +
        // 本月预算 = 上面四项之和，跟加项同一个方向色，读起来就是「这几笔攒出这个数」
        addRow('本月预算', row.budget, 'cmp-net') +
        subRow('娱乐支出', spend.fun) +
        // 特殊支出只有一半算进花销，数字下挂一道虚线，悬停拆给用户看
        (spend.special
          ? '<tr><th class="cmp-item"><span class="cell"><span class="name">特殊支出 ÷2</span></span></th>' +
            '<td class="cmp-spend"><span class="v neg">−' + money(half) + '</span>' +
            '<span class="tip">特殊支出 ' + money(spend.special) + '/2</span></td></tr>'
          : chainRow('特殊支出 ÷2', dash)) +
        subRow('本月花销', spend.total, 'cmp-net') +
        inputRow('特殊收入计入', 'specialIn') +
        netRow('本月结余', row.remain) +
      '</tbody></table>' +

      '<table class="cmp budget bitems"><thead><tr>' +
        '<th class="cmp-item"><span class="cell"><span class="name">本月娱乐支出</span></span></th>' +
        '<th class="cmp-total">金额</th></tr></thead><tbody>' +
        (items.length
          ? items.map(function (e) {
              return '<tr>' +
                '<th class="cmp-item"><span class="cell"><span class="name">' + esc(e.item) + '</span></span></th>' +
                // 跟账本里同一笔的口径一致：金额按正负上色（支出绿）
                '<td class="cmp-total"><span class="' + tone(e.amount) + '">' +
                  signed(e.amount) + '</span></td></tr>';
            }).join('') +
            subRow('合计', spend.fun, 'cmp-net')
          : chainRow('本月没有娱乐支出', dash)) +
      '</tbody></table>' +
    '</div>';
  }

  function budgetMonthHintText(month) {
    return '<p><b>是什么</b><br>' +
        '把 ' + esc(monthLabel(month)) + ' 的预算摊开：上半张是从期初往后滚出来的推导链，' +
        '下半张是本月「娱乐支出」的实际条目。点左上角返回。' +
      '</p><p><b>怎么算</b><br>' +
        '本月预算 = 1500 + 100 × 法定假日天数 + 上月结余 + 偶发加成<br>' +
        '本月结余 = 本月预算 − 本月花销 + 特殊收入计入<br>' +
        '本月花销 = 娱乐支出合计 + 特殊支出合计 ÷ 2' +
      '</p><p><b>怎么改</b><br>' +
        '「偶发加成」「特殊收入计入」两行双击就地改，数字与说明一起提交。' +
        '这两项之外都是从账本推出来的，要改数字请回「月度」视图改账。' +
      '</p>';
  }

  // 顶栏读数取「下一个月」的预算：表尾那条预告行的预算就是下月可花的数，
  // 比回头看上月结余更贴预算视图要回答的问题
  function nextBudget(data) {
    return data && data.preview ? data.preview.budget : null;
  }

  // 双击预算格才进编辑态
  function startBudgetEdit(month, field) {
    if (monthLocked(month, 'budget')) return lockedToast();
    var row = state.budget[month];
    var names = budgetFieldNames(field);
    // 草稿先记下来，等焦点离开整个小面板再一次性比对、写回
    state.budgetEdit = {
      month: month, field: field,
      draft: {
        num: row ? (row[field] || 0) : 0,
        note: (row && row[names.noteKey]) || ''
      }
    };
    render();
    var input = typeof treeEl.querySelector === 'function'
      ? treeEl.querySelector('input[data-budget]') : null;
    if (!input) return;
    input.focus();
    input.select();
  }

  // 焦点离开小面板时收尾：只有真改过的字段才发请求
  function commitBudgetEditor() {
    var edit = state.budgetEdit;
    if (!edit) return;
    state.budgetEdit = null;

    var names = budgetFieldNames(edit.field);
    var row = state.budget[edit.month] ||
      { id: null, specialIn: 0, bonus: 0, noteSpecialIn: '', noteBonus: '' };
    var raw = String(edit.draft.num).trim();
    var num = raw === '' ? 0 : Number(raw);
    if (!isFinite(num)) num = 0;
    var note = String(edit.draft.note || '').trim();

    var props = {};
    if ((row[edit.field] || 0) !== num) props[names.num] = { number: num };
    if ((row[names.noteKey] || '') !== note) {
      props[names.note] = { rich_text: note ? [{ text: { content: note } }] : [] };
    }
    if (!Object.keys(props).length) return render();
    saveBudget(edit.month, props);
  }

  function saveBudget(month, props) {
    var row = state.budget[month];
    var snapshot = row ? Object.assign({}, row) : null;
    // 先落本地再发请求，免得往返期间闪回旧值；失败整体回滚
    state.budget[month] = Object.assign(
      { id: row ? row.id : null, month: month, specialIn: 0, bonus: 0,
        noteSpecialIn: '', noteBonus: '' }, row || {});
    for (var name in props) {
      if (name === '偶发加成') state.budget[month].bonus = props[name].number;
      else if (name === '特殊收入计入') state.budget[month].specialIn = props[name].number;
      else if (name === '偶发加成说明') state.budget[month].noteBonus = richText(props[name]);
      else if (name === '特殊收入计入说明') state.budget[month].noteSpecialIn = richText(props[name]);
    }
    state.budgetEdit = null;
    render();

    var request = row && row.id
      ? notion('/pages/' + row.id, { method: 'PATCH', body: JSON.stringify({ properties: props }) })
      : notion('/pages', {
          method: 'POST',
          body: JSON.stringify({
            parent: { type: 'data_source_id', data_source_id: settings.budgetSourceId },
            properties: Object.assign(
              { '月份': { title: [{ text: { content: month } }] } }, props)
          })
        });

    return request.then(function (page) {
      var saved = normalizeBudget(page);
      if (saved.opening === null) state.budget[month] = saved;
      render();
    }).catch(function (err) {
      if (snapshot) state.budget[month] = snapshot;
      else delete state.budget[month];
      render();
      toast(err.message, false);
    });
  }

  // ---------- 我的财产 ----------
  // 每月一笔资产快照，只记月末余额（月初就是上个月的月末，不重复存）。
  // 「公积金」那部分取不出来，看「能动的钱」时得剔掉，所以两个总计都给：含公积金、不含公积金。
  var ASSET_APP_ORDER = ['招商银行', '支付宝', '微信', '公积金', '证券'];
  var ASSET_RESERVED = '公积金';


  // ===== 财产视图 =====
  function normalizeAsset(page) {
    var props = page.properties || {};
    var title = (props['类型'] && props['类型'].title) || [];
    function sel(name) {
      return (props[name] && props[name].select && props[name].select.name) || '';
    }
    function num(name) {
      var v = props[name] && props[name].number;
      return v === undefined ? null : v;
    }
    return {
      id: page.id,
      name: title.map(function (t) { return t.plain_text || ''; }).join(''),
      month: sel('月份'),
      app: sel('应用'),
      end: num('月末'),
      note: richText(props['备注'])
    };
  }

  function fetchAssets() {
    var rows = [];
    function step(cursor) {
      var payload = { page_size: 100 };
      if (cursor) payload.start_cursor = cursor;
      return notion('/data_sources/' + settings.assetsSourceId + '/query', {
        method: 'POST',
        body: JSON.stringify(payload)
      }).then(function (page) {
        rows = rows.concat((page.results || []).map(normalizeAsset));
        return page.has_more ? step(page.next_cursor) : rows;
      });
    }
    return step(null).then(function (list) { state.assets = list; return list; });
  }

  // 这一年里真正有记录的月份，正序
  function assetMonths(year) {
    var seen = {}, months = [];
    state.assets.forEach(function (a) {
      if (!a.month || !a.name) return;
      var y = yearOf(a.month);
      if (year !== null && year !== CMP_OTHER && y !== year) return;
      if (year === CMP_OTHER && y !== null) return;
      if (!seen[a.month]) { seen[a.month] = true; months.push(a.month); }
    });
    months.sort(function (a, b) { return monthKey(a) - monthKey(b); });
    return months;
  }

  function columnSums(items, count) {
    var out = [];
    for (var i = 0; i < count; i++) {
      out.push(items.reduce(function (acc, it) {
        var v = it.values[i];
        return acc + (v === null || v === undefined ? 0 : v);
      }, 0));
    }
    return out;
  }

  // 某个资产项当前的备注。各月记录里存的是同一份，写的时候整项一起写；
  // 万一历史数据不一致，就取最新那个月里的非空值，别让某月漏填把整项盖成空
  function assetItemNote(app, name) {
    var rows = state.assets.filter(function (a) {
      return a.app === app && a.name === name;
    }).sort(function (a, b) { return monthKey(a.month) - monthKey(b.month); });
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i].note) return rows[i].note;
    }
    return '';
  }

  function buildAssets(year) {
    var months = assetMonths(year);
    if (!months.length) return { months: [], groups: [], totals: [] };

    // 同一个「应用 + 类型」在各月各有一条记录，按月份攒成一行
    var index = {};
    state.assets.forEach(function (a) {
      if (months.indexOf(a.month) === -1 || !a.name) return;
      var key = a.app + '|' + a.name;
      var item = index[key] || (index[key] = { app: a.app, name: a.name, byMonth: {} });
      item.byMonth[a.month] = { id: a.id, end: a.end, note: a.note || '' };
    });

    var items = Object.keys(index).map(function (k) {
      var it = index[k];
      var cells = months.map(function (m) { return it.byMonth[m] || null; });
      return {
        app: it.app,
        name: it.name,
        // 备注属于资产项，不属于某个月：各月记录里存的是同一份，
        // 展示和预填都走同一个取值口，免得两边对不上
        note: assetItemNote(it.app, it.name),
        // 每列对应的那条记录（没有就是 null），就地编辑要拿它的 id 和原值
        cells: cells,
        values: cells.map(function (c) { return c ? c.end : null; })
      };
    });

    // 应用按固定顺序排；没列进去的排最后，免得新加的账户漏掉
    var apps = ASSET_APP_ORDER.filter(function (app) {
      return items.some(function (it) { return it.app === app; });
    });
    items.forEach(function (it) {
      if (apps.indexOf(it.app) === -1) apps.push(it.app);
    });

    var last = months.length - 1;
    var groups = apps.map(function (app) {
      var list = items.filter(function (it) { return it.app === app; })
        .sort(function (x, y) {
          // 组内按最新一个月从大到小，大头排前面；再按名字定个稳定次序
          return (y.values[last] || 0) - (x.values[last] || 0) ||
            (x.name < y.name ? -1 : 1);
        });
      return { app: app, items: list, values: columnSums(list, months.length) };
    });

    return {
      months: months,
      groups: groups,
      totals: [
        { label: '总资产', values: columnSums(items, months.length) },
        { label: '总资产（不含公积金）', values: columnSums(items.filter(function (it) {
            return it.app !== ASSET_RESERVED;
          }), months.length) }
      ]
    };
  }

  // 把整年的财产数据裁到月份区间。buildAssets 始终算整年——账本的真实净额、新增月份
  // 都要看全年，不能跟着视图的区间一起缩水；这里只裁「要铺出来的那几列」
  function sliceAssets(data) {
    var idx = [];
    data.months.forEach(function (m, i) { if (inMonthRange(m)) idx.push(i); });
    if (idx.length === data.months.length) return data;   // 整年，原样返回
    function pick(arr) { return idx.map(function (i) { return arr[i]; }); }
    return {
      months: pick(data.months),
      groups: data.groups.map(function (g) {
        return {
          app: g.app,
          values: pick(g.values),
          items: g.items.map(function (it) {
            return { app: it.app, name: it.name, note: it.note,
                     cells: pick(it.cells), values: pick(it.values) };
          })
        };
      }),
      totals: data.totals.map(function (t) { return { label: t.label, values: pick(t.values) }; })
    };
  }

  function assetNum(value) {
    return value === null || value === undefined
      ? '<span class="zero">—</span>' : money(value);
  }

  // 环比小字：这个月比上个月多/少了多少，涨红跌绿跟账本一个规矩。
  // 首月没有上个月可比，整行留空；缺数或没变化就用「—」占位，行高才齐
  function assetDeltaLine(value, prev, isFirst) {
    if (isFirst) return '';
    var d = (value === null || value === undefined ||
             prev === null || prev === undefined) ? null : value - prev;
    if (d === null || !d) return '<span class="d zero">—</span>';
    return '<span class="d ' + tone(d) + '">' + signed(d) + '</span>';
  }

  // 月份格：上面是那个月的月末余额，下面挂环比小字
  function assetMonthCell(value, prev, isFirst) {
    if (value === null || value === undefined) return '<td><span class="zero">—</span></td>';
    return '<td><span class="v">' + money(value) + '</span>' +
      assetDeltaLine(value, prev, isFirst) + '</td>';
  }

  // 一行里所有月份格：余额 + 该月环比，首月只显余额
  function assetMonthCells(values) {
    return values.map(function (v, i) {
      return assetMonthCell(v, i ? values[i - 1] : null, i === 0);
    }).join('');
  }

  // 明细格：平时只显月末 + 环比小字，双击展开输入框就地改。
  // 备注不在这儿——它属于资产项，挂在首列的名字上。
  // locked 是「这个月不在可编辑范围里」（锁着且不是最新月）：保留 data-* 好让点击给出提示，
  // 但加 .locked 把「可编辑」的悬停线索撤掉，看起来就知道动不了
  function assetCell(cell, prev, isFirst, locked) {
    if (!cell) return '<td><span class="zero">—</span></td>';
    var line = assetDeltaLine(cell.end, prev ? prev.end : null, isFirst);
    var shown = '<span class="v">' + assetNum(cell.end) + '</span>';
    if (state.assetsEdit && state.assetsEdit.id === cell.id) {
      return '<td class="cmp-edit editing">' + shown + line +
        editorPanel([{ label: '月末', type: 'number', step: '1', placeholder: '0',
          value: cell.end === null || cell.end === undefined ? '' : esc(String(cell.end)),
          attrs: 'data-asset-num="end"' }]) + '</td>';
    }
    return '<td class="cmp-edit' + (locked ? ' locked' : '') + '" data-asset-open="' + esc(cell.id) + '">' +
      shown + line + '</td>';
  }

  // 资产项的名字：备注是这一项维度的，所以虚线和气泡都挂在名字上，
  // 双击名字进编辑，写一次就同步到它在各月的记录
  function assetNameCell(item) {
    if (state.assetNoteEdit &&
        state.assetNoteEdit.app === item.app && state.assetNoteEdit.name === item.name) {
      return '<span class="indent"></span>' +
        '<span class="name">' + esc(item.name) + '</span>' +
        editorPanel([{ label: '备注', type: 'text', placeholder: '如「重点关注」',
          value: esc(state.assetNoteEdit.draft), attrs: 'data-asset-note="note"' }]);
    }
    return '<span class="indent"></span>' +
      '<span class="name asset-note' + (item.note ? ' has-note' : '') + '"' +
        ' data-asset-note-app="' + esc(item.app) + '"' +
        ' data-asset-note-name="' + esc(item.name) + '">' +
        esc(item.name) + '</span>' +
      (item.note ? '<span class="tip">' + esc(item.note) + '</span>' : '');
  }

  // 一键折叠/展开按钮住在子 tab 右侧，只服务两张可折叠的表（收支对比 / 财产对比）。
  // 文案跟着折叠态走：还有行收着就是「全部展开」，全开就是「全部折叠」
  function renderViewBar(mode) {
    var isAssets = mode === 'assets';
    var isCompare = mode === 'compare';
    btnFoldAllEl.hidden = !(isAssets || isCompare);
    btnFoldAllEl.textContent =
      foldScopeKeys.some(function (k) { return !!state.cmpCollapsed[k]; })
        ? '全部展开' : '全部折叠';
    // 导出按钮：月度详情态（当前月已打开）可用，三个子 tab 都能导当前月的理财快照
    btnExportEl.hidden = !(state.view === 'month' && state.monthOpen && !state.search.trim());
  }

  function assetsHintText() {
    return '<p><b>读数</b>：格内是当月月末余额，下方小字是较上月的增减。' +
      '</p><p>' +
        '<b>两个总计</b>：「含公积金」把公积金账户一并计入，「不含公积金」只计可用资金，两行并列。' +
      '</p><p>' +
        '<b>怎么改</b>：双击格子改月末余额；双击资产项名称写备注，一次修改同步到该项各月。' +
      '</p>' +
      '<p><b>怎么增</b>：新增月份和新增资产项在 Notion 端维护，页面只就地改数。</p>';
  }

  // 财产 › 对比：并进这一屏的两张图分别讲什么、口径如何
  function assetChartsHintText() {
    return '<p><b>总资产走势</b>：按月末余额逐月连线，两条线分别是「含公积金」与「不含公积金」。' +
      '</p><p>' +
        '<b>各应用占比</b>：取最后一个月的月末余额，按应用拆分，环形中心为含公积金的总资产。' +
      '</p><p>' +
        '<b>区间</b>：两张图都跟随上方的月份区间；点年份胶囊可切换年份。' +
      '</p>';
  }

  function renderAssets(year, budgetNext) {
    state.assetsYear = year;
    pendingHint = assetsHintText();
    var full = buildAssets(year);
    var data = sliceAssets(full);
    if (!data.months.length) {
      if (state.search.trim()) return '';
      if (full.months.length) {
        return cmpHint('该月份区间内没有财产记录。把「' + esc(rangeLabel()) +
          '」放宽即可看到其余月份。');
      }
      return cmpHint((year === null ? '还没有财产数据。' : year + '年还没有财产记录。') +
        '财产来自独立的「我的财产」数据源，新增在 Notion 端维护。');
    }

    // 锁着的时候只有最新一个月那列能动，其余列整列置灰
    var lockedCols = data.months.map(function (m) { return monthLocked(m, 'assets'); });

    var head = '<tr>' +
      '<th class="cmp-item"><span class="cell"><span class="name">资产项</span></span></th>' +
      cmpMonthHead(data.months) +
      '</tr>';

    var body = data.groups.map(function (g) {
      // 分组行可折叠，跟收支对比的分类行同一套 data-cmp-toggle 机制；
      // 键前缀 a: 与对比表的 c: 分开，互不干扰
      var hasItems = g.items.length > 0;
      var gkey = 'a:' + g.app;
      var collapsed = hasItems && !!state.cmpCollapsed[gkey];
      var groupRow = '<tr class="cmp-cat' + (hasItems ? ' is-toggle' : '') + '"' +
        (hasItems ? ' data-cmp-toggle="' + esc(gkey) + '"' : '') + '>' +
        '<th class="cmp-item"><span class="cell">' +
          '<span class="chev' + (collapsed ? '' : ' open') + (hasItems ? '' : ' ghost') + '"></span>' +
          '<span class="name">' + esc(g.app) + '</span>' +
        '</span></th>' +
        assetMonthCells(g.values) +
      '</tr>';

      var itemRows = collapsed ? '' : g.items.map(function (it) {
        return '<tr class="cmp-sub">' +
          '<th class="cmp-item' + (state.assetNoteEdit &&
            state.assetNoteEdit.app === it.app && state.assetNoteEdit.name === it.name
            ? ' editing' : '') + '"><span class="cell">' +
            assetNameCell(it) +
          '</span></th>' +
          it.cells.map(function (c, i) {
            return assetCell(c, i ? it.cells[i - 1] : null, i === 0, lockedCols[i]);
          }).join('') +
        '</tr>';
      }).join('');

      return groupRow + itemRows;
    }).join('');

    var sumRows = data.totals.map(function (t) {
      return '<tr class="assets-sum">' +
        '<th class="cmp-item"><span class="cell"><span class="name">' + esc(t.label) +
        '</span></span></th>' +
        assetMonthCells(t.values) +
      '</tr>';
    }).join('');
    // 总资产也拆「娱乐预算」：跟月份卡片构成行同一口径（总资产 − 下月娱乐预算），
    // 预算推导不出下月时（null）就不加这行
    if (budgetNext !== null) {
      sumRows += '<tr class="assets-sum">' +
        '<th class="cmp-item"><span class="cell"><span class="name">总资产（不含娱乐预算）</span></span></th>' +
        assetMonthCells(data.totals[0].values.map(function (v) {
          return v === null ? null : v - budgetNext;
        })) +
      '</tr>';
    }

    // 明细和图表并在一屏里：上面铺表，下面两张图跟着同一份月份区间
    var charts = renderAssetCharts(year);
    pendingHint = assetsHintText() + assetChartsHintText();
    setFoldScope(data.groups.filter(function (g) { return g.items.length > 0; })
      .map(function (g) { return 'a:' + g.app; }));
    return '<table class="cmp assets"><thead>' + head + '</thead><tbody>' +
      body + sumRows + '</tbody></table>' + charts;
  }

  // ---------- 财产月度：画廊 + 当月详情 ----------

  // 某个月某个口径的总计：直接从原始记录累加，不受年份与月份区间的裁剪影响
  function assetTotalOf(month, caliber) {
    return state.assets.reduce(function (acc, a) {
      if (a.month !== month || !a.name) return acc;
      if (caliber === '不含公积金' && a.app === ASSET_RESERVED) return acc;
      return acc + (a.end === null || a.end === undefined ? 0 : a.end);
    }, 0);
  }

  // 上一个月名：月初就是它的月末
  function prevMonthName(label) {
    var m = /^(\d{4})年(\d{1,2})月$/.exec(String(label || ''));
    if (!m) return null;
    var y = Number(m[1]), mo = Number(m[2]) - 1;
    if (mo < 1) { mo = 12; y -= 1; }
    return y + '年' + String(mo).padStart(2, '0') + '月';
  }

  // 当月每一项的月初/月末：月初取上一个月的月末。只在上月或本月有记录时才列出来
  function assetMonthRows(month) {
    var prev = prevMonthName(month);
    var index = {};
    state.assets.forEach(function (a) {
      if (!a.name) return;
      if (a.month !== month && a.month !== prev) return;
      var key = a.app + '|' + a.name;
      var it = index[key] || (index[key] = {
        app: a.app, name: a.name, start: null, end: null, id: null
      });
      if (a.month === prev) it.start = a.end;
      else { it.end = a.end; it.id = a.id; }
    });
    return Object.keys(index).map(function (k) {
      var it = index[k];
      it.note = assetItemNote(it.app, it.name);
      return it;
    });
  }

  function assetSumOf(rows, field) {
    return rows.reduce(function (acc, r) {
      var v = r[field];
      return acc + (v === null || v === undefined ? 0 : v);
    }, 0);
  }

  // 只读格：月初不给改——它就是上个月的月末，改这里等于改历史
  function assetStaticCell(value) {
    return '<td class="cmp-static">' + assetNum(value) + '</td>';
  }

  function assetMonthHintText() {
    return '<p><b>这是什么</b>：一张卡一个月，卡面是当月总资产（含公积金），下面一行拆成「不含公积金」和「公积金」两项，两者相加就是卡面那个数。</p>' +
      '<p>' +
        '<b>点开看什么</b>：当月每个资产项的月初（上个月月末）与月末并列，末尾是分布饼图。' +
      '</p><p>' +
        '<b>怎么改</b>：双击「月末」改当月余额；月初只读，它跟着上个月的月末走。' +
      '</p><p>' +
        '<b>新建</b>：滑到末尾的「新增月份」，照上个月铺一份，金额留空待填。' +
      '</p>';
  }

  function renderAssetMonthDetail(month, budgetNext) {
    var rows = assetMonthRows(month);
    var locked = monthLocked(month, 'assets');
    var all = assetTotalOf(month, '含公积金');
    var free = assetTotalOf(month, '不含公积金');
    var freeRows = rows.filter(function (r) { return r.app !== ASSET_RESERVED; });

    // 应用按固定顺序排，没列进去的排最后，免得新加的账户漏掉
    var apps = ASSET_APP_ORDER.filter(function (app) {
      return rows.some(function (r) { return r.app === app; });
    });
    rows.forEach(function (r) { if (apps.indexOf(r.app) === -1) apps.push(r.app); });

    var body = apps.map(function (app) {
      var list = rows.filter(function (r) { return r.app === app; })
        .sort(function (x, y) {
          // 组内按当月月末从大到小，大头排前面；再按名字定个稳定次序
          return (y.end || 0) - (x.end || 0) || (x.name < y.name ? -1 : 1);
        });
      var head = '<tr class="cmp-cat">' +
        '<th class="cmp-item"><span class="cell">' +
          '<span class="chev ghost"></span><span class="name">' + esc(app) + '</span>' +
        '</span></th>' +
        assetStaticCell(assetSumOf(list, 'start')) + assetStaticCell(assetSumOf(list, 'end')) +
      '</tr>';
      return head + list.map(function (r) {
        return '<tr class="cmp-sub">' +
          '<th class="cmp-item"><span class="cell">' + assetNameCell(r) + '</span></th>' +
          assetStaticCell(r.start) +
          // 月末格下面那行环比读的就是月初，跟对比表里的「较上月」是同一件事。
          // 只有本月有记录的那一项才可改；只存在于上月的（本月已清掉）没得改，照只读铺
          (r.id
            ? assetCell({ id: r.id, end: r.end }, { end: r.start }, false, locked)
            : assetStaticCell(r.end)) +
        '</tr>';
      }).join('');
    }).join('');

    var sumRows = [
      { label: '总资产', list: rows },
      { label: '总资产（不含公积金）', list: freeRows }
    ].map(function (t) {
      return '<tr class="assets-sum">' +
        '<th class="cmp-item"><span class="cell"><span class="name">' + esc(t.label) + '</span></span></th>' +
        assetStaticCell(assetSumOf(t.list, 'start')) + assetStaticCell(assetSumOf(t.list, 'end')) +
      '</tr>';
    }).join('');
    // 跟总览财产表同一口径：总资产 − 下月娱乐预算，预算推导不出时（null）不加
    if (budgetNext !== null) {
      var allStart = assetSumOf(rows, 'start');
      var allEnd = assetSumOf(rows, 'end');
      sumRows += '<tr class="assets-sum">' +
        '<th class="cmp-item"><span class="cell"><span class="name">总资产（不含娱乐预算）</span></span></th>' +
        assetStaticCell(allStart === null ? null : allStart - budgetNext) +
        assetStaticCell(allEnd === null ? null : allEnd - budgetNext) +
      '</tr>';
    }

    var parts = apps.map(function (app) {
      return { name: app, value: assetSumOf(rows.filter(function (r) { return r.app === app; }), 'end') };
    }).filter(function (p) { return p.value > 0; })
      .sort(function (a, b) { return b.value - a.value; });

    return '<div class="mdetail">' +
      mdetailHead(month, locked, null,
        '<span class="spacer"></span>' +
        '<span class="mdetail-io"><span>不含公积金 <b>' + money(free) + '</b></span></span>' +
        '<span class="mdetail-net">总资产 ' + money(all) + '</span>') +
      '<div class="adetail">' +
        '<table class="cmp assets asset-detail"><thead><tr>' +
          '<th class="cmp-item"><span class="cell"><span class="name">资产项</span></span></th>' +
          '<th class="cmp-month">月初</th><th class="cmp-month">月末</th>' +
        '</tr></thead><tbody>' + body + sumRows + '</tbody></table>' +
        '<div class="charts">' +
          chartCard('分布', monthLabel(month) + ' · 按月末余额',
            donutSvg(parts, '总资产', '这个月还没有余额。')) +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // 月度理财快照导出：财产（资产项明细 + 三口径总计）+ 预算（本月预算/花销/结余/
  // 特殊收入计入/偶发加成/下月预算）+ 收支汇总（只给汇总，不给明细），JSON 供 AI 分析。
  // 复制到剪贴板优先（粘贴给 AI 最方便），剪贴板不可用就落一个 .json 文件
  function exportMonthSnapshot(month) {
    var rows = assetMonthRows(month);
    var all = assetTotalOf(month, '含公积金');
    var free = assetTotalOf(month, '不含公积金');
    var m = /^(\d{4})年/.exec(month);
    var year = m ? Number(m[1]) : null;
    var budgetData = year !== null ? buildBudget(scopeToYear(all, year), year) : null;
    var bRow = null;
    if (budgetData) budgetData.rows.forEach(function (r) { if (r.month === month) bRow = r; });
    var budgetNext = nextBudget(budgetData);
    var mList = state.entries.filter(function (e) { return (e.month || UNSET_MONTH) === month; });
    var income = sum(mList.filter(function (e) { return e.amount > 0; }));
    var expense = sum(mList.filter(function (e) { return e.amount < 0; }));
    var realNets = realNetMap(year);
    var net = realNetOf(month, realNets);
    if (net === null || net === undefined) net = income + expense;
    var data = {
      类型: '月度理财快照',
      说明: '不含收支明细；收支仅给汇总。财产与预算为当月数据，金额为原始数字',
      月份: month,
      导出时间: new Date().toISOString(),
      收支汇总: { 收入: income, 支出: expense, 净额: net },
      财产: {
        总资产: all,
        不含公积金: free,
        不含娱乐预算: budgetNext === null ? null : all - budgetNext,
        资产项: rows.map(function (r) {
          return { 应用: r.app, 名称: r.name, 月初: r.start, 月末: r.end, 备注: r.note || null };
        })
      },
      预算: bRow ? {
        本月预算: bRow.budget,
        本月花销: bRow.spend.total,
        本月结余: bRow.remain,
        特殊收入计入: bRow.cfg.specialIn || 0,
        偶发加成: bRow.cfg.bonus || 0,
        下月娱乐预算: budgetNext
      } : { 下月娱乐预算: budgetNext }
    };
    var json = JSON.stringify(data, null, 2);
    var ok = function () { toast('已导出 ' + month + ' 理财快照', true); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(ok)
        .catch(function () { downloadJson(month, json); ok(); });
    } else {
      downloadJson(month, json);
      ok();
    }
  }

  function downloadJson(month, text) {
    try {
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = month + '-理财快照.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) { /* 复制和下载都不可用时静默，toast 已提示导出 */ }
  }

  // 保存进度的悬浮位：只有写 Notion 的过程中短暂出现（资产新增已移除，备注批量写时仍用）
  function setAssetProgress(text) {
    var el = document.getElementById('asset-progress');
    if (!el) return;
    var bar = document.getElementById('view-bar');
    el.hidden = !text;
    el.textContent = text || '';
    if (bar) bar.hidden = !text;
  }

  // 双击格子：草稿先记着，等焦点离开整块小面板再一次性比对、只写改过的那几个字段
  function startAssetEdit(id) {
    var row = state.assets.filter(function (a) { return a.id === id; })[0];
    if (!row) return;
    if (monthLocked(row.month, 'assets')) return lockedToast();
    state.assetsEdit = { id: id, draft: { end: row.end, note: row.note || '' } };
    render();
    var input = typeof treeEl.querySelector === 'function'
      ? treeEl.querySelector('input[data-asset-num]') : null;
    if (!input) return;
    input.focus();
    input.select();
  }

  function commitAssetEditor() {
    var edit = state.assetsEdit;
    if (!edit) return;
    state.assetsEdit = null;
    var row = state.assets.filter(function (a) { return a.id === edit.id; })[0];
    if (!row) return render();

    function num(raw) {
      var s = String(raw == null ? '' : raw).trim();
      if (!s) return null;   // 清空就是不填，别硬当成 0
      var n = Number(s);
      return isFinite(n) ? n : null;
    }
    var end = num(edit.draft.end);
    var props = {};
    if (end !== row.end) props['月末'] = { number: end };
    if (!Object.keys(props).length) return render();
    saveAsset(edit.id, props);
  }

  // 双击资产项的名字改备注。备注是项目维度的，改一次要写回它在各月的所有记录，
  // 否则换个月份看就又变回旧值
  function startAssetNoteEdit(app, name, note) {
    state.assetNoteEdit = { app: app, name: name, draft: note || '', was: note || '' };
    render();
    var input = typeof treeEl.querySelector === 'function'
      ? treeEl.querySelector('input[data-asset-note]') : null;
    if (!input) return;
    input.focus();
    input.select();
  }

  function commitAssetNote() {
    var edit = state.assetNoteEdit;
    if (!edit) return;
    state.assetNoteEdit = null;
    var rows = state.assets.filter(function (a) {
      return a.app === edit.app && a.name === edit.name;
    });
    var note = String(edit.draft == null ? '' : edit.draft).trim();
    if (!rows.length || note === edit.was) return render();

    var before = state.assets;
    var props = { '备注': { rich_text: note ? [{ text: { content: note } }] : [] } };
    // 先落本地再发请求；失败整体回滚
    state.assets = state.assets.map(function (a) {
      if (a.app !== edit.app || a.name !== edit.name) return a;
      return Object.assign({}, a, { note: note });
    });
    render();
    setLoading(true);

    var done = 0;
    function step(i) {
      if (i >= rows.length) return Promise.resolve();
      setAssetProgress('正在写备注 ' + (i + 1) + '/' + rows.length + ' 条…');
      return notion('/pages/' + rows[i].id, {
        method: 'PATCH', body: JSON.stringify({ properties: props })
      }).then(function () { done = i + 1; return step(i + 1); });
    }

    step(0).then(function () {
      setAssetProgress('');
      setLoading(false);
      toast('「' + edit.name + '」的备注已更新');
    }).catch(function (err) {
      state.assets = before;
      setAssetProgress('');
      render();
      setLoading(false);
      toast('备注只写到 ' + done + '/' + rows.length + ' 条：' + err.message, false);
    });
  }

  function saveAsset(id, props) {
    var before = state.assets;
    // 先落本地再发请求，免得往返期间闪回旧值；失败整体回滚
    state.assets = state.assets.map(function (a) {
      if (a.id !== id) return a;
      var next = Object.assign({}, a);
      if ('月末' in props) next.end = props['月末'].number;
      if ('备注' in props) {
        next.note = props['备注'].rich_text.map(function (t) {
          return (t.text && t.text.content) || '';
        }).join('');
      }
      return next;
    });
    render();
    setLoading(true);
    notion('/pages/' + id, { method: 'PATCH', body: JSON.stringify({ properties: props }) })
      .then(function (page) {
        var saved = normalizeAsset(page);
        state.assets = state.assets.map(function (a) { return a.id === saved.id ? saved : a; });
        render();
      })
      .catch(function (err) {
        state.assets = before;
        render();
        toast(err.message, false);
      })
      .then(function () { setLoading(false); });
  }

  // 表格里不提供新增也不提供删除：资产项一次归档就是各月多条记录，误点的代价太大；
  // 需要增删的时候走 Notion 端，页面上只保留「就地改数」

  // 双击格子：草稿先记着，等焦点离开整块小面板再一次性比对、只写改过的那几个字段
  // 手写 SVG，不引外部图表库：Notion 的 iframe 里加载 CDN 不稳，而且这几张图形状都简单。
  // 宽度按正文列实测（.tree 的左右内边距就是 --gutter），再减掉卡片自己的内边距和边框，
  // 这样 viewBox 跟卡片像素 1:1，刻度文字不会被缩放拉变形
  function chartWidth() {
    var el = treeEl;
    if (el && el.clientWidth) {
      var cs = window.getComputedStyle(el);
      var pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      var avail = Math.min(el.clientWidth - pad, 960);
      if (avail > 0) return Math.max(280, avail - 34);
    }
    return 600;
  }

  // 轴刻度取整：把原始步长抬到 1/2/5×10^n，刻度读数才是整数
  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    var base = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var f = raw / base;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * base;
  }

  function axisScale(min, max, count) {
    if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
    if (min === max) { max = min + 1; }
    var step = niceStep((max - min) / count);
    var lo = Math.floor(min / step) * step;
    var hi = Math.ceil(max / step) * step;
    var ticks = [];
    for (var v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
    return { lo: lo, hi: hi, ticks: ticks };
  }

  function sharePct(x) { return (Math.round(x * 1000) / 10) + '%'; }

  function svgWrap(w, h, inner) {
    return '<svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h +
      '" width="' + w + '" height="' + h + '">' + inner + '</svg>';
  }

  // 三色槽：图形和图例共用一份 --c，换主题时跟着 CSS 变量走
  function chartLegend(items) {
    return '<div class="chart-legend">' + items.map(function (it) {
      return '<span class="lg ' + it.cls + '"><i class="sw"></i>' + esc(it.name) + '</span>';
    }).join('') + '</div>';
  }

  function chartCard(title, sub, body) {
    return '<section class="chart-card">' +
      '<header><h3>' + esc(title) + '</h3>' +
        (sub ? '<span class="chart-sub">' + esc(sub) + '</span>' : '') + '</header>' +
      body + '</section>';
  }

  // 坐标骨架：横网格 + 左侧刻度 + 零线。柱图有负数时零线就是基准
  function chartFrame(w, h, pad, sc, y, withZero) {
    var right = w - pad.r;
    var grid = sc.ticks.map(function (t) {
      return '<line class="grid" x1="' + pad.l + '" x2="' + right + '" y1="' + y(t) + '" y2="' + y(t) + '"/>' +
        '<text x="' + (pad.l - 8) + '" y="' + (y(t) + 3.5) + '" text-anchor="end">' + money(t) + '</text>';
    }).join('');
    if (!withZero || sc.lo > 0) return grid;
    return grid + '<line class="zero" x1="' + pad.l + '" x2="' + right +
      '" y1="' + y(0) + '" y2="' + y(0) + '"/>';
  }

  // 成组柱：每组若干根并排，共用同一把尺子。柱身上挂 <title>，悬停能看具体数额
  function groupedBars(w, groups, legend) {
    var h = 260, pad = { l: 58, r: 16, t: 18, b: 34 };
    var plotW = w - pad.l - pad.r, plotH = h - pad.t - pad.b;
    var vals = [];
    groups.forEach(function (g) { g.bars.forEach(function (b) { vals.push(b.v); }); });
    if (!vals.length) return '';
    var sc = axisScale(Math.min.apply(null, vals.concat([0])),
                       Math.max.apply(null, vals.concat([0])), 4);
    var y = function (v) { return pad.t + (sc.hi - v) / (sc.hi - sc.lo) * plotH; };
    var zeroY = y(0);

    var slot = plotW / groups.length;
    var n = groups[0].bars.length;
    var bw = Math.max(6, Math.min(26, slot * 0.66 / n));
    var gap = 4;
    var bars = groups.map(function (g, gi) {
      var groupW = n * bw + (n - 1) * gap;
      var x0 = pad.l + slot * gi + (slot - groupW) / 2;
      return g.bars.map(function (b, bi) {
        var top = b.v >= 0 ? y(b.v) : zeroY;
        var hgt = Math.max(1, Math.abs(y(b.v) - zeroY));
        return '<rect class="bar ' + b.cls + '" x="' + (x0 + bi * (bw + gap)) + '" y="' + top +
          '" width="' + bw + '" height="' + hgt + '" rx="2"><title>' +
          esc(g.label + ' · ' + b.name + ' ' + signed(b.v)) + '</title></rect>';
      }).join('');
    }).join('');

    var labels = groups.map(function (g, gi) {
      return '<text class="xlab" x="' + (pad.l + slot * gi + slot / 2) + '" y="' + (h - 12) +
        '" text-anchor="middle">' + esc(g.label) + '</text>';
    }).join('');

    return legend + svgWrap(w, h, chartFrame(w, h, pad, sc, y, true) + bars + labels);
  }

  function assetTrendSub(data, year) {
    var m = data.months;
    if (!m.length) return '';
    var inc = data.totals[0].values;
    var span = (year === null || year === CMP_OTHER) ? '' : year + '年 ';
    var txt = span + monthLabel(m[0]) + ' – ' + monthLabel(m[m.length - 1]);
    var first = inc[0], last = inc[inc.length - 1];
    if (m.length > 1 && first !== null && first !== undefined && last !== null && last !== undefined) {
      txt += ' · 累计 ' + signed(last - first);
    }
    return txt;
  }

  // 总资产走势：含/不含公积金两条线。资产都在几十万这个量级，
  // 从 0 起画会把三条线压成一条，所以按实际区间取整，刻度上写清楚数
  function renderAssetTrend(data, year, w) {
    if (!data.months.length) return '<p class="chart-empty">还没有财产数据。</p>';
    var h = 260, pad = { l: 58, r: 18, t: 16, b: 30 };
    var plotW = w - pad.l - pad.r, plotH = h - pad.t - pad.b;
    var series = [
      { name: '含公积金', cls: 'c1', values: data.totals[0].values },
      { name: '不含公积金', cls: 'c2', values: data.totals[1].values }
    ];
    var vals = [];
    series.forEach(function (s) {
      s.values.forEach(function (v) { if (v !== null && v !== undefined) vals.push(v); });
    });
    if (!vals.length) return '<p class="chart-empty">还没有余额数据。</p>';

    var sc = axisScale(Math.min.apply(null, vals), Math.max.apply(null, vals), 4);
    var y = function (v) { return pad.t + (sc.hi - v) / (sc.hi - sc.lo) * plotH; };
    var n = data.months.length;
    var x = function (i) { return n > 1 ? pad.l + plotW * i / (n - 1) : pad.l + plotW / 2; };

    var lines = series.map(function (s) {
      var pts = [], dots = '';
      s.values.forEach(function (v, i) {
        if (v === null || v === undefined) return;
        pts.push(x(i) + ',' + y(v));
        dots += '<circle class="dot ' + s.cls + '" cx="' + x(i) + '" cy="' + y(v) + '" r="3.5">' +
          '<title>' + esc(monthLabel(data.months[i]) + ' ' + s.name + ' ' + money(v)) + '</title></circle>';
      });
      return (pts.length > 1 ? '<polyline class="ln ' + s.cls + '" points="' + pts.join(' ') + '"/>' : '') + dots;
    }).join('');

    var labels = data.months.map(function (m, i) {
      return '<text class="xlab" x="' + x(i) + '" y="' + (h - 10) + '" text-anchor="middle">' +
        esc(monthLabel(m)) + '</text>';
    }).join('');

    return chartLegend(series.map(function (s) { return { name: s.name, cls: s.cls }; })) +
      svgWrap(w, h, chartFrame(w, h, pad, sc, y, false) + lines + labels);
  }

  // 各应用占比：取某一列的月末余额，把各应用摊成环形。总量就是「含公积金」的口径
  function renderAppShare(data, at) {
    if (!data.months.length) return '<p class="chart-empty">还没有财产数据。</p>';
    // at 指定看哪一列：对比视图默认最后一列，月度详情传当月那一列
    if (at === undefined || at === null) at = data.months.length - 1;
    var parts = data.groups.map(function (g) {
      return { name: g.app, value: g.values[at] || 0 };
    }).filter(function (p) { return p.value > 0; })
      .sort(function (a, b) { return b.value - a.value; });
    return donutSvg(parts, '总资产', '最新一个月还没有余额。');
  }

  // 环形图：财产占比两处共用——对比视图取最后一列，月度详情取当月
  function donutSvg(parts, cap, emptyText) {
    if (!parts.length) return '<p class="chart-empty">' + esc(emptyText) + '</p>';

    var total = parts.reduce(function (a, p) { return a + p.value; }, 0);
    var size = 180, c = size / 2, r = 60, sw = 26;
    var C = 2 * Math.PI * r, acc = 0;
    var arcs = parts.map(function (p, i) {
      var len = p.value / total * C;
      var draw = Math.max(0.6, len - 2.5);   // 留一道细缝，两段不会糊在一起
      var el = '<circle class="arc c' + (i % 5 + 1) + '" cx="' + c + '" cy="' + c + '" r="' + r +
        '" stroke-width="' + sw + '" stroke-dasharray="' + draw + ' ' + (C - draw) + '"' +
        ' stroke-dashoffset="' + (-acc) + '">' +
        '<title>' + esc(p.name + ' ' + money(p.value) + '（' + sharePct(p.value / total) + '）') + '</title></circle>';
      acc += len;
      return el;
    }).join('');

    var legend = parts.map(function (p, i) {
      return '<li class="donut-item c' + (i % 5 + 1) + '"><i class="sw"></i>' +
        '<span class="nm">' + esc(p.name) + '</span>' +
        '<span class="vl">' + money(p.value) + '</span>' +
        '<span class="pc">' + sharePct(p.value / total) + '</span></li>';
    }).join('');

    return '<div class="donut-wrap">' +
      '<svg class="chart-svg donut" viewBox="0 0 ' + size + ' ' + size +
        '" width="' + size + '" height="' + size + '">' +
        '<g transform="rotate(-90 ' + c + ' ' + c + ')">' + arcs + '</g>' +
        '<text class="donut-total" x="' + c + '" y="' + (c - 3) + '" text-anchor="middle">' + money(total) + '</text>' +
        '<text class="donut-cap" x="' + c + '" y="' + (c + 15) + '" text-anchor="middle">' + esc(cap) + '</text>' +
      '</svg>' +
      '<ul class="donut-legend">' + legend + '</ul>' +
    '</div>';
  }

  // 预算 / 花销 / 结余：结余可以是负的（超支），所以带零线。
  // 预算走中性灰（表格里也不上色），花销走支出色，结余按正负——跟预算表一个规矩
  // 副标题写清楚画的是哪几个月，跟表里铺的月份对上
  function budgetSub(data) {
    if (!data || !data.rows.length) return '';
    return monthLabel(data.rows[0].month) + ' – ' + monthLabel(data.rows[data.rows.length - 1].month);
  }

  function renderBudgetBars(data, w) {
    if (!data || !data.rows.length) return '<p class="chart-empty">这一年还没有预算数据。</p>';
    var groups = data.rows.map(function (row) {
      var r = Math.round(row.remain);
      return {
        label: monthLabel(row.month),
        bars: [
          { v: Math.round(row.budget), cls: 'b-budget', name: '预算' },
          { v: row.spend.total, cls: 'b-spend', name: '花销' },
          { v: r, cls: r > 0 ? 'b-pos' : r < 0 ? 'b-neg' : 'b-zero', name: '结余' }
        ]
      };
    });
    return groupedBars(w, groups, chartLegend([
      { name: '本月预算', cls: 'b-budget' },
      { name: '本月花销', cls: 'b-spend' },
      { name: '本月结余', cls: 'b-pos' }
    ]));
  }

  // 逐月收入/支出：两条都按绝对值立起来，红收入、绿支出，跟账本一个规矩
  function monthlyTotals(entries) {
    var map = new Map();
    entries.forEach(function (e) {
      if (!e.month || e.month === UNSET_MONTH) return;
      var row = map.get(e.month);
      if (!row) { row = { month: e.month, income: 0, expense: 0 }; map.set(e.month, row); }
      if (e.amount > 0) row.income += e.amount;
      else if (e.amount < 0) row.expense += -e.amount;
    });
    var out = [];
    map.forEach(function (r) { out.push(r); });
    out.sort(function (a, b) { return monthKey(a.month) - monthKey(b.month); });
    return out;
  }

  function renderIncomeBars(entries, w) {
    var rows = monthlyTotals(entries);
    if (!rows.length) return '<p class="chart-empty">这一年还没有收支记录。</p>';
    var groups = rows.map(function (row) {
      return {
        label: monthLabel(row.month),
        bars: [
          { v: Math.round(row.income), cls: 'b-income', name: '收入' },
          { v: Math.round(row.expense), cls: 'b-expense', name: '支出' }
        ]
      };
    });
    return groupedBars(w, groups, chartLegend([
      { name: '收入', cls: 'b-income' },
      { name: '支出', cls: 'b-expense' }
    ]));
  }

  // 图跟着它画的数据待在同一个域里：预算图进「预算 › 图表」，收支图进对比视图，
  // 财产图并进「财产 › 对比」，跟明细表同一屏
  function renderAssetCharts(year) {
    var w = chartWidth();
    // 图跟明细同一份区间：区间一收，走势和占比都跟着只看那几个月
    var assets = sliceAssets(buildAssets(year));
    return '<div class="charts">' +
      chartCard('总资产走势', assetTrendSub(assets, year), renderAssetTrend(assets, year, w)) +
      chartCard('各应用占比', assets.months.length
        ? monthLabel(assets.months[assets.months.length - 1]) + ' · 按月末余额' : '', renderAppShare(assets)) +
    '</div>';
  }


  // ---------- 渲染 ----------

  // 当前视图要讲的那段说明，由各视图的渲染函数填进来，render 末尾统一挂到「说明」气泡上
  var pendingHint = '';

  // ===== 月度视图渲染 =====
  function amtCell(value, cls) {
    if (!value) return '<span class="amt zero">—</span>';
    return '<span class="amt ' + cls + '">' + signed(value) + '</span>';
  }

  function render() {
    var all = state.entries;
    var entries = visibleEntries();
    var searching = !!state.search.trim();
    // 月度画廊态子 tab 回默认：子 tab 只服务详情，退出详情（返回/删空换年）就回默认（财产），
    // 不记住上次的维度；详情内的切换仍保留（「切维度不丢月」只在详情内成立）
    if (state.view === 'month' && !state.monthOpen && !searching && state.sub !== DEFAULT_SUB) {
      state.sub = DEFAULT_SUB;
    }
    var mode = derivedMode();
    pendingHint = '';
    // 按钮高亮和子 tab 显隐跟着每次渲染同步：点卡进详情、返回画廊、搜索态都会改
    // monthOpen/view/sub，不走 setTab/setSub 的路径也必须刷新这里
    syncViewButtons();

    // 以年为界：年份切换栏、顶部总计、笔数和内容都收在同一年里，数字才不会互相打架
    var years = cmpYears(entries);
    var year = years.length
      ? (years.indexOf(state.cmpYear) !== -1 ? state.cmpYear : years[0])
      : null;
    // 月份区间条常驻第一行年份右侧；值只在对比、财产明细/图表里筛选内容
    renderCmpBar(years, year);

    var scoped = year !== null ? scopeToYear(entries, year) : entries;
    // 对比视图的读数按区间再裁一道，跟表里铺出来的月份对齐；其余视图整年铺，不受区间影响
    var metricEntries = RANGE_FILTER_VIEWS.indexOf(mode) === -1
      ? scoped
      : scoped.filter(function (e) { return inMonthRange(e.month || UNSET_MONTH); });

    // 预算只按年份过滤，不受搜索影响
    var yearEntries = year !== null ? scopeToYear(all, year) : all;
    // 区间条要等年份定下来才知道有哪些月；只在有年份时露出来
    renderRangeBar(year !== null ? rangeMonths(mode, year, yearEntries) : [], year !== null);
    var budgetData = buildBudget(yearEntries, year);
    var budgetNext = nextBudget(budgetData);
    var isBudgetView = mode === 'budget';

    // 空状态：月度用全局那颗；对比/预算/财产各自在表内讲自己为什么空。
    // 只有「搜索没匹配」仍旧走全局，免得表内的解释跟搜索对不上
    var emptyTip = '还没有数据，点画廊末尾的「新增月份」开始记录。';
    emptyEl.hidden = scoped.length > 0 || (mode !== 'tree' && !searching);
    if (ASSET_VIEWS.indexOf(mode) !== -1) {
      // 财产跟账本走的是两套数据，账本为空不代表没财产，这一格只标数据域
      countEl.textContent = '财产';
    } else {
      // 不报条数：范围已经由年份下拉和搜索框框定，条数是冗余信息
      countEl.textContent = '';
      emptyEl.textContent = searching && !scoped.length
        ? '没有匹配「' + state.search.trim() + '」的记录。'
        : emptyTip;
    }

    var income = sum(metricEntries.filter(function (e) { return e.amount > 0; }));
    var expense = sum(metricEntries.filter(function (e) { return e.amount < 0; }));
    // 真实净额按月算，先把这一年的财产差值备好——纠偏条目、画廊卡片、顶栏读数共用这一份
    var realNets = realNetMap(year);
    // 画廊卡片要带当月总资产（含公积金口径）：账本月与财产月按同名对齐，
    // 财产里没有的那个月写「—」；月度详情 header 也按月查同一份
    var assetTotals = {};
    (function () {
      var data = buildAssets(year);
      for (var i = 0; i < data.months.length; i++) {
        assetTotals[data.months[i]] = data.totals[0].values[i];
      }
    })();

    // 画廊卡片要带当月预算花销：budgetData 按月份铺，花销口径跟预算表一致
    // （娱乐支出合计 + 特殊支出的一半）；未标月份/无预算起始时 buildBudget 返回 null
    var budgetSpends = {};
    if (budgetData) budgetData.rows.forEach(function (r) { budgetSpends[r.month] = r.spend.total; });

    if (state.view === 'month' && state.monthOpen && !searching) {
      // 月度详情态：header 跟随当前月，三个核心数（净额/总资产/预算花销+结余），不随子 tab 变。
      // 画廊态不放信息——三个维度的概要都在月份卡片上（总资产置顶、净额主读、收支+预算花销）。
      // 搜索态铺的是账本单域，仍走下方收支分支
      var mn = state.monthOpen;
      var mList = scoped.filter(function (e) { return (e.month || UNSET_MONTH) === mn; });
      var mIncome = sum(mList.filter(function (e) { return e.amount > 0; }));
      var mExpense = sum(mList.filter(function (e) { return e.amount < 0; }));
      var mNet = realNetOf(mn, realNets);
      var mAsset = assetTotals[mn];
      var mBRow = null;
      if (budgetData) budgetData.rows.forEach(function (r) { if (r.month === mn) mBRow = r; });
      var mnNet = mNet === null ? mIncome + mExpense : mNet;
      totalsEl.hidden = false;
      totalsEl.innerHTML =
        '<span class="chip"><b>净额</b><i class="' + tone(mnNet) + '">' + signed(mnNet) + '</i></span>' +
        (mAsset !== null && mAsset !== undefined
          ? '<span class="chip"><b>总资产</b><i>' + money(mAsset) + '</i></span>'
          : '') +
        (mBRow
          ? '<span class="chip budget"><b>预算</b>' +
            (mBRow.spend.total
              ? '<i class="neg">花销 −' + money(mBRow.spend.total) + '</i>'
              : '<i>花销 —</i>') +
            '<i>结余 ' + money(mBRow.remain) + '</i></span>'
          : '');
    } else if (ASSET_VIEWS.indexOf(mode) !== -1) {
      // 财产视图不看收支，顶栏换成最新一个月的两个口径总资产。
      // 只有对比受月份区间裁剪；月度画廊整年铺，读数也跟着整年，别跟画廊对不上
      var assetTop = RANGE_FILTER_VIEWS.indexOf(mode) === -1
        ? buildAssets(year) : sliceAssets(buildAssets(year));
      var at = assetTop.months.length - 1;
      totalsEl.innerHTML = at < 0 ? '' :
        '<span class="chip"><b>总资产</b><i>' + money(assetTop.totals[0].values[at]) + '</i></span>' +
        '<span class="chip"><b>不含公积金</b><i>' + money(assetTop.totals[1].values[at]) + '</i></span>';
    } else if (isBudgetView) {
      // 预算视图只报下月能花多少：收支读数归收支视图，别在两处重复
      totalsEl.innerHTML = budgetNext !== null
        ? '<span class="chip budget"><b>下月娱乐预算</b><i>' + money(budgetNext) + '</i></span>'
        : '';
    } else if (state.view === 'month' && !searching) {
      // 画廊态：header 不放信息，三个维度的概要都在月份卡片上
      totalsEl.hidden = true;
      totalsEl.innerHTML = '';
    } else {
      // 顶栏净额也走真实口径：账本净额 + 财产覆盖到的各月纠偏合计。
      // 搜索时读的是命中集合，跟整月口径对不上，就不加纠偏
      var net = income + expense + (searching ? 0 : adjustTotal(realNets, metricEntries));
      totalsEl.innerHTML =
        '<span class="chip"><b>收入</b><i class="pos">' + signed(income) + '</i></span>' +
        '<span class="chip"><b>支出</b><i class="neg">' + signed(expense) + '</i></span>' +
        '<span class="chip"><b>' + (searching ? '匹配净额' : '净额') + '</b><i class="' +
        tone(net) + '">' + signed(net) + '</i></span>';
    }

    // 总览：子 tab 常显，收支/财产/预算各自出对比内容
    // 月度：搜索铺可展开月份列表；点开某个月进详情（子 tab 切当月维度）；否则停在画廊
    if (state.view === 'overview') {
      treeEl.className = 'tree ' + (state.sub === 'income' ? 'compare'
        : state.sub === 'assets' ? 'assets'
        : 'budget');
      treeEl.innerHTML = state.sub === 'income'
        ? renderCompare(scoped, realNets)
        : state.sub === 'assets'
          ? renderAssets(year, budgetNext)
          : renderBudget(budgetData, year, yearEntries);
    } else if (!searching && state.monthOpen) {
      var openMonth = null;
      galleryMonths(scoped).forEach(function (m) { if (m.name === state.monthOpen) openMonth = m; });
      if (openMonth) {
        // 当月详情：子 tab 决定看哪个维度的数据，月份本身不丢
        treeEl.className = 'tree detail';
        pendingHint = state.sub === 'assets' ? assetMonthHintText() : treeHintText();
        var bIdx = budgetMonthIndex(budgetData, state.monthOpen);
        treeEl.innerHTML = state.sub === 'income'
          ? renderMonthDetail(openMonth, realNets)
          : state.sub === 'assets'
            ? renderAssetMonthDetail(state.monthOpen, budgetNext)
            : bIdx !== -1
              ? renderBudgetMonth(budgetData, bIdx, yearEntries, '返回画廊')
              : cmpHint('该月没有可推导的娱乐预算。预算自 ' + esc(OPENING_MONTH) +
                ' 的结余起逐月推算。');
      } else {
        state.monthOpen = null;   // 那个月没了（删空/换了年），退回画廊
        treeEl.className = 'tree gal';
        treeEl.innerHTML = renderMonthly(scoped, searching, realNets, assetTotals, budgetSpends, budgetNext);
        galleryJump();
      }
    } else {
      treeEl.className = searching ? 'tree' : 'tree gal';
      treeEl.innerHTML = renderMonthly(scoped, searching, realNets, assetTotals, budgetSpends, budgetNext);
      if (!searching) galleryJump();
    }

    // 各视图渲染时把要讲的说明填进 pendingHint，这里统一挂到顶栏「说明」按钮的气泡上
    renderHint(pendingHint);
    // 标签只服务账本的月度视图，跟说明按钮同住在子 tab 右侧
    btnTagsEl.hidden = mode !== 'tree';
    renderViewBar(mode);

    var today = new Date();
    var nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    var options = [];
    groupByMonth(all).forEach(function (m) {
      if (m.name !== UNSET_MONTH && options.indexOf(m.name) === -1) options.push(m.name);
    });
    [monthName(nextMonth), monthName(today)].forEach(function (m) {
      if (options.indexOf(m) === -1) options.push(m);
    });
    document.getElementById('months').innerHTML = options.map(function (m) {
      return '<option value="' + esc(m) + '">';
    }).join('');
  }

  // 每个月的「真实净额」= 该月的财产差值（含公积金口径）：本月月末 − 上月月末。
  // 首月没有上月可比、财产里没这个月、那个月又缺数，都不硬凑——这些月份不进表，
  // 详情页就退回账本净额，也不显示纠偏条目
  function realNetMap(year) {
    var map = {};
    if (year === null) return map;
    var data = buildAssets(year);
    for (var i = 1; i < data.months.length; i++) {
      var cur = data.totals[0].values[i];
      var prev = data.totals[0].values[i - 1];
      if (cur === null || cur === undefined || prev === null || prev === undefined) continue;
      map[data.months[i]] = cur - prev;
    }
    return map;
  }

  // 这一年里各月纠偏的合计：Σ（真实净额 − 账本净额），只有财产覆盖到的月份才计入。
  // entries 默认取全量，对比视图收窄区间时传进来的是裁过的那一份，读数才跟表列对齐
  function adjustTotal(realNets, entries) {
    var total = 0;
    groupByMonth(entries || state.entries).forEach(function (m) {
      var real = realNetOf(m.name, realNets);
      if (real !== null) total += real - sum(m.list);
    });
    return total;
  }

  // 收支 › 月度：只说看不出来的——净额的口径、纠偏条目的含义、不显眼的操作。
  // 版面（卡片横排、三级树、哪张居中）一眼可见，不占篇幅
  function treeHintText() {
    return '<p><b>净额</b>：取当月财产差值（含公积金口径，本月月末 − 上月月末）；财产未覆盖的月份退回账本净额。' +
      '</p><p>' +
        '<b>净额纠偏</b>：真实净额与账本净额的差额，列在分类之后，不计入收支。差额超 1,000 时提示补充备注，点提示或双击备注文字填写。' +
      '</p><p>' +
        '<b>顶栏净额</b> = 账本净额 + 各月纠偏合计。' +
      '</p><p>' +
        '<b>编辑</b>：双击明细金额或名称就地改，回车或失焦保存，Esc 取消。' +
      '</p><p>' +
        '<b>增删</b>：分类行、子类行行尾的 ＋ 新增，明细行行尾的 × 删除；子类标签由标签按钮管理。' +
      '</p>';
  }

  // 收支 › 对比：只说口径——净额不来自表内各分类之和，纠偏行得这么读
  function compareHintText() {
    return '<p><b>净额</b>：取当月财产差值（含公积金口径）；财产未覆盖的月份退回账本净额。' +
      '</p><p>' +
        '<b>净额纠偏</b>：列在分类与净额之间，读作「分类合计 + 纠偏 = 净额」，只有财产覆盖的月份才有值。' +
      '</p><p>' +
        '<b>备注</b>：差额超 1,000 的月份可在该格补充备注，双击备注文字修改。' +
      '</p><p>' +
        '<b>只读</b>：改数请到「月度」视图。' +
      '</p>';
  }

  // 财产没覆盖到这个月就返回 null，调用方自己退回账本净额
  function realNetOf(monthName, realNets) {
    var v = realNets ? realNets[monthName] : null;
    return v === undefined ? null : v;
  }

  // ---------- 净额纠偏的归因 ----------
  // 纠偏是算出来的，不落库；这里只存人工补的那句「钱去哪了」，
  // 每月一行，跟「娱乐预算」同一个套路：独立数据源 + 月份做行名
  function normalizeAdjust(page) {
    var props = page.properties || {};
    var title = (props['月份'] && props['月份'].title) || [];
    var month = title.map(function (t) { return t.plain_text || ''; }).join('');
    return { id: page.id, month: month, note: richText(props['归因']) };
  }

  function fetchAdjust() {
    var rows = [];
    function step(cursor) {
      var payload = { page_size: 100 };
      if (cursor) payload.start_cursor = cursor;
      return notion('/data_sources/' + settings.adjustSourceId + '/query', {
        method: 'POST',
        body: JSON.stringify(payload)
      }).then(function (page) {
        rows = rows.concat((page.results || []).map(normalizeAdjust));
        return page.has_more ? step(page.next_cursor) : rows;
      });
    }
    return step(null).then(function (list) {
      var map = {};
      list.forEach(function (r) { if (r.month) map[r.month] = r; });
      state.adjust = map;
      return list;
    });
  }

  function adjustNoteOf(monthName) {
    var row = state.adjust[monthName];
    return row && row.note ? row.note : '';
  }

  function saveAdjust(monthName, note) {
    var row = state.adjust[monthName];
    var snapshot = row ? Object.assign({}, row) : null;
    // 先落本地再发请求，免得往返期间闪回旧值；失败整体回滚
    state.adjust[monthName] = { id: row ? row.id : null, month: monthName, note: note };
    state.adjustEdit = null;
    render();

    var props = { '归因': { rich_text: note ? [{ text: { content: note } }] : [] } };
    var request = row && row.id
      ? notion('/pages/' + row.id, { method: 'PATCH', body: JSON.stringify({ properties: props }) })
      : notion('/pages', {
          method: 'POST',
          body: JSON.stringify({
            parent: { type: 'data_source_id', data_source_id: settings.adjustSourceId },
            properties: Object.assign(
              { '月份': { title: [{ text: { content: monthName } }] } }, props)
          })
        });

    return request.then(function (page) {
      state.adjust[monthName] = normalizeAdjust(page);
      render();
    }).catch(function (err) {
      if (snapshot) state.adjust[monthName] = snapshot;
      else delete state.adjust[monthName];
      render();
      toast(err.message, false);
    });
  }

  function startAdjustEdit(monthName) {
    if (state.adjustEdit && state.adjustEdit.month === monthName) return;
    var note = adjustNoteOf(monthName);
    state.adjustEdit = { month: monthName, draft: note, was: note };
    render();
  }

  function commitAdjustNote() {
    var edit = state.adjustEdit;
    if (!edit) return;
    var note = String(edit.draft || '').trim();
    if (note === edit.was) {
      state.adjustEdit = null;
      return render();
    }
    saveAdjust(edit.month, note);
  }

  // 纠偏条目：账本净额跟真实净额对不上时，把差额单列一条，摆在娱乐支出之后。
  // 它就是分类之后多出来的一笔，所以结构、尺寸、底色一律沿用分类行（.row.lv2），
  // 只做三处细微区分：名字压灰、没有 ＋/删除（尾部只留宽度保证金额对齐）、不响应悬停。
  // 折叠箭头位置留一个隐形占位，名字才跟分类名对齐。
  // 差额超过 1000 就在金额角上点一颗小点催补备注，写完换成金额下的一道虚线
  function renderAdjust(diff, monthName) {
    var editing = state.adjustEdit && state.adjustEdit.month === monthName;
    var editor = editing ? adjustNoteEditor() : '';
    return '<div class="node adjust">' +
      '<div class="row lv2">' +
        '<span class="chev ghost"></span>' +
        '<span class="name">净额纠偏</span>' +
        '<span class="adjust-note">财产差值 − 账本净额</span>' +
        editor +
        '<span class="spacer"></span>' +
        adjustAmountHtml(diff, monthName, 'amt', editing) +
        '<span class="tail"></span>' +
      '</div>' +
    '</div>';
  }

  // 月度主 tab 的画廊/搜索态：搜索时铺可展开的月份列表（一次看全命中），否则停在画廊。
  // 月详情由 render() 直接分派到各子 tab，不经过这里
  function renderMonthly(scoped, searching, realNets, assetTotals, budgetSpends, budgetNext) {
    pendingHint = treeHintText();
    if (searching) return groupByMonth(scoped).map(renderMonth).join('');
    return renderGallery(galleryMonths(scoped), realNets, assetTotals, budgetSpends, budgetNext);
  }

  // 画廊里排的月份：只认规范月名，按时间升序（左边上个月、右边下个月）
  function galleryMonths(scoped) {
    return groupByMonth(scoped)
      .filter(function (m) { return m.name !== UNSET_MONTH; })
      .sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  }

  // 居中的那张：记着上次停在哪儿，失效了（月没了/换了年）退回最新一个月
  function resolveGalleryAt(months) {
    var cur = galAt() || readGalleryAt() || null;
    if (cur === NEW_MONTH) return NEW_MONTH;
    var hit = false;
    months.forEach(function (m) { if (m.name === cur) hit = true; });
    return hit ? cur : (months.length ? months[months.length - 1].name : NEW_MONTH);
  }

  // 卡片离中间越远越小：d0 居中、d1/d2 依次收一档，更远的再暗一档
  function galleryCls(i, ci) {
    var d = Math.abs(i - ci);
    return d === 0 ? ' is-center' : d === 1 ? ' d1' : d === 2 ? ' d2' : ' d3';
  }

  function renderGallery(months, realNets, assetTotals, budgetSpends, budgetNext) {
    var at = resolveGalleryAt(months);
    galAtSet(at);
    // 居中那张的下标：月份卡按升序排，末尾再挂一张「新增月份」
    var names = months.map(function (m) { return m.name; });
    names.push(NEW_MONTH);
    var ci = names.indexOf(at);
    if (ci === -1) ci = names.length - 1;
    var cards = months.map(function (m, i) {
      return galleryCard(i, ci, billCardData(m, realNets,
        assetTotals ? assetTotals[m.name] : null,
        budgetSpends ? budgetSpends[m.name] : null,
        budgetNext));
    });
    cards.push(galleryNewCard(months.length, ci, nextBillMonth()));
    return '<div class="gallery" id="gallery">' + cards.join('') + '</div>';
  }

  // 月份卡骨架只写一遍：总资产置顶，净额大数字居中，收支两列收底（支出括号带预算花销）。
  // 读数是调用方算好的一份数据，卡片本身不碰数据域。
  // 排布原则：先「攒下来的」（总资产），再「这个月的」（净额 → 收支），约束挂支出后面
  function galleryCard(i, ci, c) {
    var center = i === ci;
    return '<article class="gcard' + galleryCls(i, ci) + '"' +
      ' data-gallery-month="' + esc(c.name) + '"' + (center ? ' data-center="1"' : '') + '>' +
      '<div class="gcard-in">' +
        '<div class="gcard-year">' + esc(c.name.slice(0, 5)) + '</div>' +
        '<div class="gcard-mon">' + esc(c.monthNo) + '<span>月</span></div>' +
        (c.assetHtml ? '<div class="gcard-asset">' + c.assetHtml + '</div>' : '') +
        '<div class="gcard-net' + (c.netCls ? ' ' + c.netCls : '') + '">' + c.netHtml + '</div>' +
        '<div class="gcard-io">' + c.readings.map(function (r) {
          return '<span><b>' + r.label + '</b><i' + (r.cls ? ' class="' + r.cls + '"' : '') + '>' +
            r.value + '</i>' +
            (r.hint ? '<em class="io-budget">' + r.hint + '</em>' : '') + '</span>';
        }).join('') + '</div>' +
      '</div>' +
    '</article>';
  }

  // 账本卡的读数：总资产（含公积金口径，财产里没这个月就写「—」）置顶；
  // 大数字是真实净额（财产差值，缺数回落账本净额）；收支两列各占半宽，
  // 预算花销（娱乐支出 + 特殊一半）作为支出列下的第三行、相对支出居中，
  // 预算没铺到这个月就不显示。预算花销只作约束注释，不单占一行
  function billCardData(month, realNets, assetTotal, budgetSpend, funBudget) {
    var income = sum(month.list.filter(function (e) { return e.amount > 0; }));
    var expense = sum(month.list.filter(function (e) { return e.amount < 0; }));
    var real = realNetOf(month.name, realNets);
    var net = real === null ? income + expense : real;
    // 卡片跟详情页同一套提醒：差额超 1000 且还没写备注，净额右上角点一颗黄点
    var diff = real === null ? null : real - (income + expense);
    var needs = diff !== null && Math.abs(diff) > ADJUST_ALERT && !adjustNoteOf(month.name);
    // 只认「…年…月」里的月，别让正则先咬到年份的「20」
    var m = /^\d{4}年(\d{1,2})月$/.exec(month.name);
    return {
      name: month.name,
      monthNo: m ? m[1] : month.name,
      netCls: tone(net),
      netHtml: '<span class="adj-num">' + signed(net) +
        (needs ? '<span class="adj-mark gcard-mark" aria-label="差额较大，进入本月可补充备注"></span>' : '') +
        '</span>',
      // 总资产拆出「娱乐预算」：budgetNext 是预算推导出的下月娱乐预算（跟详情 header 同一口径）。
      // 家底行下注一行（其余 + 下月娱乐预算），没有下月预告就不注
      assetHtml: assetTotal === null || assetTotal === undefined
        ? '<span>总资产</span><b class="zero">—</b>'
        : '<span>总资产</span><b>' + money(assetTotal) + '</b>' +
          (funBudget ? '<em class="gcard-asset-split">（' + money(assetTotal - funBudget) +
            ' + ' + money(funBudget) + ' 娱乐预算）</em>' : ''),
      readings: [
        { label: '收入', value: signed(income), cls: 'pos' },
        { label: '支出', value: signed(expense), cls: 'neg',
          hint: budgetSpend ? '预算花销 −' + money(budgetSpend) : null }
      ]
    };
  }

  // 「新增月份」虚线卡：账本建壳专用，目标月份从外面传进来
  function galleryNewCard(i, ci, month) {
    var center = i === ci;
    return '<article class="gcard gcard-new' + galleryCls(i, ci) + '"' +
      ' data-gallery-new="1"' + (center ? ' data-center="1"' : '') + '>' +
      '<div class="gcard-in">' +
        '<div class="gcard-plus">＋</div>' +
        '<div class="gcard-new-label">新增月份</div>' +
        '<div class="gcard-new-month">' + esc(month) + '</div>' +
      '</div>' +
    '</article>';
  }

  // 点开某个月的详情：顶栏一行放返回、月份、收支和净额，下面就是那个月的分类树。
  // 锁着的时候，非最新月整页只读：撤掉 ＋/删除，双击也不进编辑
  function renderMonthDetail(month, realNets) {
    var income = sum(month.list.filter(function (e) { return e.amount > 0; }));
    var expense = sum(month.list.filter(function (e) { return e.amount < 0; }));
    var ledgerNet = income + expense;
    // 收入、支出照旧读账本，净额换成真实净额（财产差值）；
    // 两者的差额就是账本没记到的那笔，单列一条纠偏条目
    var real = realNetOf(month.name, realNets);
    var net = real === null ? ledgerNet : real;
    var diff = real === null ? null : real - ledgerNet;
    var locked = monthLocked(month.name, 'ledger');
    return '<div class="mdetail">' +
      mdetailHead(month.name, locked, null,
        '<span class="mdetail-io">' +
          '<span class="pos">' + (income ? '+' + money(income) : '—') + '</span>' +
          '<span class="neg">' + (expense ? '−' + money(expense) : '—') + '</span>' +
        '</span>' +
        '<span class="spacer"></span>' +
        '<span class="mdetail-net ' + tone(net) + '">净 ' + signed(net) + '</span>' +
        (locked ? '' :
          '<button type="button" class="icon" data-add="' + esc('m:' + month.name) + '" title="在本月新增">＋</button>')) +
      '<div class="children">' +
        groupByCategory(month.list).map(function (c) { return renderCategory(month.name, c); }).join('') +
        (diff ? renderAdjust(diff, month.name) : '') +
      '</div>' +
    '</div>';
  }

  // 进某月详情时，把该月的分类/子类默认摊开。
  // 只补「还没定过」的键：用户手动收起过的，再进来仍保持收起，
  // 这样既有默认展开的便利，又保留了折叠能力（早先用 forceOpen 参数把
  // open 钉死成 true，点了没反应，等于不能折）
  function expandMonth(month) {
    groupByCategory(month.list).forEach(function (c) {
      var ck = 'c:' + month.name + '|' + c.name;
      if (!(ck in state.expanded)) state.expanded[ck] = true;
      groupBySub(c.list).forEach(function (s) {
        var sk = 's:' + month.name + '|' + c.name + '|' + s.name;
        if (!(sk in state.expanded)) state.expanded[sk] = true;
      });
    });
  }

  // 按月份名摊开：点画廊居中卡进详情时用（拿不到 month 对象，只有名字）
  function expandMonthByName(name) {
    var months = groupByMonth(state.entries);
    months.forEach(function (m) { if (m.name === name) expandMonth(m); });
  }

  // 把居中的那张卡滚到正中间。测试桩没有布局，直接跳过
  function galleryJump() {
    var box = document.getElementById('gallery');
    if (!box || typeof box.scrollTo !== 'function' || !box.children) return;
    var card = null;
    Array.prototype.forEach.call(box.children, function (c) {
      if (c.dataset && c.dataset.center) card = c;
    });
    if (!card) return;
    box.scrollLeft = Math.max(0, card.offsetLeft - (box.clientWidth - card.offsetWidth) / 2);
    gallerySync();
  }

  // 滚动/横滑之后，把离中线最近的那张标成居中，顺手记住位置
  function gallerySync() {
    var box = document.getElementById('gallery');
    if (!box || !box.children || !box.children.length) return;
    var mid = box.scrollLeft + box.clientWidth / 2;
    var kids = Array.prototype.slice.call(box.children);
    var best = 0, bestD = Infinity;
    kids.forEach(function (c, i) {
      var d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid);
      if (d < bestD) { bestD = d; best = i; }
    });
    // 按「离中间几张」重新分级，滚起来两侧跟着放大/缩小
    kids.forEach(function (c, i) {
      if (!c.classList) return;
      var cls = galleryCls(i, best);
      c.classList.toggle('is-center', cls === ' is-center');
      c.classList.toggle('d1', cls === ' d1');
      c.classList.toggle('d2', cls === ' d2');
      c.classList.toggle('d3', cls === ' d3');
      // data-center 要跟着滚动一起搬家：点击只认这个标记。
      // 只挪 is-center 的话，横滑后「看着居中的那张」点不进详情，旧的居中卡反而能进
      if (c.dataset) {
        if (i === best) c.dataset.center = '1';
        else delete c.dataset.center;
      }
    });
    var name = galleryCardName(kids[best]);
    if (name && name !== galAt()) galAtSet(name);
  }

  function galleryCardName(card) {
    return card.dataset.galleryMonth || (card.dataset.galleryNew ? NEW_MONTH : null);
  }

  // 点侧边的卡：滑到中间。DOM 不在（测试桩）时退化成重画，让居中标重新落位
  function galleryGoTo(name) {
    galAtSet(name);
    var box = document.getElementById('gallery');
    var card = null;
    if (box && box.children) {
      Array.prototype.forEach.call(box.children, function (c) {
        if (galleryCardName(c) === name) card = c;
      });
    }
    if (!card || typeof box.scrollTo !== 'function') return render();
    box.scrollTo({
      left: Math.max(0, card.offsetLeft - (box.clientWidth - card.offsetWidth) / 2),
      behavior: 'smooth'
    });
  }

  // 鼠标滚轮一格格推：往下/往右看下一个月，往上/往左看上一个月
  function galleryStep(dir) {
    var box = document.getElementById('gallery');
    if (!box || !box.children) return;
    var names = [];
    Array.prototype.forEach.call(box.children, function (c) { names.push(galleryCardName(c)); });
    var i = names.indexOf(galAt());
    if (i === -1) i = 0;
    var j = Math.max(0, Math.min(names.length - 1, i + dir));
    if (j !== i) galleryGoTo(names[j]);
  }

  function renderMonth(month) {
    var key = 'm:' + month.name;
    var open = isOpen(key);
    var income = sum(month.list.filter(function (e) { return e.amount > 0; }));
    var expense = sum(month.list.filter(function (e) { return e.amount < 0; }));
    return '' +
      '<section class="node">' +
        '<div class="row lv1" data-toggle="' + esc(key) + '">' +
          '<span class="chev ' + (open ? 'open' : '') + '"></span>' +
          '<span class="name">' + highlight(month.name) + '</span>' +
          '<span class="spacer"></span>' +
          amtCell(income, 'pos') +
          amtCell(expense, 'neg') +
          '<span class="net ' + tone(income + expense) + '">净 ' + signed(income + expense) + '</span>' +
          '<span class="tail">' +
            (monthLocked(month.name, 'ledger') ? '' :
              '<button type="button" class="icon" data-add="' + esc(key) + '" title="在本月新增">＋</button>') +
          '</span>' +
        '</div>' +
        '<div class="children ' + (open ? '' : 'hidden') + '">' +
          groupByCategory(month.list).map(function (c) { return renderCategory(month.name, c); }).join('') +
        '</div>' +
      '</section>';
  }

  function renderCategory(monthName, category) {
    var key = 'c:' + monthName + '|' + category.name;
    var open = isOpen(key);
    var total = sum(category.list);
    var hasSub = category.list.some(function (e) { return e.sub; });
    var locked = monthLocked(monthName, 'ledger');
    var body = hasSub
      ? groupBySub(category.list).map(function (s) { return renderSub(monthName, category.name, s); }).join('')
      : category.list.slice().sort(byAmount).map(function (e) { return renderLeaf(e, false); }).join('');
    return '' +
      '<div class="node">' +
        '<div class="row lv2" data-toggle="' + esc(key) + '">' +
          '<span class="chev ' + (open ? 'open' : '') + '"></span>' +
          '<span class="name">' + highlight(category.name) + '</span>' +
          '<span class="spacer"></span>' +
          '<span class="amt ' + tone(total) + '">' + signed(total) + '</span>' +
          '<span class="tail">' +
            (locked ? '' :
              '<button type="button" class="icon" data-add="' + esc(key) + '" title="在此分类新增">＋</button>') +
          '</span>' +
        '</div>' +
        '<div class="children ' + (open ? '' : 'hidden') + '">' + body + '</div>' +
      '</div>';
  }

  function renderSub(monthName, categoryName, sub) {
    var key = 's:' + monthName + '|' + categoryName + '|' + sub.name;
    var open = isOpen(key);
    var total = sum(sub.list);
    var locked = monthLocked(monthName, 'ledger');
    return '' +
      '<div class="node sub">' +
        '<div class="row lv3" data-toggle="' + esc(key) + '">' +
          '<span class="chev ' + (open ? 'open' : '') + '"></span>' +
          '<span class="name">' + highlight(sub.name) + '</span>' +
          '<span class="spacer"></span>' +
          '<span class="amt ' + tone(total) + '">' + signed(total) + '</span>' +
          '<span class="tail">' +
            (locked ? '' :
              '<button type="button" class="icon" data-add="' + esc(key) + '" title="在此子类新增">＋</button>') +
          '</span>' +
        '</div>' +
        '<div class="children ' + (open ? '' : 'hidden') + '">' +
          sub.list.slice().sort(byAmount).map(function (e) { return renderLeaf(e, true); }).join('') +
        '</div>' +
      '</div>';
  }

  function renderLeaf(entry, inSub) {
    var field = state.editing && state.editing.id === entry.id ? state.editing.field : null;
    var confirming = state.pendingDelete === entry.id;
    var locked = monthLocked(entry.month || UNSET_MONTH, 'ledger');
    var ops = locked ? ''
      : confirming
        ? '<span class="confirm">删除这一笔？</span>' +
          '<button type="button" class="op danger" data-del-confirm="' + esc(entry.id) + '">是</button>' +
          '<button type="button" class="op" data-del-cancel="1">否</button>'
        : '<button type="button" class="op" data-del="' + esc(entry.id) + '">删除</button>';

    var nameCell = field === 'item'
      ? '<input class="ie" id="ie-item" autocomplete="off" value="' + esc(entry.item || '') + '">'
      : '<span class="name">' + (entry.item ? highlight(entry.item) : '<i class="muted">未命名</i>') + '</span>';

    var amountCell = field === 'amount'
      ? '<input class="ie ie-amt" id="ie-amount" type="number" min="0" step="0.01" value="' +
        Math.abs(entry.amount) + '">'
      : '<span class="amt ' + tone(entry.amount) + '">' + signed(entry.amount) + '</span>';

    return '' +
      '<div class="leaf ' + (inSub ? 'leaf-sub' : 'leaf-cat') + '" data-id="' + esc(entry.id) + '">' +
        '<span class="bullet"></span>' +
        nameCell +
        (field === 'item' ? '' : '<span class="spacer"></span>') +
        amountCell +
        '<span class="tail"><span class="ops ' + (confirming ? 'pinned' : '') + '">' + ops + '</span></span>' +
      '</div>';
  }

  // ---------- 就地编辑 ----------

  // ===== 就地编辑 =====
  function startEdit(id, field) {
    if (monthLocked(entryMonthOf(id), 'ledger')) return lockedToast();
    state.editing = { id: id, field: field };
    render();

    var input = document.getElementById(field === 'item' ? 'ie-item' : 'ie-amount');
    if (!input) return;
    input.focus();
    input.select();

    var done = false;
    function finish(save) {
      if (done) return;
      done = true;
      state.editing = null;
      if (save) saveInline(id, field, input.value);
      else render();
    }

    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', function () { finish(true); });
  }

  function saveInline(id, field, raw) {
    var entry = state.entries.filter(function (e) { return e.id === id; })[0];
    if (!entry) { render(); return; }

    var props, patch;
    if (field === 'item') {
      var item = String(raw).trim();
      if (!item) { toast('明细项不能为空', false); render(); return; }
      if (item === entry.item) { render(); return; }
      props = { '明细项': { title: [{ text: { content: item } }] } };
      patch = { item: item };
    } else {
      if (!String(raw).trim()) { render(); return; }
      var value = Number(raw);
      if (!Number.isFinite(value)) { render(); return; }
      var amount = resolveSign(entry.category, entry.amount).sign * Math.abs(value);
      if (amount === entry.amount) { render(); return; }
      props = { '金额': { number: amount } };
      patch = { amount: amount };
    }

    // 先改本地再发请求，免得请求往返期间又闪回旧值；失败就整体回滚
    var previous = state.entries;
    state.entries = state.entries.map(function (e) {
      return e.id === id ? Object.assign({}, e, patch) : e;
    });
    render();

    setLoading(true);
    notion('/pages/' + id, { method: 'PATCH', body: JSON.stringify({ properties: props }) })
      .then(function (page) {
        var saved = normalize(page);
        state.entries = state.entries.map(function (e) { return e.id === saved.id ? saved : e; });
        render();
        writeCache();
      })
      .catch(function (err) {
        state.entries = previous;
        render();
        toast(err.message, false);
      })
      .then(function () { setLoading(false); });
  }

  // ---------- 数据操作 ----------

  // ===== 刷新与增删 =====
  function refresh() {
    setLoading(true);
    return Promise.all([
      fetchAll(),
      // 预算读不到不影响记账，顶栏那颗读数会自己消失
      fetchBudget().catch(function () { return null; }),
      // 财产是独立数据源，读不到也只是财产视图空着，账本照常
      fetchAssets().catch(function () { return null; }),
      // 纠偏归因同理：读不到就不催归因，纠偏那条照常算出来
      fetchAdjust().catch(function () { return null; })
    ]).then(function (results) {
      state.entries = results[0];
      state.pendingDelete = null;
      render();
      writeCache();
      writeAssetCache();
      // 标签列表来自 schema，读失败也不影响记账，下拉会自动退回条目里的值
      return fetchSubOptions().catch(function () { return null; });
    }).then(function () {
      render();
    }).catch(function (err) {
      toast(err.message, false);
    }).then(function () {
      setLoading(false);
    });
  }

  function removeEntry(id) {
    var entry = state.entries.filter(function (e) { return e.id === id; })[0];
    if (!entry) return;
    setLoading(true);
    notion('/pages/' + id, { method: 'PATCH', body: JSON.stringify({ archived: true }) })
      .then(function () {
        state.entries = state.entries.filter(function (e) { return e.id !== id; });
        state.pendingDelete = null;
        render();
        writeCache();
        toast('已删除「' + (entry.item || '未命名') + '」', true, {
          label: '撤销',
          run: function () { restoreEntry(entry); }
        });
      })
      .catch(function (err) { toast(err.message, false); })
      .then(function () { setLoading(false); });
  }

  function restoreEntry(entry) {
    setLoading(true);
    notion('/pages/' + entry.id, { method: 'PATCH', body: JSON.stringify({ archived: false }) })
      .then(function (page) {
        state.entries.push(normalize(page));
        expandPath(entry);
        render();
        writeCache();
        toast('已恢复');
      })
      .catch(function (err) { toast(err.message, false); })
      .then(function () { setLoading(false); });
  }

  // ---------- 编辑器 ----------
  function prefillFromKey(key) {
    var parts = key.split(':');
    var type = parts[0];
    var rest = (parts[1] || '').split('|');
    if (type === 'm') return { month: rest[0] };
    if (type === 'c') return { month: rest[0], category: rest[1] };
    return { month: rest[0], category: rest[1], sub: rest[2] };
  }

  function signForCategory(name) {
    if (!name) return 0;
    if (name.indexOf('收入') !== -1) return 1;
    if (name.indexOf('支出') !== -1) return -1;
    return 0;
  }

  // 分类能定收支方向时锁定符号：收入分类只能记正数，支出分类只能记负数。
  // 只有已有金额与分类矛盾时（历史数据）才放开，避免悄悄改掉原值。
  function resolveSign(categoryName, storedAmount) {
    var derived = signForCategory(categoryName);
    var storedSign = (storedAmount === undefined || storedAmount === null || !Math.sign(storedAmount))
      ? 0 : Math.sign(storedAmount);
    var locked = derived !== 0 && (storedSign === 0 || storedSign === derived);
    return { sign: locked ? derived : (storedSign || derived || -1), locked: locked, derived: derived };
  }

  function setSign(sign) {
    state.sign = sign;
    Array.prototype.forEach.call(document.querySelectorAll('#f-sign button'), function (btn) {
      btn.classList.toggle('active', Number(btn.dataset.sign) === sign);
    });
  }

  function syncSign(categoryName, storedAmount) {
    var resolved = resolveSign(categoryName, storedAmount);
    state.signLocked = resolved.locked;
    setSign(resolved.sign);
    document.getElementById('f-sign').hidden = resolved.locked;
    var lockEl = document.getElementById('f-sign-lock');
    lockEl.hidden = !resolved.locked;
    if (resolved.locked) {
      lockEl.textContent = resolved.derived > 0 ? '收入' : '支出';
      lockEl.className = 'sign-lock ' + (resolved.derived > 0 ? 'pos' : 'neg');
    }
  }


  // ===== 新增/编辑弹窗 =====
  function toggleNewSubInput(show) {
    var input = document.getElementById('f-sub-new');
    input.hidden = !show;
    if (show) {
      input.value = '';
      setTimeout(function () { input.focus(); }, 0);
    }
  }

  // 子类是全局共享的标签：schema 里的选项 + 历史条目里出现过的值，不按分类过滤
  function refreshSubOptions(current) {
    var subs = subTagNames();
    if (current && subs.indexOf(current) === -1) subs.push(current);

    var sel = document.getElementById('f-sub');
    sel.innerHTML =
      '<option value="">（无子类）</option>' +
      subs.map(function (s) {
        return '<option value="' + esc(s) + '">' + esc(s) + '</option>';
      }).join('') +
      '<option value="' + NEW_SUB + '">＋ 新增子类…</option>';
    sel.value = current && subs.indexOf(current) !== -1 ? current : '';
    toggleNewSubInput(sel.value === NEW_SUB);
  }

  function openEditor(prefill) {
    var categories = CATEGORY_ORDER.slice();
    state.entries.forEach(function (e) {
      if (e.category && categories.indexOf(e.category) === -1) categories.push(e.category);
    });
    document.getElementById('f-category').innerHTML = categories.map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
    }).join('');

    document.getElementById('modal-title').textContent = '新增一笔';
    document.getElementById('f-month').value = prefill.month || monthName(new Date());
    document.getElementById('f-category').value = prefill.category || '常规支出';
    refreshSubOptions(prefill.sub || '');
    document.getElementById('f-item').value = '';

    syncSign(prefill.category || '常规支出', undefined);
    document.getElementById('f-amount').value = '';

    document.getElementById('btn-cancel').textContent = '关闭';
    document.getElementById('btn-save').textContent = '保存并继续';
    document.getElementById('saved-hint').hidden = true;

    modalEl.hidden = false;
    setTimeout(function () {
      document.getElementById('f-item').focus();
    }, 0);
  }

  function closeEditor() {
    modalEl.hidden = true;
  }

  function readForm() {
    var subSel = document.getElementById('f-sub');
    var sub = subSel.value === NEW_SUB
      ? (document.getElementById('f-sub-new').value.trim() || null)
      : (subSel.value || null);
    var sign = state.sign || -1;
    return {
      month: document.getElementById('f-month').value.trim(),
      category: document.getElementById('f-category').value,
      sub: sub,
      item: document.getElementById('f-item').value.trim(),
      amount: sign * Math.abs(Number(document.getElementById('f-amount').value || 0))
    };
  }

  function submitForm() {
    var payload = readForm();
    if (!payload.item) { toast('明细项不能为空', false); return; }
    if (!payload.month) { toast('请填写月份', false); return; }

    var saveBtn = document.getElementById('btn-save');
    saveBtn.disabled = true;
    setLoading(true);

    notion('/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { type: 'data_source_id', data_source_id: settings.dataSourceId },
        properties: buildProps(payload)
      })
    }).then(function (page) {
      var saved = normalize(page);
      state.entries.push(saved);
      expandPath(saved);
      render();
      writeCache();

      document.getElementById('f-item').value = '';
      document.getElementById('f-amount').value = '';
      var hint = document.getElementById('saved-hint');
      hint.hidden = false;
      hint.textContent = '已保存，月份、分类、子类已保留，可继续录入';
      document.getElementById('f-item').focus();
    }).catch(function (err) {
      toast(err.message, false);
    }).then(function () {
      saveBtn.disabled = false;
      setLoading(false);
    });
  }

  // ---------- 新增月份账单 ----------

  // ===== 月份账单 =====
  function billMonth(label) {
    var m = /^(\d{4})年(\d{1,2})月$/.exec(label || '');
    if (!m) return null;
    var mo = Number(m[2]);
    return mo >= 1 && mo <= 12 ? { y: Number(m[1]), mo: mo } : null;
  }

  // 明细项名字里的月号：{本月} 用目标月，{下月} 用目标月的下一个月；月份认不出时留个问号
  // 模板里没写名字的（特殊收入/特殊支出/娱乐支出）就是空行，返回空串
  function billItemName(tpl, label) {
    if (!tpl) return '';
    var at = billMonth(label);
    if (!at) return tpl.replace(/\{本月\}|\{下月\}/g, '?月');
    var next = at.mo === 12 ? { y: at.y + 1, mo: 1 } : { y: at.y, mo: at.mo + 1 };
    return tpl.replace(/\{本月\}/g, at.mo + '月').replace(/\{下月\}/g, next.mo + '月');
  }

  function billItems(label) {
    return MONTH_TEMPLATE.map(function (t) {
      return { category: t.category, item: billItemName(t.item, label) };
    });
  }

  // 空行之间只有分类不同，所以「已存在」要按分类+名字认，不能只按名字
  function monthItemKeys(label) {
    var set = {};
    state.entries.forEach(function (e) {
      if (e.month === label) set[(e.category || '') + '\u0000' + (e.item || '')] = true;
    });
    return set;
  }

  function billTodo(label) {
    var exist = monthItemKeys(label);
    return billItems(label).filter(function (it) {
      return !exist[it.category + '\u0000' + it.item];
    });
  }

  // 默认建「最新月份的下一个月」
  function nextBillMonth() {
    var latest = null;
    state.entries.forEach(function (e) {
      if (monthKey(e.month) === 999999) return;
      if (latest === null || monthKey(e.month) > monthKey(latest)) latest = e.month;
    });
    if (latest === null) return monthName(new Date());
    var at = billMonth(latest);
    var y = at.y;
    var mo = at.mo + 1;
    if (mo > 12) { mo = 1; y += 1; }
    return y + '年' + String(mo).padStart(2, '0') + '月';
  }

  function renderBillPreview() {
    var label = monthInputEl.value.trim();
    var exist = monthItemKeys(label);

    tplListEl.innerHTML = billItems(label).map(function (it) {
      var done = !!exist[it.category + '\u0000' + it.item];
      return '<li' + (done ? ' class="done"' : '') + '>' +
        '<span class="cat">' + esc(it.category) + '</span>' +
        '<span class="name">' + (it.item ? esc(it.item) : '<i class="muted">未命名</i>') + '</span>' +
        '<span class="tag">' + (done ? '已存在' : '待创建') + '</span>' +
      '</li>';
    }).join('');

    var total = state.entries.filter(function (e) { return e.month === label; }).length;
    tplNoteEl.hidden = !total;
    tplNoteEl.textContent = total
      ? '该月已有 ' + total + ' 条记录，模板里同名的项会自动跳过。'
      : '';

    if (!billMonth(label)) {
      monthErrEl.hidden = false;
      monthErrEl.textContent = '月份要能认出年月，才能生成「10月工资」这样的名字。请按 2026年10月 的格式填写。';
      monthCreateBtn.textContent = '创建';
      monthCreateBtn.disabled = true;
      return;
    }

    monthErrEl.hidden = true;
    var todo = billTodo(label);
    monthCreateBtn.textContent = todo.length ? '创建 ' + todo.length + ' 项' : '无需创建';
    monthCreateBtn.disabled = !todo.length;
  }

  function openMonthBill() {
    monthInputEl.value = nextBillMonth();
    tplProgressEl.hidden = true;
    monthCreateBtn.disabled = false;
    renderBillPreview();
    monthMaskEl.hidden = false;
    setTimeout(function () { monthInputEl.focus(); }, 0);
  }

  function closeMonthBill() { monthMaskEl.hidden = true; }

  function createMonthBill() {
    var label = monthInputEl.value.trim();
    if (!billMonth(label)) return renderBillPreview();
    var todo = billTodo(label);
    if (!todo.length) { toast('该月的模板项都已存在'); return; }

    monthErrEl.hidden = true;
    monthCreateBtn.disabled = true;
    monthCancelBtn.disabled = true;
    setLoading(true);

    var created = [];
    var failed = null;

    function step(i) {
      if (i >= todo.length) return Promise.resolve();
      tplProgressEl.hidden = false;
      tplProgressEl.textContent = '正在创建 ' + (i + 1) + '/' + todo.length + ' 项…';
      return notion('/pages', {
        method: 'POST',
        body: JSON.stringify({
          parent: { type: 'data_source_id', data_source_id: settings.dataSourceId },
          // 金额留空：不传 number，之后自己填
          properties: buildProps({
            item: todo[i].item, amount: null, category: todo[i].category, sub: null, month: label
          })
        })
      }).then(function (page) {
        created.push(normalize(page));
        return step(i + 1);
      }).catch(function (err) { failed = err; });
    }

    step(0).then(function () {
      created.forEach(function (entry) { state.entries.push(entry); expandPath(entry); });
      if (created.length) {
        // 建完就把画廊挪到新月份上，一眼看到刚铺的那张卡
        if (state.view === 'month' && !state.monthOpen) {
          state.galleryAt = label;
          localStorage.setItem(KEY_GALLERY_AT, label);
        }
        writeCache();
        render();
      }
      setLoading(false);
      monthCancelBtn.disabled = false;
      tplProgressEl.hidden = true;

      if (failed) {
        // 先重画预览（它会清掉错误行），再写失败提示
        // 已建好的会按名字被认成「已存在」，所以再点一次只会补剩下的，不会重复
        renderBillPreview();
        monthErrEl.hidden = false;
        monthErrEl.textContent = '创建失败：' + failed.message +
          (created.length ? '（已成功 ' + created.length + ' 项，再点一次「创建」可补齐剩下的）' : '');
        return;
      }
      closeMonthBill();
      toast('已建好 ' + label + ' 的账单，共 ' + created.length + ' 项，金额留空待填');
    });
  }

  // ---------- 设置 ----------

  // ===== 设置 =====
  function openSetup(message) {
    document.getElementById('s-token').value = settings.token;
    document.getElementById('s-ds').value = settings.dataSourceId;
    document.getElementById('s-budget').value = settings.budgetSourceId;
    document.getElementById('s-assets').value = settings.assetsSourceId;
    document.getElementById('s-adjust').value = settings.adjustSourceId;
    document.getElementById('s-cancel').hidden = !state.entries.length && !settings.token;
    var errEl = document.getElementById('s-err');
    errEl.hidden = !message;
    errEl.textContent = message || '';
    setupEl.hidden = false;
    setTimeout(function () { document.getElementById('s-token').focus(); }, 0);
  }

  function closeSetup() { setupEl.hidden = true; }

  // ---------- 子类标签管理 ----------

  // ===== 子类标签管理 =====
  function tagUsage() {
    var map = {};
    state.entries.forEach(function (e) {
      if (e.sub) map[e.sub] = (map[e.sub] || 0) + 1;
    });
    return map;
  }

  function renderTags() {
    var usage = tagUsage();
    var names = subTagNames();
    document.getElementById('tag-empty').hidden = names.length > 0;

    document.getElementById('tag-list').innerHTML = names.map(function (name) {
      var used = usage[name] || 0;
      if (state.tagEditing === name) {
        return '<div class="tag-row">' +
          '<input class="tag-input" id="tag-rename" autocomplete="off" value="' + esc(name) + '">' +
          '<span class="ops pinned">' +
            '<button type="button" class="op" data-tag-save="1">保存</button>' +
            '<button type="button" class="op" data-tag-cancel="1">取消</button>' +
          '</span>' +
        '</div>';
      }
      var ops = state.tagConfirm === name
        ? '<span class="confirm">删除？' + (used ? '会清空子类' : '未在使用') + '</span>' +
          '<button type="button" class="op danger" data-tag-del-confirm="' + esc(name) + '">是</button>' +
          '<button type="button" class="op" data-tag-del-cancel="1">否</button>'
        : '<button type="button" class="op" data-tag-rename="' + esc(name) + '">改名</button>' +
          '<button type="button" class="op danger" data-tag-del="' + esc(name) + '">删除</button>';
      return '<div class="tag-row">' +
        '<span class="tag-name">' + esc(name) + '</span>' +
        '<span class="tag-count">' + (used ? '使用中' : '未使用') + '</span>' +
        '<span class="spacer"></span>' +
        '<span class="ops pinned">' + ops + '</span>' +
      '</div>';
    }).join('');
  }

  function tagError(message) {
    var el = document.getElementById('tag-err');
    el.hidden = !message;
    el.textContent = message || '';
  }

  function tagStatus(message) {
    var el = document.getElementById('tag-status');
    el.hidden = !message;
    el.textContent = message || '';
  }

  function openTags() {
    state.tagEditing = null;
    state.tagConfirm = null;
    document.getElementById('tag-new').value = '';
    tagError('');
    tagStatus('');
    renderTags();
    tagsEl.hidden = false;
    setTimeout(function () { document.getElementById('tag-new').focus(); }, 0);
    setLoading(true);
    fetchSubOptions().then(function () { renderTags(); }).catch(function () {})
      .then(function () { setLoading(false); });
  }

  function closeTags() {
    tagsEl.hidden = true;
    state.tagEditing = null;
    state.tagConfirm = null;
  }

  function startTagRename(name) {
    state.tagEditing = name;
    state.tagConfirm = null;
    renderTags();
    var input = document.getElementById('tag-rename');
    if (!input) return;
    input.focus();
    input.select();
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); submitTagRename(); }
      else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();  // 别让 Esc 顺带把整个面板关掉
        state.tagEditing = null;
        renderTags();
      }
    });
  }

  // 逐个改条目，避免一次性打满 Notion 的速率限制
  function eachPage(list, fn) {
    var done = 0;
    function step() {
      if (done >= list.length) return Promise.resolve();
      var entry = list[done++];
      tagStatus('正在处理…');
      return fn(entry).then(step);
    }
    return step();
  }

  function afterTagChange(message) {
    tagStatus('');
    render();
    writeCache();
    renderTags();
    refreshSubOptions(document.getElementById('f-sub').value);
    toast(message);
  }

  // 条目只改了一半时，本地状态会和 Notion 对不上，重新拉一次
  function resyncAfterTagError(err) {
    tagStatus('');
    tagError(err.message);
    return fetchAll().then(function (entries) {
      state.entries = entries;
      render();
      writeCache();
      renderTags();
    }).catch(function () {});
  }

  function createSubTag() {
    var input = document.getElementById('tag-new');
    var name = input.value.trim();
    tagError('');
    if (!name) return tagError('标签名不能为空');
    if (name.indexOf(',') !== -1) return tagError('标签名不能包含逗号');
    if (subTagNames().indexOf(name) !== -1) return tagError('「' + name + '」已经存在');

    setLoading(true);
    putSubTagNames(subTagNames().concat([name]))
      .then(function () {
        input.value = '';
        afterTagChange('已新建标签「' + name + '」');
      })
      .catch(function (err) { tagError(err.message); })
      .then(function () { setLoading(false); });
  }

  function submitTagRename() {
    var oldName = state.tagEditing;
    var input = document.getElementById('tag-rename');
    if (!oldName || !input) return;
    var newName = input.value.trim();
    tagError('');
    if (!newName) return tagError('新名称不能为空');
    if (newName.indexOf(',') !== -1) return tagError('标签名不能包含逗号');
    if (newName === oldName) {
      state.tagEditing = null;
      return renderTags();
    }

    // Notion 的 API 不能重命名已有选项，只能把条目迁到新名字，再把旧选项从 schema 摘掉
    var affected = state.entries.filter(function (e) { return e.sub === oldName; });
    state.tagEditing = null;
    renderTags();
    if (!affected.length) tagStatus('没有条目在用这个标签，直接改名');
    setLoading(true);
    eachPage(affected, function (entry) {
      return notion('/pages/' + entry.id, {
        method: 'PATCH',
        body: JSON.stringify({ properties: { '子类': { select: { name: newName } } } })
      });
    }).then(function () {
      affected.forEach(function (e) { e.sub = newName; });
      var names = subTagNames().filter(function (n) { return n !== oldName; });
      if (names.indexOf(newName) === -1) names.push(newName);
      return putSubTagNames(names);
    }).then(function () {
      afterTagChange('已改名为「' + newName + '」' +
        (affected.length ? '，已同步' : ''));
    }).catch(resyncAfterTagError).then(function () { setLoading(false); });
  }

  // 约定：删除标签时条目保留，只清空它们的子类
  function deleteSubTag(name) {
    var affected = state.entries.filter(function (e) { return e.sub === name; });
    state.tagConfirm = null;
    renderTags();
    setLoading(true);
    eachPage(affected, function (entry) {
      return notion('/pages/' + entry.id, {
        method: 'PATCH',
        body: JSON.stringify({ properties: { '子类': { select: null } } })
      });
    }).then(function () {
      affected.forEach(function (e) { e.sub = null; });
      return putSubTagNames(subTagNames().filter(function (n) { return n !== name; }));
    }).then(function () {
      afterTagChange('已删除标签「' + name + '」' +
        (affected.length ? '，已清空子类' : ''));
    }).catch(resyncAfterTagError).then(function () { setLoading(false); });
  }

  // ---------- 事件 ----------
  treeEl.addEventListener('click', function (event) {
    var target = event.target.closest(
      '[data-toggle],[data-add],[data-del],[data-del-confirm],[data-del-cancel],[data-cmp-toggle],' +
      '[data-adjust-alert],' +
      '[data-gallery-month],[data-gallery-new],[data-gallery-back],[data-center]');
    if (!target) return;
    var data = target.dataset;
    // 纠偏的归因：提醒胶囊点一下就进编辑；已有归因的话双击文字改（dblclick 里处理）
    if (data.adjustAlert) return startAdjustEdit(data.adjustAlert);
    // 画廊：点中间那张进详情/新建，点旁边那张把它挪到中间
    if (data.galleryBack) {
      state.monthOpen = null;
      treeEl.scrollTop = 0;
      return render();
    }
    if (data.galleryMonth) {
      if (data.center) {
        state.monthOpen = data.galleryMonth;
        treeEl.scrollTop = 0;
        // 收支详情是分类树，进去默认摊开；财产/预算详情是平表，没有折叠态要铺
        if (state.sub === 'income') expandMonthByName(data.galleryMonth);
        return render();
      }
      return galleryGoTo(data.galleryMonth);
    }
    if (data.galleryNew) {
      if (data.center) return openMonthBill();
      return galleryGoTo(NEW_MONTH);
    }
    if (data.cmpToggle) {
      if (state.cmpCollapsed[data.cmpToggle]) delete state.cmpCollapsed[data.cmpToggle];
      else state.cmpCollapsed[data.cmpToggle] = true;
      return render();
    }
    if (data.toggle) {
      if (state.expanded[data.toggle]) delete state.expanded[data.toggle];
      else state.expanded[data.toggle] = true;
      return render();
    }
    if (data.add) {
      if (monthLocked(monthOfKey(data.add), 'ledger')) return lockedToast();
      return openEditor(prefillFromKey(data.add));
    }
    if (data.del) {
      if (monthLocked(entryMonthOf(data.del), 'ledger')) return lockedToast();
      state.pendingDelete = data.del;
      return render();
    }
    if (data.delCancel) { state.pendingDelete = null; return render(); }
    if (data.delConfirm) {
      if (monthLocked(entryMonthOf(data.delConfirm), 'ledger')) return lockedToast();
      return removeEntry(data.delConfirm);
    }
  });

  // 一键折叠/展开、导出按钮住在顶栏第二行（子 tab 右侧），不在 #tree 里，单独委托
  barSubEl.addEventListener('click', function (event) {
    var target = event.target.closest('[data-fold-all],[data-export-month]');
    if (!target) return;
    if (target.dataset.exportMonth) return exportMonthSnapshot(state.monthOpen);
    return foldAllToggle();
  });

  // 画廊是横向滚动容器：滚动（含横滑）时同步居中的卡。scroll 不冒泡，用捕获接住
  var galleryLock = 0;
  treeEl.addEventListener('scroll', function (event) {
    if (event.target && event.target.id === 'gallery') gallerySync();
  }, true);

  // 鼠标滚轮竖着滚 → 一格格推画廊，免得只有触控板才滑得动
  treeEl.addEventListener('wheel', function (event) {
    var box = event.target && event.target.closest ? event.target.closest('.gallery') : null;
    if (!box) return;
    var d = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!d) return;
    event.preventDefault();
    var now = Date.now();
    if (now < galleryLock) return;
    galleryLock = now + 420;
    galleryStep(d > 0 ? 1 : -1);
  }, { passive: false });

  // 双击明细行的标题或金额，就地变成输入框；预算格、财产格同样双击才进编辑
  treeEl.addEventListener('dblclick', function (event) {
    var adj = event.target.closest('[data-adjust-open]');
    if (adj) return startAdjustEdit(adj.dataset.adjustOpen);
    var note = event.target.closest('[data-asset-note-app]');
    if (note) {
      return startAssetNoteEdit(note.dataset.assetNoteApp, note.dataset.assetNoteName,
        assetItemNote(note.dataset.assetNoteApp, note.dataset.assetNoteName));
    }
    var asset = event.target.closest('[data-asset-open]');
    if (asset) return startAssetEdit(asset.dataset.assetOpen);
    var budget = event.target.closest('[data-budget-open]');
    if (budget) return startBudgetEdit(budget.dataset.budgetOpen, budget.dataset.field);
    var leaf = event.target.closest('.leaf');
    if (!leaf) return;
    if (event.target.closest('.name')) return startEdit(leaf.dataset.id, 'item');
    if (event.target.closest('.amt')) return startEdit(leaf.dataset.id, 'amount');
  });

  // 预算格、财产格、新增表单：编辑期间只更新草稿，别每敲一下都重画
  treeEl.addEventListener('input', function (event) {
    if (state.budgetEdit) {
      var num = event.target.closest('input[data-budget]');
      if (num) { state.budgetEdit.draft.num = num.value; return; }
      var note = event.target.closest('input[data-budget-note]');
      if (note) { state.budgetEdit.draft.note = note.value; return; }
    }
    if (state.assetsEdit) {
      var box = event.target.closest('input[data-asset-num]');
      if (box) { state.assetsEdit.draft[box.dataset.assetNum] = box.value; return; }
    }
    if (state.assetNoteEdit) {
      var noteBox = event.target.closest('input[data-asset-note]');
      if (noteBox) { state.assetNoteEdit.draft = noteBox.value; return; }
    }
    if (state.adjustEdit) {
      var adjBox = event.target.closest('input[data-adjust-note]');
      if (adjBox) { state.adjustEdit.draft = adjBox.value; return; }
    }
  });

  // 焦点彻底离开这个小面板才写回（在两个输入之间切换不算离开）
  treeEl.addEventListener('focusout', function (event) {
    var next = event.relatedTarget;
    // 纠偏备注的编辑框：详情页挂在 .node.adjust 里，对比视图挂在纠偏格里，两处都先单独认
    var adjEditor = event.target.closest('.node.adjust .editor, td.cmp-adj .editor');
    if (adjEditor) {
      if (next && typeof next.closest === 'function' &&
          next.closest('.node.adjust .editor, td.cmp-adj .editor') === adjEditor) return;
      return commitAdjustNote();
    }
    // 资产项的备注面板挂在首列的 th 上，预算/财产的格子挂在 td 上，分开判断
    var noteCell = event.target.closest('th.cmp-item.editing');
    if (noteCell) {
      if (next && typeof next.closest === 'function' &&
          next.closest('th.cmp-item.editing') === noteCell) return;
      return commitAssetNote();
    }
    var cell = event.target.closest('td.cmp-edit.editing');
    if (!cell) return;
    if (next && typeof next.closest === 'function' && next.closest('td.cmp-edit.editing') === cell) return;
    if (state.assetsEdit) return commitAssetEditor();
    if (state.budgetEdit) return commitBudgetEditor();
  });

  treeEl.addEventListener('keydown', function (event) {
    if (state.adjustEdit) {
      if (!event.target.closest('input[data-adjust-note]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        state.adjustEdit = null;
        return render();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        return commitAdjustNote();
      }
      return;
    }
    if (state.assetNoteEdit) {
      if (!event.target.closest('input[data-asset-note]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        state.assetNoteEdit = null;
        render();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        commitAssetNote();
      }
      return;
    }
    if (state.assetsEdit) {
      if (!event.target.closest('input[data-asset-num]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        state.assetsEdit = null;
        render();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        commitAssetEditor();
      }
      return;
    }
    if (event.target.closest('input[data-asset-num]')) return;
    if (event.target.closest('input[data-adjust-note]')) return;
    if (!state.budgetEdit) return;
    var inEditor = event.target.closest('input[data-budget], input[data-budget-note]');
    if (!inEditor) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      state.budgetEdit = null;
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commitBudgetEditor();
    }
  });

  // 年份下拉住在顶栏第一行，月份区间条住在第二行，各挂各的
  cmpBarEl.addEventListener('change', function (event) {
    var sel = event.target.closest('select.year-select');
    if (sel) setCmpYear(sel.value === CMP_OTHER ? CMP_OTHER : Number(sel.value));
  });

  // 月份区间：点胶囊开合弹层；点第一个月定起点，点第二个月成区间；
  // 「全年」一键复位。选到一半时鼠标划过的月份跟着亮，落点前先看清那一段
  rangeBarEl.addEventListener('click', function (event) {
    if (event.target.closest('[data-range-toggle]')) {
      if (state.rangeOpen) closeRange(); else openRange();
      return;
    }
    if (!event.target.closest('.range-pick')) return;
    if (event.target.closest('[data-range-all]')) {
      closeRange();
      setRange(1, 12);
      return;
    }
    var cell = event.target.closest('[data-rm]');
    if (!cell) return;
    var n = Number(cell.dataset.rm);
    if (state.rangeAnchor === null) { state.rangeAnchor = n; paintRange(); return; }
    var a = Math.min(state.rangeAnchor, n), b = Math.max(state.rangeAnchor, n);
    closeRange();
    setRange(a, b);
  });

  rangeBarEl.addEventListener('mouseover', function (event) {
    if (state.rangeAnchor === null) return;
    var cell = event.target.closest('[data-rm]');
    var n = cell ? Number(cell.dataset.rm) : null;
    if (n === state.rangeHover) return;
    state.rangeHover = n;
    paintRange();
  });

  rangeBarEl.addEventListener('mouseleave', function () {
    if (state.rangeAnchor === null || state.rangeHover === null) return;
    state.rangeHover = null;
    paintRange();
  });

  // 顶栏那把锁：点一下在「锁定历史月份 / 全部可编辑」之间切
  btnLockEl.addEventListener('click', function () { setLocked(!state.locked); });

  // 「说明」：点按钮翻气泡，点别处收起（Esc 走下面的全局 keydown）
  btnHintEl.addEventListener('click', hintToggle);
  document.addEventListener('click', function (event) {
    if (state.hintOpen && !event.target.closest('.hint-wrap')) hintToggle();
    if (state.rangeOpen && !event.target.closest('.range-pick')) closeRange();
  });

  document.getElementById('f-sign').addEventListener('click', function (event) {
    if (state.signLocked) return;
    var btn = event.target.closest('button[data-sign]');
    if (btn) setSign(Number(btn.dataset.sign));
  });

  document.getElementById('f-category').addEventListener('change', function () {
    // 子类列表跟分类无关，换分类不该把已经选好的子类清掉
    refreshSubOptions(document.getElementById('f-sub').value);
    syncSign(this.value, undefined);
  });

  document.getElementById('f-sub').addEventListener('change', function () {
    toggleNewSubInput(this.value === NEW_SUB);
  });

  document.getElementById('form').addEventListener('submit', function (event) {
    event.preventDefault();
    submitForm();
  });

  var searchTimer;
  searchEl.addEventListener('input', function () {
    var value = this.value;
    searchClearEl.hidden = !value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.search = value;
      render();
    }, 160);
  });

  searchClearEl.addEventListener('click', function () {
    searchEl.value = '';
    searchClearEl.hidden = true;
    state.search = '';
    render();
    searchEl.focus();
  });

  document.getElementById('btn-cancel').addEventListener('click', closeEditor);
  // 主 tab「月度 / 总览」：切换即重置子视图、子 tab 回收支；主 tab 本身落盘，
  // 刷新后还停在这一级
  document.getElementById('view-parent').addEventListener('click', function (event) {
    var btn = event.target.closest('button[data-tab]');
    if (!btn) return;
    localStorage.setItem(KEY_VIEW, btn.dataset.tab);
    setTab(btn.dataset.tab);
  });
  // 子 tab「收支 / 财产 / 预算」：总览里换对比内容；月度详情里切当月维度、月份不丢。
  // 子 tab 不落盘，主 tab 一切换就回收支
  document.getElementById('view-sub').addEventListener('click', function (event) {
    var btn = event.target.closest('button[data-sub]');
    if (!btn) return;
    setSub(btn.dataset.sub);
  });
  refreshBtn.addEventListener('click', function () { refresh(); });
  document.getElementById('btn-settings').addEventListener('click', function () { openSetup(); });

  document.getElementById('btn-tags').addEventListener('click', openTags);
  document.getElementById('tag-close').addEventListener('click', closeTags);
  document.getElementById('tag-create').addEventListener('click', createSubTag);
  document.getElementById('tag-new').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); createSubTag(); }
  });

  tagsEl.addEventListener('click', function (event) {
    if (event.target === tagsEl) return closeTags();
    var target = event.target.closest('[data-tag-rename],[data-tag-del],[data-tag-del-confirm],' +
      '[data-tag-del-cancel],[data-tag-save],[data-tag-cancel]');
    if (!target) return;
    var data = target.dataset;
    if (data.tagRename) return startTagRename(data.tagRename);
    if (data.tagCancel) { state.tagEditing = null; return renderTags(); }
    if (data.tagDel) { state.tagConfirm = data.tagDel; return renderTags(); }
    if (data.tagDelCancel) { state.tagConfirm = null; return renderTags(); }
    if (data.tagSave) return submitTagRename();
    if (data.tagDelConfirm) return deleteSubTag(data.tagDelConfirm);
  });

  document.getElementById('s-save').addEventListener('click', function () {
    var token = document.getElementById('s-token').value.trim();
    var ds = document.getElementById('s-ds').value.trim();
    var budgetDs = document.getElementById('s-budget').value.trim();
    var assetsDs = document.getElementById('s-assets').value.trim();
    var adjustDs = document.getElementById('s-adjust').value.trim();
    var errEl = document.getElementById('s-err');
    if (!token) { errEl.hidden = false; errEl.textContent = '请填写集成令牌'; return; }
    if (!ds) { errEl.hidden = false; errEl.textContent = '请填写数据源 ID'; return; }

    settings.token = token;
    settings.dataSourceId = ds;
    settings.budgetSourceId = budgetDs;
    settings.assetsSourceId = assetsDs || DEFAULT_ASSETS_DS;
    settings.adjustSourceId = adjustDs || DEFAULT_ADJUST_DS;
    var saveBtn = document.getElementById('s-save');
    saveBtn.disabled = true;
    setLoading(true);
    fetchAll().then(function (entries) {
      state.entries = entries;
      localStorage.setItem(KEY_TOKEN, token);
      localStorage.setItem(KEY_DS, ds);
      localStorage.setItem(KEY_BUDGET_DS, budgetDs);
      localStorage.setItem(KEY_ASSETS_DS, settings.assetsSourceId);
      localStorage.setItem(KEY_ADJUST_DS, settings.adjustSourceId);
      render();
      writeCache();
      closeSetup();
      toast('已连接');
      fetchSubOptions().catch(function () { return null; });
      fetchBudget().catch(function () { return null; })
        .then(function () { return fetchAssets().catch(function () { return null; }); })
        .then(function () { return fetchAdjust().catch(function () { return null; }); })
        .then(function () { writeAssetCache(); render(); });
    }).catch(function (err) {
      errEl.hidden = false;
      errEl.textContent = err.message;
    }).then(function () {
      saveBtn.disabled = false;
      setLoading(false);
    });
  });

  document.getElementById('s-cancel').addEventListener('click', closeSetup);

  modalEl.addEventListener('click', function (event) {
    if (event.target === modalEl) closeEditor();
  });

  monthCancelBtn.addEventListener('click', closeMonthBill);
  monthInputEl.addEventListener('input', renderBillPreview);
  monthMaskEl.addEventListener('click', function (event) {
    if (event.target === monthMaskEl) closeMonthBill();
  });
  document.getElementById('month-form').addEventListener('submit', function (event) {
    event.preventDefault();
    createMonthBill();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      if (!modalEl.hidden) closeEditor();
      else if (!monthMaskEl.hidden) closeMonthBill();
      else if (!tagsEl.hidden) closeTags();
      else if (!setupEl.hidden) closeSetup();
      else if (state.rangeOpen) closeRange();
      else if (state.hintOpen) hintToggle();
      else if (state.search) {
        searchEl.value = '';
        searchClearEl.hidden = true;
        state.search = '';
        render();
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      searchEl.focus();
      searchEl.select();
    }
  });

  // ---------- 启动 ----------
  (function boot() {
    syncViewButtons();
    syncLockButton();
    var cached = readCache();
    var cachedAssets = readAssetCache();
    if (cached || cachedAssets) {
      if (cached) state.entries = cached.entries;
      if (cachedAssets) {
        state.assets = cachedAssets.assets;
        if (cachedAssets.budgetOpening) state.budgetOpening = cachedAssets.budgetOpening;
        if (cachedAssets.budget) state.budget = cachedAssets.budget;
      }
      render();
    }
    if (!settings.token) {
      if (!cached) render();
      openSetup();
      return;
    }
    refresh();
  })();
})();
