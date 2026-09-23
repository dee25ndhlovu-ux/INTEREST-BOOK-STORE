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

let cats = [];
let creators = [];
let editing = null;

// ---------- session ----------
async function boot() {
  const s = await api("/api/admin/session");
  if (!s.loggedIn) { $("loginView").hidden = false; $("loginPass").focus(); return; }
  $("adminView").hidden = false;
  $("noPassNotice").hidden = s.passwordSet;
  $("demoNotice").hidden = !s.demoMode;
  $("logoutBtn").hidden = !s.passwordSet;
  $("pwCurrentWrap").hidden = !s.passwordSet;
  $("pwTitle").textContent = s.passwordSet ? "Change admin password" : "Set admin password";
  await Promise.all([loadCats(), loadCreators(), loadProducts(), loadOrders(), loadSettings(), loadSummary()]);
}
$("loginBtn").onclick = async () => {
  showErr("loginError", "");
  try { await api("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("loginPass").value }) }); location.reload(); }
  catch (e) { showErr("loginError", e.message); }
};
$("loginPass").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loginBtn").click(); });
$("logoutBtn").onclick = async () => { await api("/api/admin/logout", { method: "POST" }); location.reload(); };

// ---------- nav ----------
document.querySelectorAll(".side button.nav[data-view]").forEach((b) => b.onclick = () => {
  document.querySelectorAll(".side button.nav[data-view]").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== b.dataset.view));
  if (b.dataset.view === "orders") loadOrders();
});

// ---------- revenue meter ----------
async function loadSummary() {
  const s = await api("/api/admin/summary");
  $("revTotal").textContent = money(s.totalRevenue);
  $("revOrders").textContent = s.deliveredOrders;
}

// ---------- categories ----------
async function loadCats() {
  cats = await api("/api/admin/categories");
  $("pCat").innerHTML = `<option value="">None</option>` + cats.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  $("catList").innerHTML = cats.length
    ? cats.map((c) => `<span class="tag">${esc(c.name)}<button data-del="${esc(c.id)}" aria-label="Remove">×</button></span>`).join("")
    : `<p class="muted">No categories yet.</p>`;
  $("catList").querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
    if (!confirm("Remove this category? Products in it will become uncategorised.")) return;
    await api(`/api/admin/categories/${b.dataset.del}`, { method: "DELETE" }); await loadCats(); await loadProducts();
  });
}
$("catAdd").onclick = async () => {
  showErr("catError", "");
  try { await api("/api/admin/categories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("catName").value }) }); $("catName").value = ""; await loadCats(); }
  catch (e) { showErr("catError", e.message); }
};
$("catName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("catAdd").click(); });

// ---------- creators ----------
async function loadCreators() {
  creators = await api("/api/admin/creators");
  $("pCreator").innerHTML = `<option value="">None (100% store)</option>` + creators.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  $("creatorList").innerHTML = creators.length ? creators.map((c) => `
    <tr>
      <td>${esc(c.name)}</td>
      <td class="mono">${esc(c.username)}</td>
      <td>${c.productCount}</td>
      <td class="price">${money(c.totalEarnings)}</td>
      <td class="muted">${c.passwordSet ? "Done" : "Not yet"}</td>
      <td><button class="btn danger sm" data-del="${esc(c.id)}">Remove</button></td>
    </tr>`).join("") : `<tr><td colspan="6" class="muted">No creators yet. Add one above.</td></tr>`;
  $("creatorList").querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
    if (!confirm("Remove this creator? Their products stay listed but become 100% store (unassigned).")) return;
    await api(`/api/admin/creators/${b.dataset.del}`, { method: "DELETE" }); await loadCreators(); await loadProducts();
  });
}
$("crAdd").onclick = async () => {
  showErr("creatorError", "");
  try {
    await api("/api/admin/creators", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("crName").value, username: $("crUsername").value }) });
    $("crName").value = ""; $("crUsername").value = ""; await loadCreators();
  } catch (e) { showErr("creatorError", e.message); }
};

// ---------- products ----------
const catName = (id) => (cats.find((c) => c.id === id) || {}).name || "—";
async function loadProducts() {
  const list = await api("/api/admin/products");
  $("prodList").innerHTML = list.length ? list.map((p) => `
    <tr>
      <td>${p.cover ? `<img class="thumb-sm" src="${esc(p.cover)}" alt="">` : `<span class="thumb-sm"></span>`}</td>
      <td>${esc(p.title)}</td>
      <td class="muted">${esc(catName(p.categoryId))}</td>
      <td class="muted">${p.creatorName ? `${esc(p.creatorName)} (${p.creatorSplitPct}%)` : "—"}</td>
      <td class="price">${money(p.price)}</td>
      <td><button class="btn ghost sm" data-toggle="${esc(p.id)}" data-pub="${p.published !== false}">${p.published !== false ? "Yes" : "No"}</button></td>
      <td style="white-space:nowrap"><button class="btn ghost sm" data-edit="${esc(p.id)}">Edit</button> <button class="btn danger sm" data-del="${esc(p.id)}">Delete</button></td>
    </tr>`).join("") : `<tr><td colspan="7" class="muted">No products yet. Add your first one above.</td></tr>`;

  $("prodList").querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
    if (!confirm("Delete this product? Buyers who already received it are unaffected.")) return;
    try { await api(`/api/admin/products/${b.dataset.del}`, { method: "DELETE" }); loadProducts(); }
    catch (e) { alert(e.message); }
  });
  $("prodList").querySelectorAll("[data-toggle]").forEach((b) => b.onclick = async () => {
    const fd = new FormData(); fd.append("published", b.dataset.pub === "true" ? "false" : "true");
    try { await api(`/api/admin/products/${b.dataset.toggle}`, { method: "PUT", body: fd }); loadProducts(); }
    catch (e) { alert(e.message); }
  });
  $("prodList").querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => startEdit(list.find((p) => p.id === b.dataset.edit)));
}

