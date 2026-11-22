"use strict";
// 店铺清单 and 「お店を追加」 (docs/ADMIN.md): adding a shop from a report or by hand, publishing drafts, changing a
// shop's status. Every change goes through one of the database's admin_* functions, which check the signed-in
// account again; this file only prepares what to send. Loaded before app.js, whose helpers it uses when called.

const STATUS = { open: "营业", temporarily_closed: "休业", closed: "闭店" };
const KINDS = { perGram: "重さだけ", basePlusPerGram: "基本料金＋重さ", firstWeightPlusPerGram: "最初の◯gまで定額＋以降は重さ" };
const PRECISIONS = { building: "号（建筑）", block: "街区", town: "町（只到町，较粗）" };
const SHOP_COLUMNS = "id,name,chain_id,uses_chain_rule,prefecture,city,address,latitude,longitude,location_precision,apple_place_id,status,verified_on,published";
const SHOP_ADMIN_COLUMNS = SHOP_COLUMNS + ",rule,rule_checked_on,source_url,added_by,feedback_id,origin";
const ORIGINS = { first_hand: "一手来源", listing: "店家登载的页面", user_report: "用户投稿", visit: "自己去过" };
// Kinds of source that must come with their link.
const LINKED_ORIGINS = ["first_hand", "listing"];

// ---- Prices, the same way the app counts them (PricingRule.priceYen) ----

function priceYen(rule, grams) {
  const chargeable = Math.max(0, grams - rule.included_grams);
  let yen = Math.floor(rule.base_yen + chargeable * rule.yen_per_gram + 1e-9);
  if (!rule.tax_included) yen += Math.floor((yen * (rule.tax_rate_percent ?? 10)) / 100);
  if (rule.minimum_yen != null) yen = Math.max(yen, rule.minimum_yen);
  return yen;
}

function ruleSummary(rule) {
  if (!rule) return "";
  const per100 = `100gあたり¥${Math.round(rule.yen_per_gram * 10000) / 100}`;
  const head = rule.kind === "perGram" ? per100
    : rule.kind === "basePlusPerGram" ? `基本料金 ¥${rule.base_yen} ＋ ${per100}`
    : `最初の${rule.included_grams}gまで ¥${rule.base_yen}、以降${per100}`;
  const more = [rule.tax_included ? "税込" : `税抜（${rule.tax_rate_percent ?? 10}%）`];
  if (rule.minimum_yen != null) more.push(`最低料金 ¥${rule.minimum_yen}`);
  if (rule.bonus_grams != null) more.push(rule.bonus_threshold_yen > 0 ? `¥${rule.bonus_threshold_yen}以上で麺${rule.bonus_grams}g` : `麺${rule.bonus_grams}gサービス（条件なし）`);
  return [head, ...more].join("・");
}

// Full-width digits, commas and units are accepted, as in the app.
function number(text, decimal = false) {
  const folded = String(text ?? "").normalize("NFKC").replace(/[\s,¥円g]/g, "");
  if (!(decimal ? /^\d+(\.\d{1,2})?$/ : /^\d+$/).test(folded)) return null;
  return Number(folded);
}

// The rule typed into the form, or the list of what is wrong with it. Ranges as in the app (RuleDraft).
function readRule(form) {
  const problems = [];
  const kind = form.kind;
  const within = (value, low, high) => value != null && value >= low && value <= high;
  const per100 = number(form.per100, true);
  if (!within(per100, 1, 5000)) problems.push("100g 的价格要在 1〜5,000 円之间");
  const base = kind === "perGram" ? 0 : number(form.base);
  if (kind !== "perGram" && !within(base, 0, 5000)) problems.push("基本料金（定额）要在 0〜5,000 円之间");
  const included = kind === "firstWeightPlusPerGram" ? number(form.included) : 0;
  if (kind === "firstWeightPlusPerGram" && !within(included, 1, 2000)) problems.push("定额包含的重量要在 1〜2,000 g 之间");
  const minimum = form.minimum.trim() === "" ? null : number(form.minimum);
  if (form.minimum.trim() !== "" && !within(minimum, 1, 10000)) problems.push("最低料金要在 1〜10,000 円之间");
  // 「条件」 decides: empty = no free noodles, 0 = with every bowl. The amount starts at 80 g.
  let bonus = null;
  if (form.bonusThreshold.trim() !== "") {
    const threshold = number(form.bonusThreshold);
    const grams = form.bonusGrams.trim() === "" ? 80 : number(form.bonusGrams);
    if (!within(threshold, 0, 30000) || !within(grams, 1, 1000)) problems.push("送面：条件 0〜30,000 円，面量 1〜1,000 g");
    else bonus = { threshold, grams };
  }
  if (problems.length) return { problems };
  const rule = { kind, base_yen: base, included_grams: included, yen_per_gram: Math.round(per100 * 100) / 10000, tax_included: form.tax === "included" };
  if (!rule.tax_included) rule.tax_rate_percent = form.tax === "excluded8" ? 8 : 10;
  if (minimum != null) rule.minimum_yen = minimum;
  if (bonus) { rule.bonus_threshold_yen = bonus.threshold; rule.bonus_grams = bonus.grams; }
  return { rule, problems };
}

