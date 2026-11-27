"use strict";
// 店的菜单 (docs/ADMIN.md, ARCHITECTURE 15.9): a shop's own list or changes to the public list, items at a set price, and
// the soups, spice levels, arrangements and extras it offers, at its prices. Saved with admin_set_shop_menu; copied to the
// other branches of a brand with admin_copy_shop_menu (needs the migration 20261127110000_menus_and_set_prices.sql).
// The choices and ingredients come from the published ingredient library (catalog_documents 'ingredient_library').
// Loaded after shops.js and before app.js, whose helpers it uses when called.

const MENU_KINDS = { soup: "スープ（必选・一碗一种）", spice: "辛さ（必选・一碗一种）", arrangement: "アレンジ（可选・可多选）", extra: "追加（可选）" };
const menuForm = { shop: null };

async function loadLibrary() {
  if (state.library) return state.library;
  if (DEMO) return (state.library = demoLibrary());
  const rows = await api("catalog_documents?select=content&name=eq.ingredient_library");
  if (!rows.length) throw new Error("总食材库（ingredient_library）还没有发布，不能编辑菜单。");
  return (state.library = rows[0].content);
}

function brandOf(name) { return name.replace(/ [^ ]*店$/, ""); }

function choiceName(library, id) {
  const choice = library.choices.find((c) => c.id === id);
  return choice ? choice.nameJa : `（不认识：${id}）`;
}

function ingredientName(library, id) {
  const ingredient = library.ingredients.find((i) => i.id === id);
  return ingredient ? ingredient.nameJa : `（不认识：${id}）`;
}

// 「スープ＋春雨 ¥620・…」: what the shop list shows under a shop.
function menuSummary(menu, library) {
  if (!menu) return "";
  const parts = [menu.mode === "own" ? `只显示自己的清单（${(menu.items || []).length} 种）` : "公共清单"];
  if (menu.rule) parts.push(`称重：${ruleSummary(menu.rule)}`);
  if (menu.mode !== "own" && (menu.hidden || []).length) parts.push(`不显示：${menu.hidden.map((id) => library ? ingredientName(library, id) : id).join("・")}`);
  const fixed = (menu.items || []).filter((i) => i.fixed_yen != null);
  if (fixed.length) parts.push(`固定料金：${fixed.map((i) => `${library ? ingredientName(library, i.ingredient_id) : i.ingredient_id} ¥${i.fixed_yen}`).join("・")}`);
  if ((menu.options || []).length) parts.push(`选项 ${menu.options.length} 个`);
  return parts.join("　") + `（${menu.source === "partner" ? "店家提供" : "官网"}，${menu.as_of}）`;
}

// ---- The form ----

function menuOptionRows(library, menu) {
  const offered = new Map((menu && menu.options || []).map((o) => [o.choice_id, o]));
  return Object.entries(MENU_KINDS).flatMap(([kind, title]) => {
    const choices = library.choices.filter((c) => c.kind === kind);
    if (!choices.length) return [];
    return [el("h4", { text: title }), ...choices.map((choice) => {
      const option = offered.get(choice.id);
      const row = el("div", { class: "menu-option" });
      const on = el("input", { type: "checkbox", "data-choice": choice.id });
      on.checked = Boolean(option);
      const yen = el("input", { inputmode: "numeric", "data-yen": choice.id, value: option ? String(option.yen) : "", placeholder: "円" });
      const parts = [el("label", { class: "check" }, [on, ` ${choice.nameJa}`]), yen];
      if (kind === "soup" || kind === "spice") {
        const isDefault = el("input", { type: "radio", name: `menu-default-${kind}`, "data-default": choice.id });
        isDefault.checked = Boolean(option && option.default);
        parts.push(el("label", { class: "check" }, [isDefault, " 默认"]));
      }
      if (choice.noteJa) parts.push(el("span", { class: "hint", text: choice.noteJa }));
      row.append(...parts);
      return row;
    })];
  });
}

function menuItemRow(library, item) {
  const row = el("div", { class: "menu-item" });
  const select = el("select", { "data-item": "id" }, library.ingredients.map((i) =>
    el("option", { value: i.id, text: `${i.nameJa}（${i.id}）${i.inPublicList === false ? "・非公共" : ""}` })));
  select.value = item ? item.ingredient_id : library.ingredients[0].id;
  const nameJa = el("input", { "data-item": "name_ja", maxlength: "30", placeholder: "店里的叫法（不改就空着）", value: item && item.name_ja || "" });
  const nameZh = el("input", { "data-item": "name_zh", maxlength: "30", placeholder: "中文小字（不改就空着）", value: item && item.name_zh || "" });
  const fixed = el("input", { "data-item": "fixed_yen", inputmode: "numeric", placeholder: "固定料金（称重就空着）", value: item && item.fixed_yen != null ? String(item.fixed_yen) : "" });
  const remove = el("button", { type: "button", text: "删除" });
  remove.addEventListener("click", () => { row.remove(); updateMenuPreview(); });
  row.append(select, nameJa, nameZh, fixed, remove);
  // Rows added later are checked as they are typed in, like the rest of the form.
  for (const node of [select, nameJa, nameZh, fixed]) node.addEventListener("input", updateMenuPreview);
  return row;
}

