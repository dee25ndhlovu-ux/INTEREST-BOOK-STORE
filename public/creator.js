const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "US$" + Number(n).toFixed(2);
const api = async (url, opts = {}) => {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.endsWith("/login")) { location.reload(); throw new Error("Signed out"); }
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
};
const showErr = (id, msg) => { $(id).textContent = msg; $(id).hidden = !msg; };

async function boot() {
  const s = await api("/api/creator/session");
  if (!s.loggedIn) { $("loginView").hidden = false; $("loginUser").focus(); return; }
  $("creatorView").hidden = false;
  $("crWho").textContent = s.name;
  await Promise.all([loadProducts(), loadEarnings()]);
}
$("loginBtn").onclick = async () => {
  showErr("loginError", "");
  try {
    await api("/api/creator/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: $("loginUser").value, password: $("loginPass").value }) });
    location.reload();
  } catch (e) { showErr("loginError", e.message); }
};
$("loginPass").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loginBtn").click(); });
$("logoutBtn").onclick = async () => { await api("/api/creator/logout", { method: "POST" }); location.reload(); };

document.querySelectorAll(".side button.nav[data-view]").forEach((b) => b.onclick = () => {
  document.querySelectorAll(".side button.nav[data-view]").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== b.dataset.view));
});

async function loadProducts() {
  const list = await api("/api/creator/products");
  $("prodList").innerHTML = list.length ? list.map((p) => `
    <tr>
      <td>${p.cover ? `<img class="thumb-sm" src="${esc(p.cover)}" alt="">` : `<span class="thumb-sm"></span>`}</td>
      <td>${esc(p.title)}</td>
      <td class="price">${money(p.price)}</td>
      <td class="muted">${p.splitPct}%</td>
      <td class="muted">${p.published ? "Yes" : "No"}</td>
    </tr>`).join("") : `<tr><td colspan="5" class="muted">No products assigned to you yet.</td></tr>`;
}

async function loadEarnings() {
  const data = await api("/api/creator/earnings");
  $("earnTotal").textContent = money(data.total);
  $("earnList").innerHTML = data.orders.length ? data.orders.map((o) => `
    <tr>
      <td class="mono">${esc(o.ref)}</td>
      <td>${esc(o.productTitle)}</td>
      <td class="price">${money(o.amount)}</td>
      <td class="price">${money(o.earning)}</td>
      <td class="muted">${new Date(o.deliveredAt).toLocaleString()}</td>
    </tr>`).join("") : `<tr><td colspan="5" class="muted">No earnings yet.</td></tr>`;
}

boot();
