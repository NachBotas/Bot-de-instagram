// Panel de control del setter. JavaScript sin dependencias.
"use strict";

let A = null; // ajustes (con las claves enmascaradas)
let E = null; // estado
let flowsCache = null; // { flows, folders }
let vista = "inicio";
let chatSesion = String(Date.now());
let ultimasConsultas = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const main = () => $("#main");

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 2600);
}

async function api(path, opts = {}) {
  const init = { method: opts.method ?? "GET", headers: { "x-panel": "1" } };
  if (opts.body !== undefined) {
    if (opts.raw) {
      init.body = opts.body;
      init.headers["content-type"] = opts.type || "application/octet-stream";
    } else {
      init.body = JSON.stringify(opts.body);
      init.headers["content-type"] = "application/json";
    }
  }
  const res = await fetch(path, init);
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `Error ${res.status}`);
  return data;
}

async function guardar(mutar, okMsg = "Guardado ✓") {
  const copia = structuredClone(A);
  mutar(copia);
  const r = await api("/api/ajustes", { method: "PUT", body: copia });
  A = r.ajustes;
  toast(okMsg);
  await refrescarEstado();
  return r;
}

/** Inputs de claves: vacíos muestran la clave guardada enmascarada; si escribís algo, la reemplaza. */
function inputSecreto(id, valor, placeholder) {
  return `<input type="password" id="${id}" autocomplete="off" placeholder="${esc(valor || placeholder)}">`;
}
const leerSecreto = (id, actual) => ($("#" + id).value.trim() ? $("#" + id).value.trim() : actual);

function copiable(valor) {
  return `<div class="copy"><span class="mono">${esc(valor)}</span><button class="btn small" data-copiar="${esc(valor)}">Copiar</button></div>`;
}

document.addEventListener("click", async (ev) => {
  const c = ev.target.closest("[data-copiar]");
  if (c) {
    await navigator.clipboard.writeText(c.dataset.copiar).catch(() => {});
    toast("Copiado");
  }
  const ir = ev.target.closest("[data-ir]");
  if (ir) irA(ir.dataset.ir);
});

function pill(ok, siOk, siNo, neutro) {
  if (ok === undefined || ok === null) return `<span class="pill off">${esc(neutro ?? "Sin probar")}</span>`;
  return ok ? `<span class="pill ok">● ${esc(siOk)}</span>` : `<span class="pill bad">● ${esc(siNo)}</span>`;
}

// ------------------------------------------------------------------ navegación

function irA(v) {
  vista = v;
  $$("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.v === v));
  window.scrollTo(0, 0);
  render().catch((e) => (main().innerHTML = `<div class="alert bad">${esc(e.message)}</div>`));
}
$$("#nav button").forEach((b) => b.addEventListener("click", () => irA(b.dataset.v)));

async function refrescarEstado() {
  E = await api("/api/estado");
  const n = E.numeros.consultasPendientes;
  const badge = $("#badge-consultas");
  badge.textContent = n;
  badge.classList.toggle("hidden", !n);
  document.title = `${n ? `(${n}) ` : ""}Setter · ${E.botActivo ? "Activo" : "Apagado"}`;
  if (ultimasConsultas !== null && n > ultimasConsultas && "Notification" in window && Notification.permission === "granted") {
    new Notification("El bot necesita ayuda", { body: "Hay una consulta nueva en el panel." });
  }
  ultimasConsultas = n;
}

const VISTAS = {};
async function render() {
  await refrescarEstado();
  await VISTAS[vista]();
}

// ------------------------------------------------------------------ INICIO

VISTAS.inicio = async () => {
  const c = E.configurado;
  const ch = E.chequeos;
  const pasos = [
    ["Conectar Claude (el cerebro del bot)", c.claude && ch.claude?.ok !== false, "conexion"],
    ["Conectar ManyChat", c.manychat && ch.manychat?.ok !== false, "conexion"],
    ["Cargar la información de tu negocio", c.negocio, "negocio"],
    ["Elegir qué automatizaciones puede usar el bot (opcional)", c.automatizaciones > 0, "automatizaciones"],
    ["Activar la lectura de audios", c.audios, "audios"],
    ["Configurar la agenda de llamadas", c.agenda, "agenda"],
    ["Abrir la conexión con internet y configurar ManyChat", !!E.tunel.url || !!E.webhook.url, "conexion"],
    ["Probar el bot acá mismo", false, "probar"],
  ];
  main().innerHTML = `
    <h1>Hola 👋</h1>
    <p class="sub">${E.pagina ? `Cuenta conectada: <b>${esc(E.pagina)}</b>` : "Desde acá controlás tu setter de Instagram."}</p>

    <div class="card toggle-big">
      <div>
        <h2 style="margin:0">${E.botActivo ? "🟢 El bot está respondiendo" : "⚪ El bot está apagado"}</h2>
        <div class="hint">${
          E.botActivo
            ? "Responde automáticamente mientras esta compu esté prendida y esta ventana de la app abierta."
            : "Cuando lo actives, va a responder los DMs que le mande ManyChat."
        }</div>
      </div>
      <label class="switch" title="Activar / apagar el bot"><input type="checkbox" id="bot-toggle" ${E.botActivo ? "checked" : ""}><span class="slider"></span></label>
    </div>

    ${E.advertencias.map((w) => `<div class="alert warn">⚠️ ${esc(w)}</div>`).join("")}
    ${E.numeros.consultasPendientes ? `<div class="alert warn">🔔 Tenés ${E.numeros.consultasPendientes} consulta(s) que el bot no supo responder. <a href="#" data-ir="consultas">Responder</a></div>` : ""}

    <div class="grid" style="margin-bottom:16px">
      <div class="stat"><b>${E.numeros.activasHoy}</b><span>conversaciones hoy</span></div>
      <div class="stat"><b>${E.numeros.conversaciones}</b><span>conversaciones en total</span></div>
      <div class="stat"><b>${E.numeros.agendadas}</b><span>llamadas agendadas</span></div>
      <div class="stat"><b>${E.numeros.consultasPendientes}</b><span>consultas pendientes</span></div>
    </div>

    <div class="card">
      <h2>Conexiones</h2>
      <div class="grid">
        <div><div class="hint">Claude</div>${c.claude ? pill(ch.claude?.ok, "Conectado", "Error") : '<span class="pill warn">Falta configurar</span>'}</div>
        <div><div class="hint">ManyChat</div>${c.manychat ? pill(ch.manychat?.ok, "Conectado", "Error") : '<span class="pill warn">Falta configurar</span>'}</div>
        <div><div class="hint">Audios</div>${c.audios ? pill(ch.audios?.ok, "Funcionando", "Error", "Configurado") : '<span class="pill off">Apagados</span>'}</div>
        <div><div class="hint">Conexión a internet</div>${E.tunel.url || E.webhook.url ? '<span class="pill ok">● Abierta</span>' : E.tunel.error ? '<span class="pill bad">● Error</span>' : '<span class="pill off">Cerrada</span>'}</div>
      </div>
      <div class="row" style="margin-top:12px"><button class="btn small" id="probar-todo">Probar conexiones</button></div>
    </div>

    <div class="card">
      <h2>Primeros pasos</h2>
      <ol class="steps">
        ${pasos.map(([t, ok, v]) => `<li class="${ok ? "done" : ""}"><div class="row"><span class="grow">${esc(t)}</span><button class="btn small" data-ir="${v}">${ok ? "Ver" : "Ir"}</button></div></li>`).join("")}
      </ol>
      <p class="hint">Cuando tengas todo, activá el bot con el interruptor de arriba.</p>
    </div>

    <div class="card">
      <h2>Avisos en esta compu</h2>
      <p class="hint">Recibí una notificación cuando el bot necesite que respondas algo (con el panel abierto).</p>
      <button class="btn small" id="notif">${"Notification" in window && Notification.permission === "granted" ? "Avisos activados ✓" : "Activar avisos"}</button>
    </div>`;

  $("#bot-toggle").addEventListener("change", async (e) => {
    const activo = e.target.checked;
    if (activo && (!c.claude || !c.manychat)) {
      if (!confirm("Todavía falta conectar Claude o ManyChat. ¿Activarlo igual?")) {
        e.target.checked = false;
        return;
      }
    }
    await api("/api/bot", { method: "POST", body: { activo } });
    toast(activo ? "Bot activado" : "Bot apagado");
    render();
  });
  $("#probar-todo").addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Probando…";
    if (c.claude) await api("/api/probar/claude", { method: "POST", body: {} }).catch(() => {});
    if (c.manychat) await api("/api/probar/manychat", { method: "POST", body: {} }).catch(() => {});
    render();
  });
  $("#notif").addEventListener("click", async () => {
    if (!("Notification" in window)) return toast("Este navegador no soporta avisos");
    const p = await Notification.requestPermission();
    toast(p === "granted" ? "Avisos activados" : "No se activaron los avisos");
    render();
  });
};

