(function () {
  'use strict';

  var CATEGORY_ORDER = ['常规收入', '特殊收入', '常规支出', '特殊支出', '娱乐支出'];
  var UNSET_MONTH = '未标月份';
  var UNSET_CATEGORY = '未分类';
  var UNSET_SUB = '未分子类';
  var NEW_SUB = '__new__';
  var CMP_OTHER = '__other__';   // 对比视图里「月份解析不出年份」的那一档

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
  var KEY_VIEW = 'ledger.view';
  var KEY_INCOME_VIEW = 'ledger.incomeView';
  var KEY_CMP_YEAR = 'ledger.cmpYear';
  var KEY_BUDGET_DS = 'ledger.budgetSourceId';
  var DEFAULT_BUDGET_DS = '6a5dce49-5e88-4713-8cda-19925a5cc3fb';
  var KEY_ASSETS_DS = 'ledger.assetsSourceId';
  var DEFAULT_ASSETS_DS = 'aa5d7d6d-9349-4af1-a193-91c2af0eb26f';
  var KEY_ASSET_CACHE = 'ledger.assetCache';
  var MAX_RETRY = 3;

  // 视图白名单，顺序跟顶栏按钮一致；财产是独立父视图，其余三个归在「收支」下
  var VIEWS = ['tree', 'compare', 'budget', 'assets'];
  var INCOME_VIEWS = ['tree', 'compare', 'budget'];

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

  var settings = {
    token: localStorage.getItem(KEY_TOKEN) || '',
    dataSourceId: localStorage.getItem(KEY_DS) || DEFAULT_DATA_SOURCE,
    budgetSourceId: localStorage.getItem(KEY_BUDGET_DS) || DEFAULT_BUDGET_DS,
    assetsSourceId: localStorage.getItem(KEY_ASSETS_DS) || DEFAULT_ASSETS_DS
  };

  var state = {
    entries: [],
    expanded: {},   // 记录手动展开的节点，默认全部收起
    cmpCollapsed: {}, // 对比视图里收起的分类（默认展开）
    cmpYear: readCmpYear(), // 对比视图当前看哪一年；null = 跟随最新年份
    view: readView(),
    incomeView: readIncomeView(), // 「收支」下最后看的那种子视图，从财产切回来时用
    budget: {},          // 月份 -> { id, specialIn, bonus }
    budgetOpening: { id: null, amount: 0 },
    budgetEdit: null,    // 正在就地编辑的预算格：{ month, field }
    assets: [],          // 财产快照：每行 { id, name, month, app, start, end, note }
    assetsEdit: null,    // 正在就地编辑的财产格：{ id, draft: { start, end } }
    assetsForm: null,    // 财产的新增表单：{ kind: 'item' | 'month', ... }
    assetsYear: null,    // 财产视图当前看哪一年，新增月份时按它铺列
    hintOpen: false,     // 预算/财产视图的「说明」面板是否展开，默认收起
    pendingDelete: null,
    editing: null,  // 正在就地编辑的明细行：{ id, field: 'item' | 'amount' }
    search: '',
    savedCount: 0,
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
  var totalsEl = document.getElementById('totals');
  var countEl = document.getElementById('count');
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

  function monthLabel(date) {
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

  // ---------- 分组 ----------
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

  function readCmpYear() {
    var raw = localStorage.getItem(KEY_CMP_YEAR);
    if (raw === CMP_OTHER) return CMP_OTHER;
    var n = Number(raw);
    return raw && isFinite(n) ? n : null;   // null = 跟随最新年份
  }

  function readView() {
    var raw = localStorage.getItem(KEY_VIEW);
    return VIEWS.indexOf(raw) === -1 ? 'tree' : raw;
  }

  function readIncomeView() {
    var raw = localStorage.getItem(KEY_INCOME_VIEW);
    return INCOME_VIEWS.indexOf(raw) === -1 ? 'tree' : raw;
  }

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

  // 行 = 分类 + 子类两层，列 = 该年内的月份（正序）+ 合计
  function buildComparison(entries) {
    var seen = {}, months = [];
    entries.forEach(function (e) {
      var m = e.month || UNSET_MONTH;
      if (!seen[m]) { seen[m] = true; months.push(m); }
    });
    months.sort(function (a, b) { return monthKey(a) - monthKey(b); });

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

  function renderCmpBar(years, active) {
    cmpBarEl.hidden = !years.length;
    cmpBarEl.innerHTML = years.map(function (y) {
      return '<button type="button" data-cmp-year="' + esc(String(y)) + '"' +
        (y === active ? ' class="active"' : '') + '>' +
        (y === CMP_OTHER ? '未标月份' : y) + '</button>';
    }).join('');
  }

  // entries 已经裁到某一年，这里只负责把该年的月份铺成列
  function renderCompare(entries) {
    var data = buildComparison(entries);
    if (!data.months.length) return '';

    var head = '<tr><th class="cmp-item"><span class="cell">项目</span></th>' +
      data.months.map(function (m) {
        return '<th class="cmp-month">' + monthHead(m) + '</th>';
      }).join('') +
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

    // 分类有收有支，同一年内纵向加起来就是当月净额
    var netValues = data.months.map(function (m, i) {
      return sumArr(data.rows.map(function (r) { return r.values[i]; }));
    });
    var netRow = '<tr class="cmp-net">' +
      '<th class="cmp-item"><span class="cell"><span class="name">净额</span></span></th>' +
      netValues.map(function (v) { return '<td>' + cmpCell(v) + '</td>'; }).join('') +
      '<td class="cmp-total">' + cmpCell(sumArr(netValues)) + '</td>' +
    '</tr>';

    return '<table class="cmp"><thead>' + head + '</thead><tbody>' +
      body + netRow + '</tbody></table>';
  }

  function setCmpYear(year) {
    state.cmpYear = year;
    localStorage.setItem(KEY_CMP_YEAR, String(year));
    render();
  }

  // 父级只标「收支 / 财产」，子级只标当前那一个；看财产时子级整条收起
  function syncViewButtons() {
    var parent = state.view === 'assets' ? 'assets' : 'income';
    Array.prototype.forEach.call(document.querySelectorAll('#view-parent button'), function (btn) {
      btn.classList.toggle('active', btn.dataset.parent === parent);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#view-sub button'), function (btn) {
      btn.classList.toggle('active', btn.dataset.view === state.view);
    });
    document.getElementById('view-sub').hidden = state.view === 'assets';
  }

  function setView(view) {
    state.view = VIEWS.indexOf(view) === -1 ? 'tree' : view;
    state.hintOpen = false;   // 换视图就把说明收回去，默认不铺开
    localStorage.setItem(KEY_VIEW, state.view);
    if (INCOME_VIEWS.indexOf(state.view) !== -1) {
      state.incomeView = state.view;
      localStorage.setItem(KEY_INCOME_VIEW, state.view);
    }
    syncViewButtons();
    render();
  }

  // ---------- 娱乐预算 ----------
  // 数字后面跟着的那句说明，悬停时显示，双击时能改
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

  // 平时是纯文本，有说明就带虚线下划线（悬停出气泡）；双击展开「数字 + 说明」小面板
  function budgetInput(row, field) {
    var names = budgetFieldNames(field);
    var value = row.cfg[field] || 0;
    var note = row.cfg[names.noteKey] || '';
    var editing = state.budgetEdit &&
      state.budgetEdit.month === row.month && state.budgetEdit.field === field;

    // 进项走收入色（红）：这两笔都是往池子里加钱
    var shown = '<span class="v ' + tone(value) + '">' +
      (value ? money(value) : '<span class="zero">—</span>') + '</span>';

    if (editing) {
      return '<td class="cmp-edit editing">' + shown +
        '<span class="editor">' +
          '<label><span>数字</span><input type="number" step="1" placeholder="0"' +
            ' value="' + (value ? esc(String(value)) : '') + '"' +
            ' data-budget="' + esc(row.month) + '" data-field="' + field + '"></label>' +
          '<label><span>说明</span><input type="text" placeholder="这笔钱由什么组成，用 + 分隔"' +
            ' value="' + esc(note) + '"' +
            ' data-budget-note="' + esc(row.month) + '" data-field="' + field + '"></label>' +
        '</span></td>';
    }

    return '<td class="cmp-edit' + (note ? ' has-note' : '') + '"' +
      ' data-budget-open="' + esc(row.month) + '" data-field="' + field + '"' +
      '>' + shown + (note ? '<span class="tip">' + tipHtml(noteLines(note)) + '</span>' : '') + '</td>';
  }

  // 说明面板默认收起：一段解释压在表格上面太占地，收进「说明」按钮里，要看再点
  function hintPanel(html) {
    return '<div class="hint-panel"' + (state.hintOpen ? '' : ' hidden') + '>' + html + '</div>';
  }

  function hintToggle() {
    return '<button type="button" class="tool" data-hint-toggle="1"' +
      (state.hintOpen ? ' aria-expanded="true"' : '') + '>说明</button>';
  }

  function budgetHint() {
    return hintPanel('<p class="budget-hint">' +
      '本月预算 = 1500 + 100 × 法定假日天数 + 上月结余 + 偶发加成；' +
      '本月结余 = 预算 − 本月花销 + 特殊收入计入。' +
      '本月花销 = 「娱乐支出」分类合计 + 「特殊支出」分类合计/2。' +
      '法定假日按国家法定节假日天数算（国庆 3 天，不是放假 7 天）。' +
      '「特殊收入计入」「偶发加成」双击可改（数字和说明一起改）；' +
      '数字下带虚线的格子，鼠标停上去能看到明细——「本月花销」那格会拆开告诉你娱乐和特殊各占多少。' +
      '虚线那行是下月预告，仅供参考，不算记录。</p>');
  }

  function renderBudget(data, year) {
    if (!data || !data.rows.length) {
      return '<p class="budget-hint">' +
        (year === null ? '还没有数据。' : year + ' 年还没有可推算的月份。') +
        '娱乐预算从 ' + esc(OPENING_MONTH) + ' 的结余往后滚，先在月份视图记几笔就有了。</p>';
    }

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
        '<th class="cmp-item"><span class="cell"><span class="name">' + esc(monthLabel(row.month)) + '</span></span></th>' +
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

    return budgetBar() + budgetHint() + '<table class="cmp budget"><thead>' + head + '</thead><tbody>' +
      openingRow + body + previewRow + '</tbody></table>';
  }

  // 预算没有别的工具，这条只有右侧一个「说明」
  function budgetBar() {
    return '<div class="view-bar"><span class="view-bar-tools">' + hintToggle() + '</span></div>';
  }

  // 顶栏读数取最后一个有数据的月份的结余
  function lastRealBudget(data) {
    if (!data || !data.rows.length) return null;
    return data.rows[data.rows.length - 1];
  }

  // 双击预算格才进编辑态
  function startBudgetEdit(month, field) {
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
  // 每月一笔资产快照（月初 / 月末）。「公积金」那部分取不出来，看「能动的钱」时得剔掉，
  // 所以两个总计都给：含公积金、不含公积金。
  var ASSET_APP_ORDER = ['招商银行', '支付宝', '微信', '公积金', '证券'];
  var ASSET_RESERVED = '公积金';

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
      start: num('月初'),
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

  function buildAssets(year) {
    var months = assetMonths(year);
    if (!months.length) return { months: [], groups: [], totals: [] };

    // 同一个「应用 + 类型」在各月各有一条记录，按月份攒成一行
    var index = {};
    state.assets.forEach(function (a) {
      if (months.indexOf(a.month) === -1 || !a.name) return;
      var key = a.app + '|' + a.name;
      var item = index[key] || (index[key] = { app: a.app, name: a.name, byMonth: {} });
      item.byMonth[a.month] = { id: a.id, start: a.start, end: a.end };
    });

    var items = Object.keys(index).map(function (k) {
      var it = index[k];
      return {
        app: it.app,
        name: it.name,
        // 每列对应的那条记录（没有就是 null），就地编辑要拿它的 id 和原值
        cells: months.map(function (m) { return it.byMonth[m] || null; }),
        values: months.map(function (m) {
          var c = it.byMonth[m];
          return c ? c.end : null;
        })
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
        { label: '总资产（含公积金）', values: columnSums(items, months.length) },
        { label: '总资产（不含公积金）', values: columnSums(items.filter(function (it) {
            return it.app !== ASSET_RESERVED;
          }), months.length) }
      ]
    };
  }

  function assetNum(value) {
    return value === null || value === undefined
      ? '<span class="zero">—</span>' : money(value);
  }

  // 变化 = 最后一个月 − 第一个月；涨红跌绿，跟账本里一个规矩
  function assetDelta(values) {
    if (values.length < 2) return '<span class="zero">—</span>';
    var d = values[values.length - 1] - values[0];
    if (!d) return '<span class="zero">—</span>';
    return '<span class="' + tone(d) + '">' + signed(d) + '</span>';
  }

  // 明细格：平时只显月末，双击展开「月初 + 月末」两个输入框
  function assetCell(item, cell) {
    if (!cell) return '<td><span class="zero">—</span></td>';
    var shown = assetNum(cell.end);
    if (state.assetsEdit && state.assetsEdit.id === cell.id) {
      function box(field, label, value) {
        return '<label><span>' + label + '</span><input type="number" step="1" placeholder="0"' +
          ' value="' + (value === null || value === undefined ? '' : esc(String(value))) + '"' +
          ' data-asset-num="' + field + '"></label>';
      }
      return '<td class="cmp-edit editing">' + shown +
        '<span class="editor">' +
          box('start', '月初', cell.start) +
          box('end', '月末', cell.end) +
        '</span></td>';
    }
    return '<td class="cmp-edit" data-asset-open="' + esc(cell.id) + '"' +
      ' title="双击改月初 / 月末">' + shown + '</td>';
  }

  function assetForm(form) {
    var months = form.months;
    var apps = ASSET_APP_ORDER.slice();
    state.assets.forEach(function (a) {
      if (a.app && apps.indexOf(a.app) === -1) apps.push(a.app);
    });
    var list = '<datalist id="asset-apps">' + apps.map(function (a) {
      return '<option value="' + esc(a) + '"></option>';
    }).join('') + '</datalist>';

    var save = '<button type="button" data-asset-form-save="1">创建</button>' +
      '<button type="button" data-asset-form-cancel="1">取消</button>';

    if (form.kind === 'item') {
      return list + '<div class="assets-form">' +
        '<label><span>应用</span><input id="asset-app" list="asset-apps" autocomplete="off"' +
          ' data-asset-field="app" placeholder="招商银行" value="' + esc(form.app) + '"></label>' +
        '<label><span>名称</span><input id="asset-name" autocomplete="off"' +
          ' data-asset-field="name" placeholder="活期存款" value="' + esc(form.name) + '"></label>' +
        // 一个月都还没有时，得先告诉它记到哪个月
        (months.length ? '' :
          '<label><span>月份</span><input id="asset-month" list="months" autocomplete="off"' +
            ' data-asset-field="month" placeholder="2026年10月" value="' + esc(form.month) + '"></label>') +
        '<span class="assets-form-tip">' +
          (months.length ? '给 ' + months.length + ' 个月各建一行，金额留空待填' : '先建一行，之后再补别的月份') +
        '</span>' + save + '</div>';
    }

    return list + '<div class="assets-form">' +
      '<label><span>月份</span><input id="asset-month" list="months" autocomplete="off"' +
        ' data-asset-field="month" placeholder="2026年10月" value="' + esc(form.month) + '"></label>' +
      '<span class="assets-form-tip">照抄 ' + esc(form.from) + ' 的全部资产项，月初自动接上月末</span>' +
      save + '</div>';
  }

  // withHint 只在有表可讲时才给「说明」按钮，空表旁边挂个点不动的按钮没意义
  function assetBar(months, withHint) {
    return '<div class="view-bar">' +
      '<span class="view-progress" id="asset-progress" hidden></span>' +
      '<span class="view-bar-tools">' +
        (months.length
          ? '<button type="button" class="tool" data-asset-tool="month">＋ 新增月份</button>' : '') +
        '<button type="button" class="tool" data-asset-tool="item">＋ 新增资产项</button>' +
        (withHint ? hintToggle() : '') +
      '</span></div>';
  }

  function assetsHint() {
    return hintPanel('<p class="assets-hint">' +
      '每月一笔资产快照，格子里的数字是「月末」余额；双击格子能改「月初」「月末」，回车或点到别处就存下。' +
      '「总资产（含公积金）」把公积金账户算进来，「总资产（不含公积金）」只看能动用的钱——' +
      '公积金取不出来，两个口径都留着。' +
      '「较上月」是含公积金总资产的环比增量，「变化」那一列是首尾两个月之间涨跌了多少。' +
      '「＋ 新增月份」照上个月的样子铺一份新月，「＋ 新增资产项」给每个已有月份各加一行；' +
      '明细行左边的 × 会把这一项在各月的记录一起删掉，删错了能撤销。</p>');
  }

  function renderAssets(year) {
    state.assetsYear = year;
    var data = buildAssets(year);
    if (!data.months.length) {
      return assetBar([], false) +
        '<p class="assets-hint">' +
        (year === null ? '还没有财产数据。' : year + ' 年还没有财产记录。') +
        '财产存在独立的「我的财产」数据源里，点「＋ 新增资产项」记第一行。</p>' +
        (state.assetsForm ? assetForm(state.assetsForm) : '');
    }

    var head = '<tr>' +
      '<th class="cmp-item"><span class="cell"><span class="name">资产项</span></span></th>' +
      data.months.map(function (m) {
        return '<th class="cmp-month">' + monthHead(m) + '</th>';
      }).join('') +
      '<th class="cmp-total">变化</th></tr>';

    var body = data.groups.map(function (g) {
      var groupRow = '<tr class="cmp-cat">' +
        '<th class="cmp-item"><span class="cell">' +
          '<span class="chev ghost"></span>' +
          '<span class="name">' + esc(g.app) + '</span>' +
        '</span></th>' +
        g.values.map(function (v) { return '<td>' + assetNum(v) + '</td>'; }).join('') +
        '<td class="cmp-total">' + assetDelta(g.values) + '</td>' +
      '</tr>';

      var itemRows = g.items.map(function (it) {
        return '<tr class="cmp-sub">' +
          '<th class="cmp-item"><span class="cell">' +
            '<span class="indent"></span>' +
            '<span class="name">' + esc(it.name) + '</span>' +
            '<button type="button" class="asset-del" title="删掉这个资产项"' +
              ' data-asset-del-app="' + esc(it.app) + '"' +
              ' data-asset-del-name="' + esc(it.name) + '">×</button>' +
          '</span></th>' +
          it.cells.map(function (c) { return assetCell(it, c); }).join('') +
          '<td class="cmp-total">' + assetDelta(it.values) + '</td>' +
        '</tr>';
      }).join('');

      return groupRow + itemRows;
    }).join('');

    var sumRows = data.totals.map(function (t) {
      return '<tr class="assets-sum">' +
        '<th class="cmp-item"><span class="cell"><span class="name">' + esc(t.label) +
        '</span></span></th>' +
        t.values.map(function (v) { return '<td>' + assetNum(v) + '</td>'; }).join('') +
        '<td class="cmp-total">' + assetDelta(t.values) + '</td>' +
      '</tr>';
    }).join('');

    // 环比：这个月比上个月多了多少，跟「月度理财总览」里的资产增量一个意思
    var main = data.totals[0].values;
    var deltaRow = '<tr class="assets-delta">' +
      '<th class="cmp-item"><span class="cell"><span class="name">较上月</span></span></th>' +
      main.map(function (v, i) {
        if (i === 0) return '<td><span class="zero">—</span></td>';
        var d = v - main[i - 1];
        if (!d) return '<td><span class="zero">—</span></td>';
        return '<td><span class="' + tone(d) + '">' + signed(d) + '</span></td>';
      }).join('') +
      '<td class="cmp-total"><span class="zero">—</span></td></tr>';

    return assetBar(data.months, true) + assetsHint() +
      (state.assetsForm ? assetForm(state.assetsForm) : '') +
      '<table class="cmp assets"><thead>' + head + '</thead><tbody>' +
      body + sumRows + deltaRow + '</tbody></table>';
  }

  // ---------- 财产的增改 ----------
  function assetMonthsInView() {
    return buildAssets(state.assetsYear).months;
  }

  function setAssetProgress(text) {
    var el = document.getElementById('asset-progress');
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || '';
  }

  // 双击格子：草稿先记着，等焦点离开整块小面板再一次性比对、只写改过的那几个字段
  function startAssetEdit(id) {
    var row = state.assets.filter(function (a) { return a.id === id; })[0];
    if (!row) return;
    state.assetsEdit = { id: id, draft: { start: row.start, end: row.end } };
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
    var start = num(edit.draft.start);
    var end = num(edit.draft.end);
    var props = {};
    if (start !== row.start) props['月初'] = { number: start };
    if (end !== row.end) props['月末'] = { number: end };
    if (!Object.keys(props).length) return render();
    saveAsset(edit.id, props);
  }

  function saveAsset(id, props) {
    var before = state.assets;
    // 先落本地再发请求，免得往返期间闪回旧值；失败整体回滚
    state.assets = state.assets.map(function (a) {
      if (a.id !== id) return a;
      var next = Object.assign({}, a);
      if ('月初' in props) next.start = props['月初'].number;
      if ('月末' in props) next.end = props['月末'].number;
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

  function assetPost(props) {
    return notion('/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { type: 'data_source_id', data_source_id: settings.assetsSourceId },
        properties: props
      })
    });
  }

  // 删一个资产项 = 把它在各月的记录一起归档，撤销时整批恢复
  function removeAssetItem(app, name) {
    var ids = state.assets.filter(function (a) { return a.app === app && a.name === name; })
      .map(function (a) { return a.id; });
    if (!ids.length) return;
    var done = [];
    setLoading(true);

    function step(i) {
      if (i >= ids.length) return Promise.resolve();
      setAssetProgress('正在删除 ' + (i + 1) + '/' + ids.length + ' 条…');
      return notion('/pages/' + ids[i], { method: 'PATCH', body: JSON.stringify({ archived: true }) })
        .then(function () { done.push(ids[i]); return step(i + 1); });
    }

    function settle(message) {
      state.assets = state.assets.filter(function (a) { return done.indexOf(a.id) === -1; });
      setAssetProgress('');
      render();
      setLoading(false);
      if (message) toast(message, false);
      else toast('已删除「' + name + '」', true, {
        label: '撤销',
        run: function () { restoreAssetRows(done); }
      });
    }

    step(0).then(function () { settle(null); })
      .catch(function (err) { settle('删除「' + name + '」失败：' + err.message); });
  }

  function restoreAssetRows(ids) {
    setLoading(true);
    function step(i) {
      if (i >= ids.length) return Promise.resolve();
      return notion('/pages/' + ids[i], { method: 'PATCH', body: JSON.stringify({ archived: false }) })
        .then(function () { return step(i + 1); });
    }
    step(0).then(function () { return fetchAssets(); })
      .then(function () { render(); toast('已恢复 ' + ids.length + ' 条'); })
      .catch(function (err) { toast(err.message, false); })
      .then(function () { setLoading(false); });
  }

  function createAssetItem(app, name, months) {
    app = String(app || '').trim();
    name = String(name || '').trim();
    if (!app || !name) { toast('应用和名称都要填', false); return; }
    if (state.assets.some(function (a) {
      return a.app === app && a.name === name && months.indexOf(a.month) !== -1;
    })) { toast('「' + name + '」已经在了', false); return; }

    state.assetsForm = null;
    render();
    setLoading(true);
    var created = [];
    var failed = null;

    function step(i) {
      if (i >= months.length) return Promise.resolve();
      setAssetProgress('正在创建 ' + (i + 1) + '/' + months.length + ' 个月…');
      return assetPost({
        '类型': { title: [{ text: { content: name } }] },
        '应用': { select: { name: app } },
        '月份': { select: { name: months[i] } },
        '月初': { number: null },
        '月末': { number: null },
        '备注': { rich_text: [] }
      }).then(function (page) {
        created.push(normalizeAsset(page));
        return step(i + 1);
      }).catch(function (err) { failed = err; });
    }

    step(0).then(function () {
      created.forEach(function (a) { state.assets.push(a); });
      setAssetProgress('');
      render();
      setLoading(false);
      if (failed) {
        toast('「' + name + '」建到一半失败：' + failed.message +
          (created.length ? '（已建 ' + created.length + ' 个月，再点一次可补齐）' : ''), false);
      } else {
        toast('已加「' + name + '」，' + created.length + ' 个月各一行，金额待填');
      }
    });
  }

  function createAssetMonth(label, months) {
    label = String(label || '').trim();
    if (!/^\d{4}年\d{1,2}月$/.test(label)) { toast('月份要写成 2026年10月 这样', false); return; }
    var before = months.filter(function (m) { return monthKey(m) < monthKey(label); });
    var from = before.length ? before[before.length - 1] : null;
    if (!from) { toast('「' + label + '」前面没有可照抄的月份', false); return; }

    var have = {};
    state.assets.forEach(function (a) {
      if (a.month === label && a.name) have[a.app + '|' + a.name] = true;
    });
    // 已经有的项跳过，所以重复点不会写重，中途失败也能再点一次补齐
    var src = state.assets.filter(function (a) {
      return a.month === from && a.name && !have[a.app + '|' + a.name];
    });
    if (!src.length) { toast('「' + label + '」已经齐了'); return; }

    state.assetsForm = null;
    render();
    setLoading(true);
    var created = [];
    var failed = null;

    function step(i) {
      if (i >= src.length) return Promise.resolve();
      setAssetProgress('正在创建 ' + (i + 1) + '/' + src.length + ' 项…');
      return assetPost({
        '类型': { title: [{ text: { content: src[i].name } }] },
        '应用': { select: { name: src[i].app } },
        '月份': { select: { name: label } },
        // 月初接上月末，省得再填一遍
        '月初': { number: src[i].end },
        '月末': { number: null },
        '备注': { rich_text: [] }
      }).then(function (page) {
        created.push(normalizeAsset(page));
        return step(i + 1);
      }).catch(function (err) { failed = err; });
    }

    step(0).then(function () {
      created.forEach(function (a) { state.assets.push(a); });
      setAssetProgress('');
      render();
      setLoading(false);
      if (failed) {
        toast('「' + label + '」建到一半失败：' + failed.message +
          (created.length ? '（已建 ' + created.length + ' 项，再点一次可补齐）' : ''), false);
      } else {
        toast('已铺好「' + label + '」，' + created.length + ' 项，月初已接上月末');
      }
    });
  }

  function openAssetForm(kind, months) {
    if (kind === 'month') {
      var label = '';
      if (months.length) {
        var m = /^(\d{4})年(\d{1,2})月$/.exec(months[months.length - 1]);
        if (m) {
          var y = Number(m[1]), mo = Number(m[2]) + 1;
          if (mo > 12) { mo = 1; y += 1; }
          label = y + '年' + String(mo).padStart(2, '0') + '月';
        }
      }
      var before = months.filter(function (m2) { return monthKey(m2) < monthKey(label); });
      state.assetsForm = {
        kind: 'month', months: months.slice(), month: label,
        from: before.length ? before[before.length - 1] : (months[months.length - 1] || '')
      };
    } else {
      state.assetsForm = {
        kind: 'item', months: months.slice(), app: '', name: '',
        month: months.length ? months[months.length - 1] : ''
      };
    }
    render();
    var input = typeof treeEl.querySelector === 'function'
      ? treeEl.querySelector('input[data-asset-field]') : null;
    if (input) { input.focus(); input.select(); }
  }

  function submitAssetForm() {
    var form = state.assetsForm;
    if (!form) return;
    if (form.kind === 'item') {
      var months = form.months.length ? form.months : [String(form.month || '').trim()];
      if (!/^\d{4}年\d{1,2}月$/.test(months[0])) { toast('月份要写成 2026年10月 这样', false); return; }
      createAssetItem(form.app, form.name, months);
    } else {
      createAssetMonth(form.month, form.months);
    }
  }

  // ---------- 渲染 ----------
  function amtCell(value, cls) {
    if (!value) return '<span class="amt zero">—</span>';
    return '<span class="amt ' + cls + '">' + signed(value) + '</span>';
  }

  function render() {
    var all = state.entries;
    var entries = visibleEntries();
    var searching = !!state.search.trim();
    var mode = state.view;

    // 以年为界：年份切换栏、顶部总计、笔数和内容都收在同一年里，数字才不会互相打架
    var years = cmpYears(entries);
    var year = years.length
      ? (years.indexOf(state.cmpYear) !== -1 ? state.cmpYear : years[0])
      : null;
    renderCmpBar(years, year);

    var scoped = year !== null ? scopeToYear(entries, year) : entries;
    var yearName = year === null ? '' : (year === CMP_OTHER ? '未标月份' : year + ' 年');

    // 预算只按年份过滤，不受搜索影响
    var yearEntries = year !== null ? scopeToYear(all, year) : all;
    var budgetData = buildBudget(yearEntries, year);
    var budgetLast = lastRealBudget(budgetData);

    emptyEl.hidden = scoped.length > 0 || mode === 'assets';
    if (mode === 'assets') {
      // 财产跟账本走的是两套数据，账本为空不代表没财产，这里不摆「还没有数据」
      countEl.textContent = yearName ? yearName + ' · 财产' : '财产';
    } else if (searching) {
      countEl.textContent = '匹配 ' + scoped.length + ' 笔';
      if (!scoped.length) emptyEl.textContent = '没有匹配「' + state.search.trim() + '」的记录。';
    } else if (year !== null) {
      countEl.textContent = yearName + ' · ' + scoped.length + ' 笔';
      emptyEl.textContent = '还没有数据，点上方「新增月份账单」开始记录。';
    } else {
      countEl.textContent = '';
      emptyEl.textContent = '还没有数据，点上方「新增月份账单」开始记录。';
    }

    var income = sum(scoped.filter(function (e) { return e.amount > 0; }));
    var expense = sum(scoped.filter(function (e) { return e.amount < 0; }));
    if (mode === 'assets') {
      // 财产视图不看收支，顶栏换成最新一个月的两个口径总资产
      var assetTop = buildAssets(year);
      var at = assetTop.months.length - 1;
      totalsEl.innerHTML = at < 0 ? '' :
        '<span class="chip"><b>含公积金</b><i>' + money(assetTop.totals[0].values[at]) + '</i></span>' +
        '<span class="chip"><b>不含公积金</b><i>' + money(assetTop.totals[1].values[at]) + '</i></span>';
    } else {
      totalsEl.innerHTML =
        '<span class="chip"><b>收入</b><i class="pos">' + signed(income) + '</i></span>' +
        '<span class="chip"><b>支出</b><i class="neg">' + signed(expense) + '</i></span>' +
        '<span class="chip"><b>' + (searching ? '匹配净额' : '净额') + '</b><i class="' +
        tone(income + expense) + '">' + signed(income + expense) + '</i></span>' +
        (budgetLast
          ? '<span class="chip budget"><b>娱乐结余</b><i class="' + tone(budgetLast.remain) + '">' +
            signed(budgetLast.remain) + '</i></span>'
          : '');
    }

    treeEl.className = 'tree' + (mode === 'compare' ? ' compare'
      : mode === 'budget' ? ' budget' : mode === 'assets' ? ' assets' : '');
    treeEl.innerHTML = mode === 'compare'
      ? renderCompare(scoped)
      : mode === 'budget'
        ? renderBudget(budgetData, year)
        : mode === 'assets'
          ? renderAssets(year)
          : groupByMonth(scoped).map(renderMonth).join('');

    var today = new Date();
    var nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    var options = [];
    groupByMonth(all).forEach(function (m) {
      if (m.name !== UNSET_MONTH && options.indexOf(m.name) === -1) options.push(m.name);
    });
    [monthLabel(nextMonth), monthLabel(today)].forEach(function (m) {
      if (options.indexOf(m) === -1) options.push(m);
    });
    document.getElementById('months').innerHTML = options.map(function (m) {
      return '<option value="' + esc(m) + '">';
    }).join('');
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
          '<span class="tail"><button type="button" class="icon" data-add="' + esc(key) + '" title="在本月新增">＋</button></span>' +
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
          '<span class="tail"><button type="button" class="icon" data-add="' + esc(key) + '" title="在此分类新增">＋</button></span>' +
        '</div>' +
        '<div class="children ' + (open ? '' : 'hidden') + '">' + body + '</div>' +
      '</div>';
  }

  function renderSub(monthName, categoryName, sub) {
    var key = 's:' + monthName + '|' + categoryName + '|' + sub.name;
    var open = isOpen(key);
    var total = sum(sub.list);
    return '' +
      '<div class="node sub">' +
        '<div class="row lv3" data-toggle="' + esc(key) + '">' +
          '<span class="chev ' + (open ? 'open' : '') + '"></span>' +
          '<span class="name">' + highlight(sub.name) + '</span>' +
          '<span class="spacer"></span>' +
          '<span class="amt ' + tone(total) + '">' + signed(total) + '</span>' +
          '<span class="tail"><button type="button" class="icon" data-add="' + esc(key) + '" title="在此子类新增">＋</button></span>' +
        '</div>' +
        '<div class="children ' + (open ? '' : 'hidden') + '">' +
          sub.list.slice().sort(byAmount).map(function (e) { return renderLeaf(e, true); }).join('') +
        '</div>' +
      '</div>';
  }

  function renderLeaf(entry, inSub) {
    var field = state.editing && state.editing.id === entry.id ? state.editing.field : null;
    var confirming = state.pendingDelete === entry.id;
    var ops = confirming
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
  function startEdit(id, field) {
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
  function refresh() {
    setLoading(true);
    return Promise.all([
      fetchAll(),
      // 预算读不到不影响记账，顶栏那颗读数会自己消失
      fetchBudget().catch(function () { return null; }),
      // 财产是独立数据源，读不到也只是财产视图空着，账本照常
      fetchAssets().catch(function () { return null; })
    ]).then(function (results) {
      state.entries = results[0];
      state.pendingDelete = null;
      render();
      writeCache();
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
    state.savedCount = 0;

    var categories = CATEGORY_ORDER.slice();
    state.entries.forEach(function (e) {
      if (e.category && categories.indexOf(e.category) === -1) categories.push(e.category);
    });
    document.getElementById('f-category').innerHTML = categories.map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
    }).join('');

    document.getElementById('modal-title').textContent = '新增一笔';
    document.getElementById('f-month').value = prefill.month || monthLabel(new Date());
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

      state.savedCount += 1;
      document.getElementById('f-item').value = '';
      document.getElementById('f-amount').value = '';
      var hint = document.getElementById('saved-hint');
      hint.hidden = false;
      hint.textContent = '已保存 ' + state.savedCount + ' 笔 · 月份、分类、子类已保留，可继续录入';
      document.getElementById('f-item').focus();
    }).catch(function (err) {
      toast(err.message, false);
    }).then(function () {
      saveBtn.disabled = false;
      setLoading(false);
    });
  }

  // ---------- 新增月份账单 ----------
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
    if (latest === null) return monthLabel(new Date());
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
      if (created.length) { writeCache(); render(); }
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
  function openSetup(message) {
    document.getElementById('s-token').value = settings.token;
    document.getElementById('s-ds').value = settings.dataSourceId;
    document.getElementById('s-budget').value = settings.budgetSourceId;
    document.getElementById('s-assets').value = settings.assetsSourceId;
    document.getElementById('s-cancel').hidden = !state.entries.length && !settings.token;
    var errEl = document.getElementById('s-err');
    errEl.hidden = !message;
    errEl.textContent = message || '';
    setupEl.hidden = false;
    setTimeout(function () { document.getElementById('s-token').focus(); }, 0);
  }

  function closeSetup() { setupEl.hidden = true; }

  // ---------- 子类标签管理 ----------
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
        ? '<span class="confirm">删除？' + (used ? used + ' 笔会清空子类' : '未在使用') + '</span>' +
          '<button type="button" class="op danger" data-tag-del-confirm="' + esc(name) + '">是</button>' +
          '<button type="button" class="op" data-tag-del-cancel="1">否</button>'
        : '<button type="button" class="op" data-tag-rename="' + esc(name) + '">改名</button>' +
          '<button type="button" class="op danger" data-tag-del="' + esc(name) + '">删除</button>';
      return '<div class="tag-row">' +
        '<span class="tag-name">' + esc(name) + '</span>' +
        '<span class="tag-count">' + (used ? used + ' 笔' : '未使用') + '</span>' +
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
      tagStatus('正在处理 ' + done + '/' + list.length + ' 笔…');
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
        (affected.length ? '，' + affected.length + ' 笔已同步' : ''));
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
        (affected.length ? '，' + affected.length + ' 笔已清空子类' : ''));
    }).catch(resyncAfterTagError).then(function () { setLoading(false); });
  }

  // ---------- 事件 ----------
  treeEl.addEventListener('click', function (event) {
    var target = event.target.closest(
      '[data-toggle],[data-add],[data-del],[data-del-confirm],[data-del-cancel],[data-cmp-toggle],' +
      '[data-hint-toggle],[data-asset-tool],[data-asset-del-app],[data-asset-form-save],[data-asset-form-cancel]');
    if (!target) return;
    var data = target.dataset;
    if (data.hintToggle) { state.hintOpen = !state.hintOpen; return render(); }
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
    if (data.add) return openEditor(prefillFromKey(data.add));
    if (data.del) { state.pendingDelete = data.del; return render(); }
    if (data.delCancel) { state.pendingDelete = null; return render(); }
    if (data.delConfirm) return removeEntry(data.delConfirm);
    if (data.assetTool) return openAssetForm(data.assetTool, assetMonthsInView());
    if (data.assetDelApp) return removeAssetItem(data.assetDelApp, data.assetDelName);
    if (data.assetFormCancel) { state.assetsForm = null; return render(); }
    if (data.assetFormSave) return submitAssetForm();
  });

  // 双击明细行的标题或金额，就地变成输入框；预算格、财产格同样双击才进编辑
  treeEl.addEventListener('dblclick', function (event) {
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
    if (state.assetsForm) {
      var field = event.target.closest('input[data-asset-field]');
      if (field) state.assetsForm[field.dataset.assetField] = field.value;
    }
  });

  // 焦点彻底离开这个小面板才写回（在两个输入之间切换不算离开）
  treeEl.addEventListener('focusout', function (event) {
    var cell = event.target.closest('td.cmp-edit.editing');
    if (!cell) return;
    var next = event.relatedTarget;
    if (next && typeof next.closest === 'function' && next.closest('td.cmp-edit.editing') === cell) return;
    if (state.assetsEdit) return commitAssetEditor();
    if (state.budgetEdit) return commitBudgetEditor();
  });

  treeEl.addEventListener('keydown', function (event) {
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
    if (state.assetsForm) {
      if (!event.target.closest('input[data-asset-field]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        state.assetsForm = null;
        render();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        submitAssetForm();
      }
      return;
    }
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

  // 对比视图的年份切换
  cmpBarEl.addEventListener('click', function (event) {
    var btn = event.target.closest('button[data-cmp-year]');
    if (!btn) return;
    var raw = btn.dataset.cmpYear;
    setCmpYear(raw === CMP_OTHER ? CMP_OTHER : Number(raw));
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
  // 父级「收支 / 财产」：点财产直接进；点收支回到上次看的那种子视图
  document.getElementById('view-parent').addEventListener('click', function (event) {
    var btn = event.target.closest('button[data-parent]');
    if (!btn) return;
    setView(btn.dataset.parent === 'assets' ? 'assets' : state.incomeView);
  });
  document.getElementById('view-sub').addEventListener('click', function (event) {
    var btn = event.target.closest('button[data-view]');
    if (btn) setView(btn.dataset.view);
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
    var errEl = document.getElementById('s-err');
    if (!token) { errEl.hidden = false; errEl.textContent = '请填写集成令牌'; return; }
    if (!ds) { errEl.hidden = false; errEl.textContent = '请填写数据源 ID'; return; }

    settings.token = token;
    settings.dataSourceId = ds;
    settings.budgetSourceId = budgetDs;
    settings.assetsSourceId = assetsDs || DEFAULT_ASSETS_DS;
    var saveBtn = document.getElementById('s-save');
    saveBtn.disabled = true;
    setLoading(true);
    fetchAll().then(function (entries) {
      state.entries = entries;
      localStorage.setItem(KEY_TOKEN, token);
      localStorage.setItem(KEY_DS, ds);
      localStorage.setItem(KEY_BUDGET_DS, budgetDs);
      localStorage.setItem(KEY_ASSETS_DS, settings.assetsSourceId);
      render();
      writeCache();
      closeSetup();
      toast('已连接');
      fetchSubOptions().catch(function () { return null; });
      fetchBudget().catch(function () { return null; })
        .then(function () { return fetchAssets().catch(function () { return null; }); })
        .then(render);
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

  document.getElementById('btn-month').addEventListener('click', openMonthBill);
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
    var cached = readCache();
    if (cached) {
      state.entries = cached.entries;
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
