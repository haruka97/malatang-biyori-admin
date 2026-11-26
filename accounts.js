// 账号与人气 (M20 T20.10): the accounts, signs worth a look in the shops' numbers, setting names back and leaving an
// account out of the numbers. Everything goes through database functions that check the admin and write a log line
// (supabase/migrations/20261126100000_admin_accounts_and_alerts.sql). Loaded before app.js, which starts the page:
// nothing here runs at load time, and app.js's helpers (el, fill, table, notice, api, state, DEMO, shopName) and
// shops.js's rpc are there by the time these functions are called.
"use strict";

const SIGNS = {
  ratings_rose: "评价猛增（7 天内 5 条以上，占一半以上）",
  favorites_rose: "收藏猛增（7 天内 10 个以上，占一半以上）",
  only_this_shop: "只评过这一家的人 3 个以上",
  new_accounts: "刚注册就评价的人 3 个以上",
};

async function loadAccounts() {
  if (DEMO) {
    Object.assign(state, demoAccounts(), { canManageAccounts: true });
    return;
  }
  try {
    const [accounts, alerts, shopStats] = await Promise.all([
      rpc("admin_accounts", {}), rpc("admin_popularity_alerts", {}),
      api("shop_stats?select=shop_key,favorite_count,rating_count,rating_avg,updated_at&order=shop_key"),
    ]);
    Object.assign(state, { accounts, alerts, shopStats, canManageAccounts: true });
    // Its own request: before migration 20261126160000 this function is missing and the rest still shows.
    try { state.statsRuns = await rpc("admin_shop_stats_runs", {}); } catch (error) { state.statsRuns = null; }
  } catch (error) {
    // Before the migration the functions do not exist: the tab says so instead of failing the whole page.
    Object.assign(state, { accounts: [], alerts: [], shopStats: [], canManageAccounts: false });
  }
}

function day(text) {
  return text ? String(text).slice(0, 10) : "";
}

function accountButton(label, kind, confirmText, action, done) {
  const button = el("button", { text: label, class: kind });
  button.addEventListener("click", async () => {
    if (!confirm(confirmText)) return;
    button.disabled = true;
    try {
      const result = DEMO ? null : await action();
      done(result);
      notice("");
      renderAccounts();
    } catch (error) {
      notice(error.message);
      button.disabled = false;
    }
  });
  return button;
}

function accountActions(account) {
  const who = `@${account.handle}`;
  const buttons = [
    accountButton("重置ユーザー名", "", `把 ${who} 的 ユーザー名 换成自动生成的名字？本人 30 天内不能再改。`,
      () => rpc("admin_reset_names", { target: account.user_id, reset_handle: true, clear_nickname: false }),
      (handle) => { account.handle = handle || "user_demo0000"; account.handle_changed_at = new Date().toISOString(); }),
  ];
  if (account.display_name) {
    buttons.push(accountButton("清空ニックネーム", "", `清空 ${who} 的 ニックネーム「${account.display_name}」？本人可以马上再填。`,
      () => rpc("admin_reset_names", { target: account.user_id, reset_handle: false, clear_nickname: true }),
      () => { account.display_name = null; }));
  }
  if (account.excluded) {
    buttons.push(accountButton("重新计入", "", `把 ${who} 的评价和收藏重新计入店铺的数字？`,
      () => rpc("admin_set_account_excluded", { target: account.user_id, leave_out: false, why: "" }),
      () => { account.excluded = false; account.excluded_reason = null; }));
  } else {
    buttons.push(accountButton("不计入数字", "", `${who} 的评价和收藏不再计入店铺的数字（本人看不出来，数据不删）。确定？`,
      () => rpc("admin_set_account_excluded", { target: account.user_id, leave_out: true, why: "后台手动" }),
      () => { account.excluded = true; account.excluded_reason = "后台手动"; }));
  }
  return el("div", { class: "actions" }, buttons);
}

