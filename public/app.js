const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "US$" + Number(n).toFixed(2);

let store = { storeName: "", tagline: "", categories: [], products: [] };
let activeCat = "all";
let current = null;
let pollTimer = null;

$("year").textContent = new Date().getFullYear();

async function load() {
  store = await fetch("/api/store").then((r) => r.json());
  document.title = store.storeName;
  $("brandName").textContent = store.storeName;
  $("footName").textContent = store.storeName;
  $("mark").textContent = store.storeName.trim().charAt(0).toUpperCase() || "S";
  $("heroTitle").textContent = store.storeName;
  $("heroTagline").textContent = store.tagline;
  renderFilters();
  renderGrid();
}

function renderFilters() {
  const usedCats = store.categories.filter((c) => store.products.some((p) => p.categoryId === c.id));
  const uncategorised = store.products.some((p) => !p.categoryId);
  if (!store.products.length || (usedCats.length === 0)) { $("filters").hidden = true; return; }
  const chips = [{ id: "all", name: "All" }, ...usedCats];
  if (uncategorised && usedCats.length) chips.push({ id: "none", name: "Other" });
  $("filters").innerHTML = chips.map((c) => `<button class="chip ${c.id === activeCat ? "active" : ""}" data-cat="${esc(c.id)}">${esc(c.name)}</button>`).join("");
  $("filters").hidden = false;
  $("filters").querySelectorAll(".chip").forEach((b) => b.onclick = () => { activeCat = b.dataset.cat; renderFilters(); renderGrid(); });
}

function renderGrid() {
  const el = $("books");
  if (!store.products.length) {
    el.innerHTML = `<div class="empty"><h2>Nothing here yet</h2><p>No titles have been added to this store.</p></div>`;
    return;
  }
  const list = store.products.filter((p) => activeCat === "all" || (activeCat === "none" ? !p.categoryId : p.categoryId === activeCat));
  const catName = (id) => (store.categories.find((c) => c.id === id) || {}).name || "";
  el.innerHTML = `<div class="grid">` + list.map((p) => `
    <article class="card">
      <div class="cover">${p.cover ? `<img src="${esc(p.cover)}" alt="">` : `<span class="initial">${esc(p.title.charAt(0).toUpperCase())}</span>`}</div>
      <div class="card-body">
        ${p.categoryId ? `<div class="cat">${esc(catName(p.categoryId))}</div>` : ""}
        <h3>${esc(p.title)}</h3>
        <p class="desc">${esc(p.description)}</p>
        <div class="row"><span class="price">${money(p.price)}</span><button class="btn primary sm" data-id="${esc(p.id)}">Buy</button></div>
      </div>
    </article>`).join("") + `</div>`;
  el.querySelectorAll("button[data-id]").forEach((b) => b.onclick = () => openCheckout(store.products.find((p) => p.id === b.dataset.id)));
}

function show(step) { ["stepForm", "stepWait", "stepDone", "stepFail"].forEach((s) => ($(s).hidden = s !== step)); }

function openCheckout(p) {
  current = p;
  $("dTitle").textContent = p.title;
  $("dPrice").textContent = money(p.price);
  $("dThumb").innerHTML = p.cover ? `<img src="${esc(p.cover)}" alt="">` : "";
  $("formError").hidden = true;
  show("stepForm");
  $("overlay").hidden = false;
  $("fName").focus();
}
function closeCheckout() { clearInterval(pollTimer); $("overlay").hidden = true; }

$("closeBtn").onclick = closeCheckout;
$("doneBtn").onclick = closeCheckout;
$("retryBtn").onclick = () => show("stepForm");
$("overlay").onclick = (e) => { if (e.target === $("overlay")) closeCheckout(); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("overlay").hidden) closeCheckout(); });

$("payBtn").onclick = async () => {
  $("payBtn").disabled = true; $("formError").hidden = true;
  try {
    const res = await fetch("/api/checkout", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: current.id, name: $("fName").value.trim(), email: $("fEmail").value.trim(), phone: $("fPhone").value.trim() }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    $("waitRef").textContent = data.ref; $("waitMsg").textContent = data.instructions;
    show("stepWait"); poll(data.ref);
  } catch (err) { $("formError").textContent = err.message; $("formError").hidden = false; }
  finally { $("payBtn").disabled = false; }
};

function poll(ref) {
  clearInterval(pollTimer); let ticks = 0;
  pollTimer = setInterval(async () => {
    ticks++;
    try {
      const o = await fetch(`/api/orders/${ref}`).then((r) => r.json());
      if (o.status === "delivered") {
        clearInterval(pollTimer);
        $("doneEmail").textContent = o.email; $("doneRef").textContent = o.ref;
        $("previewWrap").hidden = !o.emailPreview; if (o.emailPreview) $("previewLink").href = o.emailPreview;
        show("stepDone");
      } else if (o.status === "cancelled" || o.status === "failed") {
        clearInterval(pollTimer); $("failMsg").textContent = "The payment was cancelled or declined. No money was taken."; show("stepFail");
      } else if (o.status === "delivery_failed") {
        clearInterval(pollTimer); $("failMsg").textContent = `Payment received but the email could not be sent. Contact us with order ${o.ref}.`; show("stepFail");
      } else if (ticks > 60) {
        clearInterval(pollTimer); $("failMsg").textContent = "The payment prompt timed out. Please try again."; show("stepFail");
      }
    } catch (_) {}
  }, 3000);
}

load();
