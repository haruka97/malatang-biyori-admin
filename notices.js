// お知らせ (M20 T20.12): writing, publishing and taking back what the app shows under 「お知らせ」. Everything goes
// through database functions that check the admin and write a log line; pictures are uploaded to the public bucket
// `notice-images` with the admin's session (supabase/migrations/20261126110000_notices.sql). Loaded before app.js,
// which starts the page: nothing here runs at load time.
//
// A picture stands in the text as a line of its own, 「[[image:<file name>]]」; the app shows the picture at that
// place. 「画像を挿入」 uploads the file and puts that line where the cursor is.
"use strict";

const NOTICE_BUCKET = "notice-images";
const NOTICE_LIMITS = { title: 60, body: 4000, link: 300, imageEdge: 1600, imageBytes: 2 * 1024 * 1024 };
// The label is the owner's own word; these are only offered as suggestions.
const NOTICE_LABELS = ["お知らせ", "重要", "緊急", "お店", "PR"];
const NOTICE_LABEL_LENGTH = 10;
const NOTICE_IMAGE_LINE = /^\s*\[\[image:([a-z0-9_-]{1,60}\.(?:jpg|png))\]\]\s*$/;

// What the form is working on: the notice being changed (null = a new one), and the pictures uploaded in this
// sitting (file name → a local address for the preview, so it shows before the public address answers).
const noticeForm = { editing: null, previews: new Map() };

async function loadNotices() {
  if (DEMO) {
    Object.assign(state, { notices: demoNotices(), canManageNotices: true, noticeCounts: { "demo-1": { shown: 128, opened: 47 } } });
    return;
  }
  try {
    const notices = await api("notices?select=id,title,body,label,emphasized,link_url,published_at,created_at,updated_at&order=created_at.desc");
    Object.assign(state, { notices, canManageNotices: true, noticeCounts: {} });
    // How often each notice was seen (20261126130000); without that migration the list simply shows no numbers.
    try {
      const counts = await rpc("admin_notice_counts", {});
      state.noticeCounts = Object.fromEntries(counts.map((row) => [row.notice_id, row]));
    } catch (error) { state.noticeCounts = {}; }
  } catch (error) {
    // Before the migration the table does not exist: the tab says so instead of failing the whole page.
    Object.assign(state, { notices: [], canManageNotices: false });
  }
}

// The day on this computer's clock (the server's times are UTC).
function localDay(text) {
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return String(text).slice(0, 10);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// 「2026-11-27 09:00」 on this computer's clock.
function localMinute(text) {
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return String(text);
  return `${localDay(text)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// draft / scheduled (a time still to come) / out.
function noticeStatus(item) {
  if (!item.published_at) return "draft";
  return new Date(item.published_at).getTime() > Date.now() ? "scheduled" : "out";
}

function noticeImageUrl(name) {
  if (noticeForm.previews.has(name)) return noticeForm.previews.get(name);
  if (DEMO) return null;
  return `https://${config().host}/storage/v1/object/public/${NOTICE_BUCKET}/${name}`;
}

// The body as the app shows it: paragraphs of plain text and pictures, in order.
function noticeBlocks(body) {
  const blocks = [];
  let lines = [];
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text) blocks.push({ text });
    lines = [];
  };
  for (const line of String(body).split("\n")) {
    const match = NOTICE_IMAGE_LINE.exec(line);
    if (match) { flush(); blocks.push({ image: match[1] }); } else lines.push(line);
  }
  flush();
  return blocks;
}

function noticeBody(body) {
  return noticeBlocks(body).map((block) => {
    if (block.text) return el("p", { class: "message", text: block.text });
    const url = noticeImageUrl(block.image);
    return url ? el("img", { class: "notice-picture", src: url, alt: "" }) : el("p", { class: "hint", text: `（画像：${block.image}）` });
  });
}

// A phone does not need more than this; smaller files also load faster in the app. Returns a JPEG.
async function shrinkPicture(file) {
  if (!/^image\/(jpeg|png)$/.test(file.type)) throw new Error("图片只能用 JPEG 或 PNG。");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, NOTICE_LIMITS.imageEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  // A PNG may be see-through: on white, like the app's page.
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
  if (!blob) throw new Error("图片处理失败。");
  if (blob.size > NOTICE_LIMITS.imageBytes) throw new Error("图片太大（处理后仍超过 2MB）。");
  return { blob, width: canvas.width, height: canvas.height };
}

function newPictureName() {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `n${Date.now()}-${random}.jpg`;
}

