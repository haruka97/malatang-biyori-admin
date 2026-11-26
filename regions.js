// 地区分布: where the app is used, by prefecture (docs/ADMIN.md). Counts what is already on the server by the
// prefecture of the shop — anonymous bowls with their shop, and the favourites and ratings of signed-in people.
// "Where people eat", not where they live: no location is collected. Loaded before app.js; uses its helpers only
// inside functions.

// A schematic map: one tile for each prefecture, [column, row], roughly where it lies.
const REGION_TILES = {
  "北海道": [12, 0], "青森県": [12, 1], "秋田県": [11, 2], "岩手県": [12, 2], "山形県": [11, 3], "宮城県": [12, 3],
  "石川県": [8, 4], "富山県": [9, 4], "新潟県": [10, 4], "福島県": [11, 4],
  "福井県": [8, 5], "岐阜県": [9, 5], "長野県": [10, 5], "群馬県": [11, 5], "栃木県": [12, 5],
  "佐賀県": [0, 6], "福岡県": [1, 6], "山口県": [2, 6], "島根県": [3, 6], "鳥取県": [4, 6], "兵庫県": [5, 6],
  "京都府": [6, 6], "滋賀県": [7, 6], "山梨県": [10, 6], "埼玉県": [11, 6], "茨城県": [12, 6],
  "長崎県": [0, 7], "大分県": [1, 7], "広島県": [3, 7], "岡山県": [4, 7], "大阪府": [6, 7], "奈良県": [7, 7],
  "三重県": [8, 7], "愛知県": [9, 7], "静岡県": [10, 7], "東京都": [11, 7], "千葉県": [12, 7],
  "熊本県": [0, 8], "宮崎県": [1, 8], "愛媛県": [3, 8], "香川県": [4, 8], "和歌山県": [6, 8], "神奈川県": [11, 8],
  "鹿児島県": [0, 9], "高知県": [3, 9], "徳島県": [4, 9], "沖縄県": [0, 10],
};

const REGION_METRICS = [
  { key: "bowls", label: "记录的碗" }, { key: "people", label: "登录用户（人）" },
  { key: "favorites", label: "收藏" }, { key: "ratings", label: "评价" }, { key: "shops", label: "清单里的店" },
];

async function loadRegions() {
  if (DEMO) {
    Object.assign(state, { regions: demoRegions(), canSeeRegions: true });
    return;
  }
  try {
    Object.assign(state, { regions: await rpc("admin_region_summary", {}), canSeeRegions: true });
  } catch (error) {
    // Before migration 20261126170000 the function does not exist.
    Object.assign(state, { regions: [], canSeeRegions: false });
  }
}

function renderRegions() {
  if (!$("regions")) return;
  if (!state.canSeeRegions) {
    fill($("regions-summary"), []);
    fill($("regions-map"), el("p", { class: "empty", text: "数据库里还没有这一页用的函数（迁移 20261126170000 未执行）。" }));
    fill($("regions-table"), []);
    return;
  }
  const rows = state.regions || [];
  const metric = REGION_METRICS.find((m) => m.key === $("regions-metric").value) || REGION_METRICS[0];
  const placed = rows.filter((row) => row.prefecture);
  const unplaced = rows.find((row) => !row.prefecture) || { bowls: 0, favorites: 0, ratings: 0, people: 0, shops: 0 };
  const sum = (key) => placed.reduce((total, row) => total + (row[key] || 0), 0);

  fill($("regions-summary"), [
    ["有记录的都道府县", placed.filter((row) => row.bowls > 0).length],
    ["记录的碗（能对上地区）", sum("bowls")],
    ["对不上地区的碗", unplaced.bowls],
    ["收藏", sum("favorites")],
    ["评价", sum("ratings")],
  ].map(([label, value]) => el("div", { class: "card" }, [el("b", { text: String(value) }), el("span", { text: label })])));

  const most = Math.max(0, ...placed.map((row) => row[metric.key] || 0));
  const byName = new Map(placed.map((row) => [row.prefecture, row]));
  fill($("regions-map"), el("div", { class: "tilemap" }, Object.entries(REGION_TILES).map(([name, [column, line]]) => {
    const value = (byName.get(name) || {})[metric.key] || 0;
    // Six steps: none, then five shades.
    const shade = value === 0 || most === 0 ? 0 : Math.max(1, Math.ceil((value / most) * 5));
    return el("div", { class: `tile tc${column} tr${line} ts${shade}`, title: `${name}：${metric.label} ${value}` }, [
      el("span", { text: name.replace(/[都府県]$/, "") }), el("b", { text: String(value) }),
    ]);
  })));

  const sorted = [...placed].sort((a, b) => (b[metric.key] || 0) - (a[metric.key] || 0) || a.prefecture.localeCompare(b.prefecture, "ja"));
  const shown = sorted.filter((row) => row.bowls || row.favorites || row.ratings || row.people || row.shops);
  const line = (name, row) => [name, row.bowls, row.people, row.favorites, row.ratings, row.shops];
  fill($("regions-table"), shown.length === 0 && !unplaced.bowls
    ? el("p", { class: "empty", text: "还没有数据。" })
    : table(
      [{ label: "都道府县" }, { label: "记录的碗", num: true }, { label: "登录用户（人）", num: true }, { label: "收藏", num: true },
        { label: "评价", num: true }, { label: "清单里的店", num: true }],
      [...shown.map((row) => line(row.prefecture, row)),
        ...(unplaced.bowls || unplaced.favorites || unplaced.ratings ? [line("不明（没选店，或店不在清单里）", { ...unplaced, shops: "" })] : [])]));
}

// ---- Sample data for ?demo (made up) ----

function demoRegions() {
  return [
    { prefecture: "東京都", shops: 310, bowls: 42, favorites: 18, ratings: 9, people: 7 },
    { prefecture: "神奈川県", shops: 61, bowls: 11, favorites: 4, ratings: 2, people: 3 },
    { prefecture: "大阪府", shops: 74, bowls: 8, favorites: 6, ratings: 1, people: 4 },
    { prefecture: "埼玉県", shops: 40, bowls: 5, favorites: 1, ratings: 0, people: 1 },
    { prefecture: "福岡県", shops: 22, bowls: 2, favorites: 0, ratings: 0, people: 0 },
    { prefecture: "北海道", shops: 12, bowls: 0, favorites: 0, ratings: 0, people: 0 },
    { prefecture: null, shops: 0, bowls: 6, favorites: 2, ratings: 0, people: 2 },
  ];
}
