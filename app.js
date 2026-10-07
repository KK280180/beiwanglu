/* 拍摄记录 —— 手机本地存储版（IndexedDB）
   一条记录 = 一件衣服的拍摄/推广
   字段：图片(衣服图) · 商家(谁让我拍的) · 账号(抖音/小红书) · 价钱 · 日期 · 备注
   除日期默认今天外，其余全部可以不填。数据只存本机，不上传。 */
(function () {
  'use strict';

  var DB_NAME = 'paishe-memo';
  var DB_VER = 1;
  var STORE = 'records';

  var db = null;

  // ---------- 工具 ----------
  var $ = function (id) { return document.getElementById(id); };
  var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayStr() { return ymd(new Date()); }
  function parseYmd(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function monthKey(s) { return String(s || '').slice(0, 7); }
  function curMonthKey() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
  function uid() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  function weekName(s) { return WEEK[parseYmd(s).getDay()]; }
  function dayLabel(s) { var p = String(s).split('-'); return (+p[1]) + '月' + (+p[2]) + '日'; }

  /* 金额：内部存「分」避免浮点误差；空值存 null（空 ≠ 0） */
  function parseMoney(text) {
    var t = String(text == null ? '' : text).trim().replace(/[^\d.]/g, '');
    if (t === '' || t === '.') return null;
    var n = Number(t);
    if (!isFinite(n) || n <= 0) return null;
    return Math.round(n * 100);
  }
  function fmtMoney(cents) {
    var v = Math.abs(cents || 0);
    return (Math.floor(v / 100)).toLocaleString('zh-CN') + '.' + pad2(v % 100);
  }
  function fmtSize(b) {
    if (!b) return '0 B';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1900);
  }

  // ---------- 数据库 ----------
  function openDB() {
    return new Promise(function (res, rej) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          var os = d.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('date', 'date', { unique: false });
        }
      };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
  }
  function store(mode) { return db.transaction(STORE, mode).objectStore(STORE); }
  function p(req) {
    return new Promise(function (res, rej) {
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
  }
  function dbAll() { return p(store('readonly').getAll()); }
  function dbPut(r) { return p(store('readwrite').put(r)); }
  function dbGet(id) { return p(store('readonly').get(id)); }
  function dbDel(id) { return p(store('readwrite').delete(id)); }
  function dbBulk(list) {
    return new Promise(function (res, rej) {
      var t = db.transaction(STORE, 'readwrite');
      var os = t.objectStore(STORE);
      list.forEach(function (r) { os.put(r); });
      t.oncomplete = function () { res(list.length); };
      t.onerror = function () { rej(t.error); };
    });
  }

  // ---------- 状态 ----------
  var state = {
    month: curMonthKey(),
    all: [],
    editingId: null,
    pickedPlat: '',
    pendingBlob: null,
    pendingClear: false
  };

  // ---------- 图片压缩 ----------
  function shrinkImage(file, maxSide, quality) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth, h = img.naturalHeight;
        var sc = Math.min(1, maxSide / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
        var c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        c.getContext('2d').drawImage(img, 0, 0, cw, ch);
        c.toBlob(function (b) {
          if (b) res({ blob: b, w: cw, h: ch }); else rej(new Error('处理失败'));
        }, 'image/jpeg', quality);
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('读不了这张图')); };
      img.src = url;
    });
  }
  function blobUrl(b) { return URL.createObjectURL(b); }

  /* 图片地址缓存：同一条记录、同一张图，始终复用同一个 objectURL。
     否则每次重新渲染（拖动改日期、编辑保存等）都会新建地址，
     旧地址失效会导致图片显示不出来，必须退出重进才恢复。

     指纹用「id + size + lastModified」：从 IndexedDB 读出的 Blob 每次都是
     新对象，不能比引用；而 size 单独不够（两张同尺寸的图会被误判为同一张），
     所以带上 lastModified。若浏览器未提供该字段，退化为 size:type。 */
  var urlCache = {};   // id -> { url, stamp }
  var previewUrl = null;   // 表单里当前预览用的地址

  /* 图片地址缓存：同一条记录、同一张图，始终复用同一个 objectURL。
     否则每次重新渲染（拖动改日期、编辑保存等）都会新建地址，
     旧地址失效会导致图片显示不出来，必须退出重进才恢复。

     判断「图有没有换」用记录上的 imgKey：
     保存时给每次新选的图打一个唯一标记，换图就会变，
     只改日期/商家则不变 —— 比 size、时间戳、内容哈希都可靠。 */
  function imgUrlFor(r) {
    if (!r.image) return null;
    var stamp = r.imgKey || 'legacy';
    var hit = urlCache[r.id];
    if (hit && hit.stamp === stamp) return hit.url;
    if (hit) { try { URL.revokeObjectURL(hit.url); } catch (e) {} }
    var url = URL.createObjectURL(r.image);
    urlCache[r.id] = { url: url, stamp: stamp };
    return url;
  }

  function dropImgUrl(id) {
    var hit = urlCache[id];
    if (hit) { try { URL.revokeObjectURL(hit.url); } catch (e) {} delete urlCache[id]; }
  }

  // ---------- 渲染 ----------
  function monthRecords() {
    return state.all.filter(function (r) { return monthKey(r.date) === state.month; });
  }

  function render() {
    var recs = monthRecords();
    var p0 = state.month.split('-');
    $('monthLabel').textContent = (+p0[0]) + '年' + (+p0[1]) + '月';

    var income = 0, cost = 0;
    recs.forEach(function (r) {
      if (r.cents != null) income += r.cents;
      if (r.cost != null) cost += r.cost;
    });
    $('sumCount').textContent = recs.length;
    $('sumMoney').textContent = fmtMoney(income);
    $('sumCost').textContent = fmtMoney(cost);
    var netEl = $('sumNet');
    var net = income - cost;
    netEl.textContent = fmtMoney(net);
    netEl.className = net >= 0 ? 'n pos' : 'n neg';

    var list = $('list');
    list.innerHTML = '';

    // 整月每一天都显示（空的也占位，方便拖动）
    var p1 = state.month.split('-');
    var y = +p1[0], mo = +p1[1];
    var daysInMonth = new Date(y, mo, 0).getDate();

    var byDate = {};
    recs.forEach(function (r) {
      var k = r.date || '';
      (byDate[k] = byDate[k] || []).push(r);
    });

    var tstr = todayStr();
    for (var d = 1; d <= daysInMonth; d++) {
      var date = y + '-' + pad2(mo) + '-' + pad2(d);
      var items = byDate[date] || [];
      list.appendChild(renderDay(date, items, date === tstr));
    }
  }

  function renderDay(date, items, isToday) {
    var dIncome = 0, dCost = 0, dNo = 0;
    items.forEach(function (r) {
      if (r.cents != null) dIncome += r.cents;
      if (r.cost != null) dCost += r.cost;
      if (r.cents == null) dNo++;
    });

    var day = document.createElement('section');
    day.className = 'day' + (isToday ? ' today' : '');
    day.dataset.date = date;

    var head = document.createElement('div');
    head.className = 'dayhead';

    var dEl = document.createElement('div');
    dEl.className = 'd';
    dEl.textContent = dayLabel(date) + (isToday ? ' 今天' : '');
    var wEl = document.createElement('div');
    wEl.className = 'w';
    wEl.textContent = weekName(date);
    var sp = document.createElement('div');
    sp.className = 'sp';
    var sumEl = document.createElement('div');
    sumEl.className = 'sum';
    var parts = [];
    if (dIncome > 0) parts.push('收入' + fmtMoney(dIncome));
    if (dCost > 0) parts.push('支出' + fmtMoney(dCost));
    if (dNo > 0) parts.push(dNo + '件未填价');
    // 空日期不显示"0件"，保持日头简洁
    sumEl.textContent = items.length
      ? items.length + '件' + (parts.length ? ' · ' + parts.join(' · ') : '')
      : '';

    var add = document.createElement('button');
    add.className = 'addbtn';
    add.textContent = '＋添加';
    add.onclick = function () { openEdit(null, date); };

    head.appendChild(dEl); head.appendChild(wEl); head.appendChild(sp);
    head.appendChild(sumEl); head.appendChild(add);
    day.appendChild(head);

    var cards = document.createElement('div');
    cards.className = 'cards' + (items.length ? '' : ' empty-cards');
    if (!items.length) {
      var none = document.createElement('div');
      none.className = 'noitem';
      none.textContent = '—';
      cards.appendChild(none);
    } else {
      items.forEach(function (r) { cards.appendChild(renderCard(r)); });
    }
    day.appendChild(cards);
    return day;
  }

  function renderCard(r) {
    var b = document.createElement('div');
    b.className = 'card';
    b.setAttribute('role', 'button');
    b.tabIndex = 0;

    var slot = document.createElement('div');
    slot.className = 'slot';

    if (r.image) {
      var im = document.createElement('img');
      im.src = imgUrlFor(r);      // 复用缓存地址，重新渲染也不会失效
      im.alt = '';
      im.loading = 'eager';
      slot.appendChild(im);
      // 规则：有图就不显示备注
    } else if (r.note) {
      // 没图：备注占用图片位
      slot.className = 'slot note';
      var nt = document.createElement('div');
      nt.className = 'ntext';
      nt.textContent = r.note;
      slot.appendChild(nt);
    } else {
      var ph = document.createElement('div');
      ph.className = 'ph';
      ph.textContent = '无图';
      slot.appendChild(ph);
    }

    var shop = document.createElement('div');
    shop.className = 'acct';
    shop.textContent = r.shop || '未填商家';

    var plat = document.createElement('div');
    plat.className = 'plat';
    plat.textContent = r.plat || '未选账号';

    var money = document.createElement('div');
    if (r.cents == null && r.cost == null) {
      money.className = 'money unpaid';
      money.textContent = '未填金额';
    } else if (r.cents == null) {
      money.className = 'money unpaid';
      money.textContent = '支出 ' + fmtMoney(r.cost);
    } else {
      money.className = 'money';
      money.textContent = fmtMoney(r.cents);
      if (r.cost != null && r.cost > 0) {
        var c = document.createElement('span');
        c.className = 'costline';
        c.textContent = '支出 ' + fmtMoney(r.cost);
        money.appendChild(c);
      }
    }

    b.appendChild(slot); b.appendChild(shop); b.appendChild(plat); b.appendChild(money);

    // 单击打开编辑；长按拖动改日期（拖动结束时不该触发编辑）
    b.addEventListener('click', function (e) {
      if (drag.justDragged) { e.preventDefault(); return; }
      openEdit(r, null);
    });
    bindDragOn(b, r);
    return b;
  }

  // ---------- 表单 ----------
  function renderPlatChips() {
    var inp = $('fPlat');
    if (inp) inp.value = state.pickedPlat || '';
    renderSugs();
  }

  /* 账号建议：列出已经用过的账号，点一下填入；也能直接手打别的 */
  function renderSugs() {
    var box = $('platSugs');
    if (!box) return;
    box.innerHTML = '';
    var used = {};
    state.all.forEach(function (r) { if (r.plat) used[r.plat] = 1; });
    var list = Object.keys(used);
    var typed = (($('fPlat') && $('fPlat').value) || '').trim();
    list.forEach(function (name) {
      if (name === typed) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = name;
      b.onclick = function () {
        state.pickedPlat = name;
        $('fPlat').value = name;
        renderSugs();
      };
      box.appendChild(b);
    });
  }

  function showPick(blob, name) {
    var box = $('imgBox');
    // 释放上一次预览用的地址，避免堆积
    if (previewUrl) { try { URL.revokeObjectURL(previewUrl); } catch (e) {} previewUrl = null; }
    box.innerHTML = '';
    if (blob) {
      previewUrl = URL.createObjectURL(blob);
      var im = document.createElement('img');
      im.src = previewUrl;
      box.appendChild(im);
      $('imgName').textContent = name || '已选择图片';
      $('clearImg').style.display = 'block';
    } else {
      var ph = document.createElement('div');
      ph.className = 'ph';
      ph.textContent = '无图';
      box.appendChild(ph);
      $('imgName').textContent = '未选择图片';
      $('clearImg').style.display = 'none';
    }
  }

  function openEdit(rec, presetDate) {
    state.editingId = rec ? rec.id : null;
    state.pickedPlat = rec ? (rec.plat || '') : '';
    state.pendingBlob = null;
    state.pendingClear = false;

    $('editTitle').textContent = rec ? '编辑记录' : '添加记录';
    $('fShop').value = rec ? (rec.shop || '') : '';
    $('fAmount').value = (rec && rec.cents != null) ? (rec.cents / 100).toFixed(2) : '';
    $('fCost').value = (rec && rec.cost != null) ? (rec.cost / 100).toFixed(2) : '';
    $('fDate').value = (rec && rec.date) ? rec.date : (presetDate || todayStr());
    $('fNote').value = rec ? (rec.note || '') : '';
    $('delRow').style.display = rec ? 'flex' : 'none';

    renderPlatChips();
    showPick(rec && rec.image ? rec.image : null, rec && rec.imageName ? rec.imageName : '');
    $('fileInput').value = '';
    $('editSheet').classList.add('open');
  }
  function closeEdit() { $('editSheet').classList.remove('open'); }

  function saveEdit() {
    var rec = {
      id: state.editingId || uid(),
      date: $('fDate').value || todayStr(),
      shop: $('fShop').value.trim(),
      plat: ($('fPlat').value || '').trim(),
      cents: parseMoney($('fAmount').value),
      cost: parseMoney($('fCost').value),
      note: $('fNote').value.trim(),
      image: null,
      imageName: '',
      updatedAt: Date.now()
    };

    var finish = function (image, imageName, imgKey) {
      rec.image = image || null;
      rec.imageName = imageName || '';
      rec.imgKey = rec.image ? (imgKey || 'k' + Date.now()) : '';
      dbPut(rec).then(function () {
        closeEdit();
        return reload();
      }).then(function () {
        toast(state.editingId ? '已保存' : '已添加');
      }).catch(function (e) {
        console.error(e);
        toast('保存失败');
      });
    };

    if (state.pendingBlob) {
      // 新选的图 → 打一个新的唯一标记，地址缓存据此重建
      finish(state.pendingBlob, $('imgName').textContent, 'k' + Date.now() + Math.random().toString(36).slice(2, 6));
    } else if (state.pendingClear) {
      finish(null, '', '');
    } else if (state.editingId) {
      dbGet(state.editingId).then(function (old) {
        // 没换图 → 沿用原来的标记，地址保持不变（这是修好白屏的关键）
        finish(old ? old.image : null, old ? old.imageName : '', old ? old.imgKey : '');
      }).catch(function () { finish(null, '', ''); });
    } else {
      finish(null, '', '');
    }
  }

  function reload() {
    return dbAll().then(function (rows) {
      rows.sort(function (a, b) {
        if (a.date !== b.date) return (a.date || '') < (b.date || '') ? 1 : -1;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
      state.all = rows;
      render();
    });
  }

  // ---------- 月份 ----------
  function shiftMonth(delta) {
    var p0 = state.month.split('-');
    var d = new Date(+p0[0], +p0[1] - 1 + delta, 1);
    state.month = d.getFullYear() + '-' + pad2(d.getMonth() + 1);
    render();
  }
  function fillMonthGrid(y) {
    $('yearLabel').textContent = y;
    var grid = $('monthGrid');
    grid.innerHTML = '';
    for (var m = 1; m <= 12; m++) {
      (function (m) {
        var key = y + '-' + pad2(m);
        var b = document.createElement('button');
        b.textContent = m + '月';
        if (key === state.month) b.className = 'on';
        b.onclick = function () {
          state.month = key;
          $('monthSheet').classList.remove('open');
          render();
        };
        grid.appendChild(b);
      })(m);
    }
  }
  function openMonthSheet() {
    fillMonthGrid(+state.month.split('-')[0]);
    $('monthSheet').classList.add('open');
  }

  // ---------- 拖拽：把卡片从一天挪到另一天（长按触发，可跨月） ----------
  var drag = {
    active: false, rec: null, srcDate: '', ghost: null,
    startX: 0, startY: 0, timer: null, lastZone: null,
    autoTimer: null, autoDir: 0, pointerId: null
  };
  var LONG_PRESS_MS = 400;
  var EDGE = 100;          // 距屏幕上下边缘多少像素进入自动滚动区
  var EDGE_MAX = 26;       // 贴边时达到最快
  var AUTO_MIN = 4;        // 慢速（px/帧）
  var AUTO_MAX = 22;       // 快速（px/帧）

  // 手指越靠边滚得越快，便于精确定位
  function autoSpeed(y) {
    var vh = window.innerHeight;
    var d = 0, dir = 0;
    if (y < EDGE) { d = EDGE - y; dir = -1; }
    else if (y > vh - EDGE) { d = y - (vh - EDGE); dir = 1; }
    else return { dir: 0, speed: 0 };
    var t = Math.max(0, Math.min(1, (d - 0) / (EDGE - EDGE_MAX)));
    return { dir: dir, speed: AUTO_MIN + (AUTO_MAX - AUTO_MIN) * t };
  }

  function showDragTip(date) {
    var el = $('dragTip');
    if (!el) return;
    if (!date) { el.classList.remove('show'); return; }
    el.textContent = '→ ' + dayLabel(date) + ' ' + weekName(date);
    el.classList.add('show');
  }

  function clearLongPress() {
    if (drag.timer) { clearTimeout(drag.timer); drag.timer = null; }
  }

  function beginDrag(cardEl, rec, x, y) {
    drag.active = true;
    drag.rec = rec;
    drag.srcDate = rec.date;
    drag.startX = x; drag.startY = y;
    drag.lastX = x; drag.lastY = y;

    cardEl.classList.add('dragging');
    drag.srcCard = cardEl;

    // 跟随手指的浮动副本
    var g = cardEl.cloneNode(true);
    g.classList.add('ghost');
    g.classList.remove('dragging');
    var rect = cardEl.getBoundingClientRect();
    g.style.width = rect.width + 'px';
    g.style.left = rect.left + 'px';
    g.style.top = rect.top + 'px';
    document.body.appendChild(g);
    drag.ghost = g;
    drag.offsetX = x - rect.left;
    drag.offsetY = y - rect.top;

    if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) {} }
  }

  function moveDrag(x, y) {
    if (!drag.active) return;
    drag.lastX = x; drag.lastY = y;      // 自动滚动要用最新手指位置
    drag.ghost.style.left = (x - drag.offsetX) + 'px';
    drag.ghost.style.top = (y - drag.offsetY) + 'px';
    updateZone(x, y);

    // 边缘判定：手指越靠边滚得越快
    var s = autoSpeed(y);
    drag.autoDir = s.dir;
    drag.autoSpeed = s.speed;
  }

  // 根据手指坐标更新高亮组 + 顶部落点提示
  function updateZone(x, y) {
    var el = document.elementFromPoint(x, y);
    var day = el && el.closest ? el.closest('.day') : null;
    if (day !== drag.lastZone) {
      if (drag.lastZone) drag.lastZone.classList.remove('dropday');
      if (day) day.classList.add('dropday');
      drag.lastZone = day;
    }
    showDragTip(day ? day.dataset.date : null);
  }

  function startAutoScroll() {
    if (drag.autoTimer) return;
    drag.autoTimer = setInterval(function () {
      if (!drag.active || drag.autoDir === 0) return;
      var y = drag.lastY;
      if (y == null) return;
      // 重新确认手指仍在边缘区，并按最新位置重算速度，避免停住后无限滚动
      var s = autoSpeed(y);
      if (s.dir === 0) { drag.autoDir = 0; return; }
      window.scrollBy(0, s.dir * s.speed);
      // 滚动后重新计算落点，否则高亮和提示会停在旧位置
      updateZone(drag.lastX, drag.lastY);
    }, 16);
  }

  function endDrag(cancel) {
    if (!drag.active) return;
    drag.active = false;
    // 抑制拖动结束后紧跟的那次 click，避免误打开编辑
    drag.justDragged = true;
    setTimeout(function () { drag.justDragged = false; }, 350);
    clearLongPress();
    if (drag.autoTimer) { clearInterval(drag.autoTimer); drag.autoTimer = null; }
    drag.autoDir = 0;
    drag.lastX = null; drag.lastY = null;

    if (drag.ghost) { drag.ghost.remove(); drag.ghost = null; }
    if (drag.srcCard) { drag.srcCard.classList.remove('dragging'); drag.srcCard = null; }
    showDragTip(null);

    var target = drag.lastZone;
    if (drag.lastZone) { drag.lastZone.classList.remove('dropday'); drag.lastZone = null; }

    if (cancel || !target) { drag.rec = null; return; }

    var newDate = target.dataset.date;
    var rec = drag.rec;
    drag.rec = null;

    if (!newDate || newDate === rec.date) return;

    // 落点可能不在当前月份：切到目标月份再保存
    var targetMonth = monthKey(newDate);
    var oldDate = rec.date;
    rec.date = newDate;
    rec.updatedAt = Date.now();

    dbPut(rec).then(function () {
      if (targetMonth !== state.month) state.month = targetMonth;
      return reload();
    }).then(function () {
      showUndo('已移到 ' + dayLabel(newDate), function () {
        rec.date = oldDate;
        rec.updatedAt = Date.now();
        dbPut(rec).then(function () {
          state.month = monthKey(oldDate);
          return reload();
        }).then(function () { toast('已撤销'); });
      });
    }).catch(function (e) { console.error(e); toast('移动失败'); });
  }

  var undoTimer = null;
  function showUndo(text, fn) {
    var bar = $('undoBar');
    $('undoText').textContent = text;
    bar.classList.add('show');
    clearTimeout(undoTimer);
    $('undoBtn').onclick = function () {
      bar.classList.remove('show');
      clearTimeout(undoTimer);
      fn();
    };
    undoTimer = setTimeout(function () { bar.classList.remove('show'); }, 5000);
  }

  // 绑定拖拽手势（在渲染出的卡片上）
  function bindDragOn(cardEl, rec) {
    cardEl.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      var x = e.clientX, y = e.clientY;
      clearLongPress();
      drag.timer = setTimeout(function () {
        beginDrag(cardEl, rec, x, y);
        startAutoScroll();
      }, LONG_PRESS_MS);
      drag.pendingX = x; drag.pendingY = y;
    });

    cardEl.addEventListener('pointermove', function (e) {
      if (drag.active) return;                 // 拖动时由 document 处理
      if (!drag.timer) return;
      // 手指移动过多 → 用户想滚动，取消长按
      var dx = Math.abs(e.clientX - drag.pendingX);
      var dy = Math.abs(e.clientY - drag.pendingY);
      if (dx > 8 || dy > 8) clearLongPress();
    }, { passive: true });

    cardEl.addEventListener('pointerup', function () {
      if (!drag.active) clearLongPress();
    });
  }

  // 拖动中的移动/松手挂在 document 上：手指移出卡片也能继续拖
  function bindDocumentDrag() {
    document.addEventListener('pointermove', function (e) {
      if (!drag.active) return;
      e.preventDefault();
      moveDrag(e.clientX, e.clientY);
    }, { passive: false });

    document.addEventListener('pointerup', function (e) {
      if (drag.active) { e.preventDefault(); endDrag(false); }
    });

    document.addEventListener('pointercancel', function () {
      if (drag.active) endDrag(true);
    });
  }

  // ---------- 备份 ----------
  function blobToDataURL(b) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error); };
      fr.readAsDataURL(b);
    });
  }
  function dataURLToBlob(d) {
    var parts = String(d).split(',');
    var mime = (parts[0].match(/:(.*?);/) || [, 'image/jpeg'])[1];
    var bin = atob(parts[1]);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }
  function download(name, content, mime) {
    var blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function plain(r) {
    return {
      id: r.id, date: r.date, shop: r.shop || '', plat: r.plat || '',
      cents: r.cents == null ? null : r.cents,
      cost: r.cost == null ? null : r.cost,
      note: r.note || '',
      imageName: r.imageName || '', imgKey: r.imgKey || '', updatedAt: r.updatedAt || 0
    };
  }

  function exportBackup() {
    toast('正在打包…');
    var out = [];
    var chain = Promise.resolve();
    state.all.forEach(function (r) {
      chain = chain.then(function () {
        if (!r.image) { out.push(plain(r)); return; }
        return blobToDataURL(r.image).then(function (d) {
          var o = plain(r); o.image = d; out.push(o);
        });
      });
    });
    chain.then(function () {
      download('拍摄记录备份-' + todayStr() + '.json', JSON.stringify({
        app: 'paishe-memo', version: 1,
        exportedAt: new Date().toISOString(),
        count: out.length, records: out
      }), 'application/json');
      toast('已导出 ' + out.length + ' 条');
    }).catch(function (e) { console.error(e); toast('导出失败'); });
  }

  function importBackup(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var data;
      try { data = JSON.parse(fr.result); } catch (e) { toast('文件读不了'); return; }
      var list = (data && data.records) || [];
      if (!list.length) { toast('备份里没有记录'); return; }
      var recs = list.map(function (o) {
        var cents = (o.cents == null || o.cents === '') ? null : Math.abs(Number(o.cents) || 0);
        var cost = (o.cost == null || o.cost === '') ? null : Math.abs(Number(o.cost) || 0);
        return {
          id: o.id || uid(),
          date: o.date || todayStr(),
          shop: o.shop || '',
          plat: o.plat || '',
          cents: cents,
          cost: cost,
          note: o.note || '',
          image: o.image ? dataURLToBlob(o.image) : null,
          imageName: o.imageName || '',
          imgKey: o.imgKey || ('k' + Date.now() + Math.random().toString(36).slice(2, 6)),
          updatedAt: o.updatedAt || Date.now()
        };
      });
      dbBulk(recs).then(function () { return reload(); }).then(function () {
        toast('已导入 ' + recs.length + ' 条');
      }).catch(function (e) { console.error(e); toast('导入失败'); });
    };
    fr.readAsText(file);
  }

  function exportCSV() {
    var rows = state.all.slice().sort(function (a, b) { return (a.date || '') < (b.date || '') ? -1 : 1; });
    var lines = [['日期', '星期', '商家', '账号', '收入', '支出', '盈利', '备注'].join(',')];
    rows.forEach(function (r) {
      var d = r.date || '';
      var net = (r.cents == null && r.cost == null) ? '' :
        (((r.cents || 0) - (r.cost || 0)) / 100).toFixed(2);
      var cells = [
        d, d ? weekName(d) : '', r.shop || '', r.plat || '',
        r.cents == null ? '' : (r.cents / 100).toFixed(2),
        r.cost == null ? '' : (r.cost / 100).toFixed(2),
        net,
        r.note || ''
      ].map(function (s) {
        s = String(s);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      });
      lines.push(cells.join(','));
    });
    download('拍摄记录-' + todayStr() + '.csv', '\ufeff' + lines.join('\r\n'), 'text/csv');
    toast('已导出 ' + rows.length + ' 条');
  }

  function renderPlatSettings() { /* 账号改为自由输入，设置里不再需要列表管理 */ }

  function refreshStats() {
    dbAll().then(function (rows) {
      $('statCount').textContent = rows.length + ' 条';
      var bytes = 0;
      rows.forEach(function (r) {
        bytes += JSON.stringify(plain(r)).length;
        if (r.image && r.image.size) bytes += r.image.size;
      });
      $('statSize').textContent = '约 ' + fmtSize(bytes);
    });
  }

  // ---------- 事件 ----------
  function bind() {
    $('prevMonth').onclick = function () { shiftMonth(-1); };
    $('nextMonth').onclick = function () { shiftMonth(1); };
    $('monthBtn').onclick = openMonthSheet;
    $('todayBtn').onclick = function () {
      state.month = curMonthKey();
      render();
      // 滚到今天那一组
      var t = todayStr();
      var el = document.querySelector('.day[data-date="' + t + '"]');
      if (el) {
        setTimeout(function () {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 60);
      }
    };
    $('prevYear').onclick = function () { fillMonthGrid((+$('yearLabel').textContent) - 1); };
    $('nextYear').onclick = function () { fillMonthGrid((+$('yearLabel').textContent) + 1); };
    $('closeMonth').onclick = function () { $('monthSheet').classList.remove('open'); };

    $('fabAdd').onclick = function () { openEdit(null, null); };
    $('cancelEdit').onclick = closeEdit;
    $('saveEdit').onclick = saveEdit;

    $('delEdit').onclick = function () {
      if (!state.editingId) return;
      if (!confirm('确定删除这条记录？')) return;
      dbDel(state.editingId).then(function () {
        dropImgUrl(state.editingId);
        closeEdit();
        return reload();
      }).then(function () { toast('已删除'); });
    };

    $('pickBtn').onclick = function () { $('fileInput').click(); };
    $('clearImg').onclick = function () {
      state.pendingBlob = null;
      state.pendingClear = true;
      showPick(null, '');
    };
    $('fileInput').onchange = function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      toast('正在处理图片…');
      shrinkImage(f, 1600, 0.82).then(function (r) {
        state.pendingBlob = r.blob;
        state.pendingClear = false;
        showPick(r.blob, f.name.replace(/\.[^.]+$/, '') + '（已压缩）');
        toast('图片已就绪');
      }).catch(function (e) { console.error(e); toast('图片处理失败'); });
    };

    $('gearBtn').onclick = function () {
      refreshStats();
      $('setSheet').classList.add('open');
    };
    $('closeSet').onclick = function () { $('setSheet').classList.remove('open'); };

    var platInput = $('fPlat');
    if (platInput) {
      platInput.addEventListener('input', function () { renderSugs(); });
    }

    $('exportBtn').onclick = exportBackup;
    $('csvBtn').onclick = exportCSV;
    $('importBtn').onclick = function () { $('importFile').click(); };
    $('importFile').onchange = function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (f) importBackup(f);
      ev.target.value = '';
    };

    ['editSheet', 'monthSheet', 'setSheet'].forEach(function (id) {
      $(id).addEventListener('click', function (ev) {
        if (ev.target === $(id)) $(id).classList.remove('open');
      });
    });

    // 左右滑动换月
    var sx = 0, sy = 0;
    document.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener('touchend', function (e) {
      if (drag.active || drag.justDragged) return;   // 拖拽中/刚拖完，不换月
      if (document.querySelector('.sheet.open')) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) shiftMonth(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  // ---------- 启动 ----------
  openDB().then(function (d) {
    db = d;
    bind();
    bindDocumentDrag();
    return reload();
  }).then(function () {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('./sw.js').catch(function (e) { console.warn('离线缓存未启用', e); });
    }
  }).catch(function (e) {
    console.error(e);
    $('list').innerHTML = '<div class="blank"><div class="big">打不开本地数据库</div><div>请确认不是无痕模式</div></div>';
  });
})();