// ------------------------------------------------------------------ PROBAR

VISTAS.probar = async () => {
  main().innerHTML = `
    <h1>Probar el bot</h1>
    <p class="sub">Escribile como si fueras un lead. Usa tu configuración real, pero <b>no manda nada a Instagram</b> ni dispara automatizaciones de verdad: las acciones aparecen en gris.</p>
    <div class="card">
      <div class="chat" id="chat"><div class="empty">Escribí "hola, vi tu reel" para empezar.</div></div>
      <form class="row" id="chat-form" style="margin-top:10px">
        <input type="text" id="chat-input" class="grow" placeholder="Escribí un mensaje…" autocomplete="off">
        <button class="btn primary" type="submit">Enviar</button>
        <button class="btn" type="button" id="chat-reset">Nueva conversación</button>
      </form>
    </div>`;
  const chat = $("#chat");
  const add = (cls, text) => {
    if ($(".empty", chat)) chat.innerHTML = "";
    const d = document.createElement("div");
    d.className = `msg ${cls}`;
    d.textContent = text;
    chat.appendChild(d);
    chat.scrollTop = chat.scrollHeight;
    return d;
  };
  $("#chat-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const inp = $("#chat-input");
    const texto = inp.value.trim();
    if (!texto) return;
    inp.value = "";
    add("lead", texto);
    const esperando = add("sys", "escribiendo…");
    try {
      const r = await api("/api/probar/chat", { method: "POST", body: { sesion: chatSesion, texto } });
      esperando.remove();
      r.acciones.forEach((a) => add("sys", a));
      r.mensajes.forEach((m) => add("bot", m));
      if (!r.mensajes.length) add("sys", "(el bot decidió no responder)");
    } catch (e) {
      esperando.textContent = `❌ ${e.message}`;
    }
    inp.focus();
  });
  $("#chat-reset").addEventListener("click", () => {
    chatSesion = String(Date.now());
    chat.innerHTML = '<div class="empty">Conversación nueva.</div>';
  });
  $("#chat-input").focus();
};

// ------------------------------------------------------------------ NEGOCIO

VISTAS.negocio = async () => {
  A = await api("/api/ajustes");
  main().innerHTML = `
    <h1>Mi negocio</h1>
    <p class="sub">Todo lo que el bot sabe sale de acá. Si algo no está, no lo inventa: te consulta a vos.</p>
    <div class="card">
      <div class="row"><h2 class="grow" style="margin:0">Información e indicaciones</h2>
        <button class="btn small" id="plantilla">Cargar plantilla</button></div>
      <p class="hint">Qué vendés, para quién es, cuándo ofrecer la llamada, preguntas frecuentes, objeciones, tono… Escribilo como se lo explicarías a un setter nuevo.</p>
      <textarea class="big" id="negocio">${esc(A.negocio)}</textarea>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="guardar-negocio">Guardar</button></div>
    </div>
    <div class="card">
      <h2>Comportamiento</h2>
      <div class="grid">
        <div><label>Espera antes de responder (seg)<div class="hint">Por si el lead manda varios mensajes seguidos.</div></label>
          <input type="number" id="espera" min="0" max="60" value="${A.comportamiento.esperaSeg}"></div>
        <div><label>Pausa entre burbujas (ms)<div class="hint">Para que parezca alguien escribiendo.</div></label>
          <input type="number" id="pausa" min="0" max="10000" step="100" value="${A.comportamiento.pausaMs}"></div>
        <div><label>Máximo de mensajes por respuesta</label>
          <input type="number" id="burbujas" min="1" max="6" value="${A.comportamiento.maxBurbujas}"></div>
      </div>
      <h3>Seguimiento automático</h3>
      <div class="row"><label class="switch small"><input type="checkbox" id="seg-activo" ${A.seguimientos.activo ? "checked" : ""}><span class="slider"></span></label>
        <span>Si el lead deja de responder, escribirle de nuevo</span></div>
      <div class="grid">
        <div><label>Después de (horas)</label><input type="number" id="seg-horas" min="1" max="22" value="${A.seguimientos.horas}"></div>
        <div><label>Cuántas veces como máximo</label><input type="number" id="seg-max" min="0" max="3" value="${A.seguimientos.max}"></div>
      </div>
      <p class="hint">Instagram solo deja escribir hasta 24 h después del último mensaje del lead.</p>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="guardar-comp">Guardar</button></div>
    </div>`;
  $("#plantilla").addEventListener("click", async () => {
    if ($("#negocio").value.trim() && !confirm("¿Reemplazar lo que escribiste por la plantilla?")) return;
    $("#negocio").value = await api("/api/plantilla-negocio");
  });
  $("#guardar-negocio").addEventListener("click", () => guardar((a) => (a.negocio = $("#negocio").value)));
  $("#guardar-comp").addEventListener("click", () =>
    guardar((a) => {
      a.comportamiento = { esperaSeg: +$("#espera").value, pausaMs: +$("#pausa").value, maxBurbujas: +$("#burbujas").value };
      a.seguimientos = { activo: $("#seg-activo").checked, horas: +$("#seg-horas").value, max: +$("#seg-max").value };
    }),
  );
};

