"use strict";
// 两步验证 (docs/ADMIN.md): after the password, a 6-digit code from an authenticator app (TOTP, Supabase Auth MFA).
// The database gives the owner's data only to a session that passed both steps, so this page cannot skip it: it
// only asks for the code and hands the new session on. Loaded before app.js, whose helpers it uses when called.

// 「aal2」 once the session passed the second step; read from the token, which the database checks for itself.
function assurance(session) {
  try {
    const payload = session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload)).aal || "aal1";
  } catch { return "aal1"; }
}

async function auth(path, options = {}) {
  const { host, key } = config();
  const response = await fetch(`https://${host}/auth/v1/${path}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${state.session.access_token}`, "Content-Type": "application/json" },
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    const error = new Error(detail.msg || detail.message || `(${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

const mfa = { factor: null, enrolling: false };

function showMfa(enrolling, setup) {
  mfa.enrolling = enrolling;
  $("login").hidden = true;
  $("mfa").hidden = false;
  $("mfa-title").textContent = enrolling ? "设置两步验证" : "两步验证";
  $("mfa-setup").hidden = !enrolling;
  $("mfa-skip").hidden = !enrolling;
  $("mfa-help").textContent = enrolling
    ? "用验证器 App（iPhone 的「密码」App、Google Authenticator、1Password 等）扫描二维码，或手动输入下面的密钥，然后填 App 显示的 6 位数字。"
    : "输入验证器 App 里「マーラータン日和 后台」显示的 6 位数字。";
  if (setup) {
    // The QR code comes from Supabase as SVG text; shown as an image, so nothing in it can run.
    $("mfa-qr").src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(setup.qr_code);
    $("mfa-secret").textContent = setup.secret;
  }
  $("mfa-code").value = "";
  $("mfa-error").textContent = "";
  $("mfa-code").focus();
}

function hideMfa() {
  $("mfa").hidden = true;
  $("mfa-qr").removeAttribute("src");
  $("mfa-secret").textContent = "";
}

function enterApp() {
  hideMfa();
  $("who").textContent = state.session.user && state.session.user.email ? state.session.user.email : "";
  showApp(true);
  return load();
}

// After the password (or with a session kept in this tab): ask for the code, offer the setup, or go in.
async function continueSignIn() {
  if (assurance(state.session) === "aal2") return enterApp();
  const user = await auth("user");
  const factors = (user.factors || []).filter((f) => f.factor_type === "totp");
  const verified = factors.find((f) => f.status === "verified");
  if (verified) {
    mfa.factor = verified.id;
    return showMfa(false);
  }
  // Setups that were started and never finished would only pile up.
  for (const stale of factors) await auth(`factors/${stale.id}`, { method: "DELETE" }).catch(() => {});
  const created = await auth("factors", { method: "POST", body: JSON.stringify({ factor_type: "totp", friendly_name: `admin-${Date.now()}`, issuer: "マーラータン日和 后台" }) });
  mfa.factor = created.id;
  showMfa(true, created.totp);
}

async function submitCode(event) {
  event.preventDefault();
  const code = $("mfa-code").value.normalize("NFKC").replace(/\D/g, "");
  if (code.length !== 6) { $("mfa-error").textContent = "请输入 6 位数字。"; return; }
  $("mfa-submit").disabled = true;
  try {
    const challenge = await auth(`factors/${mfa.factor}/challenge`, { method: "POST", body: "{}" });
    const session = await auth(`factors/${mfa.factor}/verify`, { method: "POST", body: JSON.stringify({ challenge_id: challenge.id, code }) });
    saveSession({ ...state.session, ...session });
    const wasEnrolling = mfa.enrolling;
    await enterApp();
    if (wasEnrolling) notice("两步验证已设置。以后登录时在密码之后输入验证器 App 的 6 位数字。");
  } catch (error) {
    $("mfa-error").textContent = error.status === 422 || error.status === 400 ? "验证码不对或已过期，请再试一次。" : `验证失败：${error.message}`;
  }
  $("mfa-submit").disabled = false;
}

function cancelMfa() {
  hideMfa();
  signOut();
}

// 「以后再设置」: in with the password only. Once the database requires both steps, nothing can be read this way.
function skipMfa() {
  enterApp().then(() => notice("还没有设置两步验证。数据库要求两步验证之后，不设置就读不到数据。"));
}