async function uploadPicture(blob, name, retried = false) {
  const { host, key } = config();
  const response = await fetch(`https://${host}/storage/v1/object/${NOTICE_BUCKET}/${name}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${state.session.access_token}`, "Content-Type": "image/jpeg", "Cache-Control": "max-age=31536000" },
    body: blob,
  });
  if (response.ok) return;
  // The session may have run out while the form was open (the storage answers 400 for that as well): renew it
  // once and try again, like api() does for the database.
  if (!retried && [400, 401, 403].includes(response.status)) {
    await refresh();
    return uploadPicture(blob, name, true);
  }
  // The storage's own reason helps to tell a refused upload from a file that is too large.
  let reason = "";
  try { reason = String((await response.json()).message || ""); } catch { reason = ""; }
  throw new Error(`图片上传失败（${response.status}${reason ? `：${reason.slice(0, 120)}` : ""}）`);
}

// Puts a picture's line at the cursor, on a line of its own.
function insertPictureLine(name) {
  const area = $("nf-body");
  const at = area.selectionStart ?? area.value.length;
  const before = area.value.slice(0, at);
  const after = area.value.slice(area.selectionEnd ?? at);
  const line = `${before && !before.endsWith("\n") ? "\n" : ""}[[image:${name}]]${after.startsWith("\n") || !after ? "" : "\n"}`;
  area.value = before + line + after;
  const cursor = (before + line).length;
  area.setSelectionRange(cursor, cursor);
  area.focus();
}

async function insertNoticePicture() {
  const file = $("nf-file").files[0];
  if (!file) { $("nf-error").textContent = "请先在左边选一个图片文件，再点「画像を挿入」。"; return; }
  $("nf-insert").disabled = true;
  try {
    const shrunk = await shrinkPicture(file);
    const name = newPictureName();
    // Uploaded right away: the line in the text must name a file that exists.
    if (!DEMO) await uploadPicture(shrunk.blob, name);
    noticeForm.previews.set(name, URL.createObjectURL(shrunk.blob));
    insertPictureLine(name);
    $("nf-error").textContent = "";
  } catch (error) {
    $("nf-error").textContent = error.message;
  }
  $("nf-file").value = "";
  $("nf-insert").disabled = false;
  updateNoticeForm();
}

// 「表示 128・開封 47（37%）」: devices on which the notice appeared in the list, and on which it was opened.
// Anonymous and approximate (once per device; people who switched the usage report off are not counted).
function noticeCountText(item) {
  if (noticeStatus(item) === "draft" && !(state.noticeCounts || {})[item.id]) return "";
  const count = (state.noticeCounts || {})[item.id] || { shown: 0, opened: 0 };
  const rate = count.shown > 0 ? `（${Math.round((count.opened / count.shown) * 100)}%）` : "";
  return el("span", { class: "notice-counts", text: `表示 ${count.shown}・開封 ${count.opened}${rate}` });
}

function noticeTag(label, emphasized) {
  return el("span", { class: `tag${emphasized ? " strong" : ""}`, text: label || "お知らせ" });
}