// ------------------------------------------------------------------ AUTOMATIZACIONES

const slug = (s) =>
  String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "flow";

function rutaCarpeta(folderId) {
  if (!flowsCache) return "";
  const parts = [];
  let id = folderId;
  for (let i = 0; id && i < 20; i++) {
    const f = flowsCache.folders.find((x) => x.id === id);
    if (!f) break;
    parts.unshift(f.name);
    id = f.parentId;
  }
  return parts.join(" / ");
}

let carpetaActual = null;
let busqueda = "";

VISTAS.automatizaciones = async () => {
  A = await api("/api/ajustes");
  main().innerHTML = `
    <h1>Automatizaciones</h1>
    <p class="sub">Elegí qué flows de ManyChat puede disparar el bot y contale cuándo usar cada uno. Los que no marques, el bot no los toca.</p>
    <div class="card">
      <div class="row"><h2 class="grow" style="margin:0">Tus flows en ManyChat</h2>
        <button class="btn small" id="recargar-flows">Actualizar lista</button></div>
      <div id="explorador" style="margin-top:12px"><div class="empty">Cargando flows…</div></div>
    </div>
    <div class="card">
      <h2>Permitidas para el bot (<span id="n-elegidas">${A.automatizaciones.length}</span>)</h2>
      <div id="elegidas"></div>
      <details><summary>Agregar un flow a mano</summary>
        <p class="hint">Si no aparece en la lista: abrí el flow en ManyChat y copiá su ID de la URL (empieza con "content…").</p>
        <div class="row"><input type="text" id="manual-ns" class="grow" placeholder="content20240101123456_123456">
          <input type="text" id="manual-nombre" class="grow" placeholder="Nombre (ej. Testimonios)">
          <button class="btn" id="manual-add">Agregar</button></div>
      </details>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="guardar-autos">Guardar automatizaciones</button></div>
    </div>
    <div class="card">
      <h2>Flows especiales</h2>
      <label>Aviso al equipo<div class="hint">Se dispara cuando el bot no sabe algo o deriva a una persona. Armá en ManyChat un flow con la acción <b>"Notify Admin"</b> (te avisa por email, Telegram o la app de ManyChat) y elegilo acá. No pongas mensajes para el lead en ese flow.</div></label>
      <select id="flow-aviso"></select>
      <label>Confirmación de llamada agendada<div class="hint">Se dispara cuando el lead agenda (ej. mensaje de confirmación + recordatorios).</div></label>
      <select id="flow-confirmacion"></select>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="guardar-especiales">Guardar</button></div>
    </div>`;

  const elegidas = A.automatizaciones;
  const pintarElegidas = () => {
    $("#n-elegidas").textContent = elegidas.length;
    $("#elegidas").innerHTML = elegidas.length
      ? elegidas
          .map(
            (x, i) => `<div class="card" style="padding:12px 14px;margin-bottom:10px">
          <div class="row"><b class="grow">${esc(x.nombre || x.clave)}</b><span class="hint">${esc(x.carpeta)}</span>
            <button class="btn small danger" data-quitar="${i}">Quitar</button></div>
          <label>¿Qué hace este flow?</label>
          <input type="text" data-desc="${i}" value="${esc(x.descripcion)}" placeholder="Ej: le manda 3 testimonios en video">
          <label>¿Cuándo tiene que usarlo el bot?</label>
          <input type="text" data-cuando="${i}" value="${esc(x.cuando_usar)}" placeholder="Ej: cuando el lead duda de si funciona o pide resultados">
        </div>`,
          )
          .join("")
      : '<div class="empty">Todavía no elegiste ninguna. Marcá flows en la lista de arriba.</div>';
    $$("[data-quitar]").forEach((b) =>
      b.addEventListener("click", () => {
        elegidas.splice(+b.dataset.quitar, 1);
        pintarElegidas();
        pintarExplorador();
      }),
    );
    $$("[data-desc]").forEach((inp) => inp.addEventListener("input", () => (elegidas[+inp.dataset.desc].descripcion = inp.value)));
    $$("[data-cuando]").forEach((inp) => inp.addEventListener("input", () => (elegidas[+inp.dataset.cuando].cuando_usar = inp.value)));
  };

  const alternar = (flow, on) => {
    const i = elegidas.findIndex((x) => x.flow_ns === flow.ns);
    if (on && i < 0) {
      let clave = slug(flow.name);
      while (elegidas.some((x) => x.clave === clave)) clave += "_2";
      elegidas.push({ clave, flow_ns: flow.ns, nombre: flow.name, carpeta: rutaCarpeta(flow.folderId), descripcion: "", cuando_usar: "" });
    } else if (!on && i >= 0) elegidas.splice(i, 1);
    pintarElegidas();
  };

  const pintarExplorador = () => {
    const box = $("#explorador");
    if (!flowsCache) return;
    const { flows, folders } = flowsCache;
    const q = busqueda.trim().toLowerCase();
    const subcarpetas = q ? [] : folders.filter((f) => (f.parentId ?? null) === carpetaActual);
    const visibles = q ? flows.filter((f) => f.name.toLowerCase().includes(q)) : flows.filter((f) => (f.folderId ?? null) === carpetaActual);
    const migas = [];
    let id = carpetaActual;
    for (let i = 0; id && i < 20; i++) {
      const f = folders.find((x) => x.id === id);
      if (!f) break;
      migas.unshift(f);
      id = f.parentId;
    }
    box.innerHTML = `
      <input type="text" id="buscar-flow" placeholder="Buscar flow por nombre…" value="${esc(busqueda)}">
      <div class="crumbs" style="margin-top:10px">${
        q
          ? `Resultados para "${esc(busqueda)}"`
          : `<button data-carpeta="">📁 Todas</button>${migas.map((f) => ` / <button data-carpeta="${f.id}">${esc(f.name)}</button>`).join("")}`
      }</div>
      <div class="list">
        ${subcarpetas.map((f) => `<div class="item clickable" data-carpeta="${f.id}"><span>📁</span><div class="grow"><div class="t">${esc(f.name)}</div></div><span class="hint">›</span></div>`).join("")}
        ${visibles
          .map((f) => {
            const on = elegidas.some((x) => x.flow_ns === f.ns);
            return `<div class="item"><span>⚡</span><div class="grow"><div class="t">${esc(f.name)}</div>${q ? `<div class="d">${esc(rutaCarpeta(f.folderId) || "Sin carpeta")}</div>` : ""}</div>
            <label class="switch small" title="Permitir al bot"><input type="checkbox" data-flow="${esc(f.ns)}" ${on ? "checked" : ""}><span class="slider"></span></label></div>`;
          })
          .join("")}
        ${!subcarpetas.length && !visibles.length ? '<div class="empty">No hay flows acá.</div>' : ""}
      </div>`;
    const inp = $("#buscar-flow");
    inp.addEventListener("input", () => {
      busqueda = inp.value;
      pintarExplorador();
      const n = $("#buscar-flow");
      n.focus();
      n.setSelectionRange(n.value.length, n.value.length);
    });
    $$("[data-carpeta]", box).forEach((el) =>
      el.addEventListener("click", () => {
        carpetaActual = el.dataset.carpeta ? +el.dataset.carpeta : null;
        pintarExplorador();
      }),
    );
    $$("[data-flow]", box).forEach((cb) =>
      cb.addEventListener("change", () => alternar(flows.find((f) => f.ns === cb.dataset.flow), cb.checked)),
    );
  };

  const pintarSelects = () => {
    const opciones = (actual) =>
      `<option value="">— Ninguno —</option>` +
      (flowsCache?.flows ?? [])
        .map((f) => `<option value="${esc(f.ns)}" ${f.ns === actual ? "selected" : ""}>${esc((rutaCarpeta(f.folderId) ? rutaCarpeta(f.folderId) + " / " : "") + f.name)}</option>`)
        .join("") +
      (actual && !(flowsCache?.flows ?? []).some((f) => f.ns === actual) ? `<option value="${esc(actual)}" selected>${esc(actual)}</option>` : "");
    $("#flow-aviso").innerHTML = opciones(A.avisos.flowAviso);
    $("#flow-confirmacion").innerHTML = opciones(A.agenda.flowConfirmacion);
  };

  const cargar = async (forzar) => {
    if (!E.configurado.manychat) {
      $("#explorador").innerHTML = `<div class="alert warn">Primero conectá ManyChat en <a href="#" data-ir="conexion">Conexión</a>.</div>`;
      pintarSelects();
      return;
    }
    if (!flowsCache || forzar) {
      $("#explorador").innerHTML = '<div class="empty">Cargando flows…</div>';
      try {
        flowsCache = await api("/api/manychat/flows");
      } catch (e) {
        $("#explorador").innerHTML = `<div class="alert bad">No pude leer tus flows: ${esc(e.message.replace(/\.$/, ""))}. Podés agregarlos a mano abajo.</div>`;
        pintarSelects();
        return;
      }
    }
    pintarExplorador();
    pintarSelects();
  };

  pintarElegidas();
  await cargar(false);
  $("#recargar-flows").addEventListener("click", () => cargar(true));
  $("#manual-add").addEventListener("click", () => {
    const ns = $("#manual-ns").value.trim();
    const nombre = $("#manual-nombre").value.trim() || ns;
    if (!ns) return toast("Pegá el ID del flow");
    alternar({ ns, name: nombre, folderId: null }, true);
    $("#manual-ns").value = $("#manual-nombre").value = "";
  });
  $("#guardar-autos").addEventListener("click", () => {
    const sinCuando = elegidas.filter((x) => !x.cuando_usar.trim());
    if (sinCuando.length && !confirm(`${sinCuando.length} automatización(es) no dicen cuándo usarlas. El bot va a decidir solo. ¿Guardar igual?`)) return;
    guardar((a) => (a.automatizaciones = elegidas));
  });
  $("#guardar-especiales").addEventListener("click", () =>
    guardar((a) => {
      a.avisos.flowAviso = $("#flow-aviso").value;
      a.avisos.flowAvisoNombre = $("#flow-aviso").selectedOptions[0]?.textContent ?? "";
      a.agenda.flowConfirmacion = $("#flow-confirmacion").value;
    }),
  );
};