async function openMenuForm(shop) {
  if (!state.canEditMenus) return notice("要先执行数据库迁移（20261127110000_menus_and_set_prices.sql）才能编辑菜单。");
  let library;
  try { library = await loadLibrary(); } catch (error) { return notice(error.message); }
  menuForm.shop = shop;
  const menu = shop.menu;
  const form = $("menu-form");
  const copies = state.shops.filter((s) => s.menu && s.id !== shop.id);
  const copySelect = el("select", { id: "mf-copy" }, [el("option", { value: "", text: "（不复制）" }),
    ...copies.map((s) => el("option", { value: s.id, text: `${s.name}：${menuSummary(s.menu, library)}` }))]);
  copySelect.addEventListener("change", () => {
    const from = state.shops.find((s) => s.id === copySelect.value);
    if (from) { menuForm.shop = { ...shop, menu: from.menu }; renderMenuFields(library, from.menu); }
  });
  fill(form, [
    el("h3", { text: `メニュー：${shop.name}` }),
    el("p", { class: "hint", text: "スープ・辛さ・アレンジ・追加是总食材库里的选项，这里勾选这家店有的并填金额（含税的处理跟称重料金一样）。七宝这类店：公共清单＋不显示汤里的春雨＋选项。合作店：只显示自己的清单。保存后 App 在一天内更新。" }),
    el("label", {}, ["从别的店复制菜单", copySelect]),
    el("div", { id: "mf-fields" }),
    el("p", { id: "mf-preview", class: "hint" }),
    el("p", { id: "mf-problems", class: "error" }),
    el("div", { class: "actions" }, [
      el("button", { id: "mf-save", class: "primary", text: "保存" }),
      el("button", { id: "mf-copy-brand", text: "同じブランドの店にコピー" }),
      el("button", { id: "mf-clear", text: "去掉菜单" }),
      el("button", { id: "mf-close", text: "关闭" }),
    ]),
  ]);
  renderMenuFields(library, menu);
  $("mf-save").addEventListener("click", () => saveMenu(library));
  $("mf-copy-brand").addEventListener("click", () => copyMenuToBrand());
  $("mf-clear").addEventListener("click", () => clearMenu());
  $("mf-close").addEventListener("click", () => { form.hidden = true; });
  form.hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderMenuFields(library, menu) {
  const mode = el("select", { id: "mf-mode" }, [el("option", { value: "public", text: "公共清单＋改动（七宝等）" }), el("option", { value: "own", text: "只显示自己的清单（合作店）" })]);
  mode.value = menu ? menu.mode : "public";
  const source = el("select", { id: "mf-source" }, [el("option", { value: "official", text: "店的官网" }), el("option", { value: "partner", text: "店家提供（合作店）" })]);
  source.value = menu ? menu.source : "official";
  const asOf = el("input", { id: "mf-as-of", type: "date", value: menu ? menu.as_of : new Date().toISOString().slice(0, 10) });
  const ruleOn = el("input", { id: "mf-rule-on", type: "checkbox" });
  ruleOn.checked = Boolean(menu && menu.rule);
  const per100 = el("input", { id: "mf-per100", inputmode: "decimal", placeholder: "例：310", value: menu && menu.rule ? String(Math.round(menu.rule.yen_per_gram * 10000) / 100) : "" });
  const tax = el("select", { id: "mf-tax" }, [el("option", { value: "included", text: "税込" }), el("option", { value: "excluded10", text: "税抜（10%）" }), el("option", { value: "excluded8", text: "税抜（8%）" })]);
  tax.value = !menu || !menu.rule || menu.rule.tax_included ? "included" : menu.rule.tax_rate_percent === 8 ? "excluded8" : "excluded10";
  const hiddenIDs = new Set(menu && menu.hidden || []);
  const hidden = el("div", { id: "mf-hidden", class: "menu-hidden" }, library.ingredients.filter((i) => i.inPublicList !== false).map((i) => {
    const box = el("input", { type: "checkbox", "data-hidden": i.id });
    box.checked = hiddenIDs.has(i.id);
    return el("label", { class: "check" }, [box, ` ${i.nameJa}`]);
  }));
  const items = el("div", { id: "mf-items" }, (menu && menu.items || []).map((item) => menuItemRow(library, item)));
  const addItem = el("button", { type: "button", text: "＋ 食材" });
  addItem.addEventListener("click", () => { items.append(menuItemRow(library, null)); updateMenuPreview(); });
  fill($("mf-fields"), [
    el("div", { class: "grid" }, [el("label", {}, ["模式", mode]), el("label", {}, ["来源", source]), el("label", {}, ["确认日（App 显示「○年○月時点」）", asOf])]),
    el("label", { class: "check" }, [ruleOn, " 称重部分用这里的料金（不勾：用这家店登记的料金。七宝：100g ¥310，店的料金里的 620 円是给测试版的）"]),
    el("div", { class: "grid" }, [el("label", {}, ["100g あたり（円）", per100]), el("label", {}, ["税", tax])]),
    el("h4", { text: "选项" }), ...menuOptionRows(library, menu),
    el("h4", { text: "公共清单里这家店不显示的食材（只在「公共清单＋改动」时有效）" }), hidden,
    el("h4", { text: "清单（合作店：全部食材；公共清单＋改动：追加的、改叫法的、固定料金的）" }), items, addItem,
  ]);
  for (const node of $("mf-fields").querySelectorAll("input, select")) node.addEventListener("input", updateMenuPreview);
  updateMenuPreview();
}

// The menu the form describes, and what is wrong with it.
function readMenuForm(library) {
  const problems = [];
  const menu = { mode: field("mf-mode"), source: field("mf-source"), as_of: field("mf-as-of") };
  if (!/^20\d\d-[01]\d-[0-3]\d$/.test(menu.as_of)) problems.push("确认日要填。");
  if ($("mf-rule-on").checked) {
    const per100 = number(field("mf-per100"), true);
    if (per100 == null || per100 <= 0 || per100 > 5000) problems.push("100g あたり 要填 1〜5,000 的数字。");
    else {
      const tax = field("mf-tax");
      menu.rule = { kind: "perGram", base_yen: 0, included_grams: 0, yen_per_gram: Math.round(per100 * 100) / 10000, tax_included: tax === "included" };
      if (tax !== "included") menu.rule.tax_rate_percent = tax === "excluded8" ? 8 : 10;
    }
  }
  menu.options = [];
  for (const box of $("mf-fields").querySelectorAll("input[data-choice]")) {
    if (!box.checked) continue;
    const id = box.getAttribute("data-choice");
    const yen = number($("mf-fields").querySelector(`input[data-yen="${id}"]`).value);
    if (yen == null || yen < 0 || yen > 10000) { problems.push(`「${choiceName(library, id)}」的金额要填 0〜10,000。`); continue; }
    const option = { choice_id: id, yen };
    const isDefault = $("mf-fields").querySelector(`input[data-default="${id}"]`);
    if (isDefault && isDefault.checked) option.default = true;
    menu.options.push(option);
  }
  for (const kind of ["soup", "spice"]) {
    const ofKind = menu.options.filter((o) => (library.choices.find((c) => c.id === o.choice_id) || {}).kind === kind);
    const defaults = ofKind.filter((o) => o.default);
    if (ofKind.length && defaults.length === 0) problems.push(`${MENU_KINDS[kind]}：请选一个默认。`);
  }
  menu.hidden = menu.mode === "public" ? [...$("mf-fields").querySelectorAll("input[data-hidden]")].filter((b) => b.checked).map((b) => b.getAttribute("data-hidden")) : [];
  menu.items = [];
  const seen = new Set();
  for (const row of $("mf-items").children) {
    const id = row.querySelector('[data-item="id"]').value;
    if (seen.has(id)) { problems.push(`「${ingredientName(library, id)}」重复了。`); continue; }
    seen.add(id);
    const item = { ingredient_id: id };
    const nameJa = row.querySelector('[data-item="name_ja"]').value.trim();
    const nameZh = row.querySelector('[data-item="name_zh"]').value.trim();
    const fixed = row.querySelector('[data-item="fixed_yen"]').value.trim();
    if (nameJa) item.name_ja = nameJa.slice(0, 30);
    if (nameZh) item.name_zh = nameZh.slice(0, 30);
    if (fixed) {
      const yen = number(fixed);
      if (yen == null || yen < 1 || yen > 10000) problems.push(`「${ingredientName(library, id)}」的固定料金要填 1〜10,000。`);
      else item.fixed_yen = yen;
    }
    menu.items.push(item);
  }
  if (menu.mode === "own" && menu.items.length === 0) problems.push("「只显示自己的清单」至少要有一种食材。");
  if (!menu.rule) delete menu.rule;
  for (const key of ["items", "hidden", "options"]) if (!menu[key].length) delete menu[key];
  return { menu, problems };
}

function updateMenuPreview() {
  const library = state.library;
  if (!library || !$("mf-fields")) return;
  const { menu, problems } = readMenuForm(library);
  const defaults = (menu.options || []).filter((o) => o.default);
  const shopRule = menuForm.shop && menuForm.shop.rule;
  const rule = menu.rule || shopRule;
  const fixed = defaults.reduce((sum, o) => sum + o.yen, 0);
  $("mf-preview").textContent = menuSummary(menu, library)
    + (rule ? `　空碗：¥${priceYen({ ...rule, base_yen: (rule.base_yen || 0) + fixed }, 0)}（${defaults.map((o) => choiceName(library, o.choice_id)).join("・") || "没有选项"}）` : "");
  $("mf-problems").textContent = problems.join(" ");
  $("mf-save").disabled = problems.length > 0;
}

async function saveMenu(library) {
  const { menu, problems } = readMenuForm(library);
  if (problems.length) return;
  const shop = state.shops.find((s) => s.id === menuForm.shop.id);
  if (!confirm(`保存「${shop.name}」的菜单？App 在一天内更新。`)) return;
  try {
    if (!DEMO) await rpc("admin_set_shop_menu", { shop_id: shop.id, new_menu: menu });
    shop.menu = menu;
    if (shop.published) bumpVersion();
    notice(`已保存：${shop.name} 的菜单。`);
    render();
  } catch (error) { notice(error.message); }
}

async function clearMenu() {
  const shop = state.shops.find((s) => s.id === menuForm.shop.id);
  if (!shop.menu || !confirm(`去掉「${shop.name}」的菜单？App 里这家店不再有スープ・辛さ的选择。`)) return;
  try {
    if (!DEMO) await rpc("admin_set_shop_menu", { shop_id: shop.id, new_menu: null });
    shop.menu = null;
    if (shop.published) bumpVersion();
    $("menu-form").hidden = true;
    render();
  } catch (error) { notice(error.message); }
}

// The saved menu to every other shop of the same brand (「七宝麻辣湯 ○○店」 → 「七宝麻辣湯」).
async function copyMenuToBrand() {
  const shop = state.shops.find((s) => s.id === menuForm.shop.id);
  if (!shop.menu) return notice("先保存这家店的菜单，再复制。");
  const brand = brandOf(shop.name);
  const targets = state.shops.filter((s) => s.id !== shop.id && brandOf(s.name) === brand && s.status !== "closed");
  if (!targets.length) return notice(`没有别的「${brand}」的店。`);
  const changed = targets.filter((s) => JSON.stringify(s.menu) !== JSON.stringify(shop.menu));
  if (!changed.length) return notice(`「${brand}」的 ${targets.length} 家店已经是同样的菜单。`);
  if (!confirm(`把「${shop.name}」的菜单复制到下面 ${changed.length} 家店？（各店之后可以单独改）\n\n${changed.map((s) => s.name).join("\n")}`)) return;
  try {
    if (!DEMO) await rpc("admin_copy_shop_menu", { from_id: shop.id, to_ids: changed.map((s) => s.id) });
    for (const s of changed) s.menu = JSON.parse(JSON.stringify(shop.menu));
    if (changed.some((s) => s.published)) bumpVersion();
    notice(`已复制到 ${changed.length} 家店。`);
    render();
  } catch (error) { notice(error.message); }
}

// Buttons and the line under a shop in the list.
function menuActions(shop) {
  if (!state.canEditMenus) return [];
  const button = el("button", { text: shop.menu ? "メニューを編集" : "メニューを作る" });
  button.addEventListener("click", () => openMenuForm(shop));
  return [button];
}

function menuLine(shop) {
  return shop.menu ? [el("p", { class: "hint", text: `メニュー：${menuSummary(shop.menu, state.library)}` })] : [];
}

// ---- Sample data for ?demo ----

function demoLibrary() {
  return {
    formatVersion: 2, catalogVersion: "demo",
    ingredients: [
      { id: "hakusai", nameJa: "白菜" }, { id: "harusame", nameJa: "春雨" }, { id: "kuanfen", nameJa: "幅広春雨" }, { id: "beefball", nameJa: "牛肉団子" },
      { id: "cheese", nameJa: "チーズ", inPublicList: false },
    ],
    choices: [
      { id: "qibao_soup", number: 1, kind: "soup", nameJa: "スープ＋春雨", noteJa: "基本のセット" },
      { id: "qibao_soup_more_harusame", number: 2, kind: "soup", nameJa: "春雨大盛り" },
      { id: "qibao_spice_1", number: 6, kind: "spice", nameJa: "1番 ピリ辛", heat: 2 },
      { id: "qibao_spice_4", number: 9, kind: "spice", nameJa: "4番 激辛", heat: 5 },
      { id: "qibao_tomyum", number: 13, kind: "arrangement", nameJa: "トムヤム" },
      { id: "qibao_kaedama", number: 19, kind: "extra", nameJa: "替玉" },
    ],
  };
}

if (typeof module !== "undefined") module.exports = { menuSummary, brandOf };
