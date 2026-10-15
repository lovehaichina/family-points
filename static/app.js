/* 家庭任务积分乐园 - 前端逻辑（无外部依赖）
   v6（2026-10-11）：① 孩子自建任务（申请发布 → 家长审核 → 扣发布费并上架）② 每日利息
   ③ 家长可设置：功能开关 / 发布费率 m / 接取费率 n / 利息率 x。
   v6.1（2026-10-11）：全部列表栏目统一分页（每页 5 条，上一页/下一页）。
   v6.2（2026-10-11）：补全分页——孩子积分总览（每名孩子的流水）、设置页成员管理列表。
   v6.3（2026-10-11）：我的任务显示"主动放弃"历史（含放弃时间与说明）；全栏目分页终检。
   v7.0（2026-10-11）：流水与任务历史改为「按需加载」——翻页实时向后端取数，突破保留量上限，
   任意年龄的记录都能翻到；主数据流瘦身（轮询更轻快）。
   v8.0（2026-10-11）：品牌升级「家庭任务积分乐园」；兑换清单按分类（category）分组 + 筛选 chip；
   默认配置体系（清空即回默认成员与配置）。
   v9.0（2026-10-11）：① 任务二级分类标签（tag）—— 类型（每天/每周/专项）+ 标签 双维度筛选；
   ② 任务大厅与任务列表重做「紧凑信息密度」视觉（压缩留白、强化层级）。 */
/* v14（2026-10-13）老浏览器兼容：
   ① 特性探测给 <html> 打标签（no-gap / no-grid / no-clamp / no-sticky / no-fetch / no-closest）
   ② 弹窗不再依赖 Element.closest()（老内核缺失会导致 openModal 抛异常）
   ③ fetch/ex-Promise 缺失时给出可读提示，避免白屏
   ④ 勾选态不再依赖 CSS :has()，改由 JS 同步 .is-checked 类
   —— 语义与业务逻辑完全不变，仅做降级兼容。 */
