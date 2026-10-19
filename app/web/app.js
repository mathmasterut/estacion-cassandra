// Estacion UTHH · funciones que comparten todas las paginas.
// Las paginas NO hablan con Cassandra: piden los datos a la API.
// La API responde JSON con los datos y con el CQL que ejecuto.

// Pide algo a la API y devuelve el JSON.
// Si hay error, lanza el mensaje que mando el servidor.
async function api(ruta, metodo = "GET", datos) {
  const opciones = {
    method: metodo,
    headers: { "Content-Type": "application/json" },
  };
  if (datos) opciones.body = JSON.stringify(datos);
  let r;
  try {
    r = await fetch("/api" + ruta, opciones);
  } catch (e) {
    throw new Error("Sin conexion con el servidor: "
      + "revisa que node servidor.js siga corriendo.");
  }
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error || "Error HTTP " + r.status);
  return json;
}

// Crea un elemento HTML con clase y texto
function el(etiqueta, clase, texto) {
  const e = document.createElement(etiqueta);
  if (clase) e.className = clase;
  if (texto !== undefined) e.textContent = texto;
  return e;
}

// Cassandra guarda la hora en UTC.
// El navegador la muestra en hora local.
const horaLocal = s => new Date(s).toLocaleTimeString("es-MX");

// Numero con un decimal, o un guion si no hay dato
function num(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toFixed(1);
}

// Fecha de hoy en formato AAAA-MM-DD (hora local)
function hoyLocal() {
  const d = new Date();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + mes + "-" + dia;
}

// "hace 5 s", "hace 3 min" o la fecha completa
function hace(s) {
  const seg = Math.round((Date.now() - new Date(s)) / 1000);
  if (seg < 60) return "hace " + Math.max(seg, 0) + " s";
  if (seg < 3600) return "hace " + Math.round(seg / 60) + " min";
  return new Date(s).toLocaleString("es-MX");
}

// Muestra un aviso (tipo "error" en rojo) dentro de un contenedor
function aviso(contenedor, texto, tipo = "") {
  contenedor.textContent = "";
  if (texto) contenedor.append(el("div", "aviso " + tipo, texto));
}

// Muestra el CQL que ejecuto la API
function verCql(contenedor, lineas) {
  contenedor.textContent = "";
  const d = el("details");
  const titulo = "CQL que ejecuto la API (" + lineas.length + ")";
  d.append(el("summary", null, titulo));
  d.append(el("pre", null, lineas.join("\n")));
  contenedor.append(d);
}

// Menu superior y estado de la conexion con Cassandra
function menu(actual) {
  const nav = el("nav");
  nav.append(el("b", null, "Estacion UTHH"));
  const paginas = [
    ["index.html", "Tablero"],
    ["sensor.html", "Sensor"],
    ["registrar.html", "Registrar"],
  ];
  for (const [pagina, texto] of paginas) {
    const a = el("a", null, texto);
    a.href = pagina;
    if (pagina === actual) a.setAttribute("aria-current", "page");
    nav.append(a);
  }
  const estado = el("span", null, "Conectando...");
  estado.id = "estado";
  nav.append(estado);
  const header = el("header");
  header.append(nav);
  document.body.prepend(header);
  api("/estado")
    .then(e => {
      const falta = e.faltan.length ? " · faltan tablas" : "";
      estado.textContent = "● Cassandra " + e.version + falta;
    })
    .catch(e => {
      estado.textContent = "● Sin conexion";
      estado.title = e.message;
    });
}

// Grafica SVG:
//   temperatura en naranja (eje izquierdo)
//   humedad en azul (eje derecho, 0 a 100 %)
function grafica(contenedor, lecturas) {
  contenedor.textContent = "";
  if (!lecturas.length) {
    const texto = "Sin lecturas en esta particion (sensor + dia).";
    contenedor.append(el("p", "nota", texto));
    return;
  }
  // Llegan de la mas nueva a la mas vieja: se invierten
  const d = lecturas.slice().reverse();
  const W = 800, H = 280, m = 40;
  const t0 = new Date(d[0].hora).getTime();
  const tFin = new Date(d[d.length - 1].hora).getTime();
  const t1 = Math.max(tFin, t0 + 1);
  const temps = d.map(p => p.temperatura);
  const tMin = Math.floor(Math.min(...temps) - 1);
  const tMax = Math.ceil(Math.max(...temps) + 1);

  // Convierten tiempo, temperatura y humedad a pixeles
  const x = t => m + (t - t0) / (t1 - t0) * (W - 2 * m);
  const yT = v => 10 + (1 - (v - tMin) / (tMax - tMin)) * (H - m - 10);
  const yH = v => 10 + (1 - v / 100) * (H - m - 10);

  // Dibuja una linea uniendo todas las lecturas
  function linea(f, color) {
    const puntos = d.map((p, i) => {
      const px = x(new Date(p.hora).getTime()).toFixed(1);
      const py = f(p).toFixed(1);
      return (i ? "L" : "M") + px + " " + py;
    });
    return `<path fill="none" stroke="${color}" stroke-width="2"`
      + ` d="${puntos.join(" ")}"/>`;
  }

  // Lineas guia y etiquetas de los ejes
  let ejes = "";
  for (let k = 0; k <= 4; k++) {
    const v = tMin + (tMax - tMin) * k / 4;
    const t = t0 + (t1 - t0) * k / 4;
    const hora = new Date(t).toLocaleTimeString("es-MX",
      { hour: "2-digit", minute: "2-digit" });
    ejes += `<line x1="${m}" x2="${W - m}" y1="${yT(v)}" y2="${yT(v)}"`
      + ` stroke="#8899AA" stroke-opacity=".25"/>`;
    ejes += `<text x="${m - 6}" y="${yT(v) + 4}" text-anchor="end">`
      + `${v.toFixed(0)}°</text>`;
    ejes += `<text x="${W - m + 6}" y="${yH(k * 25) + 4}">`
      + `${k * 25}%</text>`;
    ejes += `<text x="${x(t)}" y="${H - 12}" text-anchor="middle">`
      + `${hora}</text>`;
  }

  contenedor.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%"`
    + ` role="img" aria-label="Grafica de temperatura y humedad">`
    + ejes
    + linea(p => yH(p.humedad), "#3A9BD9")
    + linea(p => yT(p.temperatura), "#D9822B")
    + "</svg>";
}