function noticeProblem(title, body, link, label) {
  if (!title) return "请填标题。";
  if (title.length > NOTICE_LIMITS.title) return `标题最多 ${NOTICE_LIMITS.title} 字。`;
  if (/[\n\r]/.test(title)) return "标题不能换行。";
  if (!body) return "请填正文。";
  if (body.length > NOTICE_LIMITS.body) return `正文最多 ${NOTICE_LIMITS.body} 字。`;
  if (!noticeBlocks(body).some((block) => block.text)) return "正文里除了图片还要有文字。";
  if (/\[\[image:/.test(body.split("\n").filter((line) => !NOTICE_IMAGE_LINE.test(line)).join("\n"))) {
    return "图片的那一行要单独占一行，并且不要改动里面的文件名。";
  }
  if (link && !/^https:\/\/[^\s]+$/.test(link)) return "链接要以 https:// 开头，中间不能有空格。";
  if (link.length > NOTICE_LIMITS.link) return `链接最多 ${NOTICE_LIMITS.link} 字。`;
  if (label !== undefined && label.length > NOTICE_LABEL_LENGTH) return `标签最多 ${NOTICE_LABEL_LENGTH} 字。`;
  return null;
}

function openNoticeForm(item) {
  for (const url of noticeForm.previews.values()) URL.revokeObjectURL(url);
  Object.assign(noticeForm, { editing: item || null, previews: new Map() });
  $("nf-title").value = item ? item.title : "";
  $("nf-body").value = item ? item.body : "";
  $("nf-link").value = item && item.link_url ? item.link_url : "";
  $("nf-label").value = item && item.label ? item.label : "お知らせ";
  $("nf-emphasized").checked = Boolean(item && item.emphasized);
  $("nf-file").value = "";
  $("nf-heading").textContent = item ? ({ out: "修改已发布的お知らせ", scheduled: "修改预约中的お知らせ", draft: "修改草稿" }[noticeStatus(item)]) : "新しいお知らせ";
  $("nf-error").textContent = "";
  $("notice-form").hidden = false;
  updateNoticeForm();
  $("nf-title").focus();
}

function closeNoticeForm() {
  $("notice-form").hidden = true;
  noticeForm.editing = null;
}

// The preview shows the notice the way the app does: the title, the label, then text and pictures in order.
function updateNoticeForm() {
  const title = $("nf-title").value.trim();
  const body = $("nf-body").value.trim();
  const link = $("nf-link").value.trim();
  const pictures = noticeBlocks(body).filter((block) => block.image).length;
  $("nf-count").textContent = `标题 ${title.length}/${NOTICE_LIMITS.title}・正文 ${body.length}/${NOTICE_LIMITS.body}・图片 ${pictures} 张`;
  fill($("nf-preview"), [
    el("div", { class: "meta" }, el("span", { text: "App 里的样子（预览）" })),
    el("h4", { text: title || "（标题）" }),
    el("div", { class: "meta" }, noticeTag($("nf-label").value.trim(), $("nf-emphasized").checked)),
    ...(body ? noticeBody(body) : [el("p", { class: "message", text: "（正文）" })]),
    link ? el("p", { class: "hint", text: `「くわしく見る」→ ${link}` }) : "",
  ]);
  const problem = noticeProblem(title, body, link, $("nf-label").value.trim());
  $("nf-save").disabled = Boolean(problem);
  $("nf-error").textContent = title || body ? (problem || "") : "";
}

async function saveNotice() {
  const title = $("nf-title").value.trim();
  const body = $("nf-body").value.trim();
  const link = $("nf-link").value.trim();
  const problem = noticeProblem(title, body, link, $("nf-label").value.trim());
  if (problem) { $("nf-error").textContent = problem; return; }
  const editing = noticeForm.editing;
  if (editing && noticeStatus(editing) === "out" && !confirm("这条已经发布。修改后，用户的 App 会在一天内显示新的内容。确定？")) return;
  $("nf-save").disabled = true;
  try {
    const fields = { title, body, label: $("nf-label").value.trim() || "お知らせ", emphasized: $("nf-emphasized").checked, link_url: link || null };
    if (editing) fields.id = editing.id;
    const id = DEMO ? (editing ? editing.id : `demo-${Date.now()}`) : await rpc("admin_save_notice", { notice: fields });
    const now = new Date().toISOString();
    if (editing) Object.assign(editing, fields, { updated_at: now });
    else state.notices.unshift({ ...fields, id, published_at: null, created_at: now, updated_at: now });
    closeNoticeForm();
    notice(editing ? "已保存修改。" : "已存为草稿。确认内容后点「公開」。");
    renderNotices();
  } catch (error) {
    $("nf-error").textContent = error.message;
    $("nf-save").disabled = false;
  }
}

function noticeButton(label, kind, confirmText, action, done) {
  const button = el("button", { text: label, class: kind });
  button.addEventListener("click", async () => {
    if (confirmText && !confirm(confirmText)) return;
    button.disabled = true;
    try {
      if (!DEMO) await action();
      done();
      renderNotices();
    } catch (error) {
      notice(error.message);
      button.disabled = false;
    }
  });
  return button;
}

// The time typed into a 「datetime-local」 field (this computer's clock) as a moment; null when empty or not a time.
function scheduledMoment(input) {
  if (!input.value) return null;
  const date = new Date(input.value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// 「公開」 now, or at a time chosen here. Returns the controls for a draft or a scheduled notice.
function publishControls(item) {
  const when = el("input", { type: "datetime-local", class: "notice-when", "aria-label": "公開する日時" });
  const soon = new Date(Date.now() + 60 * 60 * 1000);
  const start = noticeStatus(item) === "scheduled" ? new Date(item.published_at) : soon;
  // The field wants local time without a zone.
  when.value = `${localDay(start)}T${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
  const now = noticeButton("今すぐ公開", "primary", `现在发布「${item.title}」？所有用户的 App 会在一天内显示，并出现未读的红点。`,
    () => rpc("admin_publish_notice", { notice_id: item.id, publish: true, at: null }),
    () => { item.published_at = new Date().toISOString(); notice(`已发布：${item.title}`); });
  const later = el("button", { text: noticeStatus(item) === "scheduled" ? "日時を変更" : "予約公開" });
  later.addEventListener("click", async () => {
    const moment = scheduledMoment(when);
    if (!moment) { notice("请先选好发布的日期和时间。"); return; }
    if (moment.getTime() <= Date.now()) { notice("预约的时间要在现在之后。想马上发布请点「今すぐ公開」。"); return; }
    if (!confirm(`预约在 ${localMinute(moment.toISOString())}（这台电脑的时间）发布「${item.title}」？到时间后，用户的 App 在下一次更新时显示（最晚一天内）。`)) return;
    later.disabled = true;
    try {
      if (!DEMO) await rpc("admin_publish_notice", { notice_id: item.id, publish: true, at: moment.toISOString() });
      item.published_at = moment.toISOString();
      notice(`已预约：${item.title}（${localMinute(item.published_at)}）`);
      renderNotices();
    } catch (error) {
      notice(error.message);
      later.disabled = false;
    }
  });
  return [now, el("span", { class: "notice-schedule" }, [when, later])];
}

function noticeActions(item) {
  const edit = el("button", { text: "修改" });
  edit.addEventListener("click", () => openNoticeForm(item));
  const status = noticeStatus(item);
  if (status === "out") {
    return [edit, noticeButton("取り下げる", "", `把「${item.title}」从 App 里撤下？用户的 App 会在一天内不再显示。`,
      () => rpc("admin_publish_notice", { notice_id: item.id, publish: false, at: null }),
      () => { item.published_at = null; notice("已撤下，回到草稿。"); })];
  }
  if (status === "scheduled") {
    return [...publishControls(item), edit, noticeButton("予約を取り消す", "", `取消「${item.title}」的预约？它会回到草稿。`,
      () => rpc("admin_publish_notice", { notice_id: item.id, publish: false, at: null }),
      () => { item.published_at = null; notice("已取消预约，回到草稿。"); })];
  }
  return [
    ...publishControls(item),
    edit,
    noticeButton("删除草稿", "", `删除草稿「${item.title}」？`,
      () => rpc("admin_delete_notice", { notice_id: item.id }),
      () => { state.notices = state.notices.filter((n) => n.id !== item.id); }),
  ];
}

function renderNotices() {
  if (!$("notices")) return;
  $("notices-add").hidden = !state.canManageNotices;
  if (!state.canManageNotices) {
    return fill($("notices-list"), el("p", { class: "empty", text: "数据库里还没有お知らせ的表（迁移 20261126110000 未执行）。" }));
  }
  const list = [...state.notices].sort((a, b) => (b.published_at || b.created_at).localeCompare(a.published_at || a.created_at));
  const count = (status) => list.filter((n) => noticeStatus(n) === status).length;
  $("notices-summary").textContent = `已发布 ${count("out")} 条・预约 ${count("scheduled")} 条・草稿 ${count("draft")} 条。App 只显示最新的 30 条，每天最多更新一次（预约的内容在到时间后的下一次更新时出现）。`;
  fill($("notices-list"), list.length === 0 ? el("p", { class: "empty", text: "还没有お知らせ。" })
    : list.map((item) => el("div", { class: `item${noticeStatus(item) === "out" ? "" : " draft"}` }, [
      el("div", { class: "meta" }, [
        el("span", { class: `tag${noticeStatus(item) === "out" ? "" : " new"}`,
          text: { out: `已发布 ${localMinute(item.published_at)}`, scheduled: `预约 ${localMinute(item.published_at)}`, draft: "草稿" }[noticeStatus(item)] }),
        noticeTag(item.label, item.emphasized),
        el("span", { text: `写于 ${localDay(item.created_at)}` }),
        noticeCountText(item),
      ]),
      el("h4", { text: item.title }),
      // Plain text and pictures only, like in the app.
      ...noticeBody(item.body),
      item.link_url ? (safeLink(item.link_url) || "") : "",
      el("div", { class: "actions" }, noticeActions(item)),
    ])));
}

// ---- Sample data for ?demo (made up) ----

function demoNotices() {
  return [
    { id: "demo-1", title: "利用規約を改定しました", body: "お店の評価として送るのは★だけに変更しました。\nくわしくは利用規約をご覧ください。", label: "重要", emphasized: true,
      link_url: "https://example.com/terms.html", published_at: "2026-11-20T03:00:00Z", created_at: "2026-11-20T02:00:00Z", updated_at: "2026-11-20T03:00:00Z" },
    { id: "demo-2", title: "お気に入りの人数が見られるようになりました",
      body: "お店のページで、お気に入りに入れた人の数とみんなの評価が見られます。\n\n[[image:demo-picture.jpg]]\n\n人数が集まったお店から順に表示されます。", label: "お店", emphasized: false,
      link_url: null, published_at: null, created_at: "2026-11-25T02:00:00Z", updated_at: "2026-11-25T02:00:00Z" },
    { id: "demo-3", title: "年末年始のお知らせ", body: "年末年始も通常どおりご利用いただけます。", label: "お知らせ", emphasized: false,
      link_url: null, published_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), created_at: "2026-11-26T01:00:00Z", updated_at: "2026-11-26T01:00:00Z" },
  ];
}