(function () {
  'use strict';

  /* ========== 老浏览器兼容层（最先执行） ========== */
  var COMPAT = (function () {
    var doc = document;
    var htmlEl = doc.documentElement;
    var flags = {};

    function can(prop, val) {
      try { return window.CSS && CSS.supports && CSS.supports(prop, val); } catch (e) { return false; }
    }

    // 1) Flexbox gap
    if (!can('gap', '1px')) { flags.gap = false; htmlEl.className += ' no-gap'; } else { flags.gap = true; }
    // 2) CSS Grid
    if (!can('display', 'grid')) { flags.grid = false; htmlEl.className += ' no-grid'; } else { flags.grid = true; }
    // 3) -webkit-line-clamp
    if (!can('-webkit-line-clamp', '2')) { flags.clamp = false; htmlEl.className += ' no-clamp'; } else { flags.clamp = true; }
    // 4) CSS 变量
    if (!can('color', 'var(--x, red)')) { flags.cssvar = false; htmlEl.className += ' no-cssvar'; } else { flags.cssvar = true; }
    // 5) Element.closest
    flags.closest = !!(doc.documentElement && doc.documentElement.closest);
    if (!flags.closest) htmlEl.className += ' no-closest';
    // 6) fetch
    flags.fetch = (typeof window.fetch === 'function');
    if (!flags.fetch) htmlEl.className += ' no-fetch';
    // 7) Promise
    flags.promise = (typeof window.Promise === 'function');
    if (!flags.promise) htmlEl.className += ' no-promise';
    // 8) position: sticky（用 CSS.supports 探测，无 CSS.supports 时保守降级）
    if (!can('position', 'sticky')) { flags.sticky = false; htmlEl.className += ' no-sticky'; } else { flags.sticky = true; }

    return flags;
  })();

  /* closest 兜底：老内核没有 Element.closest，用它逐级向上找。 */
  function closestEl(el, sel) {
    if (!el) return null;
    if (el.closest) {
      try { return el.closest(sel); } catch (e) { /* 落到下方手动实现 */ }
    }
    // 手动实现（仅支持本项目用到的简单选择器：[data-xxx] / .class / #id）
    var node = el;
    var attrMatch = /^\[([\w-]+)\]$/.exec(sel);
    var clsMatch = /^\.([\w-]+)$/.exec(sel);
    while (node && node.nodeType === 1) {
      if (attrMatch) {
        if (node.getAttribute && node.getAttribute(attrMatch[1]) != null) return node;
      } else if (clsMatch) {
        if (node.className && (' ' + node.className + ' ').indexOf(' ' + clsMatch[1] + ' ') >= 0) return node;
      } else {
        if (node.matches && node.matches(sel)) return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  /* 勾选态兜底：老内核不支持 :has(input:checked)，
     统一在 change 时同步 .is-checked 类。 */
  function syncCheckedClasses(root) {
    var scope = root || document;
    var items = scope.querySelectorAll('.kid-check, .pick-item');
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var input = it.querySelector && it.querySelector('input[type=checkbox], input[type=radio]');
      if (!input) continue;
      if (input.checked) { if (it.className.indexOf('is-checked') < 0) it.className += ' is-checked'; }
      else { it.className = it.className.replace(/\s*is-checked\b/g, ''); }
    }
  }

  var $ = function (sel) { return document.querySelector(sel); };

  var S = null;               // 服务端数据
  // v15：IDENT.memberToken = 当前成员的登录态（访问该成员页面的通行证）。
  //   需求：每次进入都要验证 —— 刷新页面后不保留成员登录态（memberToken 不落盘）。
  var IDENT = { mode: '', memberId: 0, token: '', memberToken: '' };
  var TAB = {};
  var pendingFiles = [];

  var WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  var STATUS_LABEL = {
    available: '可接取', in_progress: '进行中', submitted: '待审核',
    done: '已完成', overdue: '已超时', abandoned: '已放弃', expired: '已过期', cancelled: '已取消'
  };
  var LEDGER_LABEL = {
    claim: '接取消耗', reward: '任务奖励', refund: '成本退还', spend: '积分使用', adjust: '手动调整',
    interest: '每日利息', publish_fee: '发布费'
  };
  var LIMIT_LABEL = { day: '每天', week: '每周', month: '每月', none: '不限' };
  var LIMIT_SHORT = { day: '今日', week: '本周', month: '本月', none: '累计' };
  // v15：成员 PIN 默认值（首次强制修改时用它作为「当前 PIN」提交）
  var DEFAULT_PIN_FALLBACK = '1234';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtTs(s) { return s ? String(s).slice(5, 16) : ''; }
  function deadlineH() { return (S && S.settings && S.settings.submit_deadline_hours) || 3; }
  function fmtRemain(sec) {
    if (sec == null) return '';
    if (sec <= 0) return '即将超时';
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    if (h > 0) return '剩余 ' + h + ' 小时 ' + m + ' 分';
    if (m > 0) return '剩余 ' + m + ' 分钟';
    return '剩余 ' + Math.max(1, Math.floor(sec)) + ' 秒';
  }

  function toast(msg, isErr) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  /* ---------- 数据访问 ---------- */
  function fetchData() {
    return fetch('/api/data').then(function (r) {
      // 访问口令会话过期 / 未登录：立即跳登录页。
      //   必须在解析 JSON 之前判断——否则 401 时后续逻辑依赖响应体，行为不确定。
      if (r.status === 401) {
        if (location.pathname.indexOf('/login') !== 0) location.href = '/login';
        throw new Error('need-access');
      }
      return r.json();
    }).then(function (d) {
      if (!d || d.ok !== true || !d.members) {
        if (location.pathname.indexOf('/login') !== 0) location.href = '/login';
        throw new Error('need-access');
      }
      S = d; return d;
    });
  }

  function act(action, payload) {
    payload = payload || {};
    payload.action = action;
    var headers = { 'Content-Type': 'application/json' };
    if (IDENT.token) headers['X-Parent-Token'] = IDENT.token;
    if (IDENT.memberToken) headers['X-Member-Token'] = IDENT.memberToken;
    return fetch('/api/action', { method: 'POST', headers: headers, body: JSON.stringify(payload) })
      .then(function (r) {
        // 访问口令会话过期：跳登录页（不弹网络错误提示，避免误导）
        if (r.status === 401) {
          if (location.pathname.indexOf('/login') !== 0) location.href = '/login';
          throw new Error('need-access');
        }
        return r.json();
      })
      .then(function (res) {
        if (!res.ok) {
          if (res.needLogin) { IDENT.token = ''; IDENT.mode = 'kid'; saveIdent(); }
          // v15：成员登录态失效（改过 PIN / 家长改过 / 服务重启）→ 清掉本地成员 token
          if (res.needMemberLogin) { IDENT.memberToken = ''; saveIdent(); }
          toast(res.error || '操作失败', true);
        }
        return res;
      })
      .catch(function (e) {
        if (e && e.message === 'need-access') return { ok: false, needAccess: true };
        toast('网络错误，请确认服务在运行', true); return { ok: false };
      });
  }

  /* ---------- 身份 ---------- */
  function saveIdent() {
    try {
      // v15安全：成员登录态【不落盘】—— 每次进入/刷新都要重新验证 PIN。
      localStorage.setItem('family_ident', JSON.stringify({
        mode: IDENT.mode, memberId: IDENT.memberId, token: IDENT.token
      }));
    } catch (e) {}
  }
  function loadIdent() {
    try {
      var raw = localStorage.getItem('family_ident');
      if (raw) {
        var saved = JSON.parse(raw);
        IDENT.mode = saved.mode || '';
        IDENT.memberId = saved.memberId || 0;
        IDENT.token = saved.token || '';
      }
    } catch (e) {}
    IDENT.memberToken = '';
    if (!IDENT.mode) IDENT = { mode: '', memberId: 0, token: '', memberToken: '' };
  }

  function me() {
    if (!S) return null;
    return (S.members || []).filter(function (m) { return m.id === IDENT.memberId; })[0] || null;
  }
  function kids() {
    return (S.members || []).filter(function (m) { return m.role === 'child'; });
  }

  function switchIdentity(value) {
    if (value === 'parent') {
      if (IDENT.token) { IDENT.mode = 'parent'; IDENT.memberToken = ''; saveIdent(); renderAll(); }
      else promptPin();
    } else {
      // v15：切到某位成员 → 必须输入该成员的 PIN 才能进入（每次进入都要验证）
      var mid = parseInt(value, 10) || 0;
      // 同一成员的登录态仍有效时可直接进入？—— 需求为「每次进入都验证」，
      //   因此只要 memberToken 不属于目标成员，就弹 PIN 门禁。
      if (IDENT.mode === 'kid' && IDENT.memberId === mid && memberGateOpen(mid)) {
        renderAll();
        return;
      }
      promptMemberPin(mid);
    }
  }

  // 当前是否已通过某成员的门禁（memberToken 与 memberId 匹配时才算开）
  function memberGateOpen(mid) {
    return !!(IDENT.memberToken && IDENT.memberId === mid && IDENT.mode === 'kid');
  }

  function promptMemberPin(mid) {
    var m = (S && S.members || []).filter(function (x) { return x.id === mid; })[0];
    var who = m ? m.name : '该成员';
    openModal('进入「' + who + '」的页面', '' +
      '<div class="form-field"><label>请输入 ' + esc(who) + ' 的 PIN</label>' +
      '<input type="password" id="mPinInput" inputmode="numeric" autocomplete="off" placeholder="首次使用默认 1234"></div>' +
      '<div class="hint">每位成员有独立 PIN，进入自己的页面时需要验证。首次使用默认 1234，进入后需立即修改。</div>', [
      { label: '取消', cls: 'ghost', onClick: function (close) { close(); renderAll(); } },
      { label: '进入', cls: 'primary', onClick: function (close) {
        var pin = ($('#mPinInput') || {}).value || '';
        if (!pin) { toast('请输入 PIN', true); return; }
        act('member:login', { member_id: mid, pin: pin }).then(function (res) {
          if (!res.ok) return;
          IDENT.mode = 'kid';
          IDENT.memberId = mid;
          IDENT.memberToken = res.token;
          saveIdent();
          close();
          // 首次仍为默认 PIN → 强制修改后才能进入
          if (res.need_change) {
            promptChangeMemberPin(mid, true);
          } else {
            renderAll();
          }
        });
      } }
    ]);
    setTimeout(function () { var el = $('#mPinInput'); if (el) el.focus(); }, 60);
  }

  // 修改成员 PIN。forced=true 表示首次强制修改（不可跳过、不可取消）。
  function promptChangeMemberPin(mid, forced) {
    var m = (S && S.members || []).filter(function (x) { return x.id === mid; })[0];
    var who = m ? m.name : '该成员';
    var oldField = forced
      ? ''
      : '<div class="form-field"><label>当前 PIN</label>' +
        '<input type="password" id="mcOld" inputmode="numeric" autocomplete="off" placeholder="请输入当前 PIN"></div>';
    openModal(forced ? ('请为「' + who + '」设置新 PIN') : ('修改「' + who + '」的 PIN'),
      (forced ? '<div class="hint" style="margin-bottom:10px">你正在使用默认 PIN 1234，为保护你的积分与任务记录，请先设置一个新 PIN 再进入。</div>' : '') +
      oldField +
      '<div class="form-field"><label>新 PIN（至少 4 位，不能是 1234）</label>' +
      '<input type="password" id="mcNew" inputmode="numeric" autocomplete="off" placeholder="设置新 PIN"></div>' +
      '<div class="form-field"><label>确认新 PIN</label>' +
      '<input type="password" id="mcNew2" inputmode="numeric" autocomplete="off" placeholder="再输一次"></div>', [
      forced ? null : { label: '取消', cls: 'ghost', onClick: function (close) { close(); renderAll(); } },
      { label: forced ? '设置并进入' : '保存', cls: 'primary', onClick: function (close) {
        var oldPin = forced ? DEFAULT_PIN_FALLBACK : (($('#mcOld') || {}).value || '');
        var n1 = ($('#mcNew') || {}).value || '';
        var n2 = ($('#mcNew2') || {}).value || '';
        if (!forced && !oldPin) { toast('请输入当前 PIN', true); return; }
        if (n1.length < 4) { toast('新 PIN 至少 4 位', true); return; }
        if (n1 === DEFAULT_PIN_FALLBACK) { toast('不能使用默认 PIN 1234', true); return; }
        if (n1 !== n2) { toast('两次输入的新 PIN 不一致', true); return; }
        act('member:set_pin', { member_id: mid, old_pin: oldPin, new_pin: n1 }).then(function (res) {
          if (!res.ok) return;
          toast('PIN 已设置，请用新 PIN 重新进入');
          IDENT.memberToken = '';
          saveIdent();
          close();
          // 改完 PIN 后旧 token 已作废 → 让用户用新 PIN 重新进入
          promptMemberPin(mid);
        });
      } }
    ].filter(function (x) { return !!x; }));
  }

  function promptPin() {
    openModal('家长验证', '' +
      '<div class="form-field"><label>请输入家长 PIN</label>' +
      '<input type="password" id="pinInput" inputmode="numeric" autocomplete="off" placeholder="默认 1234（请尽快修改）"></div>', [
      { label: '取消', cls: 'ghost', onClick: function (close) { close(); renderAll(); } },
      { label: '进入家长端', cls: 'primary', onClick: function (close) {
        var pin = ($('#pinInput') || {}).value || '';
        act('parent:login', { pin: pin }).then(function (res) {
          if (res.ok) { IDENT.token = res.token; IDENT.mode = 'parent'; saveIdent(); close(); renderAll(); }
        });
      } }
    ]);
    setTimeout(function () { var el = $('#pinInput'); if (el) el.focus(); }, 60);
  }

  /* ---------- 弹窗 ---------- */
  function openModal(title, bodyHtml, buttons) {
    var root = $('#modalRoot');
    // v14 兼容：不用 Element.closest()，直接从已注入的 DOM 里取节点引用。
    root.innerHTML = '<div class="modal-backdrop"><div class="modal" id="modalBox">' +
      '<h3 class="modal-title">' + esc(title) + '</h3>' +
      '<div class="modal-scroll" id="modalBody">' + bodyHtml + '</div>' +
      '<div class="modal-actions" id="modalActions"></div></div></div>';
    var box = $('#modalActions');
    (buttons || []).forEach(function (b) {
      var el = document.createElement('button');
      el.className = 'btn ' + (b.cls || '');
      el.textContent = b.label;
      el.onclick = function () { b.onClick ? b.onClick(closeModal) : closeModal(); };
      box.appendChild(el);
    });
    // 内容可滚动时给标题栏底部加阴影，提示下方还有内容
    var sc = $('#modalBody');
    var m = $('#modalBox');
    function upd() {
      if (!m || !m.className) return;
      if (sc.scrollTop > 2) {
        if (m.className.indexOf('scrolled') < 0) m.className = m.className + ' scrolled';
      } else {
        m.className = m.className.replace(/\s*scrolled\b/g, '');
      }
    }
    if (sc.addEventListener) sc.addEventListener('scroll', upd);
    else sc.onscroll = upd;
    upd();
    // v14：老内核弹窗内滚动可能锁死，触摸滚动手动兜一层
    if (COMPAT.sticky === false) {
      // 不做特殊处理，靠 CSS 的 -webkit-overflow-scrolling: auto
    }
    // v14：同步弹窗内勾选态（替代 :has()）
    syncCheckedClasses(root);
    var inputs = root.querySelectorAll('input[type=checkbox], input[type=radio]');
    for (var ii = 0; ii < inputs.length; ii++) {
      (function (inp) {
        var handler = function () { syncCheckedClasses(root); };
        if (inp.addEventListener) inp.addEventListener('change', handler);
        else inp.onchange = handler;
      })(inputs[ii]);
    }
    // 老内核 <select>/<label> 点击不触发 change 时，补一层 click 兜底
    var labels = root.querySelectorAll('.kid-check, .pick-item');
    for (var li = 0; li < labels.length; li++) {
      (function (lb) {
        var h = function () { setTimeout(function () { syncCheckedClasses(root); }, 0); };
        if (lb.addEventListener) lb.addEventListener('click', h);
        else lb.onclick = h;
      })(labels[li]);
    }
  }
  function closeModal() { $('#modalRoot').innerHTML = ''; }
  function modalOpen() { return !!$('#modalRoot').children.length; }

  function confirmDialog(title, message, okLabel, okCls, onOk) {
    // pre-line：保留消息中的换行（多段提示更易读），同时不影响单段短消息
    openModal(title, '<div class="confirm-msg">' + esc(message) + '</div>', [
      { label: '取消', cls: 'ghost', onClick: function (close) { close(); } },
      { label: okLabel || '确定', cls: okCls || 'primary', onClick: function (close) { close(); onOk(); } }
    ]);
  }

  /* ---------- 文件处理 ---------- */
  function fileToPayload(file) {
    return new Promise(function (resolve, reject) {
      var rd = new FileReader();
      rd.onerror = function () { reject(new Error('读取失败')); };
      rd.onload = function () {
        var result = String(rd.result || '');
        var b64 = result.split(',')[1] || '';
        if (file.type.indexOf('image/') === 0) {
          var img = new Image();
          img.onload = function () {
            try {
              var max = 1600;
              var w = img.width, h = img.height;
              var sc = Math.min(1, max / Math.max(w, h));
              var cv = document.createElement('canvas');
              cv.width = Math.max(1, Math.round(w * sc));
              cv.height = Math.max(1, Math.round(h * sc));
              cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
              var url = cv.toDataURL('image/jpeg', 0.85);
              resolve({ name: file.name.replace(/\.\w+$/, '') + '.jpg', data: url.split(',')[1] });
            } catch (e) { resolve({ name: file.name, data: b64 }); }
          };
          img.onerror = function () { resolve({ name: file.name, data: b64 }); };
          img.src = result;
        } else {
          resolve({ name: file.name, data: b64 });
        }
      };
      rd.readAsDataURL(file);
    });
  }

  /* ---------- 渲染 ---------- */
  function renderAll() {
    if (!S) return;
    $('#familyName').textContent = (S.settings && S.settings.family_name) || '家庭任务积分乐园';
    renderIdentity();
    renderTabs();
    renderView();
    // v14：同步勾选态类（替代 CSS :has()），并绑定 change
    bindCheckStates();
  }

  /* v14：为列表/弹窗中的复选框同步 .is-checked 类（老内核无 :has()） */
  function bindCheckStates() {
    var root = document;
    syncCheckedClasses(root);
    var inputs = root.querySelectorAll('.kid-check input, .pick-item input');
    for (var i = 0; i < inputs.length; i++) {
      (function (inp) {
        if (inp._fpBound) return;
        inp._fpBound = true;
        var h = function () { syncCheckedClasses(root); };
        if (inp.addEventListener) inp.addEventListener('change', h);
        else inp.onchange = h;
      })(inputs[i]);
    }
  }

  function renderIdentity() {
    var sel = $('#identitySelect');
    var html = '';
    kids().forEach(function (k) {
      html += '<option value="' + k.id + '">' + esc(k.name) + '</option>';
    });
    html += '<option value="parent">家长入口</option>';
    sel.innerHTML = html;
    sel.value = IDENT.mode === 'parent' ? 'parent' : String(IDENT.memberId || (kids()[0] || {}).id || '');
    if (IDENT.mode !== 'parent' && !IDENT.memberId && kids()[0]) {
      IDENT.memberId = kids()[0].id;
    }
    var chip = $('#balanceChip');
    var m = me();
    // v15：只有通过门禁（memberToken 有效）才显示余额；否则显示「待验证」
    if (IDENT.mode === 'kid' && m) {
      chip.hidden = false;
      chip.textContent = memberGateOpen(m.id) ? (m.name + '：' + m.balance + ' 分') : (m.name + '：待验证');
    } else {
      chip.hidden = true;
    }
  }

  var TAB_ICONS = {
    hall: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>',
    mine: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
    points: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 9.8h4.6a1.9 1.9 0 0 1 0 3.8H9"/></svg>',
    todo: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 15l2 2 4-4"/></svg>',
    tasks: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5h11M9 12h11M9 19h11"/><circle cx="4.5" cy="5" r="1.4" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="4.5" cy="19" r="1.4" fill="currentColor" stroke="none"/></svg>',
    rewards: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/><path d="M12 8s-.4-5-4-5a2 2 0 0 0 0 4h8a2 2 0 0 0 0-4c-3.6 0-4 5-4 5z"/></svg>',
    kids: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M2.5 20c.6-3.2 3.2-5 6.5-5s5.9 1.8 6.5 5"/><circle cx="17.5" cy="9.5" r="2.4"/><path d="M15.5 14.6c2.8.2 4.8 1.8 5.4 4.4"/></svg>',
    settings: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="2.2" fill="currentColor" stroke="none"/><circle cx="7" cy="18" r="2.2" fill="currentColor" stroke="none"/></svg>'
  };

  function renderTabs() {
    var tabsEl = $('#tabs');
    var defs;
    if (IDENT.mode === 'parent') {
      var todoCount = pendingReviewCount() + pendingRequestCount() + pendingPublishCount();
      defs = [
        ['todo', '待办', todoCount],
        ['tasks', '任务管理', 0],
        ['rewards', '兑换清单', 0],
        ['kids', '孩子与积分', 0],
        ['settings', '设置', 0]
      ];
    } else {
      defs = [['hall', '任务大厅', 0], ['mine', '我的任务', 0], ['points', '我的积分', 0]];
    }
    var cur = TAB[IDENT.mode] || defs[0][0];
    if (!defs.some(function (d) { return d[0] === cur; })) cur = defs[0][0];
    TAB[IDENT.mode] = cur;
    tabsEl.innerHTML = defs.map(function (d) {
      var badge = d[2] ? '<span class="badge">' + d[2] + '</span>' : '';
      return '<button class="' + (cur === d[0] ? 'active' : '') + '" data-tab="' + d[0] + '">' +
        (TAB_ICONS[d[0]] || '') + '<span>' + esc(d[1]) + '</span>' + badge + '</button>';
    }).join('');
    Array.prototype.forEach.call(tabsEl.querySelectorAll('button'), function (b) {
      b.onclick = function () { TAB[IDENT.mode] = b.getAttribute('data-tab'); renderAll(); };
    });
  }

  function pendingReviewCount() {
    return (S.instances || []).filter(function (i) { return i.status === 'submitted'; }).length;
  }
  function pendingRequestCount() {
    return (S.spend_requests || []).filter(function (r) { return r.status === 'pending'; }).length;
  }
  function pendingPublishCount() {
    return (S.publish_requests || []).filter(function (r) { return r.status === 'pending'; }).length;
  }

  function renderView() {
    var v = $('#view');
    if (!S.members || S.members.length === 0) { v.innerHTML = setupHtml(); bindSetup(); return; }
    var tab = TAB[IDENT.mode] || (IDENT.mode === 'parent' ? 'todo' : 'hall');
    if (IDENT.mode === 'parent') {
      if (tab === 'todo') v.innerHTML = parentTodoHtml();
      else if (tab === 'tasks') { v.innerHTML = parentTasksHtml(); bindParentTasks(); }
      else if (tab === 'rewards') { v.innerHTML = parentRewardsHtml(); bindParentRewards(); }
      else if (tab === 'kids') { v.innerHTML = parentKidsHtml(); bindParentKids(); }
      else { v.innerHTML = settingsHtml(); bindSettings(); }
    } else {
      // v15：成员门禁 —— 未通过该成员 PIN 验证时，不渲染成员页面内容
      if (!memberGateOpen(IDENT.memberId)) {
        v.innerHTML = memberGateHtml();
        bindMemberGate();
        return;
      }
      if (tab === 'hall') { v.innerHTML = kidHallHtml(); bindHall(); }
      else if (tab === 'mine') { v.innerHTML = kidMineHtml(); bindMine(); }
      else { v.innerHTML = kidPointsHtml(); bindPoints(); }
    }
  }

  /* ---------- v15：成员门禁占位（未验证 PIN 时显示） ---------- */
  function memberGateHtml() {
    var m = me();
    var who = m ? m.name : '成员';
    return '<div class="card gate-card"><div class="gate-lock">🔒</div>' +
      '<div class="card-title">进入「' + esc(who) + '」的页面需要验证</div>' +
      '<div class="card-desc">请输入 ' + esc(who) + ' 的 PIN 继续。首次使用默认为 1234，进入后请尽快修改。</div>' +
      '<div class="card-actions"><button class="btn primary" id="gateEnter">输入 PIN 进入</button></div></div>';
  }
  function bindMemberGate() {
    var b = $('#gateEnter');
    if (b) b.onclick = function () { promptMemberPin(IDENT.memberId); };
  }

  /* ---------- 首次设置 ---------- */
  function setupHtml() {
    return '<div class="card"><div class="card-title">欢迎使用 · 首次设置</div>' +
      '<div class="card-desc">请填写家庭基础信息，创建后进入家长端。</div>' +
      '<div class="form-field" style="margin-top:14px"><label>家庭名称</label>' +
      '<input type="text" id="suFam" value="家庭任务积分乐园"></div>' +
      '<div class="form-row"><div class="form-field"><label>孩子称呼</label>' +
      '<input type="text" id="suKid" placeholder="例如：小星"></div>' +
      '<div class="form-field"><label>家长称呼</label>' +
      '<input type="text" id="suParent" placeholder="例如：爸爸"></div></div>' +
      '<div class="form-field"><label>家长 PIN（至少 4 位，审核与设置时使用）</label>' +
      '<input type="password" id="suPin" inputmode="numeric"></div>' +
      '<div class="modal-actions"><button class="btn ghost" id="suDemo">先载入演示数据看看</button>' +
      '<button class="btn primary" id="suGo">创建并进入</button></div></div>';
  }
  function bindSetup() {
    $('#suGo').onclick = function () {
      var fam = $('#suFam').value.trim() || '家庭任务积分乐园';
      var kid = $('#suKid').value.trim();
      var par = $('#suParent').value.trim() || '家长';
      var pin = $('#suPin').value.trim();
      if (!kid) { toast('请填写孩子称呼', true); return; }
      if (pin.length < 4) { toast('PIN 至少 4 位', true); return; }
      act('parent:init', { family_name: fam, child_name: kid, parent_name: par, pin: pin }).then(function (res) {
        if (res.ok) {
          IDENT.token = res.token; IDENT.mode = 'parent'; saveIdent();
          refresh();
        }
      });
    };
    $('#suDemo').onclick = function () {
      var pin = $('#suPin').value.trim();
      if (pin.length < 4) { toast('请先设置 PIN（至少 4 位），演示数据也会用它', true); return; }
      act('parent:init', { family_name: '示例家庭', child_name: '小星', parent_name: '爸爸', pin: pin }).then(function (res) {
        if (!res.ok) return;
        IDENT.token = res.token;
        return act('parent:load_demo', {}).then(function () {
          IDENT.mode = 'parent'; saveIdent(); refresh();
        });
      });
    };
  }

  /* ---------- 通用小工具 ---------- */
  function visibleInstances(filterFn) {
    return (S.instances || []).filter(filterFn);
  }
  function taskOf(inst) { return { title: inst.task_title, type: inst.task_type, reward: inst.reward, cost: inst.cost }; }
  function costHint() {
    return (S.settings && S.settings.cost_refund) ? '完成后退还' : '完成后不退还';
  }
  function pubSettings() {
    var st = (S && S.settings) || {};
    return {
      enabled: st.kid_publish_enabled !== false,
      m: (st.kid_publish_fee != null) ? st.kid_publish_fee : 5,
      n: (st.kid_claim_cost != null) ? st.kid_claim_cost : 5,
      x: (st.interest_rate != null) ? st.interest_rate : 1
    };
  }
  function pubFee(reward) { return Math.floor(reward * pubSettings().m / 100); }
  function pubCost(reward) { return Math.floor(reward * pubSettings().n / 100); }

  /* -------- 列表分页（v6.1）：每页 5 条，上一页 / 下一页 -------- */
  var PAGES = {};        // 各栏目分页状态：key -> 当前页码（从 0 起）
  var PAGE_SIZE = 5;

  /* -------- v9.0：任务双维度筛选（类型 + 标签） -------- */
  var TYPE_FILTER = { hall: '', parent: '' };   // ''=全部；'daily' | 'routine' | 'special'
  var TAG_FILTER = { hall: '', parent: '' };    // ''=全部；标签名

  var TYPE_ORDER = ['daily', 'routine', 'special'];
  var TYPE_NAME = { daily: '每天例行', routine: '每周例行', special: '专项任务' };

  /* 收集当前任务集合里出现过的标签（按出现频次降序），用于渲染标签筛选项 */
  function taskTags(tasks) {
    var seen = {}, order = [];
    (tasks || []).forEach(function (t) {
      var g = String(t.tag || '').trim();
      if (!g) return;
      if (!seen[g]) { seen[g] = 0; order.push(g); }
      seen[g]++;
    });
    return order.sort(function (a, b) { return seen[b] - seen[a]; });
  }

  /* 收集实例集合对应的任务标签（孩子端实例本身无 tag，需回查 S.tasks） */
  function instanceTags(instances) {
    var seen = {}, order = [];
    (instances || []).forEach(function (i) {
      var g = String(taskTagOf(i) || '').trim();
      if (!g) return;
      if (!seen[g]) { seen[g] = 0; order.push(g); }
      seen[g]++;
    });
    return order.sort(function (a, b) { return seen[b] - seen[a]; });
  }

  /* 渲染筛选条：typeKeys/tagKeys 为可用项（空数组则不渲染该行） */
  function filterBarHtml(scope, types, tags) {
    var html = '<div class="filters">';
    if (types && types.length > 1) {
      html += '<div class="filter-row"><span class="filter-label">类型</span><div class="filter-chips">' +
        '<button class="chip' + (TYPE_FILTER[scope] === '' ? ' on' : '') + '" data-tfilter="' + scope + ':">全部</button>' +
        types.map(function (k) {
          return '<button class="chip' + (TYPE_FILTER[scope] === k ? ' on' : '') + '" data-tfilter="' + scope + ':' + k + '">' +
            esc(TYPE_NAME[k] || k) + '</button>';
        }).join('') + '</div></div>';
    }
    if (tags && tags.length > 1) {
      html += '<div class="filter-row"><span class="filter-label">标签</span><div class="filter-chips">' +
        '<button class="chip' + (TAG_FILTER[scope] === '' ? ' on' : '') + '" data-gfilter="' + scope + ':">全部</button>' +
        tags.map(function (g) {
          return '<button class="chip' + (TAG_FILTER[scope] === g ? ' on' : '') + '" data-gfilter="' + scope + ':' + esc(g) + '">' +
            esc(g) + '</button>';
        }).join('') + '</div></div>';
    }
    return html + '</div>';
  }

  /* 组合筛选：先类型后标签（items 需含 .task_type / .tag 或为任务对象） */
  function applyFilters(items, scope, typeOf, tagOf) {
    var tf = TYPE_FILTER[scope], gf = TAG_FILTER[scope];
    return (items || []).filter(function (x) {
      if (tf && typeOf(x) !== tf) return false;
      if (gf && String(tagOf(x) || '').trim() !== gf) return false;
      return true;
    });
  }

  /* 绑定筛选条点击（切换后重置该 scope 下所有分页到第 1 页） */
  function bindFilters(scope) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-tfilter]'), function (b) {
      b.onclick = function () {
        var v = b.getAttribute('data-tfilter');
        if (v.indexOf(scope + ':') !== 0) return;
        TYPE_FILTER[scope] = v.slice(scope.length + 1);
        resetPages(scope);
        renderView();
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-gfilter]'), function (b) {
      b.onclick = function () {
        var v = b.getAttribute('data-gfilter');
        if (v.indexOf(scope + ':') !== 0) return;
        TAG_FILTER[scope] = v.slice(scope.length + 1);
        resetPages(scope);
        renderView();
      };
    });
  }

  function resetPages(scope) {
    Object.keys(PAGES).forEach(function (k) {
      if (k.indexOf(scope) === 0) PAGES[k] = 0;
    });
  }

  /* 预设标签池（家长/孩子新增任务时的候选），与已有任务的标签合并去重 */
  var PRESET_TAGS = ['学业', '阅读', '运动', '生活', '兴趣', '品格', '荣誉'];

  function allTagOptions() {
    var set = {}, order = [];
    PRESET_TAGS.concat(taskTags(S.tasks || [])).forEach(function (g) {
      if (g && !set[g]) { set[g] = 1; order.push(g); }
    });
    return order;
  }

  /* 标签下拉：预设项 + 「自定义…」（选中后显示输入框） */
  function tagOptionsHtml(current) {
    var cur = String(current || '').trim();
    var opts = allTagOptions();
    var extra = (cur && opts.indexOf(cur) < 0) ? cur : '';
    var html = '<option value="">未分类</option>' +
      opts.map(function (g) {
        return '<option value="' + esc(g) + '"' + (cur === g ? ' selected' : '') + '>' + esc(g) + '</option>';
      }).join('');
    if (extra) html += '<option value="' + esc(extra) + '" selected>' + esc(extra) + '</option>';
    html += '<option value="__custom__">自定义…</option>';
    return html;
  }

  function paged(key, items, renderFn) {
    var total = items.length;
    if (total <= PAGE_SIZE) return items.map(renderFn).join('');
    var pages = Math.ceil(total / PAGE_SIZE);
    var cur = Math.min(Math.max(PAGES[key] || 0, 0), pages - 1);
    PAGES[key] = cur;
    var html = items.slice(cur * PAGE_SIZE, (cur + 1) * PAGE_SIZE).map(renderFn).join('');
    html += '<div class="pager">' +
      '<button class="btn ghost small" data-page="' + key + ':-1"' + (cur === 0 ? ' disabled' : '') + '>上一页</button>' +
      '<span class="pager-info">第 ' + (cur + 1) + ' / ' + pages + ' 页 · 共 ' + total + ' 条</span>' +
      '<button class="btn ghost small" data-page="' + key + ':1"' + (cur >= pages - 1 ? ' disabled' : '') + '>下一页</button>' +
      '</div>';
    return html;
  }

  /* -------- 历史按需加载（v7.0）：翻页实时向后端取数，突破保留量上限 -------- */
  var SLICES = {};   // key -> { page, total, items, loading, bg, dirty, err, seq }

  function sliceSrc(key) {
    if (key.indexOf('points_ledger_') === 0) return { kind: 'ledger', member_id: parseInt(key.slice(14), 10) };
    if (key.indexOf('mine_closed_') === 0) return { kind: 'instance_history', member_id: parseInt(key.slice(12), 10) };
    if (key.indexOf('kids_ledger_') === 0) return { kind: 'ledger', member_id: parseInt(key.slice(12), 10) };
    return null;
  }

  function doLoad(key, page, bg) {
    var st = SLICES[key];
    var src = sliceSrc(key);
    if (!st || !src || !src.member_id) { return; }
    st.loading = true;
    st.bg = !!bg;
    st.err = '';
    st.page = Math.max(0, page);
    var seq = ++st.seq;
    act('history:query', { kind: src.kind, member_id: src.member_id, offset: st.page * PAGE_SIZE, limit: PAGE_SIZE })
      .then(function (res) {
        if (seq !== st.seq) return;   // 丢弃迟到响应
        st.loading = false;
        st.bg = false;
        if (res.ok) {
          st.total = res.total;
          st.items = res.items || [];
          var pages = Math.max(1, Math.ceil(st.total / PAGE_SIZE));
          if (st.page > pages - 1) { doLoad(key, pages - 1, true); return; }   // 数据变化导致越界 → 修正
        } else {
          st.err = res.error || '加载失败';
          if (st.total < 0) { st.total = 0; st.items = []; }
        }
        renderAll();
      })
      .catch(function () {
        if (seq !== st.seq) return;
        st.loading = false;
        st.bg = false;
        st.err = '网络错误';
        if (st.total < 0) { st.total = 0; st.items = []; }
        renderAll();
      });
  }

  function invalidateSlices() {
    Object.keys(SLICES).forEach(function (k) {
      if (!SLICES[k].loading) SLICES[k].dirty = true;
    });
  }

  function asyncPaged(key, renderFn, emptyText) {
    var st = SLICES[key];
    if (!st) {
      st = SLICES[key] = { page: 0, total: -1, items: [], loading: true, bg: false, dirty: false, err: '', seq: 0 };
      doLoad(key, 0, false);
      return '<div class="empty">加载中…</div>';
    }
    if (st.dirty && !st.loading) {
      st.dirty = false;
      doLoad(key, st.total < 0 ? 0 : st.page, true);   // 后台静默刷新，旧数据继续显示
    }
    if (st.total < 0) return '<div class="empty">加载中…</div>';
    if (st.err && !st.items.length) return '<div class="empty">' + esc(st.err) + '，请稍后重试</div>';
    if (st.total === 0) return '<div class="empty">' + (emptyText || '暂无记录') + '</div>';
    var pages = Math.max(1, Math.ceil(st.total / PAGE_SIZE));
    var cur = Math.min(st.page, pages - 1);
    var html = st.items.map(renderFn).join('');
    if (st.total > PAGE_SIZE) {
      if (st.loading && !st.bg) {
        html += '<div class="pager"><span class="pager-info">载入中…</span></div>';
      } else {
        html += '<div class="pager">' +
          '<button class="btn ghost small" data-aspage="' + key + ':-1"' + (cur <= 0 ? ' disabled' : '') + '>上一页</button>' +
          '<span class="pager-info">第 ' + (cur + 1) + ' / ' + pages + ' 页 · 共 ' + st.total + ' 条</span>' +
          '<button class="btn ghost small" data-aspage="' + key + ':1"' + (cur >= pages - 1 ? ' disabled' : '') + '>下一页</button>' +
          '</div>';
      }
    }
    return html;
  }
  function rewardOf(id) {
    return (S.rewards || []).filter(function (r) { return r.id === id; })[0] || null;
  }
  function myRewardUsage(rewardId) {
    var rows = (S.reward_usage || []).filter(function (u) {
      return u.reward_id === rewardId && u.member_id === IDENT.memberId;
    });
    var u = rows[0] || { approved: 0, pending: 0 };
    var r = rewardOf(rewardId);
    var remaining = (r && r.limit_type !== 'none')
      ? Math.max(0, r.limit_count - (u.approved || 0) - (u.pending || 0))
      : Infinity;
    return { approved: u.approved || 0, pending: u.pending || 0, remaining: remaining };
  }
  function rewardUsageTotal(rewardId) {
    var rows = (S.reward_usage || []).filter(function (u) { return u.reward_id === rewardId; });
    var a = 0, p = 0;
    rows.forEach(function (u) { a += u.approved || 0; p += u.pending || 0; });
    return { approved: a, pending: p };
  }
  function reqTitlePlain(r) {
    if (r.kind === 'reward' && r.reward_name) {
      return '兑换「' + r.reward_name + '」' + ((r.quantity || 1) > 1 ? ' ×' + r.quantity : '');
    }
    return '使用 ' + r.amount + ' 分';
  }
  function typeLabel(t) {
    if (t === 'routine') return '每周例行';
    if (t === 'daily') return '每天例行';
    return '专项';
  }
  function kidsText(t) {
    var ids = String(t.kids || '').split(',').filter(Boolean);
    if (!ids.length) return '全部孩子';
    var names = ids.map(function (id) {
      var m = (S.members || []).filter(function (x) { return String(x.id) === id; })[0];
      return m ? m.name : ('#' + id);
    });
    return names.join('、');
  }
  function taskInstanceSummary(t) {
    if (!t.active) return '已停用';
    var cur;
    if (t.type === 'routine') {
      cur = (S.instances || []).filter(function (i) {
        return i.task_id === t.id && i.week_key === S.week_key && i.status !== 'cancelled' && i.status !== 'expired';
      });
    } else if (t.type === 'daily') {
      cur = (S.instances || []).filter(function (i) {
        return i.task_id === t.id && i.day_key === S.day_key && i.status !== 'cancelled' && i.status !== 'expired';
      });
    } else {
      cur = (S.instances || []).filter(function (i) {
        return i.task_id === t.id && (i.status === 'available' || i.status === 'in_progress' || i.status === 'submitted');
      });
    }
    var c = { available: 0, in_progress: 0, submitted: 0, done: 0 };
    cur.forEach(function (i) { if (c[i.status] !== undefined) c[i.status] += 1; });
    var scope = t.type === 'routine' ? '本周' : (t.type === 'daily' ? '今日' : '当前');
    var parts = [];
    if (c.available) parts.push('可接 ' + c.available);
    if (c.in_progress) parts.push('进行中 ' + c.in_progress);
    if (c.submitted) parts.push('待审核 ' + c.submitted);
    if (c.done) parts.push('已完成 ' + c.done);
    if (!parts.length) parts.push(t.type === 'special' ? '暂无' : '未生成');
    return scope + '：' + parts.join(' · ');
  }

  /* ---------- 孩子端 ---------- */
  function kidHallHtml() {
    var meId = IDENT.memberId;
    var m = me();
    var wk = S.week_key;
    var dk = S.day_key;
    var available = visibleInstances(function (i) {
      if (i.status !== 'available') return false;
      if (i.member_id && i.member_id !== meId) return false;
      if (i.task_type === 'routine' && i.week_key !== wk) return false;
      if (i.task_type === 'daily' && i.day_key !== dk) return false;
      return true;
    });
    var daily = available.filter(function (i) { return i.task_type === 'daily'; });
    var rout = available.filter(function (i) { return i.task_type === 'routine'; });
    var spec = available.filter(function (i) { return i.task_type === 'special'; });
    var html = '';
    if (m) {
      html += '<div class="card balance-card"><div class="row"><div>' +
        '<div class="label">' + esc(m.name) + '的当前积分</div>' +
        '<div class="num">' + m.balance + '<span style="font-size:16px"> 分</span></div></div>' +
        '<div class="kid-hint">接取任务消耗积分（' + costHint() + '）<br>接取后需在 ' + deadlineH() + ' 小时内提交，超时作废' +
        (pubSettings().x > 0 ? '<br>每天有利息：余额 × ' + pubSettings().x + '%' : '') + '</div></div></div>';
      if (pubSettings().enabled) {
        html += '<div class="card compact"><div class="card-head"><div>' +
          '<div class="card-title">想给自己发布任务？</div>' +
          '<div class="card-desc">自己设计任务并设定奖励，提交给家长审核；通过后扣发布费 ' + pubSettings().m +
          '%（按奖励计算），接取时消耗 ' + pubSettings().n + '%。</div></div>' +
          '<span class="pill special">自建</span></div>' +
          '<div class="card-actions"><button class="btn primary small" id="btnPubReq">申请发布新任务</button></div></div>';
      }
      var myReqs = (S.publish_requests || []).filter(function (r) { return r.member_id === meId; });
      if (myReqs.length) {
        html += '<div class="section-title">我的发布申请</div>';
        html += paged('hall_myreq', myReqs, pubReqCard);
      }
    }
    // v9.0：类型 + 标签 双维度筛选
    var allAvail = daily.concat(rout, spec);
    html += '<div class="section-title">可接取任务 · ' + allAvail.length + ' 个</div>';
    var usedTypes = TYPE_ORDER.filter(function (k) { return allAvail.some(function (i) { return i.task_type === k; }); });
    html += filterBarHtml('hall', usedTypes, instanceTags(allAvail));
    var shown = applyFilters(allAvail, 'hall',
      function (i) { return i.task_type; },
      function (i) { return taskTagOf(i); });
    if (!shown.length) {
      html += '<div class="empty">' + (allAvail.length ? '没有符合筛选条件的任务' : '暂无可接取的任务') + '</div>';
      return html;
    }
    // 未筛选时按类型分组展示，筛选后统一扁平静态列表
    if (!TYPE_FILTER.hall && !TAG_FILTER.hall) {
      html += '<div class="section-sub">每天例行（每天可接一次）</div>';
      html += daily.length ? paged('hall_daily', daily, function (i) { return hallCard(i, meId); }) : '<div class="empty">今天没有待接取的例行任务</div>';
      html += '<div class="section-sub">每周例行（每周可接一次）</div>';
      html += rout.length ? paged('hall_rout', rout, function (i) { return hallCard(i, meId); }) : '<div class="empty">本周没有待接取的例行任务</div>';
      html += '<div class="section-sub">专项任务（不定期发布）</div>';
      html += spec.length ? paged('hall_spec', spec, function (i) { return hallCard(i, meId); }) : '<div class="empty">暂时没有新的专项任务</div>';
    } else {
      html += paged('hall_filtered', shown, function (i) { return hallCard(i, meId); });
    }
    return html;
  }

  function taskTagOf(inst) {
    var t = (S.tasks || []).filter(function (x) { return x.id === inst.task_id; })[0];
    return t ? (t.tag || '') : '';
  }

  /* v9.0 紧凑任务卡：单行信息 + 右侧奖励/消耗 + 底部动作（v9.1：标签行回归文档流，避免与说明重叠） */
  /* v10：连续完成进度（结果导向表述，不用低幼的"打卡"叙事）
     只对「每天例行」任务展示；返回 '' 表示无需展示。
     注意：任务一旦被接取/完成，就不再出现在「任务大厅」的 available 列表里，
     因此这里必须用 task_id 查询（而非依赖 instance 的存在），
     并在「我的任务」页也调用，否则孩子完成当天任务后就再也看不到自己的连续进度。 */
  function streakHintByTask(taskId, taskType, meId) {
    if (taskType !== 'daily') return '';
    var s = (S.streaks || []).filter(function (x) {
      return x.task_id === taskId && x.member_id === meId;
    })[0];
    if (!s) return '';
    var goal = (S.settings && S.settings.streak_reward_days) || 7;
    var parts = [];
    if (s.streak > 0) parts.push('已连续 ' + s.streak + ' 天');
    if (s.month_count > 0) parts.push('本月 ' + s.month_count + ' 次');
    if (!parts.length) return '';
    // 距目标还差多少（仅在未达标且有连续时提示，避免天天催）
    var left = goal - (s.streak || 0);
    var tail = (s.streak > 0 && left > 0 && left <= 3) ? '，再坚持 ' + left + ' 天有额外奖励' : '';
    return '<div class="tc-streak">' + parts.join(' · ') + tail + '</div>';
  }

  function streakHintOf(inst, meId) {
    return streakHintByTask(inst.task_id, inst.task_type, meId);
  }

  function hallCard(inst, meId) {
    var t = taskOf(inst);
    var tag = taskTagOf(inst);
    var bal = me() ? me().balance : 0;
    var can = bal >= t.cost;
    var btn = can
      ? '<button class="btn warm small" data-claim="' + inst.id + '">接取' + (t.cost > 0 ? '（-' + t.cost + '）' : '') + '</button>'
      : '<button class="btn small" disabled>积分不足</button>';
    var wd = inst.task_type === 'routine' ? taskWeekdayText(inst) : '';
    var sub = [wd, inst.task_type === 'routine' && wd && inst.task_desc ? '' : '', inst.task_desc || ''].filter(Boolean).join(' · ');
    return '<div class="task-card">' +
      '<div class="tc-body">' +
        '<div class="tc-row"><div class="tc-main"><div class="tc-title">' + esc(t.title) + '</div>' +
        (sub ? '<div class="tc-desc">' + esc(sub) + '</div>' : '') +
        streakHintOf(inst, meId) + '</div>' +
        '<div class="tc-side"><div class="tc-reward">+' + t.reward + '</div>' +
        (t.cost > 0 ? '<div class="tc-cost">-' + t.cost + '</div>' : '') +
        btn + '</div></div>' +
        '<div class="tc-tags"><span class="tag">' + esc(tag || '未分类') + '</span>' +
          '<span class="pill ' + inst.task_type + ' sm">' + typeLabel(inst.task_type) + '</span></div>' +
      '</div>' +
      '</div>';
  }

  function taskWeekdayText(inst) {
    var t = (S.tasks || []).filter(function (x) { return x.id === inst.task_id; })[0];
    if (!t || t.weekday === null || t.weekday === undefined) return '';
    return '建议' + WEEKDAYS[t.weekday];
  }

  function pubReqCard(r) {
    var st = r.status === 'pending' ? '等待家长处理' : (r.status === 'approved' ? '已通过 · 任务已发布' : '已被驳回');
    var pillCls = r.status === 'approved' ? 'done' : (r.status === 'pending' ? 'submitted' : 'cancelled');
    return '<div class="card"><div class="card-head"><div>' +
      '<div class="card-title">' + esc(r.title) + '</div>' +
      '<div class="card-desc">' + typeLabel(r.type) + ' ｜ 奖励 +' + r.reward + ' 分' +
      (r.fee > 0 ? ' ｜ 发布费 -' + r.fee + ' 分' : ' ｜ 免发布费') +
      (r.cost > 0 ? ' ｜ 接取消耗 -' + r.cost + ' 分' : '') + '</div>' +
      '<div class="card-desc">提交于 ' + fmtTs(r.created_at) + '</div></div>' +
      '<span class="pill status-' + pillCls + '">' + st + '</span></div></div>';
  }

  function bindHall() {
    var pb = $('#btnPubReq');
    if (pb) pb.onclick = openPublishModal;
    bindFilters('hall');
    Array.prototype.forEach.call(document.querySelectorAll('[data-claim]'), function (b) {
      b.onclick = function () {
        var iid = parseInt(b.getAttribute('data-claim'), 10);
        var inst = (S.instances || []).filter(function (i) { return i.id === iid; })[0];
        if (!inst) return;
        confirmDialog('接取任务', '接取「' + inst.task_title + '」将消耗 ' + inst.cost + ' 分（' +
          costHint() + '），并请在 ' + deadlineH() + ' 小时内提交证据（超时任务作废、已扣积分不退还）。确定接取吗？',
          '确定接取', 'warm', function () {
          act('claim', { instance_id: iid, member_id: IDENT.memberId }).then(function (res) {
            if (res.ok) { toast('接取成功，加油完成！'); refresh(); }
          });
        });
      };
    });
  }

  function openPublishModal() {
    var ps = pubSettings();
    if (!ps.enabled) { toast('家长已关闭申请发布功能', true); return; }
    openModal('申请发布新任务', '' +
      '<div class="form-field"><label>任务类型</label>' +
      '<select class="full" id="pbType">' +
      '<option value="daily">每天例行（每天可接一次）</option>' +
      '<option value="routine">每周例行（每周可接一次）</option>' +
      '<option value="special" selected>专项任务（一次性）</option></select></div>' +
      '<div class="form-field"><label>任务名称</label>' +
      '<input type="text" id="pbTitle" placeholder="例如：每天练字 20 分钟"></div>' +
      '<div class="form-field"><label>任务说明（选填）</label>' +
      '<textarea id="pbDesc" placeholder="你想做什么？做到什么标准算完成？"></textarea></div>' +
      '<div class="form-field"><label>标签（选填，便于分类筛选）</label>' +
      '<select class="full" id="pbTag">' + tagOptionsHtml('') + '</select></div>' +
      '<div class="form-field"><label>完成奖励（分）</label>' +
      '<input type="number" id="pbReward" min="1" step="1" value="10"></div>' +
      '<div class="hint">任务将只发布给你自己；家长通过后扣除发布费（奖励 × ' + ps.m + '%，向下取整）；' +
      '接取任务时消耗（奖励 × ' + ps.n + '%，向下取整）。若未完成或超时，已扣积分不退还。</div>' +
      '<div class="hint" id="pbSummary"></div>', [
      { label: '取消', cls: 'ghost', onClick: function (close) { close(); } },
      { label: '提交申请', cls: 'primary', onClick: function (close) {
        var reward = parseInt(($('#pbReward') || {}).value || '0', 10);
        var payload = {
          member_id: IDENT.memberId,
          type: $('#pbType').value,
          title: ($('#pbTitle').value || '').trim(),
          description: ($('#pbDesc').value || '').trim(),
          tag: ($('#pbTag') || {}).value || '',
          reward: reward
        };
        if (!payload.title) { toast('请填写任务名称', true); return; }
        if (!reward || reward < 1) { toast('请填写大于 0 的完成奖励', true); return; }
        var fee = pubFee(reward);
        var m = me();
        if (m && m.balance < fee) { toast('积分不足：发布需扣 ' + fee + ' 分，当前 ' + m.balance + ' 分', true); return; }
        act('kid:request_publish', payload).then(function (res) {
          if (res.ok) { close(); toast('已提交申请，等待家长处理'); refresh(); }
        });
      } }
    ]);
    function syncPb() {
      var reward = parseInt(($('#pbReward') || {}).value || '0', 10) || 0;
      var m = me();
      var fee = pubFee(reward);
      var cost = pubCost(reward);
      var txt = '按当前奖励 ' + reward + ' 分计算：发布费 ' + fee + ' 分（通过后扣除）；接取消耗 ' + cost + ' 分';
      if (reward < 1) txt = '请先填写完成奖励（大于 0 的整数）';
      else if (m && m.balance < fee) txt += '（余额不足，当前 ' + m.balance + ' 分）';
      ($('#pbSummary') || {}).textContent = txt;
    }
    setTimeout(function () {
      var el = $('#pbReward');
      if (el) el.oninput = syncPb;
      syncPb();
    }, 60);
  }

  function kidMineHtml() {
    var meId = IDENT.memberId;
    var mine = visibleInstances(function (i) { return i.assignee_id === meId; });
    var inprog = mine.filter(function (i) { return i.status === 'in_progress'; });
    var submitted = mine.filter(function (i) { return i.status === 'submitted'; });
    var html = '<div class="section-title">进行中（需在 ' + deadlineH() + ' 小时内提交）</div>';
    html += inprog.length ? paged('mine_prog', inprog, function (i) { return mineCard(i, true); }) : '<div class="empty">没有进行中的任务，去大厅接一个吧</div>';
    html += '<div class="section-title">等待家长审核</div>';
    html += submitted.length ? paged('mine_sub', submitted, function (i) { return mineCard(i, false); }) : '<div class="empty">暂无</div>';
    html += '<div class="section-title">已完成 / 已结束</div>';
    html += asyncPaged('mine_closed_' + meId, function (i) { return mineCard(i, false); }, '暂无记录');
    return html;
  }

  function mineCard(inst, showActions) {
    var filesHtml = '';
    if (inst.files && inst.files.length) {
      filesHtml = '<div class="evidence">' + inst.files.map(function (f) {
        if (/\.(png|jpe?g|webp|gif)$/i.test(f.url)) {
          return '<a href="' + f.url + '" target="_blank"><img src="' + f.url + '" alt="证据"></a>';
        }
        return '<a class="file-chip" href="' + f.url + '" target="_blank">' + esc(f.filename) + '</a>';
      }).join('') + '</div>';
    }
    var actions = '';
    var dlPill = '';
    if (showActions) {
      actions = '<div class="card-actions">' +
        '<button class="btn primary" data-submit="' + inst.id + '">提交证据</button>' +
        '<button class="btn danger small" data-abandon="' + inst.id + '">放弃任务</button></div>';
      if (typeof inst.remain_sec === 'number') {
        var warn = inst.remain_sec <= 1800;
        dlPill = '<span class="pill deadline' + (warn ? ' warn' : '') + '">限时提交 · ' + fmtRemain(inst.remain_sec) + '</span>';
      }
    }
    var note = inst.submit_note ? '<div class="card-desc">说明：' + esc(inst.submit_note) + '</div>' : '';
    if (inst.status === 'overdue') {
      note += '<div class="hint warn">已超时作废：接取后未在 ' + deadlineH() + ' 小时内提交，接取消耗不退还。</div>';
    }
    if (inst.status === 'abandoned') {
      note += '<div class="hint warn">已放弃任务：接取消耗不退还（任务已回到大厅）。</div>';
    }
    var review = inst.review_note ? '<div class="hint warn">家长反馈：' + esc(inst.review_note) + '</div>' : '';
    // v10：连续完成进度也在这里展示——任务完成后就从大厅消失，孩子只有在这里才能看到自己的连续战绩
    var streak = streakHintByTask(inst.task_id, inst.task_type, inst.assignee_id || IDENT.memberId);
    return '<div class="card"><div class="card-head"><div>' +
      '<div class="card-title">' + esc(inst.task_title) + '</div>' + note + review + streak + '</div>' +
      '<span class="pill status-' + inst.status + '">' + (STATUS_LABEL[inst.status] || inst.status) + '</span></div>' +
      '<div class="card-meta"><span class="pill reward">奖励 +' + inst.reward + ' 分</span>' +
      (inst.cost > 0 ? '<span class="pill cost">消耗 -' + inst.cost + ' 分</span>' : '') +
      dlPill +
      (inst.status === 'done' && inst.completed_at ? '<span class="pill">完成于 ' + fmtTs(inst.completed_at) + '</span>' : '') +
      (inst.status === 'abandoned' && inst.created_at ? '<span class="pill">放弃于 ' + fmtTs(inst.created_at) + '</span>' : '') +
      '</div>' + filesHtml + actions + '</div>';
  }

  function bindMine() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-submit]'), function (b) {
      b.onclick = function () { openSubmitModal(parseInt(b.getAttribute('data-submit'), 10)); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-abandon]'), function (b) {
      b.onclick = function () {
        var iid = parseInt(b.getAttribute('data-abandon'), 10);
        confirmDialog('放弃任务', '放弃后任务将回到大厅（其他人可接取），已消耗的接取积分不退还。确定放弃吗？', '确定放弃', 'danger', function () {
          act('abandon', { instance_id: iid, member_id: IDENT.memberId }).then(function (res) {
            if (res.ok) { toast('已放弃任务'); refresh(); }
          });
        });
      };
    });
  }

  function openSubmitModal(iid) {
    pendingFiles = [];
    openModal('提交证据', '' +
      '<div class="form-field"><label>证据附件（照片/PDF，最多 6 个；手机可直接拍照）</label>' +
      '<input type="file" id="evFiles" multiple accept="image/*,application/pdf"></div>' +
      '<div class="thumbs" id="evThumbs"></div>' +
      '<div class="form-field" style="margin-top:10px"><label>文字说明（选填）</label>' +
      '<textarea id="evNote" placeholder="例如：已完成，照片为证"></textarea></div>' +
      '<div class="hint">请注意时限：接取后 ' + deadlineH() + ' 小时内提交，超时任务作废且接取消耗不退还。</div>', [
      { label: '取消', cls: 'ghost', onClick: function (close) { close(); } },
      { label: '提交给家长审核', cls: 'primary', onClick: function (close) {
        var note = ($('#evNote') || {}).value || '';
        if (!pendingFiles.length && !note.trim()) { toast('请至少上传一个附件或填写说明', true); return; }
        Promise.all(pendingFiles.map(fileToPayload)).then(function (payloadFiles) {
          act('submit', { instance_id: iid, member_id: IDENT.memberId, note: note, files: payloadFiles }).then(function (res) {
            if (res.ok) { close(); toast('已提交，等待家长审核'); refresh(); }
          });
        }).catch(function () { toast('附件处理失败，请重试', true); });
      } }
    ]);
    setTimeout(function () {
      var input = $('#evFiles');
      if (!input) return;
      input.onchange = function () {
        pendingFiles = Array.prototype.slice.call(input.files || []).slice(0, 6);
        var box = $('#evThumbs');
        box.innerHTML = pendingFiles.map(function (f) {
          if (f.type.indexOf('image/') === 0) {
            return '<img src="' + URL.createObjectURL(f) + '" alt="">';
          }
          return '<span class="file-chip">' + esc(f.name) + '</span>';
        }).join('');
      };
    }, 60);
  }

  function kidPointsHtml() {
    var m = me();
    var myReq = (S.spend_requests || []).filter(function (r) { return r.member_id === IDENT.memberId; });
    var html = '';
    if (m) {
      html += '<div class="card balance-card"><div class="row"><div>' +
        '<div class="label">' + esc(m.name) + '的当前积分</div>' +
        '<div class="num">' + m.balance + '<span style="font-size:16px"> 分</span></div></div>' +
        '<div class="actions"><button class="btn warm" id="btnSpend">使用积分</button></div></div></div>';
    }
    html += '<div class="section-title">我的使用申请</div>';
        if (myReq.length) {
          html += paged('points_req', myReq, function (r) {
            var st = r.status === 'pending' ? '等待家长确认' : (r.status === 'approved' ? '已确认扣除' : '已被拒绝');
            var pillCls = r.status === 'approved' ? 'done' : (r.status === 'pending' ? 'submitted' : 'cancelled');
            var title, desc = '';
            if (r.kind === 'cart' && (r.items || []).length) {
              // v11 购物车申请：标题显示合计与件数，明细逐行列出
              var cnt = (r.items || []).reduce(function (a, it) { return a + (it.quantity || 1); }, 0);
              title = '兑换 ' + r.items.length + ' 类商品（合计 ' + r.amount + ' 分）';
              desc = '<div class="req-items">' + r.items.map(function (it) {
                return '<div class="req-item"><span class="req-item-name">' + esc(it.name) +
                  ((it.quantity || 1) > 1 ? ' ×' + it.quantity : '') + '</span>' +
                  '<span class="req-item-amt">' + it.amount + ' 分</span></div>';
              }).join('') + '</div>';
            } else if (r.kind === 'reward' && r.reward_name) {
              title = '兑换：' + esc(r.reward_name) + ((r.quantity || 1) > 1 ? ' ×' + r.quantity : '') + '（' + r.amount + ' 分）';
            } else {
              title = '使用 ' + r.amount + ' 分';
            }
            return '<div class="card"><div class="card-head"><div class="card-title">' + title + '</div>' +
              '<span class="pill status-' + pillCls + '">' + st + '</span></div>' +
              desc +
              (r.decision_note && r.status !== 'pending' ? '<div class="card-desc">家长备注：' + esc(r.decision_note) + '</div>' : '') +
              (r.note ? '<div class="card-desc">备注：' + esc(r.note) + '</div>' : '') +
              '<div class="card-meta"><span class="pill">提交于 ' + fmtTs(r.created_at) + '</span></div></div>';
          });
        } else {
      html += '<div class="empty">还没有提交过使用申请</div>';
    }
    html += '<div class="section-title">积分流水</div><div class="card">';
    html += asyncPaged('points_ledger_' + IDENT.memberId, function (l) {
      var plus = l.delta > 0;
      return '<div class="ledger-row"><div class="ledger-left"><div>' + esc(LEDGER_LABEL[l.type] || l.type) + '</div>' +
        '<div class="ledger-note">' + esc(l.note || '') + ' · ' + fmtTs(l.created_at) + '</div></div>' +
        '<div class="ledger-delta ' + (plus ? 'plus' : 'minus') + '">' + (plus ? '+' : '') + l.delta + '</div></div>';
    }, '暂无流水');
    html += '</div>';
    return html;
  }

  function bindPoints() {
    var btn = $('#btnSpend');
    if (btn) btn.onclick = openSpendModal;
  }

  /* 按分类把兑换项分组：返回 [{cat, items}]（空分类归入「其他」并置末） */
  function groupRewards(rewards) {
    var order = [], map = {};
    rewards.forEach(function (r) {
      var c = (r.category || '').trim() || '其他';
      if (!map[c]) { map[c] = []; order.push(c); }
      map[c].push(r);
    });
    // 「其他」永远排在最后
    var idx = order.indexOf('其他');
    if (idx >= 0) { order.splice(idx, 1); order.push('其他'); }
    return order.map(function (c) { return { cat: c, items: map[c] }; });
  }

  /* ---------- v11：使用积分（网购商城购物车式） ----------
     交互：左侧/上方是「商品墙」（按分类分组的兑换项卡片，点「+」加购），
     下方是「购物车结算条」（数量加减、小计、合计、余额校验），一次提交给家长确认。
     保留「自由填写数值」入口（作为购物车中的一类明细，kind='free'）。 */
  function openSpendModal() {
    var m = me();
    if (!m) return;
    var rewards = (S.rewards || []).filter(function (r) { return r.active; });
    var groups = groupRewards(rewards);
    var cart = [];   // [{reward_id, name, cost, quantity, limit_type, remaining}]
    var freeAmount = 0;

    /* ---- 商品墙（按分类分组） ---- */
    function shopHtml() {
      if (!rewards.length) {
        return '<div class="empty">家长还没有设置可兑换的内容</div>';
      }
      return groups.map(function (g) {
        var cards = g.items.map(function (r) {
          var u = myRewardUsage(r.id);
          var soldOut = (r.limit_type !== 'none' && u.remaining <= 0);
          var limitTip = (r.limit_type !== 'none')
            ? (LIMIT_SHORT[r.limit_type] + '剩 ' + u.remaining + ' 次')
            : '不限次';
          return '<div class="shop-item' + (soldOut ? ' is-soldout' : '') + '" data-reward-card="' + r.id + '">' +
            '<div class="shop-thumb">' + esc(String(r.name).slice(0, 1)) + '</div>' +
            '<div class="shop-name" title="' + esc(r.name) + '">' + esc(r.name) + '</div>' +
            '<div class="shop-price"><b>' + r.cost + '</b> 分<span class="shop-unit">/次</span></div>' +
            '<div class="shop-limit' + (soldOut ? ' warn' : '') + '">' + esc(limitTip) + '</div>' +
            '<button class="shop-add" data-reward-add="' + r.id + '"' + (soldOut ? ' disabled' : '') + '>' +
            (soldOut ? '已兑完' : '＋ 加购') + '</button></div>';
        }).join('');
        return '<div class="shop-group">' +
          '<div class="shop-group-head"><span class="shop-group-name">' + esc(g.cat) + '</span>' +
          '<span class="shop-group-line"></span></div>' +
          '<div class="shop-grid">' + cards + '</div></div>';
      }).join('');
    }

    /* ---- 购物车条目 ---- */
    function cartRowsHtml() {
      if (!cart.length && !freeAmount) {
        return '<div class="cart-empty">购物车还是空的，点上面商品的「＋ 加购」</div>';
      }
      var rows = cart.map(function (c, i) {
        // 限额项：购物车里已有的数量达到本次可用余量时，禁用「＋」
        var maxed = (c.limit_type !== 'none' && c.quantity >= c.remaining);
        return '<div class="cart-row">' +
          '<div class="cart-thumb">' + esc(String(c.name).slice(0, 1)) + '</div>' +
          '<div class="cart-info"><div class="cart-name">' + esc(c.name) + '</div>' +
          '<div class="cart-sub">' + c.cost + ' 分/次' +
          (c.limit_type !== 'none' ? (' · 可兑 ' + c.remaining + ' 次') : '') + '</div></div>' +
          '<div class="cart-qty">' +
          '<button class="qty-btn" data-cart-dec="' + i + '"' + (c.quantity <= 1 ? ' disabled' : '') + '>−</button>' +
          '<span class="qty-num">' + c.quantity + '</span>' +
          '<button class="qty-btn" data-cart-inc="' + i + '"' + (maxed ? ' disabled title="本期可兑换次数已用完"' : '') + '>＋</button></div>' +
          '<div class="cart-sum">' + (c.cost * c.quantity) + ' 分</div>' +
          '<button class="cart-del" data-cart-del="' + i + '" title="移除">✕</button>' +
          '</div>';
      }).join('');
      if (freeAmount > 0) {
        rows += '<div class="cart-row">' +
          '<div class="cart-thumb free">自</div>' +
          '<div class="cart-info"><div class="cart-name">自由支配</div>' +
          '<div class="cart-sub">自定义数值</div></div>' +
          '<div class="cart-qty"><span class="qty-num" style="min-width:auto">×1</span></div>' +
          '<div class="cart-sum">' + freeAmount + ' 分</div>' +
          '<button class="cart-del" data-cart-free-del="1" title="移除">✕</button>' +
          '</div>';
      }
      return rows;
    }

    function cartTotal() {
      var t = freeAmount;
      cart.forEach(function (c) { t += c.cost * c.quantity; });
      return t;
    }

    function renderCart() {
      var box = $('#cartRows');
      if (box) box.innerHTML = cartRowsHtml();
      var total = cartTotal();
      var cnt = cart.reduce(function (a, c) { return a + c.quantity; }, 0) + (freeAmount > 0 ? 1 : 0);
      var badge = $('#cartBadge');
      if (badge) { badge.textContent = cnt; badge.style.display = cnt ? '' : 'none'; }
      var sum = $('#cartTotal');
      if (sum) sum.textContent = total;
      var dif = $('#cartDiff');
      if (dif) dif.textContent = (m.balance - total);
      var bar = $('#cartSummaryBar');
      if (bar) bar.classList.toggle('over', total > m.balance);
      bindCart();
    }

    function bindCart() {
      Array.prototype.forEach.call(document.querySelectorAll('[data-cart-inc]'), function (b) {
        b.onclick = function () {
          var i = parseInt(b.getAttribute('data-cart-inc'), 10);
          var c = cart[i];
          if (!c) return;
          if (c.quantity >= 99) { toast('单个商品一次最多兑换 99 次', true); return; }
          if (c.limit_type !== 'none' && c.quantity + 1 > c.remaining) {
            toast('「' + c.name + '」本次可兑换次数已达上限（剩 ' + c.remaining + ' 次）', true); return;
          }
          c.quantity += 1; renderCart();
        };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-cart-dec]'), function (b) {
        b.onclick = function () {
          var i = parseInt(b.getAttribute('data-cart-dec'), 10);
          if (!cart[i] || cart[i].quantity <= 1) return;
          cart[i].quantity -= 1; renderCart();
        };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-cart-del]'), function (b) {
        b.onclick = function () {
          var i = parseInt(b.getAttribute('data-cart-del'), 10);
          cart.splice(i, 1); renderCart();
        };
      });
      var fd = $('[data-cart-free-del]');
      if (fd) fd.onclick = function () { freeAmount = 0; renderCart(); };
    }

    function addToCart(rid) {
      var r = rewardOf(rid);
      if (!r) return;
      var u = myRewardUsage(r.id);
      if (r.limit_type !== 'none' && u.remaining <= 0) { toast('「' + r.name + '」本期已兑完', true); return; }
      var exist = cart.filter(function (c) { return c.reward_id === rid; })[0];
      if (exist) {
        if (exist.quantity >= 99) { toast('单个商品一次最多兑换 99 次', true); return; }
        if (r.limit_type !== 'none' && exist.quantity + 1 > u.remaining) {
          toast('「' + r.name + '」本次可兑换次数已达上限（剩 ' + u.remaining + ' 次）', true); return;
        }
        exist.quantity += 1;
      } else {
        cart.push({ reward_id: r.id, name: r.name, cost: r.cost, quantity: 1,
                    limit_type: r.limit_type, remaining: u.remaining });
      }
      renderCart();
      toast('已加入购物车：' + r.name);
    }

    openModal('兑换商城', '' +
      '<div class="shop-wrap">' +
      '<div class="shop-tip">当前余额 <b>' + m.balance + '</b> 分 · 选好后一起提交，家长一次确认</div>' +
      shopHtml() +
      '<div class="shop-group"><div class="shop-group-head">' +
      '<span class="shop-group-name">其他</span><span class="shop-group-line"></span></div>' +
      '<div class="shop-grid"><div class="shop-item shop-item-free">' +
      '<div class="shop-thumb free">自</div>' +
      '<div class="shop-name">自由支配</div>' +
      '<div class="shop-price">自定 <b>数值</b></div>' +
      '<div class="shop-limit">不选商品时可用</div>' +
      '<button class="shop-add" id="shopFreeAdd">＋ 加购</button></div></div></div>' +
      '<div class="shop-group"><div class="shop-group-head">' +
      '<span class="shop-group-name">购物车</span>' +
      '<span class="cart-badge" id="cartBadge" style="display:none">0</span>' +
      '<span class="shop-group-line"></span></div>' +
      '<div class="cart-list" id="cartRows"></div>' +
      '<div class="cart-bar" id="cartSummaryBar">' +
      '<div class="cart-bar-left"><span>合计</span>' +
      '<span class="cart-total"><b id="cartTotal">0</b> 分</span>' +
      '<span class="cart-bal">余额 <b id="cartDiff">' + m.balance + '</b> 分</span></div></div>' +
      '<div class="form-field" style="margin-top:12px"><label>备注（选填）</label>' +
      '<input type="text" id="spNote" placeholder="例如：想这周五晚上用"></div>' +
      '</div>' +
      '<div id="spFreeWrap" style="display:none" class="cart-free-wrap">' +
      '<label>自由支配数值（分）</label>' +
      '<input type="number" id="spAmount" min="1" step="1" placeholder="例如：20">' +
      '<button class="btn small" id="spFreeOk">加入购物车</button></div>' +
      '</div>', [
      { label: '取消', cls: 'ghost', onClick: function (close) { close(); } },
      { label: '提交给家长确认', cls: 'warm', onClick: function (close) {
        var total = cartTotal();
        if (!cart.length && !freeAmount) { toast('购物车是空的，请先选择要兑换的内容', true); return; }
        if (total > m.balance) { toast('积分不足：购物车共需 ' + total + ' 分，当前 ' + m.balance + ' 分', true); return; }
        var note = ($('#spNote') || {}).value || '';
        var items = cart.map(function (c) {
          return { kind: 'reward', reward_id: c.reward_id, quantity: c.quantity };
        });
        if (freeAmount > 0) { items.push({ kind: 'free', amount: freeAmount }); }
        act('spend_request', { member_id: IDENT.memberId, kind: 'cart', items: items, note: note }).then(function (res) {
          if (res.ok) { close(); toast('已提交，等待家长确认'); refresh(); }
        });
      } }
    ]);

    setTimeout(function () {
      renderCart();
      Array.prototype.forEach.call(document.querySelectorAll('[data-reward-add]'), function (b) {
        b.onclick = function () { addToCart(parseInt(b.getAttribute('data-reward-add'), 10)); };
      });
      var fb = $('#shopFreeAdd');
      if (fb) fb.onclick = function () {
        var w = $('#spFreeWrap');
        w.style.display = (w.style.display === 'none') ? 'block' : 'none';
        var el = $('#spAmount');
        if (el) el.focus();
      };
      var fok = $('#spFreeOk');
      if (fok) fok.onclick = function () {
        var v = parseInt(($('#spAmount') || {}).value || '0', 10);
        if (!v || v <= 0) { toast('请填写大于 0 的数值', true); return; }
        if (v > m.balance) { toast('数值不能超过当前余额（' + m.balance + ' 分）', true); return; }
        freeAmount = v;
        $('#spFreeWrap').style.display = 'none';
        renderCart();
        toast('已加入购物车：自由支配 ' + v + ' 分');
      };
    }, 60);
  }

  /* ---------- 家长端：待办 ---------- */
  function parentTodoHtml() {
    var reviews = (S.instances || []).filter(function (i) { return i.status === 'submitted'; });
    var allReqs = (S.spend_requests || []).filter(function (r) { return r.status === 'pending'; });
    // v10：连续完成奖励单独成块（加分项），与积分扣除申请（减分项）分开，避免家长混淆
    var streakReqs = allReqs.filter(function (r) { return r.kind === 'streak'; });
    var reqs = allReqs.filter(function (r) { return r.kind !== 'streak'; });
    var pubs = (S.publish_requests || []).filter(function (r) { return r.status === 'pending'; });
    var html = '';
    if (streakReqs.length) {
      html += '<div class="section-title">连续完成奖励待确认（' + streakReqs.length + '）</div>';
      html += paged('todo_streak', streakReqs, function (r) {
        var m = (S.members || []).filter(function (x) { return x.id === r.member_id; })[0] || {};
        return '<div class="card"><div class="card-head"><div>' +
          '<div class="card-title">' + esc(r.member_name) + ' · ' + esc(r.note || '连续完成奖励') + '</div>' +
          '<div class="card-desc">已达成连续目标，确认后为其发放 ' + r.amount + ' 分（' +
          esc(r.member_name) + ' 当前 ' + (m.balance || 0) + ' 分，确认后变为 ' + ((m.balance || 0) + r.amount) + ' 分）</div></div>' +
          '<span class="pill status-submitted">待确认</span></div>' +
          '<div class="card-actions">' +
          '<button class="btn ok" data-streak-approve="' + r.id + '">确认发放 +' + r.amount + ' 分</button>' +
          '<button class="btn danger" data-streak-reject="' + r.id + '">不发放</button></div></div>';
      });
    }
    html += '<div class="section-title">待处理的发布申请（' + pubs.length + '）</div>';
    if (pubs.length) {
      html += paged('todo_pub', pubs, function (r) {
        var m = (S.members || []).filter(function (x) { return x.id === r.member_id; })[0] || {};
        return '<div class="card"><div class="card-head"><div>' +
          '<div class="card-title">' + esc(r.member_name) + ' 申请发布：' + esc(r.title) + '</div>' +
          '<div class="card-desc">' + typeLabel(r.type) + ' ｜ 完成奖励 +' + r.reward + ' 分 ｜ 发布费 -' + r.fee +
          ' 分（TA 当前余额 ' + (m.balance || 0) + ' 分）｜ 接取消耗 -' + r.cost + ' 分</div>' +
          (r.description ? '<div class="card-desc">说明：' + esc(r.description) + '</div>' : '') +
          '<div class="card-desc">通过：扣除发布费并创建任务（仅 TA 本人可接取）；驳回：不扣任何积分。提交于 ' + fmtTs(r.created_at) + '</div></div>' +
          '<span class="pill status-submitted">待处理</span></div>' +
          '<div class="card-actions">' +
          '<button class="btn ok" data-pub-approve="' + r.id + '">通过并发布（扣 ' + r.fee + ' 分）</button>' +
          '<button class="btn danger" data-pub-reject="' + r.id + '">驳回</button></div></div>';
      });
    } else {
      html += '<div class="empty">没有待处理的发布申请</div>';
    }
    html += '<div class="section-title">待审核的任务（' + reviews.length + '）</div>';
    if (reviews.length) {
      html += paged('todo_review', reviews, function (i) {
        var filesHtml = (i.files && i.files.length) ? '<div class="evidence">' + i.files.map(function (f) {
          if (/\.(png|jpe?g|webp|gif)$/i.test(f.url)) {
            return '<a href="' + f.url + '" target="_blank"><img src="' + f.url + '" alt="证据"></a>';
          }
          return '<a class="file-chip" href="' + f.url + '" target="_blank">' + esc(f.filename) + '</a>';
        }).join('') + '</div>' : '<div class="hint">（无附件）</div>';
        return '<div class="card"><div class="card-head"><div>' +
          '<div class="card-title">' + esc(i.task_title) + '</div>' +
          '<div class="card-desc">提交人：' + esc(i.assignee_name || '') + ' · ' + fmtTs(i.submitted_at) + '</div>' +
          (i.submit_note ? '<div class="card-desc">说明：' + esc(i.submit_note) + '</div>' : '') + '</div>' +
          '<span class="pill status-submitted">待审核</span></div>' + filesHtml +
          '<div class="card-actions">' +
          '<button class="btn ok" data-approve="' + i.id + '">通过并发放 +' + i.reward + ' 分</button>' +
          '<button class="btn danger" data-reject="' + i.id + '">驳回</button></div></div>';
      });
    } else {
      html += '<div class="empty">没有待审核的任务</div>';
    }
    html += '<div class="section-title">待确认的积分使用申请（' + reqs.length + '）</div>';
    if (reqs.length) {
      html += paged('todo_req', reqs, function (r) {
        var m = (S.members || []).filter(function (x) { return x.id === r.member_id; })[0] || {};
        var isCart = (r.kind === 'cart' && (r.items || []).length);
        var body, actions;
        if (isCart) {
          // v11 购物车申请：逐项勾选（默认全选），家长可只给其中几件
          var rows = r.items.map(function (it, i) {
            return '<label class="pick-item">' +
              '<input type="checkbox" data-pick-item="' + r.id + '" value="' + i + '" checked>' +
              '<span class="pick-name">' + esc(it.name) + ((it.quantity || 1) > 1 ? ' ×' + it.quantity : '') + '</span>' +
              '<span class="pick-amt">' + it.amount + ' 分</span></label>';
          }).join('');
          body = '<div class="pick-list">' + rows + '</div>' +
            '<div class="card-desc">已勾选 <b data-pick-count="' + r.id + '">' + r.items.length + '</b> / ' +
            r.items.length + ' 件，勾选合计 <b data-pick-total="' + r.id + '">' + r.amount + '</b> 分 · ' +
            esc(r.member_name) + ' 当前余额 ' + (m.balance || 0) + ' 分</div>' +
            (r.note ? '<div class="card-desc">备注：' + esc(r.note) + '</div>' : '');
          actions = '<button class="btn ok" data-cart-approve="' + r.id + '">确认选中项</button>' +
            '<button class="btn ghost" data-cart-all="' + r.id + '">全选</button>' +
            '<button class="btn danger" data-req-reject="' + r.id + '">整单拒绝</button>';
          return '<div class="card"><div class="card-head"><div>' +
            '<div class="card-title">' + esc(r.member_name) + ' 的购物车兑换（' + r.items.length + ' 类 · 合计 ' + r.amount + ' 分）</div>' +
            body + '</div><span class="pill status-submitted">待确认</span></div>' +
            '<div class="card-actions">' + actions + '</div></div>';
        }
        var title;
        if (r.kind === 'reward' && r.reward_name) {
          title = esc(r.member_name) + ' 申请兑换：' + esc(r.reward_name) +
            ((r.quantity || 1) > 1 ? ' ×' + r.quantity : '') + '（共 ' + r.amount + ' 分）';
        } else {
          title = esc(r.member_name) + ' 申请使用 ' + r.amount + ' 分';
        }
        return '<div class="card"><div class="card-head"><div>' +
          '<div class="card-title">' + title + '</div>' +
          (r.note ? '<div class="card-desc">备注：' + esc(r.note) + '</div>' : '') +
          '<div class="card-desc">当前余额 ' + (m.balance || 0) + ' 分，确认后余额将变为 ' + ((m.balance || 0) - r.amount) + ' 分</div></div>' +
          '<span class="pill status-submitted">待确认</span></div>' +
          '<div class="card-actions">' +
          '<button class="btn ok" data-req-approve="' + r.id + '">确认扣除 ' + r.amount + ' 分</button>' +
          '<button class="btn danger" data-req-reject="' + r.id + '">拒绝</button></div></div>';
      });
    } else {
      html += '<div class="empty">没有待确认的使用申请</div>';
    }
    setTimeout(bindParentTodo, 0);
    return html;
  }

  function bindParentTodo() {
    // v10：连续完成奖励的确认 / 不发放
    Array.prototype.forEach.call(document.querySelectorAll('[data-streak-approve]'), function (b) {
      b.onclick = function () {
        var rid = parseInt(b.getAttribute('data-streak-approve'), 10);
        var r = (S.spend_requests || []).filter(function (x) { return x.id === rid; })[0];
        if (!r) return;
        confirmDialog('发放连续完成奖励', '确认给' + r.member_name + '发放 ' + r.amount + ' 分吗？' +
          (r.note ? '（' + r.note + '）' : ''), '确认发放', 'ok', function () {
          act('parent:decide_request', { request_id: rid, approve: true }).then(function (res) {
            if (res.ok) { toast('已发放 ' + r.amount + ' 分'); refresh(); }
          });
        });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-streak-reject]'), function (b) {
      b.onclick = function () {
        var rid = parseInt(b.getAttribute('data-streak-reject'), 10);
        confirmDialog('不发放连续奖励', '确定不发放这条连续完成奖励吗？该记录会被标记为已拒绝。', '确认不发放', 'danger', function () {
          act('parent:decide_request', { request_id: rid, approve: false, note: '不发放' }).then(function (res) {
            if (res.ok) { toast('已跳过'); refresh(); }
          });
        });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-pub-approve]'), function (b) {
      b.onclick = function () {
        var rid = parseInt(b.getAttribute('data-pub-approve'), 10);
        var r = (S.publish_requests || []).filter(function (x) { return x.id === rid; })[0];
        if (!r) return;
        confirmDialog('通过发布申请', '同意' + r.member_name + '发布「' + r.title + '」吗？将通过扣除 ' + r.fee +
          ' 分发布费，并创建任务（完成奖励 +' + r.reward + ' 分，接取消耗 -' + r.cost + ' 分，仅 TA 本人可接取）。',
          '通过并发布', 'ok', function () {
          act('parent:decide_publish', { request_id: rid, approve: true }).then(function (res) { if (res.ok) { toast('已通过，任务已发布'); refresh(); } });
        });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-pub-reject]'), function (b) {
      b.onclick = function () {
        var rid = parseInt(b.getAttribute('data-pub-reject'), 10);
        confirmDialog('驳回发布申请', '确定驳回这条申请吗？不会扣除任何积分。', '确认驳回', 'danger', function () {
          act('parent:decide_publish', { request_id: rid, approve: false }).then(function (res) { if (res.ok) { toast('已驳回'); refresh(); } });
        });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-approve]'), function (b) {
      b.onclick = function () {
        var iid = parseInt(b.getAttribute('data-approve'), 10);
        var inst = (S.instances || []).filter(function (i) { return i.id === iid; })[0];
        if (!inst) return;
        confirmDialog('通过审核', '确认「' + inst.task_title + '」已按要求完成？将发放奖励 +' + inst.reward + ' 分' +
          ((S.settings.cost_refund && inst.cost > 0) ? '，并退还接取消耗 ' + inst.cost + ' 分' : '') + '。', '通过并发放', 'ok', function () {
          act('parent:approve', { instance_id: iid }).then(function (res) { if (res.ok) { toast('已发放积分'); refresh(); } });
        });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-reject]'), function (b) {
      b.onclick = function () {
        var iid = parseInt(b.getAttribute('data-reject'), 10);
        openModal('驳回任务', '<div class="form-field"><label>驳回原因（会展示给孩子）</label>' +
          '<textarea id="rjNote" placeholder="例如：桌面还没有擦干净，请补充照片"></textarea></div>' +
          '<div class="hint">驳回后任务回到「进行中」，孩子可补充证据后重新提交；接取消耗不重复扣。注意：如接近时限请提醒孩子尽快提交。</div>', [
          { label: '取消', cls: 'ghost', onClick: function (close) { close(); } },
          { label: '确认驳回', cls: 'danger', onClick: function (close) {
            var note = ($('#rjNote') || {}).value || '';
            act('parent:reject', { instance_id: iid, note: note }).then(function (res) { if (res.ok) { close(); toast('已驳回'); refresh(); } });
          } }
        ]);
      };
    });
    // v11：购物车申请 —— 逐项勾选，实时更新「已勾选件数 / 合计分」
    function pickedOf(rid) {
      var boxes = document.querySelectorAll('[data-pick-item="' + rid + '"]');
      var r = (S.spend_requests || []).filter(function (x) { return x.id === rid; })[0] || { items: [] };
      var picked = [], total = 0;
      Array.prototype.forEach.call(boxes, function (cb) {
        if (cb.checked) {
          var i = parseInt(cb.value, 10);
          if (r.items && r.items[i]) { picked.push(i); total += r.items[i].amount; }
        }
      });
      return { picked: picked, total: total };
    }
    function refreshPickBar(rid) {
      var p = pickedOf(rid);
      var cntEl = document.querySelector('[data-pick-count="' + rid + '"]');
      if (cntEl) cntEl.textContent = p.picked.length;
      var totEl = document.querySelector('[data-pick-total="' + rid + '"]');
      if (totEl) totEl.textContent = p.total;
    }
    Array.prototype.forEach.call(document.querySelectorAll('[data-pick-item]'), function (cb) {
      cb.onchange = function () { refreshPickBar(parseInt(cb.getAttribute('data-pick-item'), 10)); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-cart-all]'), function (b) {
      b.onclick = function () {
        var rid = parseInt(b.getAttribute('data-cart-all'), 10);
        Array.prototype.forEach.call(document.querySelectorAll('[data-pick-item="' + rid + '"]'), function (cb) {
          cb.checked = true;
        });
        refreshPickBar(rid);
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-cart-approve]'), function (b) {
      b.onclick = function () {
        var rid = parseInt(b.getAttribute('data-cart-approve'), 10);
        var r = (S.spend_requests || []).filter(function (x) { return x.id === rid; })[0];
        if (!r) return;
        var p = pickedOf(rid);
        if (!p.picked.length) { toast('请先勾选要发放的商品', true); return; }
        var names = p.picked.map(function (i) {
          var it = r.items[i];
          return it.name + ((it.quantity || 1) > 1 ? ' ×' + it.quantity : '');
        }).join('、');
        var full = p.picked.length === r.items.length;
        confirmDialog(full ? '确认整单扣除' : '确认部分通过',
          (full ? '确认' : '只通过其中 ' + p.picked.length + ' 件：') + esc(r.member_name) + '的兑换（' + names + '）？' +
          '将扣除 ' + p.total + ' 分。', '确认扣除', 'ok', function () {
          var payload = { request_id: rid, approve: full };
          if (!full) payload.items = p.picked;   // 部分通过：传选中明细下标
          act('parent:decide_request', payload).then(function (res) {
            if (res.ok) { toast('已扣除 ' + p.total + ' 分'); refresh(); }
          });
        });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-req-approve]'), function (b) {
      b.onclick = function () {
        var rid = parseInt(b.getAttribute('data-req-approve'), 10);
        var r = (S.spend_requests || []).filter(function (x) { return x.id === rid; })[0];
        if (!r) return;
        confirmDialog('确认扣除', '确认' + r.member_name + '的申请（' + reqTitlePlain(r) + '）吗？确认后扣除 ' +
          r.amount + ' 分。', '确认扣除', 'ok', function () {
          act('parent:decide_request', { request_id: rid, approve: true }).then(function (res) { if (res.ok) { toast('已扣除积分'); refresh(); } });
        });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-req-reject]'), function (b) {
      b.onclick = function () {
        var rid = parseInt(b.getAttribute('data-req-reject'), 10);
        confirmDialog('拒绝申请', '确定拒绝这条使用申请吗？不会扣除任何积分。', '确认拒绝', 'danger', function () {
          act('parent:decide_request', { request_id: rid, approve: false }).then(function (res) { if (res.ok) { toast('已拒绝'); refresh(); } });
        });
      };
    });
  }

  /* ---------- 家长端：任务管理 ---------- */
  function parentTasksHtml() {
    var tasks = S.tasks || [];
    var html = '<div class="section-title">任务列表 · ' + tasks.length + ' 个</div>';
    html += '<div class="card compact"><div class="card-actions" style="margin-top:0">' +
      '<button class="btn primary small" id="btnNewTask">发布新任务</button></div>' +
      '<div class="hint">每天例行任务每天自动刷新、每天可接一次；每周例行任务每周一刷新、每周可接一次；' +
      '可勾选可接取的孩子（不勾选 = 全部孩子，勾选多名时各自独立一份）；接取后需在 ' + deadlineH() + ' 小时内提交。</div></div>';
    if (!tasks.length) {
      html += '<div class="empty">还没有任务，点击上方按钮发布</div>';
      return html;
    }
    // v9.0：类型 + 标签 双维度筛选
    html += filterBarHtml('parent', TYPE_ORDER.slice(), taskTags(tasks));
    var shown = applyFilters(tasks, 'parent',
      function (t) { return t.type; },
      function (t) { return t.tag; });
    if (!shown.length) {
      html += '<div class="empty">没有符合筛选条件的任务</div>';
      return html;
    }
    html += '<div class="card">' + paged('parent_tasks', shown, function (t) {
      var typeText = t.type === 'routine'
        ? ('每周' + (t.weekday !== null && t.weekday !== undefined ? '·' + WEEKDAYS[t.weekday] : ''))
        : (t.type === 'daily' ? '每天' : '专项');
      var tag = String(t.tag || '').trim();
      return '<div class="task-row"><div class="task-main">' +
        '<div class="task-title">' + esc(t.title) + (t.active ? '' : '（已停用）') + '</div>' +
        '<div class="task-tagline">' +
        (tag ? '<span class="tag">' + esc(tag) + '</span>' : '') +
        '<span class="pill ' + t.type + ' sm">' + esc(TYPE_NAME[t.type] || typeText) + '</span>' +
        (t.type === 'routine' && t.weekday !== null && t.weekday !== undefined ? '<span class="pill sm">' + WEEKDAYS[t.weekday] + '</span>' : '') +
        (t.origin === 'kid' ? '<span class="pill sm">孩子自建</span>' : '') +
        '</div>' +
        '<div class="task-sub">奖励 +' + t.reward + ' ｜ 消耗 -' + t.cost + ' ｜ 对象：' + esc(kidsText(t)) + '</div>' +
        '<div class="task-sub">' + esc(taskInstanceSummary(t)) + '</div>' +
        '</div><div class="task-side">' +
        '<button class="btn small" data-edit-task="' + t.id + '">编辑</button>' +
        '<button class="btn small ' + (t.active ? 'danger' : 'ok') + '" data-toggle-task="' + t.id + '" data-to="' + (t.active ? '0' : '1') + '">' + (t.active ? '停用' : '启用') + '</button>' +
        '</div></div>';
    }) + '</div>';
    return html;
  }

  function bindParentTasks() {
    $('#btnNewTask').onclick = function () { openTaskModal(null); };
    bindFilters('parent');
    Array.prototype.forEach.call(document.querySelectorAll('[data-edit-task]'), function (b) {
      b.onclick = function () {
        var tid = parseInt(b.getAttribute('data-edit-task'), 10);
        openTaskModal((S.tasks || []).filter(function (t) { return t.id === tid; })[0]);
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-toggle-task]'), function (b) {
      b.onclick = function () {
        var tid = parseInt(b.getAttribute('data-toggle-task'), 10);
        var to = b.getAttribute('data-to') === '1';
        act('parent:toggle_task', { task_id: tid, active: to }).then(function (res) {
          if (res.ok) { toast(to ? '已启用（已刷新为可接取）' : '已停用'); refresh(); }
        });
      };
    });
  }

  function openTaskModal(task) {
    var isEdit = !!task;
    var t = task || { type: 'routine', title: '', description: '', reward: 10, cost: 2, weekday: null, kids: '' };
    var weekdayOpts = '<option value="">每周任意时间</option>' + WEEKDAYS.map(function (w, idx) {
      return '<option value="' + idx + '"' + (t.weekday === idx ? ' selected' : '') + '>' + w + '</option>';
    }).join('');
    var selKids = String(t.kids || '').split(',').filter(Boolean);
    var kidsHtml = kids().map(function (m) {
      var ck = selKids.indexOf(String(m.id)) >= 0 ? ' checked' : '';
      return '<label class="kid-check"><input type="checkbox" name="tkKid" value="' + m.id + '"' + ck + '> ' + esc(m.name) + '</label>';
    }).join('') || '<span class="hint">（暂无孩子成员）</span>';
    openModal(isEdit ? '编辑任务' : '发布新任务', '' +
      '<div class="form-row"><div class="form-field"><label>任务类型</label>' +
      '<select class="full" id="tkType">' +
      '<option value="routine"' + (t.type === 'routine' ? ' selected' : '') + '>每周例行</option>' +
      '<option value="daily"' + (t.type === 'daily' ? ' selected' : '') + '>每天例行</option>' +
      '<option value="special"' + (t.type === 'special' ? ' selected' : '') + '>专项任务</option>' +
      '</select></div>' +
      '<div class="form-field" id="wkField"><label>建议完成日（选填，仅每周例行）</label><select class="full" id="tkWeekday">' + weekdayOpts + '</select></div></div>' +
      '<div class="form-field"><label>可接取的孩子（不勾选 = 所有孩子可接；勾选多名时各自独立一份）</label>' +
      '<div class="kid-checks" id="tkKids">' + kidsHtml + '</div></div>' +
      '<div class="form-field"><label>任务名称</label><input type="text" id="tkTitle" value="' + esc(t.title) + '" placeholder="例如：每日阅读 20 分钟"></div>' +
      '<div class="form-field"><label>标签（选填，用于分类筛选）</label>' +
      '<select class="full" id="tkTag">' + tagOptionsHtml(t.tag) + '</select>' +
      '<input type="text" id="tkTagCustom" maxlength="12" placeholder="输入自定义标签" style="display:none;margin-top:8px">' +
      '</div>' +
      '<div class="form-field"><label>任务说明（选填）</label><textarea id="tkDesc" placeholder="具体要求、验收标准等">' + esc(t.description) + '</textarea></div>' +
      '<div class="form-row"><div class="form-field"><label>完成奖励（分）</label>' +
      '<input type="number" id="tkReward" min="0" value="' + t.reward + '"></div>' +
      '<div class="form-field"><label>接取消耗（自动计算）</label>' +
      '<div class="tk-cost-ro" id="tkCostRo">—</div></div></div>' +
      '<div class="hint">接取消耗 = 完成奖励 × 接取费率 <b>' + pubSettings().n + '%</b>' +
      '（在「设置 → 孩子自建任务 → 接取费率 n」统一调整，所有任务共用此费率）。<br>' +
      '每天例行的实例每天自动刷新；接取后需在 ' + deadlineH() + ' 小时内提交，超时作废；接取消耗在接取时扣除（' + costHint() + '）。</div>', [
      { label: '取消', cls: 'ghost', onClick: function (close) { close(); } },
      { label: isEdit ? '保存修改' : '发布任务', cls: 'primary', onClick: function (close) {
        var tagSel = $('#tkTag');
        var tag = tagSel ? tagSel.value : '';
        if (tag === '__custom__') tag = ($('#tkTagCustom') || {}).value || '';
        var payload = {
          task_id: isEdit ? t.id : 0,
          type: $('#tkType').value,
          title: $('#tkTitle').value.trim(),
          description: $('#tkDesc').value.trim(),
          tag: String(tag).trim().slice(0, 12),
          reward: parseInt($('#tkReward').value || '0', 10),
          // v13：不传 cost —— 接取消耗由后端按「奖励 × 接取费率 n%」统一计算
          weekday: $('#tkWeekday').value === '' ? null : parseInt($('#tkWeekday').value, 10),
          kids: Array.prototype.slice.call(document.querySelectorAll('input[name=tkKid]:checked')).map(function (el) {
            return parseInt(el.value, 10);
          })
        };
        if (!payload.title) { toast('请填写任务名称', true); return; }
        act('parent:save_task', payload).then(function (res) {
          if (res.ok) { close(); toast(isEdit ? '已保存（当期未接取实例已按新设置刷新）' : '已发布'); refresh(); }
        });
      } }
    ]);
    // v13：奖励输入实时联动「接取消耗」只读展示
    (function () {
      var ro = $('#tkCostRo');
      var rw = $('#tkReward');
      function syncCost() {
        if (!ro) return;
        var v = parseInt((rw || {}).value || '0', 10);
        if (isNaN(v) || v <= 0) { ro.textContent = '免接取费'; return; }
        var c = pubCost(v);
        ro.textContent = c > 0 ? ('-' + c + ' 分') : '免接取费（费率 ' + pubSettings().n + '%）';
      }
      if (rw) { rw.oninput = syncCost; rw.onchange = syncCost; }
      syncCost();
    })();
    var typeSel = $('#tkType');
    var wkField = $('#wkField');
    function syncWeek() { wkField.style.display = typeSel.value === 'routine' ? '' : 'none'; }
    typeSel.onchange = syncWeek; syncWeek();
    var tagSel = $('#tkTag');
    var tagCustom = $('#tkTagCustom');
    function syncTag() {
      if (!tagSel || !tagCustom) return;
      tagCustom.style.display = tagSel.value === '__custom__' ? '' : 'none';
      if (tagSel.value === '__custom__') tagCustom.focus();
    }
    if (tagSel) { tagSel.onchange = syncTag; syncTag(); }
  }

  /* ---------- 家长端：兑换清单 ---------- */
  var REWARD_FILTER = '';   // 当前选中的分类筛选（''=全部）

  function rewardRowHtml(r) {
    var used = rewardUsageTotal(r.id);
    var periodText = r.limit_type === 'none' ? '不限次数' : (LIMIT_LABEL[r.limit_type] + '最多 ' + r.limit_count + ' 次');
    var usageText = r.limit_type === 'none'
      ? ('累计已兑换 ' + used.approved + ' 次' + (used.pending ? '（待确认 ' + used.pending + '）' : ''))
      : (LIMIT_SHORT[r.limit_type] + '已兑换 ' + used.approved + ' 次 / 限 ' + r.limit_count + ' 次' +
         (used.pending ? '（待确认 ' + used.pending + '）' : ''));
    return '<div class="task-row"><div class="task-main">' +
      '<div class="task-title">' + esc(r.name) + (r.active ? '' : '（已停用）') + '</div>' +
      '<div class="task-sub">' + r.cost + ' 分/次 ｜ ' + periodText + ' ｜ ' + usageText + '</div></div>' +
      '<div class="task-side">' +
      '<button class="btn small" data-edit-reward="' + r.id + '">编辑</button>' +
      '<button class="btn small ' + (r.active ? 'danger' : 'ok') + '" data-toggle-reward="' + r.id + '" data-to="' + (r.active ? '0' : '1') + '">' + (r.active ? '停用' : '启用') + '</button>' +
      '</div></div>';
  }

  function parentRewardsHtml() {
    var rewards = S.rewards || [];
    var activeCount = rewards.filter(function (r) { return r.active; }).length;
    var html = '<div class="section-title">兑换清单 · ' + rewards.length + ' 项</div>';
    html += '<div class="card compact"><div class="card-actions" style="margin-top:0">' +
      '<button class="btn primary small" id="btnNewReward">发布兑换项</button></div>' +
      '<div class="hint">兑换项按分类分组展示，孩子端「使用积分」下拉也会按分类分组，找起来更快。' +
      '格式示例：「游戏 1 小时」= 1500 分/次，每周最多 3 次。</div></div>';
    if (!rewards.length) {
      html += '<div class="empty">还没有兑换项，点击上方按钮发布</div>';
      return html;
    }
    // 分类筛选条
    var groups = groupRewards(rewards);
    html += '<div class="filter-bar">' +
      '<button class="chip' + (REWARD_FILTER === '' ? ' on' : '') + '" data-rfilter="">全部（' + rewards.length + '）</button>' +
      groups.map(function (g) {
        return '<button class="chip' + (REWARD_FILTER === g.cat ? ' on' : '') + '" data-rfilter="' + esc(g.cat) + '">' +
          esc(g.cat) + '（' + g.items.length + '）</button>';
      }).join('') + '</div>';
    // 按分类分区
    groups.forEach(function (g) {
      if (REWARD_FILTER && REWARD_FILTER !== g.cat) return;
      html += '<div class="card"><div class="cat-head">' + esc(g.cat) +
        '<span class="cat-count">' + g.items.length + ' 项</span></div>' +
        paged('parent_rewards_' + g.cat, g.items, rewardRowHtml) + '</div>';
    });
    return html;
  }

  function bindParentRewards() {
    $('#btnNewReward').onclick = function () { openRewardModal(null); };
    Array.prototype.forEach.call(document.querySelectorAll('[data-rfilter]'), function (b) {
      b.onclick = function () {
        REWARD_FILTER = b.getAttribute('data-rfilter') || '';
        renderView();
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-edit-reward]'), function (b) {
      b.onclick = function () {
        var rid = parseInt(b.getAttribute('data-edit-reward'), 10);
        openRewardModal(rewardOf(rid));
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-toggle-reward]'), function (b) {
      b.onclick = function () {
        var rid = parseInt(b.getAttribute('data-toggle-reward'), 10);
        var to = b.getAttribute('data-to') === '1';
        act('parent:toggle_reward', { reward_id: rid, active: to }).then(function (res) { if (res.ok) refresh(); });
      };
    });
  }

  function openRewardModal(reward) {
    var isEdit = !!reward;
    var r = reward || { name: '', cost: 10, limit_type: 'week', limit_count: 1, category: '' };
    var ltOpts = ['day', 'week', 'month', 'none'].map(function (k) {
      return '<option value="' + k + '"' + (r.limit_type === k ? ' selected' : '') + '>' + LIMIT_LABEL[k] + '</option>';
    }).join('');
    // 分类下拉：预置常用分类 + 允许自行输入
    var presetCats = ['自由支配金', '自我投资', '社交体验', '数字时间', '特权与自主'];
    var catOpts = '<option value="">（未分类）</option>' + presetCats.map(function (c) {
      return '<option value="' + c + '"' + (r.category === c ? ' selected' : '') + '>' + c + '</option>';
    }).join('');
    var customCat = (r.category && presetCats.indexOf(r.category) < 0) ? r.category : '';
    catOpts += '<option value="__custom__"' + (customCat ? ' selected' : '') + '>自定义…</option>';
    openModal(isEdit ? '编辑兑换项' : '发布兑换项', '' +
      '<div class="form-field"><label>兑换名称</label>' +
      '<input type="text" id="rwName" value="' + esc(r.name) + '" placeholder="例如：游戏 / 短视频 1 小时"></div>' +
      '<div class="form-row"><div class="form-field"><label>所需积分（分/次）</label>' +
      '<input type="number" id="rwCost" min="1" value="' + r.cost + '"></div>' +
      '<div class="form-field"><label>分类</label><select class="full" id="rwCat">' + catOpts + '</select></div></div>' +
      '<div class="form-field" id="rwCatCustomWrap" style="display:none"><label>自定义分类名</label>' +
      '<input type="text" id="rwCatCustom" value="' + esc(customCat) + '" placeholder="例如：学习装备"></div>' +
      '<div class="form-row"><div class="form-field"><label>限额周期</label><select class="full" id="rwLimitType">' + ltOpts + '</select></div>' +
      '<div class="form-field" id="rwCountWrap"><label>限额数量</label>' +
      '<input type="number" id="rwLimitCount" min="1" value="' + (r.limit_count || 1) + '"></div></div>' +
      '<div class="hint">限额 = 每名孩子在周期内最多可兑换的次数（含待确认）。选择「不限」则不需要填数量。</div>', [
      { label: '取消', cls: 'ghost', onClick: function (close) { close(); } },
      { label: isEdit ? '保存修改' : '发布', cls: 'primary', onClick: function (close) {
        var catVal = $('#rwCat').value;
        var category = catVal === '__custom__' ? ($('#rwCatCustom').value.trim()) : catVal;
        var payload = {
          reward_id: isEdit ? r.id : 0,
          name: $('#rwName').value.trim(),
          cost: parseInt($('#rwCost').value || '0', 10),
          category: category,
          limit_type: $('#rwLimitType').value,
          limit_count: $('#rwLimitType').value === 'none' ? 1 : parseInt($('#rwLimitCount').value || '1', 10)
        };
        if (!payload.name) { toast('请填写兑换名称', true); return; }
        act('parent:save_reward', payload).then(function (res) { if (res.ok) { close(); toast('已保存'); refresh(); } });
      } }
    ]);
    var ltSel = $('#rwLimitType');
    var cntWrap = $('#rwCountWrap');
    function syncLimit() { cntWrap.style.display = ltSel.value === 'none' ? 'none' : ''; }
    ltSel.onchange = syncLimit; syncLimit();
    var catSel = $('#rwCat');
    var catWrap = $('#rwCatCustomWrap');
    function syncCat() { catWrap.style.display = catSel.value === '__custom__' ? '' : 'none'; }
    catSel.onchange = syncCat; syncCat();
  }

  /* ---------- 家长端：孩子与积分 ---------- */
  function parentKidsHtml() {
    var html = '<div class="section-title">孩子积分总览</div>';
    var kidList = kids();
    if (!kidList.length) return html + '<div class="empty">还没有孩子成员，请在设置中添加</div>';
    html += paged('parent_kids', kidList, function (k) {
      return '<div class="card"><div class="card-head"><div>' +
        '<div class="card-title">' + esc(k.name) + '</div>' +
        '<div class="card-desc">当前积分：<b style="font-size:20px;color:var(--brand-deep)">' + k.balance + '</b> 分</div></div>' +
        '<div><button class="btn small" data-adjust="' + k.id + '">调整积分</button></div></div>' +
        '<div style="margin-top:8px">' + asyncPaged('kids_ledger_' + k.id, function (l) {
          var plus = l.delta > 0;
          return '<div class="ledger-row"><div class="ledger-left"><div>' + esc(LEDGER_LABEL[l.type] || l.type) + '</div>' +
            '<div class="ledger-note">' + esc(l.note || '') + ' · ' + fmtTs(l.created_at) + '</div></div>' +
            '<div class="ledger-delta ' + (plus ? 'plus' : 'minus') + '">' + (plus ? '+' : '') + l.delta + '</div></div>';
        }, '暂无流水') + '</div>' +
        '</div>';
    });
    return html;
  }

  function bindParentKids() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-adjust]'), function (b) {
      b.onclick = function () {
        var mid = parseInt(b.getAttribute('data-adjust'), 10);
        openModal('调整积分', '<div class="form-field"><label>调整数值（正数加分，负数扣分）</label>' +
          '<input type="number" id="adjDelta" step="1" placeholder="例如：10 或 -5"></div>' +
          '<div class="form-field"><label>原因说明（选填）</label><input type="text" id="adjNote" placeholder="例如：奖励、临时扣减"></div>', [
          { label: '取消', cls: 'ghost', onClick: function (close) { close(); } },
          { label: '确认调整', cls: 'primary', onClick: function (close) {
            var delta = parseInt(($('#adjDelta') || {}).value || '0', 10);
            var note = ($('#adjNote') || {}).value || '';
            if (!delta) { toast('请填写非 0 的数值', true); return; }
            act('parent:adjust', { member_id: mid, delta: delta, note: note }).then(function (res) { if (res.ok) { close(); toast('已调整'); refresh(); } });
          } }
        ]);
      };
    });
  }

  /* ---------- 家长端：设置 ---------- */
  function settingsHtml() {
    var parents = (S.members || []).filter(function (m) { return m.role === 'parent'; });
    var html = '<div class="section-title">家庭信息</div>';
    html += '<div class="card"><div class="form-field"><label>家庭名称</label>' +
      '<input type="text" id="stFam" value="' + esc(S.settings.family_name) + '"></div>' +
      '<div class="card-actions"><button class="btn primary small" id="stFamSave">保存</button></div></div>';
    html += '<div class="section-title">接取消耗规则</div>';
    html += '<div class="card"><div class="form-field"><label>任务完成并经审核通过后，接取消耗的积分：</label>' +
      '<div style="margin-top:6px"><label style="display:block;font-weight:400;margin-bottom:6px">' +
      '<input type="radio" name="stRefund" value="1"' + (S.settings.cost_refund ? ' checked' : '') + '> 全额退还（押金制，推荐）</label>' +
      '<label style="display:block;font-weight:400"><input type="radio" name="stRefund" value="0"' + (!S.settings.cost_refund ? ' checked' : '') + '> 不退还（成本制）</label></div></div>' +
      '<div class="hint">放弃/未完成/超时作废时接取消耗均不退还。提交时限：接取后 ' + deadlineH() + ' 小时内（当前为固定值）。</div>' +
      '<div class="card-actions"><button class="btn primary small" id="stRefundSave">保存规则</button></div></div>';
    html += '<div class="section-title">孩子自建任务（申请发布）</div>';
    html += '<div class="card"><div class="form-field"><label>功能开关</label>' +
      '<div style="margin-top:6px"><label style="display:block;font-weight:400;margin-bottom:6px">' +
      '<input type="radio" name="stKidPub" value="1"' + (S.settings.kid_publish_enabled ? ' checked' : '') + '> 开启：孩子可申请发布任务</label>' +
      '<label style="display:block;font-weight:400"><input type="radio" name="stKidPub" value="0"' + (!S.settings.kid_publish_enabled ? ' checked' : '') + '> 关闭：孩子不可申请（已提交的申请与已发布的任务不受影响）</label></div></div>' +
      '<div class="form-row">' +
      '<div class="form-field"><label>发布费率 m（%）</label><input type="number" id="stPubFee" min="0" step="1" value="' + S.settings.kid_publish_fee + '"></div>' +
      '<div class="form-field"><label>接取费率 n（%）</label><input type="number" id="stPubCost" min="0" step="1" value="' + S.settings.kid_claim_cost + '"></div>' +
      '<div class="form-field"><label>利息率 x（%）</label><input type="number" id="stInterest" min="0" step="1" value="' + S.settings.interest_rate + '"></div></div>' +
      '<div class="hint long">m / n / x 只能设置为大于等于 0 的整数（默认 5 / 5 / 1，填写 0 表示免费或关闭利息）。<br>' +
      '发布费 = 奖励 × m%（申请通过时扣除）；均向下取整、未完成不退还。<br>' +
      '<b>接取费率 n 为全局统一费率</b>：<b>所有任务</b>（含你发布的任务与孩子自建通过的任务）的接取消耗 ' +
      '= 完成奖励 × n%，保存后自动同步调整全部任务的接取消耗；孩子自建任务的接取消耗也共用此费率。<br>' +
      '利息：孩子余额每天获得 余额 × x% 的积分（每天一次、向下取整，余额为 0 时不计息）。</div>' +
      '<div class="card-actions"><button class="btn primary small" id="stKidPubSave">保存设置</button>' +
      '<button class="btn small" id="stResyncCost">重算全部任务接取消耗</button></div></div>';
    html += '<div class="section-title">成员管理</div>';
    html += '<div class="card">';
    html += paged('settings_members', S.members || [], function (m) {
      return '<div class="task-row"><div class="task-main"><div class="task-title">' + esc(m.name) + '</div>' +
        '<div class="task-sub">' + (m.role === 'parent' ? '家长' : '孩子') + ' ｜ 余额 ' + m.balance + ' 分</div></div>' +
        '<div class="task-side"><button class="btn small" data-rename="' + m.id + '">改名</button></div></div>';
    });
    html += '<div class="card-actions"><button class="btn small" id="stAddChild">添加孩子</button>' +
      '<button class="btn small" id="stAddParent">添加家长</button></div></div>';
    html += '<div class="section-title">成员 PIN 管理</div>';
    html += '<div class="card">' +
      '<div class="card-desc">每位孩子有独立 PIN，进入自己的页面时需验证。首次使用默认 <b>1234</b>，' +
      '成员进入后会被要求立即修改。你可在此为任意成员单独设置或重置 PIN。</div>';
    var kidsList = kids();
    if (!kidsList.length) {
      html += '<div class="empty">还没有孩子成员，请先在上方「成员管理」中添加</div>';
    } else {
      html += kidsList.map(function (k) {
        var status = k.pin_changed
          ? '<span class="pin-badge ok">已自定义</span>'
          : '<span class="pin-badge warn">默认 1234</span>';
        return '<div class="pin-row"><div class="pin-row-main"><div class="pin-row-name">' + esc(k.name) + '</div>' +
          '<div class="pin-row-sub">' + status + '</div></div>' +
          '<div class="pin-row-actions">' +
          '<button class="btn small" data-setmpin="' + k.id + '">设置 PIN</button>' +
          '<button class="btn small ghost" data-resetmpin="' + k.id + '">重置为 1234</button>' +
          '</div></div>';
      }).join('');
    }
    html += '</div>';
    html += '<div class="section-title">家长安全</div>';
    html += '<div class="card"><div class="form-field"><label>修改家长 PIN（当前家长：' +
      esc(parents.map(function (p) { return p.name; }).join('、') || '未设置') + '）</label>' +
      '<input type="password" id="stNewPin" placeholder="新的 PIN（至少 4 位）"></div>' +
      '<div class="card-actions"><button class="btn primary small" id="stPinSave">修改 PIN</button></div></div>';
    html += '<div class="section-title">数据与配置</div>';
    // ---- 区 1：配置导出 / 导入 ----
    html += '<div class="card io-card">' +
      '<div class="io-head"><span class="io-tag cfg">配置</span><span class="io-title">配置导出 / 导入</span></div>' +
      '<div class="io-desc">导出当前的服务端与家长端设置（家庭名称、接取规则、孩子自建任务费率、利息率、连续完成奖励等），' +
      '换台设备或重新部署时可一键还原。</div>' +
      '<div class="io-format">文件格式：<b>.json</b>（format = <code>family-points-config</code>，version = 1）｜' +
      '不含家长 PIN，不含任务与积分数据</div>' +
      '<div class="zone-actions">' +
      '<button class="btn small" id="stCfgExport" data-label="导出配置">导出配置</button>' +
      '<button class="btn small" id="stCfgImport">导入配置</button>' +
      '<input type="file" id="stCfgFile" accept=".json,application/json" style="display:none">' +
      '</div>' +
      '<div class="io-hint">导入前会校验文件格式、字段完整性与版本兼容性；校验不通过时不会覆盖现有配置。</div>' +
      '</div>';
    // ---- 区 2：数据备份导出 / 导入 ----
    html += '<div class="card io-card">' +
      '<div class="io-head"><span class="io-tag bak">备份</span><span class="io-title">数据备份导出 / 导入</span></div>' +
      '<div class="io-desc">导出完整数据备份（成员、任务、兑换清单、积分流水、兑换申请、上传记录等全部内容），' +
      '用于整机迁移或灾难恢复。</div>' +
      '<div class="io-format">文件格式：<b>.json</b>（format = <code>family-points-backup</code>，version = 1）｜' +
      '不含家长 PIN</div>' +
      '<div class="zone-actions">' +
      '<button class="btn small" id="stBakExport" data-label="导出数据备份">导出数据备份</button>' +
      '<button class="btn small" id="stBakImport">导入数据备份</button>' +
      '<input type="file" id="stBakFile" accept=".json,application/json" style="display:none">' +
      '</div>' +
      '<div class="io-hint warn">导入备份会<b>覆盖</b>当前全部数据（含成员、任务、积分与记录），操作前请先导出备份留档。</div>' +
      '</div>';
    // ---- 区 3：清空所有数据 ----
    html += '<div class="card io-card">' +
      '<div class="io-head"><span class="io-tag danger">重置</span><span class="io-title">清空所有数据</span></div>' +
      '<div class="io-desc">删除全部任务、兑换清单、积分流水与申请记录，并重建为出厂默认的任务体系与兑换清单。</div>' +
      '<div class="io-keep">保留内容：<b>访问口令</b>、<b>家长 PIN</b>。重置后成员回到「老大 / 老二 / 家长」。</div>' +
      '<div class="zone-actions">' +
      '<button class="btn small danger" id="stClearData">清空所有数据</button>' +
      '<button class="btn small" id="stLoadDemo">载入演示数据</button>' +
      '</div>' +
      '<div class="io-hint">全部数据保存在本机 data 文件夹内；也可直接复制 data 文件夹做整机备份。</div>' +
      '</div>';
    return html;
  }

  function bindSettings() {
    $('#stFamSave').onclick = function () {
      act('parent:set_setting', { key: 'family_name', value: $('#stFam').value.trim() }).then(function (res) { if (res.ok) { toast('已保存'); refresh(); } });
    };
    $('#stRefundSave').onclick = function () {
      var val = document.querySelector('input[name=stRefund]:checked').value === '1';
      act('parent:set_setting', { key: 'cost_refund', value: val }).then(function (res) { if (res.ok) { toast('已保存'); refresh(); } });
    };
    $('#stKidPubSave').onclick = function () {
      var enabled = document.querySelector('input[name=stKidPub]:checked').value === '1';
      var feeRaw = String(($('#stPubFee') || {}).value || '').trim();
      var costRaw = String(($('#stPubCost') || {}).value || '').trim();
      var intRaw = String(($('#stInterest') || {}).value || '').trim();
      if (!/^\d+$/.test(feeRaw) || !/^\d+$/.test(costRaw) || !/^\d+$/.test(intRaw)) {
        toast('m / n / x 只能填写大于等于 0 的整数', true); return;
      }
      var items = [
        ['kid_publish_enabled', enabled],
        ['kid_publish_fee', parseInt(feeRaw, 10)],
        ['kid_claim_cost', parseInt(costRaw, 10)],
        ['interest_rate', parseInt(intRaw, 10)]
      ];
      var synced = 0;   // v13：接取费率变更后自动同步的任务数
      var chain = Promise.resolve(true);
      items.forEach(function (it) {
        chain = chain.then(function (prev) {
          return act('parent:set_setting', { key: it[0], value: it[1] }).then(function (res) {
            if (it[0] === 'kid_claim_cost' && res.ok && typeof res.synced === 'number') synced = res.synced;
            return prev && res.ok;
          });
        });
      });
      chain.then(function (all) {
        if (all) {
          toast(synced > 0
            ? ('设置已保存，已同步调整 ' + synced + ' 个任务的接取消耗')
            : '设置已保存');
          refresh();
        }
      });
    };
    $('#stResyncCost').onclick = function () {
      act('parent:resync_claim_cost', {}).then(function (res) {
        if (res.ok) {
          toast(res.synced > 0
            ? ('已重算：' + res.synced + ' 个任务的接取消耗已按当前费率更新')
            : '所有任务的接取消耗已与当前费率一致，无需调整');
          if (res.synced > 0) refresh();
        }
      });
    };
    $('#stPinSave').onclick = function () {
      var pin = $('#stNewPin').value.trim();
      if (pin.length < 4) { toast('PIN 至少 4 位', true); return; }
      act('parent:set_setting', { key: 'parent_pin', value: pin }).then(function (res) {
        if (res.ok) {
          toast('PIN 已修改，请重新登录');
          IDENT.token = ''; IDENT.mode = 'kid'; saveIdent();
          promptPin();
        }
      });
    };
    $('#stAddChild').onclick = function () { addMemberModal('child'); };
    $('#stAddParent').onclick = function () { addMemberModal('parent'); };
    // v15：成员 PIN 管理 —— 设置 / 重置
    Array.prototype.forEach.call(document.querySelectorAll('[data-setmpin]'), function (b) {
      b.onclick = function () {
        var mid = parseInt(b.getAttribute('data-setmpin'), 10);
        var m = (S.members || []).filter(function (x) { return x.id === mid; })[0];
        openModal('设置「' + (m ? m.name : '') + '」的 PIN',
          '<div class="form-field"><label>新 PIN（至少 4 位）</label>' +
          '<input type="password" id="pmPin" inputmode="numeric" autocomplete="off" placeholder="为该成员设置新 PIN"></div>' +
          '<div class="hint">保存后该成员当前登录状态立即失效，需用新 PIN 重新进入。</div>', [
          { label: '取消', cls: 'ghost', onClick: function (close) { close(); } },
          { label: '保存', cls: 'primary', onClick: function (close) {
            var pin = ($('#pmPin') || {}).value || '';
            if (pin.length < 4) { toast('PIN 至少 4 位', true); return; }
            act('parent:set_member_pin', { member_id: mid, pin: pin }).then(function (res) {
              if (res.ok) { close(); toast('已设置，成员需用新 PIN 重新进入'); refresh(); }
            });
          } }
        ]);
        setTimeout(function () { var el = $('#pmPin'); if (el) el.focus(); }, 60);
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-resetmpin]'), function (b) {
      b.onclick = function () {
        var mid = parseInt(b.getAttribute('data-resetmpin'), 10);
        var m = (S.members || []).filter(function (x) { return x.id === mid; })[0];
        confirmDialog('重置「' + (m ? m.name : '') + '」的 PIN',
          '将把该成员的 PIN 重置为默认 1234，且其当前登录状态立即失效。该成员下次进入时需用 1234 登录并重新设置新 PIN。确定继续？',
          '重置', 'danger', function () {
            act('parent:reset_member_pin', { member_id: mid }).then(function (res) {
              if (res.ok) { toast('已重置为默认 PIN 1234'); refresh(); }
            });
          });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-rename]'), function (b) {
      b.onclick = function () {
        var mid = parseInt(b.getAttribute('data-rename'), 10);
        var m = (S.members || []).filter(function (x) { return x.id === mid; })[0];
        openModal('修改称呼', '<div class="form-field"><label>新称呼</label><input type="text" id="rnName" value="' + esc(m.name) + '"></div>', [
          { label: '取消', cls: 'ghost', onClick: function (close) { close(); } },
          { label: '保存', cls: 'primary', onClick: function (close) {
            act('parent:rename_member', { member_id: mid, name: $('#rnName').value.trim() }).then(function (res) { if (res.ok) { close(); refresh(); } });
          } }
        ]);
      };
    });
    $('#stLoadDemo').onclick = function () {
      confirmDialog('载入演示数据', '将清空现有全部数据并载入演示数据（家庭「示例家庭」）。此操作不可撤销，确定继续？', '清空并载入', 'danger', function () {
        act('parent:load_demo', {}).then(function (res) {
          if (res.ok) {
            toast('已载入演示数据');
            IDENT.mode = 'parent'; saveIdent(); refresh();
          }
        });
      });
    };

    /* ---------- v13.1：配置 / 备份导出（fetch + Blob 下载） ----------
       为什么不用 <a href download>：
         ① 浏览器（尤其 Edge）对 HTTP 来源的直接下载可能报「无法下载 - 没有权限」而拦截；
         ② <a> 是静默导航，token 失效（如服务重启）时只会在下载列表里失败，用户看不到原因。
       改为先 fetch 拿 Blob 再触发本地下载：既绕开来源安全策略，又能捕获错误给出明确提示。 */
    function exportJson(url, filename, btn) {
      var label = btn ? (btn.getAttribute('data-label') || btn.textContent) : '';
      if (btn) { btn.disabled = true; btn.textContent = '导出中…'; }
      function restore() { if (btn) { btn.disabled = false; btn.textContent = label; } }
      return fetch(url, { headers: { 'Accept': 'application/json' } })
        .then(function (r) {
          if (r.status === 401) {
            // 访问口令会话过期 → 回登录页（与 fetchData / act 行为一致）
            if (location.pathname.indexOf('/login') !== 0) location.href = '/login';
            throw new Error('访问口令已过期，请重新登录后再导出');
          }
          if (r.status === 403) {
            // 家长身份失效（服务重启 / 改过 PIN）→ 清掉本地 token，引导重新登录
            IDENT.token = '';
            IDENT.mode = 'kid';
            saveIdent();
            throw new Error('家长身份已失效，请重新选择「家长」并输入 PIN 后再导出');
          }
          if (!r.ok) {
            return r.json().catch(function () { return {}; }).then(function (j) {
              throw new Error((j && j.error) || ('服务返回 ' + r.status));
            });
          }
          return r.blob();
        })
        .then(function (blob) {
          var a = document.createElement('a');
          var u = URL.createObjectURL(blob);
          a.href = u;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          setTimeout(function () { URL.revokeObjectURL(u); if (a.parentNode) a.parentNode.removeChild(a); }, 0);
          toast('已导出：' + filename);
        })
        .catch(function (err) {
          toast('导出失败：' + ((err && err.message) ? err.message : '网络错误，请确认服务在运行'), true);
          renderAll();   // token 可能已被清空，重绘回孩子端
        })
        .then(function () { restore(); });
    }
    $('#stCfgExport').onclick = function () {
      exportJson('/api/parent/config?token=' + encodeURIComponent(IDENT.token), 'family-config.json', this);
    };
    $('#stBakExport').onclick = function () {
      exportJson('/api/parent/backup?token=' + encodeURIComponent(IDENT.token), 'family-backup.json', this);
    };

    /* ---------- v12：配置导入 ---------- */
    $('#stCfgImport').onclick = function () { $('#stCfgFile').click(); };
    $('#stCfgFile').onchange = function () {
      var input = $('#stCfgFile');
      var file = input.files && input.files[0];
      if (!file) return;
      readJsonFile(file).then(function (doc) {
        // 前端预校验（快速失败，减少无谓请求）
        if (!doc || typeof doc !== 'object') throw new Error('文件内容不是有效的 JSON 对象');
        if (doc.format !== 'family-points-config') {
          throw new Error('这不是本系统的配置文件（缺少正确的 format 标识）');
        }
        if (!doc.settings || typeof doc.settings !== 'object') {
          throw new Error('配置文件缺少 settings 字段');
        }
        return act('parent:import_config', { config: doc }).then(function (res) {
          if (res.ok) {
            var n = res.changed_count || 0;
            toast(n ? ('配置已导入，' + n + ' 项设置已更新') : '配置已导入，内容与当前一致');
            refresh();
          }
        });
      }).catch(function (err) {
        toast('导入失败：' + (err && err.message ? err.message : '文件读取错误'), true);
      }).then(function () { input.value = ''; });   // 允许重复选择同一文件
    };

    /* ---------- v12：数据备份导入（二次确认 + 覆盖风险提示） ---------- */
    $('#stBakImport').onclick = function () { $('#stBakFile').click(); };
    $('#stBakFile').onchange = function () {
      var input = $('#stBakFile');
      var file = input.files && input.files[0];
      if (!file) return;
      readJsonFile(file).then(function (doc) {
        if (!doc || typeof doc !== 'object') throw new Error('文件内容不是有效的 JSON 对象');
        if (doc.format !== 'family-points-backup') {
          throw new Error('这不是本系统的备份文件（缺少正确的 format 标识）');
        }
        if (!doc.data || typeof doc.data !== 'object') {
          throw new Error('备份文件缺少 data 字段');
        }
        // 汇总预览，让家长看清将被覆盖的内容
        var d = doc.data;
        var preview = '成员 ' + cnt(d.members) + ' 位、任务 ' + cnt(d.tasks) + ' 个、兑换项 ' + cnt(d.rewards) +
          ' 个、积分流水 ' + cnt(d.ledger) + ' 条、兑换申请 ' + cnt(d.spend_requests) + ' 条';
        confirmDialog('导入数据备份（将覆盖现有数据）',
          '文件导出时间：' + (doc.exported_at || '未知') + '\n' +
          '包含：' + preview + '\n\n' +
          '⚠️ 导入将【清空并替换】当前全部数据（成员、任务、积分与记录），此操作不可撤销。\n' +
          '建议先「导出数据备份」留档。确定继续导入吗？',
          '确认覆盖导入', 'danger', function () {
            act('parent:import_backup', { backup: doc }).then(function (res) {
              if (res.ok) {
                toast('数据已恢复');
                IDENT.mode = 'parent'; saveIdent(); refresh();
              }
            });
          });
      }).catch(function (err) {
        toast('导入失败：' + (err && err.message ? err.message : '文件读取错误'), true);
      }).then(function () { input.value = ''; });
    };

    /* ---------- v12：清空所有数据（保留口令与 PIN） ---------- */
    $('#stClearData').onclick = function () {
      confirmDialog('清空所有数据',
        '将删除全部成员以外的业务数据（任务、兑换清单、积分流水、申请记录），并重建为出厂默认任务与兑换清单。\n\n' +
        '保留：访问口令、家长 PIN。\n成员将回到「老大 / 老二 / 家长」。\n\n此操作不可撤销，确定继续？',
        '确认清空', 'danger', function () {
          act('parent:clear_data', {}).then(function (res) {
            if (res.ok) { toast('已清空并恢复初始状态'); refresh(); }
          });
        });
    };
  }

  // v12：读取用户选择的 JSON 文件（返回 Promise）
  function readJsonFile(file) {
    return new Promise(function (resolve, reject) {
      if (file.size > 60 * 1024 * 1024) { reject(new Error('文件过大（上限 60MB）')); return; }
      var rd = new FileReader();
      rd.onerror = function () { reject(new Error('文件读取失败，请重试')); };
      rd.onload = function () {
        try {
          resolve(JSON.parse(String(rd.result || '')));
        } catch (e) {
          reject(new Error('文件不是有效的 JSON 格式'));
        }
      };
      rd.readAsText(file, 'utf-8');
    });
  }

  // v12：统计数组成员数量（用于备份导入预览）
  function cnt(arr) { return Array.isArray(arr) ? arr.length : 0; }

  function addMemberModal(role) {
    openModal(role === 'child' ? '添加孩子' : '添加家长', '<div class="form-field"><label>称呼</label>' +
      '<input type="text" id="amName" placeholder="' + (role === 'child' ? '例如：小星' : '例如：妈妈') + '"></div>', [
      { label: '取消', cls: 'ghost', onClick: function (close) { close(); } },
      { label: '添加', cls: 'primary', onClick: function (close) {
        act('parent:add_member', { name: $('#amName').value.trim(), role: role }).then(function (res) { if (res.ok) { close(); toast('已添加'); refresh(); } });
      } }
    ]);
  }

  /* ---------- 启动 ---------- */
  function refresh() {
    return fetchData().then(function () {
      if (!IDENT.mode) {
        IDENT.mode = 'kid';
        var first = kids()[0];
        if (first) IDENT.memberId = first.id;
      }
      // v15：刷新/重开页面后成员登录态一律失效（需求：每次进入都要验证）。
      IDENT.memberToken = '';
      saveIdent();
      invalidateSlices();
      renderAll();
      // v13.1：家长模式下校验 token 是否仍有效。
      //   服务重启（每次部署）或改过 PIN 都会让 token 失效——此时页面看起来还是家长端
      //   （因为 /api/data 不校验 token），但所有家长操作与导出都会 403。
      //   这里主动探测一次，及时提示重新登录，避免「点了没反应/无法下载」的困惑。
      if (IDENT.mode === 'parent' && IDENT.token) {
        act('parent:ping', {}).then(function (res) {
          if (!res.ok && res.needLogin) {
            toast('家长身份已过期，请重新选择「家长」并输入 PIN', true);
            renderAll();
          }
        });
      }
    }).catch(function () { toast('无法连接服务，请确认已启动', true); });
  }

  function startPolling() {
    setInterval(function () {
      if (modalOpen()) return;
      var ae = document.activeElement;
      if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
      fetchData().then(function () { invalidateSlices(); renderAll(); }).catch(function () {});
    }, 15000);
  }

  function init() {
    loadIdent();
    // v14：老内核缺失 fetch/Promise 时不白屏，给出可读提示
    if (!COMPAT.fetch || !COMPAT.promise) {
      var tnode = $('#toast');
      if (tnode) {
        tnode.textContent = '当前浏览器版本过旧，无法加载数据。请升级浏览器（推荐 Chrome / Edge / 夸克）后重试。';
        tnode.className = 'toast err';
        tnode.hidden = false;
        tnode._timer = setTimeout(function () { tnode.hidden = true; }, 9000);
      }
      return;
    }
    $('#identitySelect').onchange = function (e) { switchIdentity(e.target.value); };
    if (IDENT.mode === 'parent' && !IDENT.token) IDENT.mode = 'kid';
    document.addEventListener('click', function (e) {
      var elA = closestEl(e.target, '[data-aspage]');
      if (elA && !elA.disabled) {
        var kvA = String(elA.getAttribute('data-aspage')).split(':');
        var kA = kvA[0];
        var dA = parseInt(kvA[1], 10) || 1;
        var stA = SLICES[kA];
        if (stA && !stA.loading) doLoad(kA, Math.max(0, stA.page + dA), false);
        return;
      }
      var el = closestEl(e.target, '[data-page]');
      if (!el || el.disabled) return;
      var kv = String(el.getAttribute('data-page')).split(':');
      var k = kv[0];
      var d = parseInt(kv[1], 10) || 1;
      var next = (PAGES[k] || 0) + d;
      if (next < 0) next = 0;
      PAGES[k] = next;
      renderAll();
    });
    refresh().then(startPolling);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
