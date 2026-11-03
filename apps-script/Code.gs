/**
 * PGY 臨床技能課程排課 — Google Apps Script 後端
 *
 * 部署方式請見同資料夾的「設定說明.md」。
 * ⚠ 密碼不要寫在這個檔案裡！請設定在「專案設定 → 指令碼屬性」：
 *    ADMIN_PW   管理密碼（必填，管理頁 pgy.html 同步用）
 *    TEACHER_PW 導師密碼（選填；留空＝導師只要輸入姓名即可查詢與回覆）
 *
 * 資料存放：
 *    _data      完整資料（JSON，分段存放，請勿手動修改）
 *    梯次／學員／課程／訓練紀錄  每次同步自動產生的唯讀報表，方便在試算表中查看
 *    導師回覆   導師在查詢頁送出的回覆紀錄
 */

var TZ = "Asia/Taipei";
var CHUNK = 40000;
var REPLY_HEAD = ["序號", "回覆時間", "梯次ID", "課程", "原定日期", "導師", "結果", "建議日期", "建議開始", "建議結束", "備註"];
var STATUS_T = { draft: "草擬", pending: "待導師確認", confirmed: "導師已確認", resched: "導師建議改期", done: "已完成", cancel: "已取消" };

/* ================= 進入點 ================= */
function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    var fn = API[req.fn];
    if (!fn) throw new Error("未知的功能：" + req.fn);
    out = { result: fn.apply(null, req.args || []) };
  } catch (err) {
    out = { error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
function doGet() {
  return ContentService.createTextOutput("PGY 排課 API 運作中");
}

var API = {
  ping: function () { return { ok: true, time: now_() }; },

  /* ---------- 管理端 ---------- */
  adminLoad: function (pw) {
    checkAdmin_(pw);
    var db = readDB_();
    return { db: db, ver: ver_(), replies: repliesAfter_(db ? db.replySeq || 0 : 0) };
  },
  adminSave: function (pw, db, baseVer, force) {
    checkAdmin_(pw);
    if (!db || !db.courses || !db.students || !db.sessions) throw new Error("資料格式錯誤");
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var cur = ver_();
      if (!force && Number(baseVer) !== cur) throw new Error("CONFLICT");
      writeDB_(db);
      writeTables_(db);
      var nv = cur + 1;
      PropertiesService.getScriptProperties().setProperty("VER", String(nv));
      return { ver: nv, time: now_() };
    } finally {
      lock.releaseLock();
    }
  },

  /* ---------- 公開月曆（不含學員名單） ---------- */
  publicCalendar: function (month) {
    month = String(month || "").slice(0, 7);
    var db = readDB_() || emptyDb_();
    var show = { pending: 1, confirmed: 1, resched: 1, done: 1 };
    return db.sessions.filter(function (x) { return x.date && x.date.indexOf(month) === 0 && show[x.status]; })
      .map(function (x) {
        var c = course_(db, x.cid) || {};
        return { id: x.id, course: c.name || "", level: c.level || "", content: c.content || "", date: x.date, start: x.start, end: x.end, place: x.place,
          status: x.status === "confirmed" || x.status === "done" ? x.status : "pending" };
      })
      .sort(function (a, b) { return (a.date + a.start) < (b.date + b.start) ? -1 : 1; });
  },

  /* ---------- 學生查詢（只回傳本人資料） ---------- */
  studentLookup: function (emp) {
    var id = String(emp || "").trim().toUpperCase();
    if (!id) throw new Error("請輸入人事號");
    var db = readDB_() || emptyDb_();
    var s = null;
    for (var i = 0; i < db.students.length; i++) if (String(db.students[i].id).trim().toUpperCase() === id) { s = db.students[i]; break; }
    if (!s) { Utilities.sleep(600); throw new Error("查無此人事號，請確認或洽教學部"); }
    var items = [];
    sortCourses_(db).forEach(function (c) {
      if (!c.active) return;
      var req = required_(s, c);
      if (!req && !(c.ugy && s.level === "UGY")) return;
      var base = { course: c.name, level: c.level, content: c.content || "", required: req, makeup: req && s.level === "PGY2" && c.level === "PGY1" };
      var d = doneInfo_(db, s.id, c.id);
      if (d) { base.k = "done"; base.date = d.date || ""; items.push(base); return; }
      var sc = schedInfo_(db, s.id, c.id);
      if (sc) { base.k = "sch"; base.date = sc.date; base.start = sc.start; base.end = sc.end; base.place = sc.place; base.status = sc.status; items.push(base); return; }
      base.k = req ? "miss" : "opt";
      items.push(base);
    });
    return { name: mask_(s.name), level: s.level, start: s.start || "", end: s.end || "", items: items };
  },

  /* ---------- 導師專區 ---------- */
  teacherLookup: function (name, pw) {
    checkTeacher_(pw);
    var n = normT_(name);
    if (!n) throw new Error("請輸入姓名");
    var db = readDB_() || emptyDb_();
    var from = addDays_(today_(), -60);
    var pend = latestReplies_(db.replySeq || 0);
    var stu = {};
    db.students.forEach(function (s) { stu[s.id] = s; });
    var list = db.sessions.filter(function (x) {
      return normT_(x.instructor) === n && x.status !== "draft" && x.status !== "cancel" && x.date >= from;
    }).map(function (x) {
      var c = course_(db, x.cid) || {};
      return { id: x.id, course: c.name || "", level: c.level || "", content: c.content || "", cap: c.cap || 0, date: x.date, start: x.start, end: x.end, place: x.place,
        status: x.status, proposal: x.proposal || null, note: x.note || "",
        students: x.students.map(function (id) { var s = stu[id]; return s ? { name: s.name, level: s.level } : { name: "（已移除）", level: "" }; }),
        reply: pend[x.id] || null };
    }).sort(function (a, b) { return (a.date + a.start) < (b.date + b.start) ? -1 : 1; });
    return { name: String(name).trim(), sessions: list, needPw: !!PropertiesService.getScriptProperties().getProperty("TEACHER_PW") };
  },
  teacherReply: function (name, pw, sid, ok, date, start, end, note) {
    checkTeacher_(pw);
    var db = readDB_() || emptyDb_();
    var x = null;
    for (var i = 0; i < db.sessions.length; i++) if (db.sessions[i].id === sid) { x = db.sessions[i]; break; }
    if (!x || normT_(x.instructor) !== normT_(name)) throw new Error("找不到此梯次，或非您負責的課程");
    if (x.status === "done" || x.status === "cancel") throw new Error("此梯次已結束或取消，無法回覆");
    ok = !!ok;
    date = clean_(date, 10); start = clean_(start, 5); end = clean_(end, 5); note = clean_(note, 300);
    if (!ok && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("請填寫建議日期");
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var sh = sheet_("導師回覆", REPLY_HEAD);
      var seq = Math.max(1, sh.getLastRow());
      var c = course_(db, x.cid) || {};
      var row = [seq, now_(), x.id, c.name || "", x.date + " " + x.start, String(name).trim(), ok ? "可以" : "建議改期", ok ? "" : date, ok ? "" : start, ok ? "" : end, note];
      var rg = sh.getRange(seq + 1, 1, 1, row.length);
      rg.setNumberFormat("@");
      rg.setValues([row.map(String)]);
      return { seq: seq };
    } finally {
      lock.releaseLock();
    }
  }
};

/* ================= 驗證 ================= */
function checkAdmin_(pw) {
  var p = PropertiesService.getScriptProperties().getProperty("ADMIN_PW");
  if (!p) throw new Error("後端尚未設定管理密碼（指令碼屬性 ADMIN_PW）");
  if (String(pw || "") !== p) { Utilities.sleep(800); throw new Error("管理密碼錯誤"); }
}
function checkTeacher_(pw) {
  var p = PropertiesService.getScriptProperties().getProperty("TEACHER_PW");
  if (p && String(pw || "") !== p) { Utilities.sleep(800); throw new Error("導師密碼錯誤"); }
}

/* ================= 儲存 ================= */
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(name, head) {
  var sh = ss_().getSheetByName(name);
  if (!sh) {
    sh = ss_().insertSheet(name);
    if (head) { sh.getRange(1, 1, 1, head.length).setValues([head]); sh.setFrozenRows(1); }
  }
  return sh;
}
function ver_() { return Number(PropertiesService.getScriptProperties().getProperty("VER") || 0); }
function readDB_() {
  var sh = ss_().getSheetByName("_data");
  if (!sh || sh.getLastRow() < 1) return null;
  var s = sh.getRange(1, 1, sh.getLastRow(), 1).getValues().map(function (r) { return String(r[0]).replace(/^~/, ""); }).join("");
  return s ? JSON.parse(s) : null;
}
function writeDB_(db) {
  var sh = sheet_("_data");
  var s = JSON.stringify(db), rows = [];
  for (var i = 0; i < s.length; i += CHUNK) rows.push(["~" + s.slice(i, i + CHUNK)]); // 前綴避免被當成公式或數字
  sh.clearContents();
  var rg = sh.getRange(1, 1, rows.length, 1);
  rg.setNumberFormat("@");
  rg.setValues(rows);
  try { sh.hideSheet(); } catch (e) {}
}
function writeTable_(name, head, rows) {
  var sh = sheet_(name, head);
  sh.clearContents();
  var all = [head].concat(rows.map(function (r) { return r.map(function (v) { return v == null ? "" : String(v); }); }));
  var rg = sh.getRange(1, 1, all.length, head.length);
  rg.setNumberFormat("@");
  rg.setValues(all);
  sh.setFrozenRows(1);
}
function writeTables_(db) {
  var cn = {}, sn = {};
  db.courses.forEach(function (c) { cn[c.id] = c; });
  db.students.forEach(function (s) { sn[s.id] = s.name; });
  writeTable_("梯次", ["日期", "開始", "結束", "課程", "級別", "地點", "導師", "狀態", "人數", "學員", "出席"],
    db.sessions.slice().sort(function (a, b) { return (a.date + a.start) < (b.date + b.start) ? -1 : 1; }).map(function (x) {
      var c = cn[x.cid] || {};
      return [x.date, x.start, x.end, c.name, c.level, x.place, x.instructor, STATUS_T[x.status] || x.status, x.students.length,
        x.students.map(function (i) { return sn[i] || i; }).join("、"), x.attended ? x.attended.map(function (i) { return sn[i] || i; }).join("、") : ""];
    }));
  writeTable_("學員", ["人事號", "姓名", "級別", "訓練開始", "訓練結束", "備註"], db.students.map(function (s) { return [s.id, s.name, s.level, s.start, s.end, s.note]; }));
  writeTable_("課程", ["課程名稱", "分類", "課程內容", "地點", "每梯上限", "人員說明", "開放UGY", "啟用", "備註"],
    db.courses.map(function (c) { return [c.name, c.level, c.content, c.place, c.cap || "不限", c.audience, c.ugy ? "是" : "", c.active ? "是" : "否", c.note]; }));
  writeTable_("訓練紀錄", ["人事號", "姓名", "課程", "完成日期", "來源"], db.records.map(function (r) { return [r.sid, sn[r.sid] || "", (cn[r.cid] || {}).name || "", r.date, r.src]; }));
}
function repliesAfter_(seq) {
  var sh = ss_().getSheetByName("導師回覆");
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, REPLY_HEAD.length).getValues()
    .filter(function (r) { return Number(r[0]) > seq; })
    .map(function (r) { return { seq: Number(r[0]), time: String(r[1]), sid: String(r[2]), name: String(r[5]), ok: String(r[6]) === "可以", date: String(r[7]), start: String(r[8]), end: String(r[9]), note: String(r[10]) }; });
}
function latestReplies_(seq) {
  var m = {};
  repliesAfter_(seq).forEach(function (r) { m[r.sid] = r; });
  return m;
}

