// マーラータン日和 admin site (docs/ADMIN.md). A static page: it talks to Supabase with the public publishable key
// and the signed-in owner's session. No secret is in these files; the project address and key are typed in once and
// kept in this browser. Everything read from the database was typed by other people: it is shown as text only.
"use strict";

const $ = (id) => document.getElementById(id);
const DEMO = new URLSearchParams(location.search).has("demo");
const PAGE = 1000;

const TOPICS = {
  closed: "閉店", moved: "移転", hours: "营业时间・休业", price_rule: "料金ルール", location: "地点・住所",
  new_shop: "新店投稿", owner: "店家联系", other: "其他",
};
const REVIEWS = { new: "未处理", checked: "已核实", rejected: "不采用" };
const CHAINS = { yangguofu: "楊国福", qibao: "七宝", lixiaoqi: "李暁七", lahongbang: "ラホンバン", custom: "自定义店铺" };

const state = { session: null, feedback: [], requests: [], bowls: [], shops: [], dataset: null };

// ---- Small DOM helpers (text only, never innerHTML) ----

function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "class") node.className = value;
    else if (name === "text") node.textContent = value;
    else node.setAttribute(name, value);
  }
  for (const child of [].concat(children)) node.append(child);
  return node;
}

function fill(container, children) {
  container.replaceChildren(...[].concat(children));
}

function table(headers, rows) {
  const head = el("tr", {}, headers.map((h) => el("th", { text: h.label, class: h.num ? "num" : "" })));
  const body = rows.map((row) => el("tr", {}, row.map((cell, i) =>
    el("td", { text: cell == null ? "" : String(cell), class: headers[i].num ? "num" : headers[i].wrap ? "wrap" : "" }))));
  return el("div", { class: "scroll" }, el("table", {}, [el("thead", {}, head), el("tbody", {}, body)]));
}

function bars(rows) {
  const most = Math.max(1, ...rows.map((r) => r.value));
  return rows.map((r) => el("div", { class: "row" }, [
    el("span", { text: r.label }),
    el("span", { class: "track" }, el("span", { class: `fill w${Math.round((r.value / most) * 20)}` })),
    el("span", { text: String(r.value) }),
  ]));
}

function notice(text) {
  $("notice").textContent = text || "";
  $("notice").hidden = !text;
}

// ---- Supabase over fetch ----

function config() {
  try { return JSON.parse(localStorage.getItem("admin.config") || "null"); } catch { return null; }
}

function cleanHost(text) {
  const host = text.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return /^[a-z0-9-]+\.supabase\.co$/.test(host) ? host : null;
}

async function signIn(host, key, email, password) {
  const response = await fetch(`https://${host}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(response.status === 400 ? "邮箱或密码不对。" : `登录失败（${response.status}）。`);
  return response.json();
}

async function refresh() {
  const { host, key } = config();
  const response = await fetch(`https://${host}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: state.session.refresh_token }),
  });
  if (!response.ok) throw new Error("登录已过期，请重新登录。");
  saveSession(await response.json());
}

function saveSession(session) {
  state.session = session;
  if (session) sessionStorage.setItem("admin.session", JSON.stringify(session));
  else sessionStorage.removeItem("admin.session");
}

