/**
 * 臨床技能課程安排表 — Google Apps Script 資料來源
 *
 * 使用方式：
 * 1. 把課程 Excel 匯入 Google 試算表（檔案 → 匯入 → 取代試算表），分頁名稱維持
 *    「課程場次」「學員名單」「選課紀錄」「師資」「課程清單」「課程回饋」。
 * 2. 試算表選單：擴充功能 → Apps Script，把本檔內容整個貼上並儲存。
 * 3. 部署 → 新增部署作業 → 類型「網頁應用程式」
 *      執行身分：我　／　誰可以存取：任何人
 * 4. 複製部署網址（結尾 /exec），貼到 schedule/index.html 的 GAS_URL。
 *
 * 本程式只「讀取」試算表，把每個分頁原樣（顯示文字）回傳，解析在網頁端完成。
 * 若有不想公開的分頁，把名稱加到 HIDDEN_SHEETS。
 */
const HIDDEN_SHEETS = [];

function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const out = {
    generatedAt: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm"),
    sheets: {}
  };
  ss.getSheets().forEach(function (sh) {
    const name = sh.getName();
    if (HIDDEN_SHEETS.indexOf(name) >= 0) return;
    if (sh.getLastRow() < 1) { out.sheets[name] = []; return; }
    out.sheets[name] = sh.getDataRange().getDisplayValues();
  });
  const json = JSON.stringify(out);
  const cb = e && e.parameter && e.parameter.callback;
  if (cb && /^[\w$.]+$/.test(cb)) {
    return ContentService.createTextOutput(cb + "(" + json + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}
