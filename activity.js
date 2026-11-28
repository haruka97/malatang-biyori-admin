// 安全与操作记录 (2026-11-28, security review S-1, S-2): how many rows the app sends per hour against the caps, and
// the latest admin changes with 「撤回」 for the four that reach every app (prices, menu, status, a copied menu).

const ACTIVITY_TABLES = {
  bowl_submissions: "碗数据", daily_usage: "匿名日报", notice_events: "お知らせ的显示・打开",
  missing_ingredients: "店にない食材", ingredient_requests: "食材リクエスト", shop_feedback: "店铺反馈・意见",
};
const CHANGE_LABELS = {
  set_rule: "改料金", set_menu: "改菜单", set_status: "改营业状态", copy_menu: "复制菜单", add_shop: "新增店",
  publish: "发布店铺清单", add_notice: "新建お知らせ", change_notice: "改お知らせ", publish_notice: "发布お知らせ",
  unpublish_notice: "撤下お知らせ", undo: "撤回",
};
const UNDOABLE = new Set(["set_rule", "set_menu", "set_status", "copy_menu"]);

async function loadActivity() {
  if (DEMO) {
    Object.assign(state, demoActivity(), { canSeeActivity: true });
    return;
  }
  try {
    const [counts, changes] = await Promise.all([rpc("admin_insert_counts", {}), rpc("admin_recent_changes", {})]);
    Object.assign(state, { insertCounts: counts, changes, canSeeActivity: true });
  } catch (error) {
    // Before migrations 20261128100100 and 20261128100200 the functions do not exist.
    Object.assign(state, { insertCounts: [], changes: [], canSeeActivity: false });
  }
}

function renderActivity() {
  if (!$("activity")) return;
  if (!state.canSeeActivity) {
    fill($("activity-counts"), el("p", { class: "empty", text: "数据库里还没有这一页用的函数（迁移 20261128100100、20261128100200 未执行）。" }));
    fill($("activity-changes"), []);
    return;
  }
  // Per table: the last 24 hours, the busiest hour against the cap.
  const byTable = new Map();
  for (const row of state.insertCounts || []) {
    const entry = byTable.get(row.table_name) || { total: 0, most: 0, cap: row.per_hour };
    entry.total += row.n;
    entry.most = Math.max(entry.most, row.n);
    byTable.set(row.table_name, entry);
  }
  const rows = Object.entries(ACTIVITY_TABLES).map(([name, label]) => {
    const entry = byTable.get(name) || { total: 0, most: 0, cap: null };
    const near = entry.cap && entry.most >= entry.cap * 0.8;
    return [label, entry.total, entry.most, entry.cap ?? "—", near ? "⚠ 接近上限" : ""];
  });
  fill($("activity-counts"), table(
    [{ label: "表" }, { label: "最近 24 小时", num: true }, { label: "最多的 1 小时", num: true }, { label: "每小时上限", num: true },
      { label: "" }], rows));

  const changes = state.changes || [];
  fill($("activity-changes"), changes.length === 0 ? el("p", { class: "empty", text: "还没有操作记录。" })
    : el("div", {}, changes.map(changeRow)));
}

function changeRow(change) {
  const when = new Date(change.at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const label = CHANGE_LABELS[change.action] || change.action;
  const target = change.shop_name || change.shop_id || "";
  const canUndo = UNDOABLE.has(change.action) && change.detail && "before" in change.detail && !change.undone;
  const parts = [
    el("span", { class: "tag", text: label }),
    el("span", { text: `${when}  ${target}` }),
    el("span", { class: "hint", text: changeSummary(change) }),
  ];
  if (change.undone) parts.push(el("span", { class: "tag", text: "已撤回" }));
  if (canUndo) {
    const button = el("button", { text: "撤回" });
    button.addEventListener("click", () => undoChange(change));
    parts.push(button);
  }
  return el("div", { class: change.undone ? "item change done" : "item change" }, parts);
}

function changeSummary(change) {
  const detail = change.detail || {};
  if (change.action === "set_status") {
    const name = (status) => STATUS[status] || status || "?";
    return `${name(detail.before)} → ${name(detail.after ?? detail.status)}`;
  }
  if (change.action === "copy_menu") return `复制到 ${detail.changed ?? 0} 家`;
  if (change.action === "undo") return `撤回第 ${detail.change_id} 号操作（恢复 ${detail.restored ?? 0} 家）`;
  if (!("before" in detail) && UNDOABLE.has(change.action)) return "旧记录（没有改之前的值，不能撤回）";
  if (change.action === "set_rule") return `${ruleSummary(detail.before) || "没有料金"} → ${ruleSummary(detail.after) || "没有料金"}`;
  if (change.action === "set_menu") return `${detail.before ? "有菜单" : "没有菜单"} → ${detail.after ? "新的菜单" : "没有菜单"}`;
  return "";
}

async function undoChange(change) {
  const label = CHANGE_LABELS[change.action] || change.action;
  const target = change.shop_name || change.shop_id || "";
  if (!confirm(`撤回「${label}」（${target}）？\n恢复成这次修改之前的内容。已发布的店会提高店铺清单的版本，App 一天内拿到。`)) return;
  try {
    if (!DEMO) await rpc("admin_undo_change", { change_id: change.id });
    else change.undone = true;
    notice("已撤回。");
    if (!DEMO) await load(); else renderActivity();
  } catch (error) {
    const message = /changed since/.test(error.message) ? "这家店之后又改过了，不能撤回（会把之后的修改也丢掉）。"
      : /already undone/.test(error.message) ? "这次操作已经撤回过了。" : error.message;
    notice(message);
  }
}

function demoActivity() {
  const hour = (h) => new Date(Date.now() - h * 3600000).toISOString();
  return {
    insertCounts: [
      { table_name: "daily_usage", hour: hour(2), n: 14, per_hour: 3000 },
      { table_name: "daily_usage", hour: hour(1), n: 22, per_hour: 3000 },
      { table_name: "bowl_submissions", hour: hour(1), n: 3, per_hour: 600 },
      { table_name: "shop_feedback", hour: hour(3), n: 101, per_hour: 120 },
    ],
    changes: [
      { id: 12, at: hour(1), action: "set_rule", shop_id: "s_demo0001", shop_name: "示例麻辣湯 本店", undone: false,
        detail: { before: { kind: "perGram", base_yen: 0, included_grams: 0, yen_per_gram: 4, tax_included: true },
                  after: { kind: "perGram", base_yen: 0, included_grams: 0, yen_per_gram: 4.2, tax_included: true } } },
      { id: 11, at: hour(5), action: "set_status", shop_id: "s_demo0002", shop_name: "示例麻辣湯 二号店", detail: { status: "closed", before: "open", after: "closed" }, undone: true },
      { id: 10, at: hour(30), action: "publish", shop_id: null, shop_name: null, detail: { ids: ["s_demo0003"], version: 15 }, undone: false },
    ],
  };
}