function startEdit(p) {
  editing = p;
  $("prodFormTitle").textContent = `Edit: ${p.title}`;
  $("pTitle").value = p.title; $("pDesc").value = p.description || ""; $("pPrice").value = p.price; $("pCat").value = p.categoryId || "";
  $("pCreator").value = p.creatorId || ""; $("pSplit").value = p.creatorSplitPct || 0;
  $("pPdf").value = ""; $("pCover").value = "";
  $("pPdfHint").textContent = "Leave empty to keep the current file.";
  $("prodSave").textContent = "Save changes"; $("prodCancel").hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function resetForm() {
  editing = null;
  $("prodFormTitle").textContent = "Add a product";
  ["pTitle", "pDesc", "pPrice", "pPdf", "pCover"].forEach((id) => ($(id).value = "")); $("pCat").value = ""; $("pCreator").value = ""; $("pSplit").value = 0;
  $("pPdfHint").textContent = "The master file customers pay for.";
  $("prodSave").textContent = "Add product"; $("prodCancel").hidden = true;
}
$("prodCancel").onclick = resetForm;
$("prodSave").onclick = async () => {
  showErr("prodError", ""); $("prodSave").disabled = true;
  try {
    const fd = new FormData();
    fd.append("title", $("pTitle").value); fd.append("description", $("pDesc").value);
    fd.append("price", $("pPrice").value); fd.append("categoryId", $("pCat").value);
    fd.append("creatorId", $("pCreator").value); fd.append("creatorSplitPct", $("pSplit").value);
    if ($("pPdf").files[0]) fd.append("pdf", $("pPdf").files[0]);
    if ($("pCover").files[0]) fd.append("cover", $("pCover").files[0]);
    if (editing) await api(`/api/admin/products/${editing.id}`, { method: "PUT", body: fd });
    else await api("/api/admin/products", { method: "POST", body: fd });
    resetForm(); await loadProducts();
  } catch (e) { showErr("prodError", e.message); }
  finally { $("prodSave").disabled = false; }
};

// ---------- orders ----------
async function loadOrders() {
  const list = await api("/api/admin/orders");
  $("orderList").innerHTML = list.length ? list.map((o) => `
    <tr>
      <td class="mono">${esc(o.ref)}</td>
      <td>${esc(o.email)}</td>
      <td>${esc(o.productTitle)}</td>
      <td class="price">${money(o.amount)}</td>
      <td class="muted">${o.creatorEarning != null ? `${money(o.creatorEarning)} / ${money(o.storeEarning)}` : "—"}</td>
      <td><span class="pill ${esc(o.status)}">${esc(o.status.replace("_", " "))}</span>${o.emailPreview ? ` <a class="muted" href="${esc(o.emailPreview)}" target="_blank">preview</a>` : ""}${o.error ? `<br><span class="muted">${esc(o.error)}</span>` : ""}</td>
      <td class="muted">${new Date(o.createdAt).toLocaleString()}</td>
    </tr>`).join("") : `<tr><td colspan="7" class="muted">No orders yet.</td></tr>`;
  await loadSummary();
}

// ---------- settings ----------
async function loadSettings() {
  const s = await api("/api/admin/settings");
  $("sName").value = s.storeName || ""; $("sTagline").value = s.tagline || "";
}
$("sSave").onclick = async () => {
  await api("/api/admin/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storeName: $("sName").value, tagline: $("sTagline").value }) });
  $("sSaved").hidden = false; setTimeout(() => ($("sSaved").hidden = true), 2000);
};
$("pwSave").onclick = async () => {
  showErr("pwError", "");
  try {
    await api("/api/admin/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current: $("pwCurrent").value, next: $("pwNext").value }) });
    $("pwCurrent").value = ""; $("pwNext").value = ""; $("pwSaved").hidden = false;
    $("noPassNotice").hidden = true; $("logoutBtn").hidden = false; $("pwCurrentWrap").hidden = false; $("pwTitle").textContent = "Change admin password";
    setTimeout(() => ($("pwSaved").hidden = true), 2500);
  } catch (e) { showErr("pwError", e.message); }
};

boot();
