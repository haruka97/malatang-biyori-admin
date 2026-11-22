"use strict";
// Address → coordinates for 「位置を調べる」, the same way as tools/geocode_isj.py and from the same data:
// 街区レベル位置参照情報（国土交通省, https://nlftp.mlit.go.jp/isj/ , PDL1.0), split by city into isj/*.json.gz by
// tools/build_isj_lookup.py. Nothing is sent anywhere: the files are read from this site.

const Geocode = (() => {
  const PREFECTURES = ["東京都", "神奈川県", "埼玉県", "千葉県"];
  const KANJI_DIGITS = "〇一二三四五六七八九";

  // 1 → 一, 10 → 十, 12 → 十二, 21 → 二十一 (the way 丁目 are written in the data).
  function kanjiNumber(n) {
    if (n < 10) return KANJI_DIGITS[n];
    const tens = Math.floor(n / 10), ones = n % 10;
    return (tens === 1 ? "" : KANJI_DIGITS[tens]) + "十" + (ones ? KANJI_DIGITS[ones] : "");
  }

  // 一 → 1, 十 → 10, 十二 → 12, 二十一 → 21.
  function kanjiValue(text) {
    if (!text.includes("十")) return KANJI_DIGITS.indexOf(text);
    const at = text.lastIndexOf("十");
    const tens = text.slice(0, at), ones = text.slice(at + 1);
    return (tens ? KANJI_DIGITS.indexOf(tens) : 1) * 10 + (ones ? KANJI_DIGITS.indexOf(ones) : 0);
  }

  function normalize(text) {
    return text.normalize("NFKC").replace(/[‐‑‒–—―−ｰ－]/g, "-").replace(/\s+/g, "");
  }

  // `towns`: {town: {block: [lat, lon]}} of one city; `rest`: the address after the city.
  function inCity(towns, rest) {
    let best = null;
    for (const town of Object.keys(towns)) {
      let base = town, chome = null;
      const m = town.match(/^(.+?)([一二三四五六七八九十]+)丁目$/);
      if (m) { base = m[1]; chome = m[2]; }
      if (!rest.startsWith(base)) continue;
      const tail = rest.slice(base.length);
      let block;
      if (chome !== null) {
        const t = tail.match(/^(\d+)(?:丁目|-)(\d+)?/);
        if (!t || kanjiNumber(Number(t[1])) !== chome) continue;
        block = t[2];
      } else {
        const t = tail.match(/^(\d+)/);
        block = t ? t[1] : undefined;
      }
      if (best === null || town.length > best.town.length) best = { town, block };
    }
    if (best === null) return null;
    const blocks = towns[best.town];
    if (best.block && blocks[best.block]) {
      const [lat, lon] = blocks[best.block];
      return { latitude: lat, longitude: lon, precision: "block", matched: best.town + best.block };
    }
    const points = Object.values(blocks);
    return {
      latitude: points.reduce((sum, p) => sum + p[0], 0) / points.length,
      longitude: points.reduce((sum, p) => sum + p[1], 0) / points.length,
      precision: "town", matched: best.town,
    };
  }

  // The prefecture, the city (the longest name the address starts with) and what follows it.
  function split(address, index) {
    const text = normalize(address).replace(/([一二三四五六七八九十]{1,3})丁目/g, (_, k) => `${kanjiValue(k)}丁目`);
    const prefecture = PREFECTURES.find((p) => text.startsWith(p));
    if (!prefecture || !index[prefecture]) return null;
    const after = text.slice(prefecture.length);
    const city = Object.keys(index[prefecture]).sort((a, b) => b.length - a.length).find((c) => after.startsWith(c));
    if (!city) return null;
    return { prefecture, city, rest: after.slice(city.length), file: index[prefecture][city] };
  }

  // Also tries 「高島町2丁目」 as 「高島2丁目」, like the Python tool.
  function locate(towns, rest) {
    return inCity(towns, rest) || inCity(towns, rest.replace(/町(\d+丁目)/, "$1"));
  }

  let indexPromise = null;
  const cities = new Map();

  async function gunzipJSON(response) {
    const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }

  // {latitude, longitude, precision: "block" | "town", matched} or null when the address is not found.
  async function geocode(address) {
    indexPromise = indexPromise || fetch("isj/index.json").then((r) => { if (!r.ok) throw new Error("index"); return r.json(); });
    const parts = split(address, await indexPromise);
    if (!parts) return null;
    if (!cities.has(parts.file)) {
      const response = await fetch(`isj/${parts.file}.json.gz`);
      if (!response.ok) throw new Error("city");
      cities.set(parts.file, await gunzipJSON(response));
    }
    const found = locate(cities.get(parts.file), parts.rest);
    return found && { ...found, matched: parts.city + found.matched };
  }

  return { geocode, split, locate, normalize, kanjiNumber, kanjiValue, PREFECTURES };
})();

if (typeof module !== "undefined") module.exports = Geocode;