async function api(path, options = {}, retried = false) {
  const { host, key } = config();
  const response = await fetch(`https://${host}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${state.session.access_token}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (response.status === 401 && !retried) {
    await refresh();
    return api(path, options, true);
  }
  if (!response.ok) throw new Error(`读取失败（${response.status}）：${path.split("?")[0]}`);
  return response.status === 204 ? null : response.json();
}

async function all(table, select, order) {
  const rows = [];
  for (;;) {
    const page = await api(`${table}?select=${select}&order=${order}&limit=${PAGE}&offset=${rows.length}`);
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

// ---- Loading ----

async function load() {
  notice("");
  try {
    if (DEMO) Object.assign(state, demoData());
    else {
      const [feedback, requests, bowls, shops, dataset] = await Promise.all([
        all("shop_feedback", "id,shop_id,topic,message,source_url,app_version,iso_week,review", "iso_week.desc,id"),
        all("ingredient_requests", "upload_id,name,category,unit,grams_per_unit,app_version,iso_week,review", "iso_week.desc,upload_id"),
        all("bowl_submissions", "upload_id,chain_id,estimated_grams_raw,actual_grams,actual_yen,iso_week,place_id,app_version", "iso_week.desc,upload_id"),
        all("shops", "id,name,chain_id,uses_chain_rule,prefecture,city,address,apple_place_id,status,verified_on,published", "id"),
        api("shop_dataset?select=version,checked_on&limit=1"),
      ]);
      Object.assign(state, { feedback, requests, bowls, shops, dataset: dataset[0] || null });
    }
    if (!DEMO && state.shops.length === 0 && state.dataset == null) {
      notice("没有读到任何数据。这个账号可能还没有被加进管理员名单（见 docs/ADMIN.md）。");
    }
    render();
  } catch (error) {
    notice(error.message);
    if (/过期/.test(error.message)) signOut();
  }
}

function render() {
  renderFeedback();
  renderRequests();
  renderBowls();
  renderShops();
}

// ---- 店铺反馈 ----

function shopName(id) {
  if (!id) return "（清单以外）";
  const shop = state.shops.find((s) => s.id === id);
  return shop ? shop.name : id;
}

function reviewButtons(row, current, mark) {
  return el("div", { class: "actions" }, Object.entries(REVIEWS).filter(([value]) => value !== current).map(([value, label]) => {
    const button = el("button", { text: value === "new" ? "改回未处理" : `标为${label}`, class: value === "checked" ? "primary" : "" });
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await mark(row, value); } catch (error) { notice(error.message); button.disabled = false; }
    });
    return button;
  }));
}

async function markFeedback(row, review) {
  if (!DEMO) await api(`shop_feedback?id=eq.${encodeURIComponent(row.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ review }) });
  row.review = review;
  renderFeedback();
}

function safeLink(url) {
  // Shown, never followed automatically; only plain https links become clickable.
  if (typeof url !== "string" || !/^https:\/\/[^\s]+$/.test(url)) return null;
  return el("a", { class: "link", href: url, target: "_blank", rel: "noopener noreferrer nofollow", text: url });
}

function renderFeedback() {
  const showAll = $("feedback-filter").value === "all";
  const rows = state.feedback.filter((r) => showAll || r.review === "new");
  const waiting = state.feedback.filter((r) => r.review === "new").length;
  document.querySelector('[data-tab="feedback"]').textContent = waiting ? `店铺反馈（${waiting}）` : "店铺反馈";
  if (rows.length === 0) return fill($("feedback-list"), el("p", { class: "empty", text: showAll ? "还没有反馈。" : "没有未处理的反馈。" }));
  fill($("feedback-list"), rows.map((row) => el("div", { class: row.review === "new" ? "item" : "item done" }, [
    el("div", { class: "meta" }, [
      el("span", { class: "tag", text: TOPICS[row.topic] || row.topic }),
      el("b", { text: shopName(row.shop_id) }),
      el("span", { text: row.iso_week }),
      el("span", { text: `v${row.app_version}` }),
      el("span", { class: row.review === "new" ? "tag new" : "tag", text: REVIEWS[row.review] || row.review }),
    ]),
    el("p", { class: "message", text: row.message }),
    ...(safeLink(row.source_url) ? [safeLink(row.source_url)] : []),
    reviewButtons(row, row.review, markFeedback),
  ])));
}

// ---- 食材リクエスト ----