// ------------------------------------------------------------------ CONSULTAS

VISTAS.consultas = async () => {
  const items = await api("/api/consultas");
  const pendientes = items.filter((c) => c.estado === "pendiente");
  const resueltas = items.filter((c) => c.estado !== "pendiente").slice(0, 30);
  const fecha = (iso) => new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
  main().innerHTML = `
    <h1>Consultas</h1>
    <p class="sub">Cuando el bot no sabe algo, te lo pregunta acá en lugar de inventar. Le decís al lead que lo consulta y sigue la charla.</p>
    ${
      pendientes.length
        ? pendientes
            .map(
              (c) => `<div class="card">
        <div class="row"><span class="pill ${c.tipo === "consulta" ? "warn" : "bad"}">${c.tipo === "consulta" ? "No sabe responder" : "Pidió una persona"}</span>
          <b class="grow">${esc(c.nombre || c.username || c.leadId)}${c.username ? ` <span class="hint">@${esc(c.username)}</span>` : ""}</b>
          <span class="hint">${fecha(c.creada)}</span></div>
        <h3>${c.tipo === "consulta" ? "Pregunta" : "Motivo"}: ${esc(c.texto)}</h3>
        ${c.ultimoMensaje ? `<p class="hint">Último mensaje del lead: "${esc(c.ultimoMensaje)}"</p>` : ""}
        <textarea data-resp="${c.id}" style="min-height:70px" placeholder="Escribí la respuesta para el lead…"></textarea>
        <div class="row" style="margin-top:8px">
          <label class="row" style="font-weight:400;margin:0"><input type="checkbox" data-enviar="${c.id}" checked> Mandársela al lead</label>
          ${c.tipo === "consulta" ? `<label class="row" style="font-weight:400;margin:0"><input type="checkbox" data-guardar="${c.id}" checked> Guardarla para que el bot la sepa la próxima vez</label>` : ""}
          ${c.tipo === "derivacion" ? `<label class="row" style="font-weight:400;margin:0"><input type="checkbox" data-reactivar="${c.id}"> Volver a activar el bot para este lead</label>` : ""}
        </div>
        <div class="row" style="margin-top:10px"><button class="btn primary" data-responder="${c.id}">Responder</button>
          <button class="btn" data-ver="${esc(c.leadId)}">Ver conversación</button>
          <button class="btn danger" data-descartar="${c.id}">Descartar</button></div>
      </div>`,
            )
            .join("")
        : '<div class="card"><div class="empty">No hay consultas pendientes 🎉</div></div>'
    }
    ${
      resueltas.length
        ? `<div class="card"><h2>Resueltas</h2><div class="list">${resueltas
            .map((c) => `<div class="item"><div class="grow"><div class="t">${esc(c.texto)}</div><div class="d">${c.estado === "respondida" ? `→ ${esc(c.respuesta)}` : "Descartada"}</div></div><span class="hint">${fecha(c.creada)}</span></div>`)
            .join("")}</div></div>`
        : ""
    }`;
  $$("[data-responder]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.dataset.responder;
      const respuesta = $(`[data-resp="${id}"]`).value.trim();
      if (!respuesta) return toast("Escribí la respuesta");
      b.disabled = true;
      try {
        await api(`/api/consultas/${id}/responder`, {
          method: "POST",
          body: {
            respuesta,
            enviar: $(`[data-enviar="${id}"]`).checked,
            guardar: !!$(`[data-guardar="${id}"]`)?.checked,
            reactivar: !!$(`[data-reactivar="${id}"]`)?.checked,
          },
        });
        toast("Respondido ✓");
        render();
      } catch (e) {
        toast(e.message);
        b.disabled = false;
      }
    }),
  );
  $$("[data-descartar]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/consultas/${b.dataset.descartar}/descartar`, { method: "POST", body: {} });
      render();
    }),
  );
  $$("[data-ver]").forEach((b) => b.addEventListener("click", () => verConversacion(b.dataset.ver)));
};