/* ================= 訓練邏輯（與 pgy.html 相同） ================= */
function emptyDb_() { return { courses: [], students: [], records: [], sessions: [] }; }
function course_(db, id) { for (var i = 0; i < db.courses.length; i++) if (db.courses[i].id === id) return db.courses[i]; return null; }
function sortCourses_(db) {
  return db.courses.slice().sort(function (a, b) { return a.level > b.level ? 1 : a.level < b.level ? -1 : db.courses.indexOf(a) - db.courses.indexOf(b); });
}
function required_(s, c) {
  if (!c.active) return false;
  if (c.level === "PGY1") return s.level === "PGY1" || s.level === "PGY2";
  if (c.level === "PGY2") return s.level === "PGY2";
  return false;
}
function doneInfo_(db, sid, cid) {
  for (var i = 0; i < db.records.length; i++) { var r = db.records[i]; if (r.sid === sid && r.cid === cid) return { date: r.date }; }
  var best = null;
  db.sessions.forEach(function (x) {
    if (x.cid === cid && x.status === "done" && (x.attended || x.students).indexOf(sid) >= 0 && (!best || x.date < best.date)) best = x;
  });
  return best ? { date: best.date } : null;
}
function schedInfo_(db, sid, cid) {
  var best = null;
  db.sessions.forEach(function (x) {
    if (x.cid === cid && x.status !== "done" && x.status !== "cancel" && x.students.indexOf(sid) >= 0 && (!best || x.date < best.date)) best = x;
  });
  return best;
}

/* ================= 小工具 ================= */
function now_() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss"); }
function today_() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd"); }
function addDays_(s, n) { var p = String(s).split("-").map(Number); return Utilities.formatDate(new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)), "UTC", "yyyy-MM-dd"); }
function normT_(s) { return String(s || "").replace(/\s/g, "").replace(/(醫師|老師|主任|教授|醫生)$/, "").toLowerCase(); }
function clean_(v, n) { return String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").replace(/^[=+\-@]+/, "").trim().slice(0, n); }
function mask_(name) {
  var s = String(name || "");
  if (s.length <= 1) return s;
  if (s.length === 2) return s[0] + "○";
  return s[0] + Array(s.length - 1).join("○") + s[s.length - 1];
}