async function markRequest(group, review) {
  for (const row of group.rows) {
    if (!DEMO) await api(`ingredient_requests?upload_id=eq.${encodeURIComponent(row.upload_id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ review }) });
    row.review = review;
  }
  renderRequests();
}

function renderRequests() {
  const showAll = $("requests-filter").value === "all";
  const groups = new Map();
  for (const row of state.requests) {
    if (!showAll && row.review !== "new") continue;
    const key = `${row.name.trim().toLowerCase()}|${row.review}`;
    if (!groups.has(key)) groups.set(key, { name: row.name.trim(), review: row.review, rows: [] });
    groups.get(key).rows.push(row);
  }
  const waiting = state.requests.filter((r) => r.review === "new").length;
  document.querySelector('[data-tab="requests"]').textContent = waiting ? `食材リクエスト（${waiting}）` : "食材リクエスト";
  const sorted = [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name, "ja"));
  if (sorted.length === 0) return fill($("requests-list"), el("p", { class: "empty", text: showAll ? "还没有リクエスト。" : "没有未处理的リクエスト。" }));
  fill($("requests-list"), sorted.map((group) => {
    const grams = group.rows.map((r) => Number(r.grams_per_unit)).filter(Number.isFinite).sort((a, b) => a - b);
    const kinds = [...new Set(group.rows.map((r) => `${r.category}・${r.unit}`))].join("、");
    const weeks = group.rows.map((r) => r.iso_week).sort();
    return el("div", { class: group.review === "new" ? "item" : "item done" }, [
      el("div", { class: "meta" }, [
        el("b", { text: group.name }),
        el("span", { class: "tag", text: `${group.rows.length} 件` }),
        el("span", { text: kinds }),
        el("span", { text: grams.length ? `约 ${median(grams)}g` : "" }),
        el("span", { text: weeks[0] === weeks[weeks.length - 1] ? weeks[0] : `${weeks[0]}〜${weeks[weeks.length - 1]}` }),
        el("span", { class: group.review === "new" ? "tag new" : "tag", text: REVIEWS[group.review] || group.review }),
      ]),
      reviewButtons(group, group.review, markRequest),
    ]);
  }));
}

// ---- 碗数据 ----

function median(sorted) {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value * 100) / 100;
}

function ratios(rows) {
  return rows.filter((r) => r.estimated_grams_raw > 0 && r.actual_grams > 0).map((r) => r.actual_grams / r.estimated_grams_raw).sort((a, b) => a - b);
}

function renderBowls() {
  const bowls = state.bowls;
  const everyRatio = ratios(bowls);
  const yen = bowls.map((r) => r.actual_yen).filter((v) => v > 0).sort((a, b) => a - b);
  fill($("bowls-summary"), [
    ["碗数", bowls.length],
    ["实际÷估算（中位数）", everyRatio.length ? median(everyRatio).toFixed(2) : "—"],
    ["金额（中位数）", yen.length ? `¥${Math.round(median(yen))}` : "—"],
    ["带店铺的碗", bowls.filter((r) => r.place_id).length],
  ].map(([label, value]) => el("div", { class: "card" }, [el("b", { text: String(value) }), el("span", { text: label })])));

  const weeks = new Map();
  for (const row of bowls) weeks.set(row.iso_week, (weeks.get(row.iso_week) || 0) + 1);
  const weekRows = [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-16).map(([label, value]) => ({ label, value }));
  fill($("bowls-weeks"), weekRows.length ? bars(weekRows) : el("p", { class: "empty", text: "还没有碗数据。" }));

  const chains = new Map();
  for (const row of bowls) {
    const key = row.chain_id || "custom";
    if (!chains.has(key)) chains.set(key, []);
    chains.get(key).push(row);
  }
  fill($("bowls-chains"), table(
    [{ label: "连锁" }, { label: "碗数", num: true }, { label: "中位数", num: true }, { label: "最小", num: true }, { label: "最大", num: true }],
    [...chains.entries()].sort((a, b) => b[1].length - a[1].length).map(([chain, rows]) => {
      const r = ratios(rows);
      return [CHAINS[chain] || chain, rows.length, r.length ? median(r).toFixed(2) : "—",
        r.length ? r[0].toFixed(2) : "—", r.length ? r[r.length - 1].toFixed(2) : "—"];
    })));

  const edges = [0.6, 0.8, 0.9, 1.1, 1.2, 1.4];
  const labels = ["〜0.6", "0.6〜0.8", "0.8〜0.9", "0.9〜1.1", "1.1〜1.2", "1.2〜1.4", "1.4〜"];
  const counts = labels.map(() => 0);
  for (const ratio of everyRatio) counts[edges.filter((edge) => ratio >= edge).length] += 1;
  fill($("bowls-histogram"), everyRatio.length ? bars(labels.map((label, i) => ({ label, value: counts[i] }))) : el("p", { class: "empty", text: "还没有碗数据。" }));

  const places = new Map();
  for (const row of bowls) {
    if (!row.place_id) continue;
    if (!places.has(row.place_id)) places.set(row.place_id, []);
    places.get(row.place_id).push(row);
  }
  fill($("bowls-places"), table(
    [{ label: "店", wrap: true }, { label: "碗数", num: true }, { label: "实际÷估算", num: true }, { label: "金额中位数", num: true }],
    [...places.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 20).map(([place, rows]) => {
      const r = ratios(rows);
      const amounts = rows.map((x) => x.actual_yen).filter((v) => v > 0).sort((a, b) => a - b);
      // Apple Maps places show their ID only: look the name up with tools/place_lookup.swift when needed.
      return [place.startsWith("s_") ? shopName(place) : `Apple 地图 ${place}`, rows.length,
        r.length ? median(r).toFixed(2) : "—", amounts.length ? `¥${Math.round(median(amounts))}` : "—"];
    })));
}

// ---- 店铺清单 ----

function renderShops() {
  const query = $("shops-search").value.trim().toLowerCase();
  const rows = state.shops.filter((s) => !query || [s.id, s.name, s.prefecture, s.city, s.address].join(" ").toLowerCase().includes(query));
  const published = state.shops.filter((s) => s.published).length;
  $("shops-summary").textContent = state.dataset
    ? `版本 ${state.dataset.version}（${state.dataset.checked_on}）・共 ${state.shops.length} 家，已发布 ${published} 家，有 Apple Place ID ${state.shops.filter((s) => s.apple_place_id).length} 家。修改清单请改 shopdata/shops.csv 后发布新版本。`
    : `共 ${state.shops.length} 家。`;
  const status = { open: "营业", temporarily_closed: "休业", closed: "闭店" };
  fill($("shops-list"), table(
    [{ label: "店名", wrap: true }, { label: "连锁" }, { label: "地址", wrap: true }, { label: "状态" }, { label: "确认日" }, { label: "发布" }, { label: "Apple ID" }, { label: "ID" }],
    rows.map((s) => [s.name, (CHAINS[s.chain_id] || s.chain_id || "—") + (s.chain_id && !s.uses_chain_rule ? "（规则不同）" : ""),
      `${s.prefecture}${s.city}${s.address}`, status[s.status] || s.status, s.verified_on, s.published ? "✓" : "草稿", s.apple_place_id ? "✓" : "", s.id])));
}

// ---- Session and navigation ----

function showApp(signedIn) {
  $("login").hidden = signedIn;
  $("tabs").hidden = !signedIn;
  $("session").hidden = !signedIn;
  if (!signedIn) document.querySelectorAll(".tab").forEach((tab) => { tab.hidden = true; });
  else selectTab(document.querySelector("#tabs button.on").dataset.tab);
}

function selectTab(name) {
  document.querySelectorAll("#tabs button").forEach((button) => button.classList.toggle("on", button.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((tab) => { tab.hidden = tab.id !== name; });
}

function signOut() {
  saveSession(null);
  showApp(false);
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-error").textContent = "";
  const host = cleanHost($("host").value);
  const key = $("key").value.trim();
  if (!host) { $("login-error").textContent = "项目地址应为 xxxxxxxx.supabase.co。"; return; }
  if (!/^sb_publishable_/.test(key)) { $("login-error").textContent = "这里只填 publishable key（sb_publishable_ 开头）。不要填 secret key。"; return; }
  try {
    const session = await signIn(host, key, $("email").value.trim(), $("password").value);
    localStorage.setItem("admin.config", JSON.stringify({ host, key }));
    $("password").value = "";
    saveSession(session);
    $("who").textContent = session.user && session.user.email ? session.user.email : "";
    showApp(true);
    await load();
  } catch (error) {
    $("login-error").textContent = error.message;
  }
});

$("tabs").addEventListener("click", (event) => { if (event.target.dataset.tab) selectTab(event.target.dataset.tab); });
$("signout").addEventListener("click", signOut);
$("reload").addEventListener("click", load);
$("feedback-filter").addEventListener("change", renderFeedback);
$("requests-filter").addEventListener("change", renderRequests);
$("shops-search").addEventListener("input", renderShops);

(function start() {
  const saved = config();
  if (saved) { $("host").value = saved.host; $("key").value = saved.key; }
  if (DEMO) {
    $("who").textContent = "示例数据";
    showApp(true);
    load();
    return;
  }
  try { state.session = JSON.parse(sessionStorage.getItem("admin.session") || "null"); } catch { state.session = null; }
  if (saved && state.session) {
    $("who").textContent = state.session.user && state.session.user.email ? state.session.user.email : "";
    showApp(true);
    load();
  } else {
    showApp(false);
  }
})();

// ---- Sample data for ?demo (made up; used to check the page without signing in) ----

function demoData() {
  const shops = [
    { id: "s_demo0001", name: "サンプル麻辣湯 東京店", chain_id: "yangguofu", uses_chain_rule: true, prefecture: "東京都", city: "千代田区", address: "丸の内1-1-1", apple_place_id: "I0000000000000001", status: "open", verified_on: "2026-11-21", published: true },
    { id: "s_demo0002", name: "サンプル麻辣湯 横浜店", chain_id: "qibao", uses_chain_rule: false, prefecture: "神奈川県", city: "横浜市西区", address: "高島2-2-2", apple_place_id: null, status: "temporarily_closed", verified_on: "2026-11-21", published: false },
  ];
  const feedback = [
    { id: "00000000-0000-4000-8000-000000000001", shop_id: "s_demo0001", topic: "price_rule", message: "100g あたり 420 円に変わっていました（2026年11月）", source_url: "https://example.com/news", app_version: "1.0.0", iso_week: "2026-W47", review: "new" },
    { id: "00000000-0000-4000-8000-000000000002", shop_id: null, topic: "new_shop", message: "店名：麻辣湯 はなび ／ 住所：東京都中央区京橋3-1-1 <b>太字にならない</b>", source_url: "javascript:alert(1)", app_version: "1.0.0", iso_week: "2026-W47", review: "new" },
    { id: "00000000-0000-4000-8000-000000000003", shop_id: "s_demo0002", topic: "closed", message: "11月に行ったら閉店していました", source_url: null, app_version: "1.0.0", iso_week: "2026-W46", review: "checked" },
  ];
  const requests = [
    { upload_id: "a1", name: "もち巾着", category: "soy", unit: "piece", grams_per_unit: 30, app_version: "1.0.0", iso_week: "2026-W47", review: "new" },
    { upload_id: "a2", name: "もち巾着", category: "soy", unit: "piece", grams_per_unit: 35, app_version: "1.0.0", iso_week: "2026-W46", review: "new" },
    { upload_id: "a3", name: "うずらの卵", category: "other", unit: "piece", grams_per_unit: 10, app_version: "1.0.0", iso_week: "2026-W46", review: "rejected" },
  ];
  const bowls = [];
  const weeks = ["2026-W44", "2026-W45", "2026-W46", "2026-W47"];
  for (let i = 0; i < 46; i += 1) {
    const estimated = 250 + (i * 37) % 200;
    const chain = ["yangguofu", "qibao", "lixiaoqi", null][i % 4];
    bowls.push({ upload_id: `b${i}`, chain_id: chain, estimated_grams_raw: estimated, actual_grams: Math.round(estimated * (0.75 + ((i * 13) % 60) / 100)),
      actual_yen: 900 + (i * 53) % 900, iso_week: weeks[Math.min(3, Math.floor(i / 9))], place_id: i % 3 === 0 ? "s_demo0001" : i % 5 === 0 ? "I0000000000000009" : null, app_version: "1.0.0" });
  }
  return { feedback, requests, bowls, shops, dataset: { version: 2, checked_on: "2026-11-21" } };
}