// ------------------------------------------------------------------ CONVERSACIONES

const ETAPAS = {
  nuevo: ["Nuevo", "off"],
  conversando: ["Conversando", "off"],
  calificado: ["Calificado", "ok"],
  no_calificado: ["No califica", "warn"],
  link_enviado: ["Link enviado", "ok"],
  agendado: ["Agendó ✓", "ok"],
  humano: ["Lo atiende una persona", "bad"],
};
const pillEtapa = (e) => `<span class="pill ${(ETAPAS[e] ?? [e, "off"])[1]}">${esc((ETAPAS[e] ?? [e])[0])}</span>`;

VISTAS.conversaciones = async () => {
  const items = await api("/api/conversaciones");
  main().innerHTML = `
    <h1>Conversaciones</h1>
    <p class="sub">Lo que está hablando el bot con cada lead. Podés pausarlo para responder vos.</p>
    <div class="list">${
      items.length
        ? items
            .map(
              (c) => `<div class="item clickable" data-id="${esc(c.id)}">
          <div class="grow"><div class="t">${esc(c.nombre || c.username || c.id)} ${c.username ? `<span class="hint">@${esc(c.username)}</span>` : ""} ${c.pausado ? "⏸️" : ""}</div>
          <div class="d">${c.ultimo ? `${c.ultimo.de === "bot" ? "🤖 " : ""}${esc(c.ultimo.texto)}` : ""}</div></div>
          ${pillEtapa(c.etapa)}</div>`,
            )
            .join("")
        : '<div class="empty">Todavía no hay conversaciones.</div>'
    }</div>`;
  $$("[data-id]").forEach((el) => el.addEventListener("click", () => verConversacion(el.dataset.id)));
};

