const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "US$" + Number(n).toFixed(2);

let store = { storeName: "", tagline: "", categories: [], products: [] };
let current = null;
let pollTimer = null;

$("year").textContent = new Date().getFullYear();

async function load() {
  store = await fetch("/api/store").then((r) => r.json());
  document.title = store.storeName;
  $("brandName").textContent = store.storeName;
  $("footName").textContent = store.storeName;
  if (store.logo) { $("brandLogo").src = store.logo; $("brandLogo").hidden = false; }
  $("heroTitle").textContent = store.storeName;
  $("heroTagline").textContent = store.tagline;
  renderGrid();
}

function renderGrid() {
  const el = $("books");
  if (!store.products.length) {
    el.innerHTML = `<div class="empty"><h2>Nothing here yet</h2><p>No titles have been added to this store.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="grid">` + store.products.map((p) => `
    <article class="card" data-id="${esc(p.id)}">
      <div class="cover">${p.cover ? `<img src="${esc(p.cover)}" alt="">` : `<span class="initial">${esc(p.title.charAt(0).toUpperCase())}</span>`}</div>
      <div class="card-body">
        <h3>${esc(p.title)}</h3>
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
  $("dDesc").textContent = p.description || "";
  $("dThumb").innerHTML = p.cover ? `<img src="${esc(p.cover)}" alt="">` : "";
  $("formError").hidden = true;
  $("fEmail").value = ""; $("fPhone").value = "";
  show("stepForm");
  $("overlay").hidden = false;
  $("fEmail").focus();
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
      body: JSON.stringify({
        productId: current.id, email: $("fEmail").value.trim(), phone: $("fPhone").value.trim(),
      }) });
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
        $("downloadLink").href = o.downloadUrl;
        $("previewWrap").hidden = !o.emailPreview; if (o.emailPreview) $("previewLink").href = o.emailPreview;
        show("stepDone");
      } else if (o.status === "cancelled" || o.status === "failed") {
        clearInterval(pollTimer); $("failMsg").textContent = "The payment was cancelled or declined. No money was taken."; show("stepFail");
      } else if (o.status === "delivery_failed") {
        clearInterval(pollTimer); $("failMsg").textContent = `Payment was received but your download could not be prepared. Contact us with order ${o.ref}.`; show("stepFail");
      } else if (ticks > 60) {
        clearInterval(pollTimer); $("failMsg").textContent = "The payment prompt timed out. Please try again."; show("stepFail");
      }
    } catch (_) {}
  }, 3000);
}

load();