// ---- What a report says: 「店名：… ／ 住所（場所）：… ／ 料金：… ／ メモ：…」 ----

function parseReport(message) {
  const parts = {};
  for (const piece of String(message || "").split(" ／ ")) {
    const m = piece.match(/^(店名|住所|場所|料金|メモ)：(.*)$/);
    if (m) parts[m[1]] = m[2].trim();
  }
  return { name: parts["店名"] || "", place: parts["住所"] || parts["場所"] || "", prices: parts["料金"] || "", note: parts["メモ"] || "" };
}

// 「東京都新宿区百人町1-7-3」 → its prefecture and the rest (the city is cut off when the position is looked up).
function splitPrefecture(place) {
  const text = Geocode.normalize(place === "未入力" ? "" : place);
  const prefecture = Geocode.PREFECTURES.find((p) => text.startsWith(p)) || "";
  return { prefecture, rest: prefecture ? text.slice(prefecture.length) : text };
}

// The permanent ID: 「s_」 and the first 8 hex digits of SHA-1(name + prefecture + city + address), as in the repository.
async function shopID(name, prefecture, city, address) {
  const bytes = new TextEncoder().encode(name + prefecture + city + address);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return "s_" + [...digest].slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function rpc(name, body) {
  return api(`rpc/${name}`, { method: "POST", body: JSON.stringify(body) });
}

// ---- The form ----

const shopForm = { feedback: null };

function field(id) { return $(id).value; }

function formValues() {
  return {
    kind: field("sf-kind"), per100: field("sf-per100"), base: field("sf-base"), included: field("sf-included"), tax: field("sf-tax"),
    minimum: field("sf-minimum"), bonusThreshold: field("sf-bonus-threshold"), bonusGrams: field("sf-bonus-grams"),
  };
}

function openShopForm(feedback) {
  if (!state.canEditShops) return notice("要先执行数据库迁移（20261122180000_admin_shops.sql）才能追加店铺。");
  shopForm.feedback = feedback || null;
  const report = feedback ? parseReport(feedback.message) : { name: "", place: "", prices: "", note: "" };
  const place = splitPrefecture(report.place);
  $("sf-origin").textContent = feedback ? `来自投稿：${feedback.message}` : "";
  $("sf-origin").hidden = !feedback;
  $("sf-name").value = report.name;
  $("sf-chain").value = "";
  $("sf-uses-chain").checked = true;
  $("sf-pref").value = place.prefecture || "東京都";
  $("sf-city").value = "";
  $("sf-address").value = place.rest;
  for (const id of ["sf-lat", "sf-lon", "sf-base", "sf-included", "sf-per100", "sf-minimum", "sf-bonus-threshold"]) $(id).value = "";
  $("sf-precision").value = "block";
  $("sf-located").textContent = "";
  showCandidates([]);
  $("sf-source").value = feedback && feedback.source_url ? feedback.source_url : "";
  // From a report: the facts come from a user, unless a first-hand source is filled in.
  $("sf-origin-kind").value = feedback ? "user_report" : "first_hand";
  // The prices the person entered in the app, when the report carries them.
  const rule = feedback && feedback.rule;
  // Prices a user reported are filled in below but not registered unless the owner ticks the box: nobody checked them.
  $("sf-rule-on").checked = false;
  $("sf-kind").value = rule ? rule.kind : "perGram";
  $("sf-tax").value = !rule || rule.tax_included ? "included" : rule.tax_rate_percent === 8 ? "excluded8" : "excluded10";
  $("sf-bonus-grams").value = "80";
  if (rule) {
    $("sf-per100").value = String(Math.round(rule.yen_per_gram * 10000) / 100);
    $("sf-base").value = rule.kind === "perGram" ? "" : String(rule.base_yen);
    $("sf-included").value = rule.kind === "firstWeightPlusPerGram" ? String(rule.included_grams) : "";
    $("sf-minimum").value = rule.minimum_yen != null ? String(rule.minimum_yen) : "";
    if (rule.bonus_grams != null) { $("sf-bonus-threshold").value = String(rule.bonus_threshold_yen); $("sf-bonus-grams").value = String(rule.bonus_grams); }
  }
  $("sf-reported-prices").textContent = report.prices ? `投稿里写的料金：${report.prices}` : "";
  $("shop-form").hidden = false;
  updateShopForm();
  $("shop-form").scrollIntoView({ behavior: "smooth", block: "start" });
  $("sf-name").focus();
}

function closeShopForm() {
  $("shop-form").hidden = true;
  shopForm.feedback = null;
}

// Shows the fields the chosen pricing needs, the example prices and what still stops saving.
function updateShopForm() {
  const withRule = $("sf-rule-on").checked;
  $("sf-rule").hidden = !withRule;
  const kind = field("sf-kind");
  $("sf-base-row").hidden = kind === "perGram";
  $("sf-included-row").hidden = kind !== "firstWeightPlusPerGram";
  const problems = [];
  if (!field("sf-name").trim()) problems.push("店名");
  if (!field("sf-city").trim() || !field("sf-address").trim()) problems.push("市区町村和地址");
  const lat = Number(field("sf-lat")), lon = Number(field("sf-lon"));
  if (!(field("sf-lat") && field("sf-lon") && lat >= 20 && lat <= 46 && lon >= 122 && lon <= 154)) problems.push("位置（点「位置を調べる」）");
  const source = field("sf-source").trim();
  const needsLink = LINKED_ORIGINS.includes(field("sf-origin-kind"));
  if (needsLink ? !/^https:\/\/\S+$/.test(source) : source !== "" && !/^https:\/\/\S+$/.test(source)) {
    problems.push(needsLink ? "出典（https 开头的网址）" : "出典（要填的话以 https 开头）");
  }
  let preview = "";
  if (withRule) {
    const read = readRule(formValues());
    problems.push(...read.problems);
    if (read.rule) preview = `${ruleSummary(read.rule)}　例：${[200, 300, 400].map((g) => `${g}g ¥${priceYen(read.rule, g)}`).join("、")}`;
  }
  $("sf-preview").textContent = preview;
  $("sf-problems").textContent = problems.length ? `还需要：${problems.join("；")}` : "";
  $("sf-save").disabled = problems.length > 0;
}

// 地理院地図 at a point (zoom 18), to see where a point is. Opening it sends nothing but the coordinates in the link.
function mapLink(point) {
  const link = document.createElement("a");
  link.href = `https://maps.gsi.go.jp/#18/${point.latitude.toFixed(6)}/${point.longitude.toFixed(6)}/`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "地理院地図で見る";
  return link;
}

function setLocation(point) {
  $("sf-lat").value = point.latitude.toFixed(6);
  $("sf-lon").value = point.longitude.toFixed(6);
}

// The points 「位置を調べる」 found. One: a link to look at it. Several (a block with more than one point in the
// data): one has to be chosen, because the data cannot say at which the shop stands.
function showCandidates(points) {
  const box = $("sf-candidates");
  box.replaceChildren();
  box.hidden = points.length === 0;
  points.forEach((point, index) => {
    const row = document.createElement("label");
    row.className = "check";
    if (points.length > 1) {
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "sf-candidate";
      radio.checked = index === 0;
      radio.addEventListener("change", () => { setLocation(point); updateShopForm(); });
      row.append(radio);
    }
    const label = points.length > 1 ? (index === 0 ? "候选 1（数据里标的代表点）" : `候选 ${index + 1}`) : "找到的位置";
    row.append(` ${label}：${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}　`, mapLink(point));
    box.append(row);
  });
}

async function locateShop() {
  const button = $("sf-locate");
  button.disabled = true;
  $("sf-located").textContent = "查找中…";
  showCandidates([]);
  try {
    const found = await Geocode.geocode(field("sf-pref") + field("sf-city").trim() + field("sf-address").trim());
    if (!found) $("sf-located").textContent = "没有找到。检查市区町村和地址的写法（例：百人町1-7-3），或手动填经纬度。";
    else {
      setLocation(found);
      $("sf-precision").value = found.precision;
      const points = found.candidates.length > 0 ? found.candidates : [found];
      $("sf-located").textContent = `找到：${found.matched}（精度：${PRECISIONS[found.precision]}）`
        + (points.length > 1 ? `。这个街区在数据里有 ${points.length} 个点，数据分不出店在哪一个：请打开地图对照，选离店最近的。` : "");
      showCandidates(points);
    }
  } catch (error) {
    $("sf-located").textContent = "位置数据读取失败（isj/ 目录是否已部署？）。可以手动填经纬度。";
  }
  button.disabled = false;
  updateShopForm();
}

async function saveShop() {
  const name = field("sf-name").trim(), prefecture = field("sf-pref"), city = field("sf-city").trim(), address = field("sf-address").trim();
  const read = $("sf-rule-on").checked ? readRule(formValues()) : { rule: null };
  const shop = {
    id: await shopID(name, prefecture, city, address), name, chain_id: field("sf-chain"), uses_chain_rule: $("sf-uses-chain").checked,
    prefecture, city, address, latitude: Number(field("sf-lat")), longitude: Number(field("sf-lon")),
    location_precision: field("sf-precision"), source_url: field("sf-source").trim(), origin: field("sf-origin-kind"),
    rule: read.rule || null,
    feedback_id: shopForm.feedback ? shopForm.feedback.id : "",
  };
  if (state.shops.some((s) => s.id === shop.id)) return notice("清单里已经有这家店（店名和地址完全相同）。");
  $("sf-save").disabled = true;
  try {
    if (!DEMO) await rpc("admin_add_shop", { shop });
    const today = new Date().toISOString().slice(0, 10);
    state.shops.push({ ...shop, chain_id: shop.chain_id || null, apple_place_id: null, status: "open", verified_on: today, published: false,
                       rule_checked_on: shop.rule ? today : null, added_by: "admin", feedback_id: shop.feedback_id || null });
    if (shopForm.feedback) shopForm.feedback.review = "checked";
    closeShopForm();
    notice(`已保存为草稿：${name}。在下面的清单里确认后点「公開」。`);
    render();
  } catch (error) {
    notice(`保存失败：${error.message}`);
    $("sf-save").disabled = false;
  }
}

// ---- Actions on the list ----

async function runShopAction(button, action, done) {
  button.disabled = true;
  try {
    await action();
    done();
    render();
  } catch (error) {
    notice(error.message);
    button.disabled = false;
  }
}

function actionButton(label, kind, action, done, confirmText) {
  const button = el("button", { text: label, class: kind });
  button.addEventListener("click", () => {
    if (confirmText && !confirm(confirmText)) return;
    runShopAction(button, DEMO ? async () => {} : action, done);
  });
  return button;
}

function bumpVersion() {
  if (state.dataset) { state.dataset.version += 1; state.dataset.checked_on = new Date().toISOString().slice(0, 10); }
}

function shopActions(shop) {
  if (!state.canEditShops) return [];
  if (!shop.published) {
    const buttons = [actionButton("公開", "primary", () => rpc("admin_publish_shops", { shop_ids: [shop.id] }),
      () => { shop.published = true; bumpVersion(); notice(`已公开：${shop.name}。App 会在一天内更新。`); },
      `公开「${shop.name}」？公开后所有用户的 App 都会显示这家店。`)];
    if (shop.added_by === "admin") {
      buttons.push(actionButton("删除草稿", "", () => rpc("admin_delete_draft", { shop_id: shop.id }),
        () => { state.shops = state.shops.filter((s) => s.id !== shop.id); }, `删除草稿「${shop.name}」？`));
    }
    return buttons;
  }
  return Object.entries(STATUS).filter(([value]) => value !== shop.status).map(([value, label]) =>
    actionButton(`改为${label}`, "", () => rpc("admin_set_shop_status", { shop_id: shop.id, new_status: value }),
      () => { shop.status = value; bumpVersion(); }, `把「${shop.name}」改为${label}？所有用户的 App 都会更新。`));
}

// Buttons under a report: add the shop it tells about, or mark the listed shop it is about as closed.
function feedbackShopActions(row) {
  if (!state.canEditShops) return [];
  if (row.topic === "new_shop") {
    const button = el("button", { text: "このお店を追加", class: "primary" });
    button.addEventListener("click", () => { selectTab("shops"); openShopForm(row); });
    return [button];
  }
  const shop = row.shop_id && state.shops.find((s) => s.id === row.shop_id);
  if (shop && shop.published && (row.topic === "closed" || row.topic === "hours")) {
    return [["closed", "閉店にする"], ["temporarily_closed", "休業にする"]].filter(([value]) => value !== shop.status).map(([value, label]) =>
      actionButton(label, "", () => rpc("admin_set_shop_status", { shop_id: shop.id, new_status: value }),
        () => { shop.status = value; bumpVersion(); row.review = "checked"; if (!DEMO) markFeedback(row, "checked"); },
        `把「${shop.name}」${label === "閉店にする" ? "改为闭店" : "改为休业"}？请先对照一手来源确认。`));
  }
  return [];
}

function renderShops() {
  const query = $("shops-search").value.trim().toLowerCase();
  const rows = state.shops.filter((s) => !query || [s.id, s.name, s.prefecture, s.city, s.address].join(" ").toLowerCase().includes(query));
  const published = state.shops.filter((s) => s.published).length;
  const drafts = state.shops.length - published;
  $("shops-summary").textContent = (state.dataset ? `版本 ${state.dataset.version}（${state.dataset.checked_on}）・` : "")
    + `共 ${state.shops.length} 家，已公开 ${published} 家${drafts ? `，草稿 ${drafts} 家` : ""}，有 Apple Place ID ${state.shops.filter((s) => s.apple_place_id).length} 家。`
    + (state.canEditShops ? "在这里追加的店会在定期维护时同步回仓库的 shops.csv，并补上 Apple Place ID。" : "只读：执行数据库迁移后可以在这里追加店铺。");
  $("shops-add").hidden = !state.canEditShops;
  // Drafts first: they are what is waiting for a decision.
  const ordered = [...rows].sort((a, b) => Number(a.published) - Number(b.published) || a.id.localeCompare(b.id));
  fill($("shops-list"), ordered.map((s) => el("div", { class: s.published ? "item shop" : "item shop draft" }, [
    el("div", { class: "meta" }, [
      el("b", { text: s.name }),
      el("span", { class: s.published ? "tag" : "tag new", text: s.published ? "已公开" : "草稿" }),
      el("span", { class: "tag", text: STATUS[s.status] || s.status }),
      // Where the facts come from, when it is not a first-hand source: these are the ones to check first.
      ...(s.origin && s.origin !== "first_hand" ? [el("span", { class: "tag", text: ORIGINS[s.origin] || s.origin })] : []),
      el("span", { text: (CHAINS[s.chain_id] || s.chain_id || "单店") + (s.chain_id && !s.uses_chain_rule ? "（规则不同）" : "") }),
      el("span", { text: `确认 ${s.verified_on}` }),
      el("span", { text: s.id }),
    ]),
    el("p", { class: "message", text: `${s.prefecture}${s.city}${s.address}` + (s.apple_place_id ? "" : "　（无 Apple Place ID）") }),
    ...(s.rule ? [el("p", { class: "hint", text: `这家店的料金：${ruleSummary(s.rule)}（${s.rule_checked_on}）` })] : []),
    ...(safeLink(s.source_url) ? [safeLink(s.source_url)] : []),
    el("div", { class: "actions" }, shopActions(s)),
  ])));
}

if (typeof module !== "undefined") module.exports = { priceYen, ruleSummary, readRule, parseReport, number };