async function verConversacion(id) {
  const l = await api(`/api/conversaciones/${encodeURIComponent(id)}`);
  $$("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.v === "conversaciones"));
  vista = "conversaciones";
  const perfil = Object.entries(l.perfil || {});
  main().innerHTML = `
    <button class="btn small" data-ir="conversaciones">← Volver</button>
    <h1 style="margin-top:12px">${esc([l.firstName, l.lastName].filter(Boolean).join(" ") || l.username || l.subscriberId)}</h1>
    <p class="sub">${l.username ? `@${esc(l.username)} · ` : ""}${pillEtapa(l.etapa)}${l.email ? ` · ${esc(l.email)}` : ""}${l.booking?.start ? ` · 📅 ${new Date(l.booking.start).toLocaleString("es-AR")}` : ""}</p>
    <div class="card toggle-big">
      <div><b>${l.paused ? "⏸️ Bot pausado para este lead" : "🤖 El bot responde a este lead"}</b>
        <div class="hint">${l.paused ? "Respondé vos desde ManyChat (Live Chat). Reactivalo cuando termines." : "Pausalo si querés responder vos."}</div></div>
      <button class="btn" id="pausa">${l.paused ? "Reactivar bot" : "Pausar bot"}</button>
    </div>
    ${perfil.length ? `<div class="card"><h2>Lo que averiguó el bot</h2>${perfil.map(([k, v]) => `<div><b>${esc(k)}:</b> ${esc(v)}</div>`).join("")}</div>` : ""}
    <div class="card"><div class="chat" style="max-height:none">${
      (l.turnos || [])
        // Visto desde tu cuenta: lo del bot a la derecha (como tus mensajes), lo del lead a la izquierda.
        .map((t) => `<div class="msg ${t.de === "bot" ? "lead" : "bot"}" title="${esc(new Date(t.at).toLocaleString("es-AR"))}">${esc(t.texto)}</div>`)
        .join("") || '<div class="empty">Sin mensajes.</div>'
    }</div></div>`;
  $("#pausa").addEventListener("click", async () => {
    await api(`/api/conversaciones/${encodeURIComponent(id)}/pausa`, { method: "POST", body: { pausar: !l.paused } });
    verConversacion(id);
  });
}

// ------------------------------------------------------------------ AUDIOS

const PROVEEDORES = {
  groq: {
    nombre: "Groq (recomendado)",
    pasos: [
      'Entrá a <a href="https://console.groq.com" target="_blank" rel="noopener">console.groq.com</a> y creá una cuenta (podés entrar con Google).',
      'En el menú, andá a <b>API Keys</b> → <b>Create API Key</b>. Ponele de nombre "setter".',
      "Copiá la key (empieza con <code>gsk_</code>) y pegala acá abajo. Solo se muestra una vez.",
      "Tocá <b>Guardar</b> y después probá con un audio tuyo.",
    ],
    nota: "Es muy rápido y tiene un plan gratuito para empezar. Una nota de voz cuesta una fracción de centavo.",
  },
  openai: {
    nombre: "OpenAI",
    pasos: [
      'Entrá a <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com/api-keys</a> e iniciá sesión.',
      "Cargá saldo en <b>Billing</b> (sin saldo no funciona).",
      "Tocá <b>Create new secret key</b>, copiala (empieza con <code>sk-</code>) y pegala acá abajo.",
      "Tocá <b>Guardar</b> y probá con un audio.",
    ],
    nota: "Usa el modelo gpt-4o-mini-transcribe.",
  },
  deepgram: {
    nombre: "Deepgram",
    pasos: [
      'Entrá a <a href="https://console.deepgram.com" target="_blank" rel="noopener">console.deepgram.com</a> y creá una cuenta (trae crédito de regalo).',
      "Andá a <b>API Keys</b> → <b>Create a New API Key</b>.",
      "Copiá la key y pegala acá abajo.",
      "Tocá <b>Guardar</b> y probá con un audio.",
    ],
    nota: "Usa el modelo nova-3.",
  },
};

VISTAS.audios = async () => {
  A = await api("/api/ajustes");
  const prov = A.audios.proveedor;
  main().innerHTML = `
    <h1>Audios</h1>
    <p class="sub">Claude lee texto e imágenes, pero no escucha audio. Por eso las notas de voz pasan primero por un servicio que las convierte en texto, y después el bot responde a lo que dijo la persona.</p>
    <div class="card">
      <label>Servicio de transcripción</label>
      <select id="proveedor">
        <option value="none" ${prov === "none" ? "selected" : ""}>Apagado (el bot le pide que lo escriba)</option>
        ${Object.entries(PROVEEDORES).map(([k, p]) => `<option value="${k}" ${prov === k ? "selected" : ""}>${esc(p.nombre)}</option>`).join("")}
      </select>
      <div id="tutorial"></div>
    </div>
    <div class="card" id="prueba-audio">
      <h2>Probar</h2>
      <p class="hint">Subí una nota de voz (mp3, m4a, ogg, mp4…) y fijate si la transcribe bien.</p>
      <div class="row"><input type="file" id="archivo" accept="audio/*,video/*"><button class="btn" id="probar-audio">Transcribir</button></div>
      <pre class="mono hidden" id="resultado-audio"></pre>
    </div>`;
  const pintar = () => {
    const p = $("#proveedor").value;
    const t = PROVEEDORES[p];
    $("#tutorial").innerHTML = t
      ? `<h3>Cómo conseguir la API key de ${esc(t.nombre.replace(" (recomendado)", ""))}</h3>
         <ol class="steps">${t.pasos.map((x) => `<li>${x}</li>`).join("")}</ol>
         <p class="hint">${esc(t.nota)}</p>
         <label>API key</label>${inputSecreto("audio-key", A.audios.claves[p], "Pegá la API key")}
         <label>Idioma principal de tus leads</label>
         <select id="idioma">${[["es", "Español"], ["en", "Inglés"], ["pt", "Portugués"]].map(([v, n]) => `<option value="${v}" ${A.audios.idioma === v ? "selected" : ""}>${n}</option>`).join("")}</select>
         <div class="row" style="margin-top:12px"><button class="btn primary" id="guardar-audio">Guardar</button></div>`
      : `<div class="row" style="margin-top:12px"><button class="btn primary" id="guardar-audio">Guardar</button></div>`;
    $("#guardar-audio").addEventListener("click", () =>
      guardar((a) => {
        a.audios.proveedor = p;
        if (t) {
          a.audios.claves[p] = leerSecreto("audio-key", a.audios.claves[p]);
          a.audios.idioma = $("#idioma").value;
        }
      }).then(() => VISTAS.audios()),
    );
  };
  $("#proveedor").addEventListener("change", pintar);
  pintar();
  $("#probar-audio").addEventListener("click", async (ev) => {
    const f = $("#archivo").files[0];
    if (!f) return toast("Elegí un archivo de audio");
    const out = $("#resultado-audio");
    out.classList.remove("hidden");
    out.textContent = "Transcribiendo…";
    ev.target.disabled = true;
    try {
      const r = await api("/api/probar/audio", { method: "POST", body: f, raw: true, type: f.type || "audio/mpeg" });
      out.textContent = (r.ok ? "✅ " : "❌ ") + r.texto;
    } catch (e) {
      out.textContent = "❌ " + e.message;
    }
    ev.target.disabled = false;
  });
};

// ------------------------------------------------------------------ AGENDA

VISTAS.agenda = async () => {
  A = await api("/api/ajustes");
  const g = A.agenda;
  main().innerHTML = `
    <h1>Agenda</h1>
    <p class="sub">Cómo el bot lleva al lead a agendar la llamada de venta.</p>
    <div class="card">
      <label><input type="radio" name="modo" value="link" ${g.modo === "link" ? "checked" : ""}> Mandar mi link de agenda (Calendly, Cal.com, TidyCal…)</label>
      <div class="hint" style="margin-left:22px">El bot manda tu link con el nombre y email del lead ya cargados. Lo más simple.</div>
      <label><input type="radio" name="modo" value="calcom" ${g.modo === "calcom" ? "checked" : ""}> Que el bot agende solo (Cal.com)</label>
      <div class="hint" style="margin-left:22px">El bot ofrece 2 o 3 horarios libres, pide el email y reserva la llamada en tu calendario.</div>
      <label><input type="radio" name="modo" value="ninguna" ${g.modo === "ninguna" ? "checked" : ""}> Sin agenda (te aviso y coordinás vos)</label>

      <div id="modo-link">
        <label>Tu link de agenda</label>
        <input type="url" id="link" value="${esc(g.link)}" placeholder="https://calendly.com/tu-usuario/llamada">
      </div>
      <div id="modo-calcom">
        <h3>Conectar Cal.com</h3>
        <ol class="steps">
          <li>En Cal.com, creá un tipo de evento para la llamada (ej. "Llamada de diagnóstico, 30 min").</li>
          <li>Abrí ese evento: el número que aparece en la URL (…/event-types/<b>123456</b>) es el ID. Pegalo abajo.</li>
          <li>Andá a <b>Settings → Developer → API Keys</b>, creá una key y pegala abajo.</li>
        </ol>
        <label>ID del tipo de evento</label><input type="text" id="cal-evento" value="${esc(g.calEventTypeId)}" placeholder="123456">
        <label>API key de Cal.com</label>${inputSecreto("cal-key", g.calApiKey, "cal_live_…")}
      </div>
      <label>Zona horaria de tu negocio</label>
      <input type="text" id="zona" value="${esc(g.zonaHoraria)}" placeholder="America/Argentina/Buenos_Aires">
      <div class="row" style="margin-top:12px"><button class="btn primary" id="guardar-agenda">Guardar</button></div>
    </div>`;
  const sync = () => {
    const m = $('input[name="modo"]:checked').value;
    $("#modo-link").classList.toggle("hidden", m !== "link");
    $("#modo-calcom").classList.toggle("hidden", m !== "calcom");
  };
  $$('input[name="modo"]').forEach((r) => r.addEventListener("change", sync));
  sync();
  $("#guardar-agenda").addEventListener("click", () =>
    guardar((a) => {
      a.agenda.modo = $('input[name="modo"]:checked').value;
      a.agenda.link = $("#link").value.trim();
      a.agenda.calEventTypeId = $("#cal-evento").value.trim();
      a.agenda.calApiKey = leerSecreto("cal-key", a.agenda.calApiKey);
      a.agenda.zonaHoraria = $("#zona").value.trim() || "America/Argentina/Buenos_Aires";
    }),
  );
};

// ------------------------------------------------------------------ CONEXIÓN

VISTAS.conexion = async () => {
  A = await api("/api/ajustes");
  const ch = E.chequeos;
  const url = E.webhook.url;
  const body = '{ "subscriber_id": "{{user_id}}", "first_name": "{{first_name}}", "username": "{{ig_username}}", "text": "{{last_input_text}}" }';
  main().innerHTML = `
    <h1>Conexión</h1>
    <p class="sub">Las cuentas que usa el bot. Las claves quedan guardadas solo en esta compu.</p>

    <div class="card">
      <div class="row"><h2 class="grow" style="margin:0">1. Claude (el cerebro)</h2>${pill(ch.claude?.ok, ch.claude?.detalle ?? "", ch.claude?.detalle ?? "")}</div>
      <ol class="steps" style="margin-top:12px">
        <li>Entrá a <a href="https://platform.claude.com" target="_blank" rel="noopener">platform.claude.com</a>, creá tu cuenta y cargá saldo en <b>Billing</b>.</li>
        <li>Andá a <b>API Keys</b> → <b>Create Key</b>, copiala (empieza con <code>sk-ant-</code>) y pegala acá.</li>
      </ol>
      <label>API key de Claude</label>${inputSecreto("claude-key", A.claude.apiKey, "sk-ant-…")}
      <label>Velocidad de respuesta</label>
      <select id="esfuerzo">
        <option value="low" ${A.claude.esfuerzo === "low" ? "selected" : ""}>Rápido (recomendado para chat)</option>
        <option value="medium" ${A.claude.esfuerzo === "medium" ? "selected" : ""}>Equilibrado</option>
        <option value="high" ${A.claude.esfuerzo === "high" ? "selected" : ""}>Más pensado (más lento)</option>
      </select>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="guardar-claude">Guardar y probar</button></div>
    </div>

    <div class="card">
      <div class="row"><h2 class="grow" style="margin:0">2. ManyChat</h2>${pill(ch.manychat?.ok, ch.manychat?.detalle ?? "", ch.manychat?.detalle ?? "")}</div>
      <ol class="steps" style="margin-top:12px">
        <li>Necesitás ManyChat <b>Pro</b> con tu Instagram conectado.</li>
        <li>En ManyChat: <b>Settings → API</b> → <b>Generate your API Key</b>. Copiala y pegala acá.</li>
        <li>Tocá <b>Preparar ManyChat</b>: crea solo los tags y campos que usa el bot.</li>
      </ol>
      <label>API key de ManyChat</label>${inputSecreto("mc-key", A.manychat.apiKey, "1234567:abcdef…")}
      <div class="row" style="margin-top:12px"><button class="btn primary" id="guardar-mc">Guardar y probar</button>
        <button class="btn" id="preparar-mc" ${A.manychat.apiKey ? "" : "disabled"}>Preparar ManyChat</button></div>
      <div id="preparar-out"></div>
    </div>

    <div class="card">
      <div class="row"><h2 class="grow" style="margin:0">3. Conexión con internet</h2>${
        E.tunel.url ? '<span class="pill ok">● Abierta</span>' : E.tunel.iniciando ? '<span class="pill warn">Abriendo…</span>' : '<span class="pill off">Cerrada</span>'
      }</div>
      <p class="hint">ManyChat necesita una dirección en internet para pasarle los mensajes a esta compu. Usamos <b>ngrok</b> (gratis), que te da una dirección fija: la configurás una sola vez en ManyChat.</p>
      <ol class="steps">
        <li>Creá una cuenta gratis en <a href="https://dashboard.ngrok.com/signup" target="_blank" rel="noopener">ngrok.com</a>.</li>
        <li>Copiá tu <b>Authtoken</b> de <a href="https://dashboard.ngrok.com/get-started/your-authtoken" target="_blank" rel="noopener">esta página</a> y pegalo abajo.</li>
        <li>En <a href="https://dashboard.ngrok.com/domains" target="_blank" rel="noopener">Domains</a> reclamá tu dominio gratis (algo como <code>nombre.ngrok-free.app</code>) y pegalo abajo.</li>
        <li>Tocá <b>Abrir conexión</b>.</li>
      </ol>
      <label>Authtoken de ngrok</label>${inputSecreto("ngrok-token", A.tunel.authtoken, "2abc…")}
      <label>Tu dominio de ngrok</label><input type="text" id="ngrok-dominio" value="${esc(A.tunel.dominio)}" placeholder="tu-nombre.ngrok-free.app">
      ${E.tunel.error ? `<div class="alert bad">${esc(E.tunel.error)}</div>` : ""}
      <div class="row" style="margin-top:12px"><button class="btn primary" id="guardar-tunel">Guardar</button>
        ${E.tunel.url ? '<button class="btn danger" id="cerrar-tunel">Cerrar conexión</button>' : '<button class="btn" id="abrir-tunel">Abrir conexión</button>'}</div>
    </div>

    <div class="card">
      <h2>4. Conectar ManyChat con el bot</h2>
      ${url ? "" : '<div class="alert warn">Primero abrí la conexión (paso 3) para tener tu dirección.</div>'}
      <ol class="steps">
        <li>En ManyChat andá a <b>Automation → Default Reply</b> (Instagram) y poné la frecuencia en <b>"Every time"</b>.</li>
        <li>En ese flow agregá una acción <b>External Request</b>.</li>
        <li>Request type: <b>POST</b>. Request URL:${copiable(url || "(abrí la conexión primero)")}</li>
        <li>En <b>Headers</b> agregá uno con nombre <code>X-Webhook-Secret</code> y este valor:${copiable(E.webhook.secreto)}</li>
        <li>En <b>Body</b> elegí JSON y pegá esto (después reemplazá cada valor entre llaves usando el botón <b>{+} Add a Variable</b> de ManyChat: Contact Id, First Name, Instagram Username y Last Text Input):${copiable(body)}
          <div class="hint">O más fácil: activá <b>"Add Full Contact Data"</b> y dejá el body vacío.</div></li>
        <li>No pongas mensajes después del External Request: el bot responde solo. Publicá el flow.</li>
        <li>Activá el bot desde <a href="#" data-ir="inicio">Inicio</a> y mandá un DM de prueba desde otra cuenta.</li>
      </ol>
      <details><summary>¿Y si apago la compu?</summary>
        <p>Mientras la compu esté apagada o la app cerrada, el bot no responde (los mensajes quedan sin contestar en ManyChat y los ves en Live Chat). Si querés que responda 24/7, el siguiente paso es subirlo a un servidor en la nube: funciona igual que acá.</p>
      </details>
    </div>`;

  $("#guardar-claude").addEventListener("click", async () => {
    await guardar((a) => {
      a.claude.apiKey = leerSecreto("claude-key", a.claude.apiKey);
      a.claude.esfuerzo = $("#esfuerzo").value;
    });
    const r = await api("/api/probar/claude", { method: "POST", body: {} });
    toast(r.ok ? "Claude conectado ✓" : r.detalle);
    VISTAS.conexion();
  });
  $("#guardar-mc").addEventListener("click", async () => {
    await guardar((a) => (a.manychat.apiKey = leerSecreto("mc-key", a.manychat.apiKey)));
    const r = await api("/api/probar/manychat", { method: "POST", body: {} });
    toast(r.ok ? r.detalle : r.detalle);
    flowsCache = null;
    await refrescarEstado();
    VISTAS.conexion();
  });
  $("#preparar-mc").addEventListener("click", async (ev) => {
    ev.target.disabled = true;
    try {
      const r = await api("/api/manychat/preparar", { method: "POST", body: {} });
      $("#preparar-out").innerHTML = `<div class="alert ok">Listo. ${r.creados.length ? `Creé: ${esc(r.creados.join(", "))}.` : ""} ${r.existentes.length ? `Ya estaban: ${esc(r.existentes.join(", "))}.` : ""}</div>`;
    } catch (e) {
      $("#preparar-out").innerHTML = `<div class="alert bad">${esc(e.message)}</div>`;
    }
    ev.target.disabled = false;
  });
  $("#guardar-tunel").addEventListener("click", async () => {
    await guardar((a) => {
      a.tunel.authtoken = leerSecreto("ngrok-token", a.tunel.authtoken);
      a.tunel.dominio = $("#ngrok-dominio").value.trim();
    });
    VISTAS.conexion();
  });
  $("#abrir-tunel")?.addEventListener("click", async (ev) => {
    ev.target.disabled = true;
    ev.target.textContent = "Abriendo…";
    const r = await api("/api/tunel", { method: "POST", body: { activo: true } });
    toast(r.tunel.url ? "Conexión abierta ✓" : r.tunel.error || "No se pudo abrir");
    await refrescarEstado();
    VISTAS.conexion();
  });
  $("#cerrar-tunel")?.addEventListener("click", async () => {
    await api("/api/tunel", { method: "POST", body: { activo: false } });
    await refrescarEstado();
    VISTAS.conexion();
  });
};

// ------------------------------------------------------------------ ANÁLISIS

function markdown(md) {
  const lines = md.split("\n");
  let html = "";
  let i = 0;
  const inline = (s) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  while (i < lines.length) {
    const l = lines[i];
    if (/^\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const body = rows.filter((r) => !/^\|[\s|:-]+\|$/.test(r));
      html += `<table><thead><tr>${cells(body[0]).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body
        .slice(1)
        .map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`;
      continue;
    }
    if (/^#{1,3} /.test(l)) {
      const n = l.match(/^#+/)[0].length;
      html += `<h${n}>${inline(l.slice(n + 1))}</h${n}>`;
    } else if (/^\s*[-*] /.test(l)) {
      html += "<ul>";
      while (i < lines.length && /^\s*[-*] /.test(lines[i])) html += `<li>${inline(lines[i++].replace(/^\s*[-*] /, ""))}</li>`;
      html += "</ul>";
      continue;
    } else if (/^\d+\. /.test(l)) {
      html += "<ol>";
      while (i < lines.length && /^\d+\. /.test(lines[i])) html += `<li>${inline(lines[i++].replace(/^\d+\. /, ""))}</li>`;
      html += "</ol>";
      continue;
    } else if (/^> /.test(l)) html += `<div class="alert warn">${inline(l.slice(2))}</div>`;
    else if (/^---+$/.test(l)) html += "<hr>";
    else if (l.trim()) html += `<p>${inline(l)}</p>`;
    i++;
  }
  return html;
}

VISTAS.analisis = async () => {
  main().innerHTML = `
    <h1>Análisis</h1>
    <p class="sub">Dónde deja de responder la gente: después de qué pregunta se caen los leads y qué cambiar.</p>
    <div class="card"><div class="row">
      <select id="dias" style="width:auto"><option value="7">Últimos 7 días</option><option value="30" selected>Últimos 30 días</option><option value="90">Últimos 90 días</option><option value="0">Todo</option></select>
      <label class="row" style="font-weight:400;margin:0"><input type="checkbox" id="ia" checked> Pedir recomendaciones a Claude</label>
      <button class="btn primary" id="correr">Analizar</button></div>
      <p class="hint">Con pocas conversaciones los números todavía no son confiables (se marcan con ⚠️).</p>
    </div>
    <div class="card md hidden" id="reporte"></div>`;
  $("#correr").addEventListener("click", async (ev) => {
    ev.target.disabled = true;
    ev.target.textContent = "Analizando…";
    const box = $("#reporte");
    try {
      const r = await api("/api/analisis", { method: "POST", body: { dias: +$("#dias").value, ia: $("#ia").checked } });
      box.innerHTML = markdown(r.markdown);
      box.classList.remove("hidden");
    } catch (e) {
      box.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`;
      box.classList.remove("hidden");
    }
    ev.target.disabled = false;
    ev.target.textContent = "Analizar";
  });
};

// ------------------------------------------------------------------ arranque

irA("inicio");
setInterval(() => refrescarEstado().catch(() => {}), 8000);
