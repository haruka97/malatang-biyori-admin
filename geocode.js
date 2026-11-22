"use strict";
// Address → coordinates for 「位置を調べる」, the same way as tools/geocode_shop.py and from the same data:
//   1. the house number, from the Digital Agency's アドレス・ベース・レジストリ (住居表示-住居マスター位置参照拡張,
//      https://dataset.address-br.digital.go.jp/ , PDL1.0), split by city into abr/*.json.gz by
//      tools/build_abr_lookup.py — where 住居表示 is in use and the city is in the data;
//   2. else the block, from 街区レベル位置参照情報（国土交通省, https://nlftp.mlit.go.jp/isj/ , PDL1.0), split by city
//      into isj/*.json.gz by tools/build_isj_lookup.py. A block can have several points in the data: all of them
//      are returned, the flagged one first, because the data cannot say at which one a shop stands;
//   3. else the town (the average of its blocks).
// Nothing is sent anywhere: the files are read from this site.

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
    return text.normalize("NFKC").replace(/[‐‑‒–—―−ｰ－]/g, "-").replace(/ヶ/g, "ケ").replace(/\s+/g, "");
  }

  // The address up to its numbers: what follows a space after a digit is the building and the floor
  // (「百人町1-11-27 1F」 must not read as 「…-271F」).
  function head(address) {
    const text = address.normalize("NFKC").trim().split(/(?<=\d)\s/)[0];
    return normalize(text).replace(/([一二三四五六七八九十]{1,3})丁目/g, (_, k) => `${kanjiValue(k)}丁目`);
  }

  // The longest town of `towns` (names as in the data, 「鷺宮三丁目」) that `rest` starts with, and the numbers after
  // it: {town, block, house, house2}. 「百人町1-7-3」 and 「百人町1丁目7番3号」 are both 百人町一丁目, block 7, house 3.
  function matchTown(towns, rest) {
    let best = null;
    for (const town of Object.keys(towns)) {
      let base = town, chome = null;
      const m = town.match(/^(.+?)([一二三四五六七八九十]+)丁目$/);
      if (m) { base = m[1]; chome = m[2]; }
      if (!rest.startsWith(base)) continue;
      const tail = rest.slice(base.length);
      let numbers;
      if (chome !== null) {
        const t = tail.match(/^(\d+)(?:丁目|-)(\d+)?(?:(?:番地?|-)(\d+))?(?:(?:号|-)(\d+))?/);
        if (!t || kanjiNumber(Number(t[1])) !== chome) continue;
        numbers = [t[2], t[3], t[4]];
      } else {
        const t = tail.match(/^(\d+)(?:(?:番地?|-)(\d+))?(?:(?:号|-)(\d+))?/);
        numbers = t ? [t[1], t[2], t[3]] : [];
      }
      if (best === null || town.length > best.town.length) best = { town, block: numbers[0], house: numbers[1], house2: numbers[2] };
    }
    return best;
  }

  // Also tries 「高島町2丁目」 as 「高島2丁目」, like the Python tool.
  function variants(rest) {
    const other = rest.replace(/町(\d+丁目)/, "$1");
    return other === rest ? [rest] : [rest, other];
  }

  // `towns`: {town: {block: {house: [lat, lon]}}} of one city. The point of the house number, or null.
  function house(towns, rest) {
    for (const text of variants(rest)) {
      const found = matchTown(towns, text);
      if (!found || !found.block || !found.house) continue;
      const houses = (towns[found.town] || {})[String(Number(found.block))];
      if (!houses) continue;
      const number = String(Number(found.house));
      const point = (found.house2 && houses[`${number}-${Number(found.house2)}`]) || houses[number];
      if (point) return { latitude: point[0], longitude: point[1], precision: "building", matched: `${found.town}${found.block}-${found.house}`, candidates: [] };
    }
    return null;
  }

  // `towns`: {town: {block: [lat, lon] | [[lat, lon], …]}} of one city. The block with all its points, else the town.
  function block(towns, rest) {
    for (const text of variants(rest)) {
      const found = matchTown(towns, text);
      if (!found) continue;
      const blocks = towns[found.town];
      const points = (value) => (Array.isArray(value[0]) ? value : [value]);
      if (found.block && blocks[found.block]) {
        const all = points(blocks[found.block]);
        return { latitude: all[0][0], longitude: all[0][1], precision: "block", matched: found.town + found.block,
                 candidates: all.map((p) => ({ latitude: p[0], longitude: p[1] })) };
      }
      const firsts = Object.values(blocks).map((value) => points(value)[0]);
      return {
        latitude: firsts.reduce((sum, p) => sum + p[0], 0) / firsts.length,
        longitude: firsts.reduce((sum, p) => sum + p[1], 0) / firsts.length,
        precision: "town", matched: found.town, candidates: [],
      };
    }
    return null;
  }

  // The prefecture, the city (the longest name the address starts with) and what follows it.
  function split(address, index) {
    const text = head(address);
    const prefecture = PREFECTURES.find((p) => text.startsWith(p));
    if (!prefecture || !index[prefecture]) return null;
    const after = text.slice(prefecture.length);
    const city = Object.keys(index[prefecture]).sort((a, b) => b.length - a.length).find((c) => after.startsWith(normalize(c)));
    if (!city) return null;
    return { prefecture, city, rest: after.slice(normalize(city).length), file: index[prefecture][city] };
  }

  const indexes = {};
  const cities = new Map();

  async function gunzipJSON(response) {
    const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }

  function index(folder) {
    indexes[folder] = indexes[folder] || fetch(`${folder}/index.json`).then((r) => { if (!r.ok) throw new Error("index"); return r.json(); });
    return indexes[folder];
  }

  async function city(folder, file) {
    const key = `${folder}/${file}`;
    if (!cities.has(key)) {
      const response = await fetch(`${key}.json.gz`);
      if (!response.ok) throw new Error("city");
      cities.set(key, await gunzipJSON(response));
    }
    return cities.get(key);
  }

  // {latitude, longitude, precision: "building" | "block" | "town", matched, candidates} or null when the address
  // is not found. `candidates`: every point of the block ({latitude, longitude}, the flagged one first) when the
  // answer is a block; more than one means the right one has to be chosen by looking at a map.
  async function geocode(address) {
    const parts = split(address, await index("isj"));
    if (!parts) return null;
    // The house-level files are an addition: without them (not deployed, or no file for this city) the block answers.
    const houseIndex = await index("abr").catch(() => ({}));
    // The two data sets do not always spell a city alike (「鎌ヶ谷市」「鎌ケ谷市」): the house files use the normalized name.
    const houseCities = houseIndex[parts.prefecture] || {};
    const houseFile = houseCities[parts.city] || houseCities[normalize(parts.city)];
    if (houseFile) {
      const found = house(await city("abr", houseFile), parts.rest);
      if (found) return { ...found, matched: parts.city + found.matched };
    }
    const found = block(await city("isj", parts.file), parts.rest);
    return found && { ...found, matched: parts.city + found.matched };
  }

  return { geocode, split, house, block, matchTown, head, normalize, kanjiNumber, kanjiValue, PREFECTURES };
})();

if (typeof module !== "undefined") module.exports = Geocode;