function renderAccounts() {
  if (!$("accounts")) return;
  if (!state.canManageAccounts) {
    fill($("accounts-summary"), []);
    fill($("accounts-alerts"), el("p", { class: "empty", text: "数据库里还没有这一页用的函数（迁移 20261126100000 未执行）。" }));
    fill($("accounts-stats"), []);
    fill($("accounts-list"), []);
    return;
  }
  const accounts = state.accounts;
  fill($("accounts-summary"), [
    ["账号", accounts.length],
    ["同意计入评价", accounts.filter((a) => a.rating_consent === true).length],
    ["评价（条）", accounts.reduce((sum, a) => sum + a.ratings, 0)],
    ["收藏（个）", accounts.reduce((sum, a) => sum + a.favorites, 0)],
    ["保存的レシピ", accounts.reduce((sum, a) => sum + a.saved_recipes, 0)],
    ["不计入的账号", accounts.filter((a) => a.excluded).length],
    ["有数字显示的店", state.shopStats.length],
  ].map(([label, value]) => el("div", { class: "card" }, [el("b", { text: String(value) }), el("span", { text: label })])));

  renderStatsRuns();
  fill($("accounts-alerts"), state.alerts.length === 0
    ? el("p", { class: "empty", text: "没有需要看的迹象。" })
    : table(
      [{ label: "店" }, { label: "迹象", wrap: true }, { label: "评价", num: true }, { label: "7 天内", num: true }, { label: "只评这家", num: true },
       { label: "新账号", num: true }, { label: "收藏", num: true }, { label: "7 天内", num: true }],
      state.alerts.map((a) => [shopName(a.shop_key.startsWith("s_") ? a.shop_key : null) === "（清单以外）" ? a.shop_key : shopName(a.shop_key),
        a.signs.map((s) => SIGNS[s] || s).join("；"), a.ratings, a.ratings_7d, a.only_this_shop, a.new_accounts, a.favorites, a.favorites_7d])));

  fill($("accounts-stats"), state.shopStats.length === 0
    ? el("p", { class: "empty", text: "还没有到门槛的店。" })
    : table([{ label: "店" }, { label: "★ 平均", num: true }, { label: "评价人数", num: true }, { label: "♥ 收藏人数", num: true }, { label: "算出的时间" }],
      state.shopStats.map((s) => [s.shop_key.startsWith("s_") ? shopName(s.shop_key) : s.shop_key, s.rating_avg, s.rating_count, s.favorite_count, day(s.updated_at)])));

  const query = $("accounts-search").value.trim().toLowerCase();
  const shown = accounts.filter((a) => !query || `${a.handle} ${a.display_name || ""} ${a.user_id}`.toLowerCase().includes(query));
  fill($("accounts-list"), shown.length === 0 ? el("p", { class: "empty", text: accounts.length ? "没有符合的账号。" : "还没有账号。" })
    : shown.map((account) => el("div", { class: `item${account.excluded ? " draft" : ""}` }, [
      el("div", { class: "meta" }, [
        el("span", { class: "tag", text: `@${account.handle}` }),
        el("span", { text: `注册 ${day(account.created_at)}` }),
        account.handle_changed_at ? el("span", { text: `改名 ${day(account.handle_changed_at)}` }) : "",
        el("span", { text: `评价 ${account.ratings}・收藏 ${account.favorites}・レシピ ${account.saved_recipes}` }),
        el("span", { text: account.rating_consent === true ? "同意计入评价" : account.rating_consent === false ? "不计入评价（本人选的）" : "还没问过" }),
        account.excluded ? el("span", { class: "tag new", text: `不计入数字${account.excluded_reason ? `：${account.excluded_reason}` : ""}` }) : "",
      ]),
      // The names are whatever the person typed: shown as plain text only.
      el("p", { class: "message", text: account.display_name ? `ニックネーム：${account.display_name}` : "ニックネーム：（没有）" }),
      accountActions(account),
    ])));
}

// The nightly recomputation: how long it took. Slow runs are the sign to change how it is computed.
const SLOW_RUN_MS = 5000;

function renderStatsRuns() {
  const box = $("accounts-runs");
  if (!box) return;
  const runs = state.statsRuns;
  if (runs === null || runs === undefined) {
    fill(box, el("p", { class: "empty", text: "还没有重算用时的记录（迁移 20261126160000 未执行）。" }));
    return;
  }
  if (runs.length === 0) {
    fill(box, el("p", { class: "empty", text: "还没有重算过（每天凌晨 4:10 一次）。" }));
    return;
  }
  const latest = runs[0];
  const slowest = runs.reduce((max, run) => Math.max(max, run.duration_ms), 0);
  const seconds = (ms) => (ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`);
  const slow = latest.duration_ms >= SLOW_RUN_MS;
  fill(box, el("p", { class: slow ? "warn" : "", text:
    `上一次：${new Date(latest.ran_at).toLocaleString("ja-JP")}，用了 ${seconds(latest.duration_ms)}`
    + `（收藏 ${latest.favorites} 个、评价 ${latest.ratings} 条、有数字的店 ${latest.shops_shown} 家）。`
    + `最近 ${runs.length} 次里最慢 ${seconds(slowest)}。`
    + (slow ? "超过 5 秒了：请告诉 Claude，该改成只重算有变化的店。" : "") }));
}

// ---- Sample data for ?demo (made up) ----

function demoAccounts() {
  const accounts = [
    { user_id: "00000000-0000-4000-8000-0000000000a1", handle: "mala_fan", display_name: "まーらー好き", created_at: "2026-11-20T03:00:00Z", handle_changed_at: null,
      rating_consent: true, favorites: 6, ratings: 4, saved_recipes: 2, excluded: false, excluded_reason: null },
    { user_id: "00000000-0000-4000-8000-0000000000a2", handle: "user_k3m9x2ab", display_name: null, created_at: "2026-11-24T10:00:00Z", handle_changed_at: null,
      rating_consent: null, favorites: 1, ratings: 0, saved_recipes: 0, excluded: false, excluded_reason: null },
    { user_id: "00000000-0000-4000-8000-0000000000a3", handle: "promo_account", display_name: "サンプル麻辣湯 最高！！", created_at: "2026-11-25T01:00:00Z", handle_changed_at: "2026-11-25T01:05:00Z",
      rating_consent: true, favorites: 1, ratings: 1, saved_recipes: 0, excluded: true, excluded_reason: "后台手动" },
  ];
  const alerts = [
    { shop_key: "s_demo0002", ratings: 9, ratings_7d: 8, only_this_shop: 7, new_accounts: 6, favorites: 12, favorites_7d: 11,
      signs: ["ratings_rose", "favorites_rose", "only_this_shop", "new_accounts"] },
  ];
  const shopStats = [
    { shop_key: "s_demo0001", favorite_count: 38, rating_count: 12, rating_avg: 4.2, updated_at: "2026-11-25T19:10:00Z" },
    { shop_key: "I0000000000000009", favorite_count: 7, rating_count: null, rating_avg: null, updated_at: "2026-11-25T19:10:00Z" },
  ];
  const statsRuns = [
    { ran_at: "2026-11-25T19:10:00Z", duration_ms: 42, favorites: 8, ratings: 5, shops_shown: 2 },
    { ran_at: "2026-11-24T19:10:00Z", duration_ms: 38, favorites: 6, ratings: 4, shops_shown: 1 },
  ];
  return { accounts, alerts, shopStats, statsRuns };
}
