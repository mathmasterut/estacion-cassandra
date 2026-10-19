// Estacion UTHH · servidor web y API REST sobre Cassandra.
// Entrega las paginas de web/ y responde /api/... con JSON.
// Cada respuesta trae "cql": las sentencias que se ejecutaron.
const http = require("http");
const fs = require("fs");
const path = require("path");
const bd = require("./bd");
const { KS, LocalDate, ejecutar, leerSensores, guardarLectura, diaLocal } = bd;

const PUERTO = 3000;
const WEB = path.join(__dirname, "web");
const TABLAS = ["sensores", "lecturas_por_sensor_dia", "ultima_lectura",
  "alertas_por_dia", "conteo_por_dia"];
// Una sola conexion para todo el servidor
const cliente = bd.crearCliente();

// GET /api/estado : version de Cassandra y tablas que existen
async function estado() {
  const cql = [];
  const v = (await ejecutar(cliente,
    "SELECT release_version FROM system.local", [], cql)).first();
  const t = await ejecutar(cliente,
    "SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?",
    [KS], cql);
  const tablas = t.rows.map(r => r.table_name);
  const faltan = TABLAS.filter(x => !tablas.includes(x));
  return { version: v.release_version, tablas, faltan, cql };
}

// GET /api/sensores : catalogo + ultima lectura + lecturas de hoy
async function sensores() {
  const cql = [];
  const hoy = diaLocal();
  const catalogo = await leerSensores(cliente, cql);
  const ultimas = {};
  const u = await ejecutar(cliente,
    `SELECT sensor, hora, temperatura, humedad FROM ${KS}.ultima_lectura`,
    [], cql);
  for (const r of u.rows) {
    ultimas[r.sensor] = {
      hora: r.hora, temperatura: r.temperatura, humedad: r.humedad };
  }
  const lista = [];
  for (const s of Object.values(catalogo)) {
    const c = await ejecutar(cliente,
      `SELECT lecturas FROM ${KS}.conteo_por_dia WHERE sensor = ? AND dia = ?`,
      [s.id, LocalDate.fromString(hoy)], cql);
    const fila = c.first();
    lista.push({ ...s, ultima: ultimas[s.id] || null,
      lecturasHoy: fila ? Number(fila.lecturas) : 0 });
  }
  lista.sort((a, b) => a.id.localeCompare(b.id));
  return { hoy, sensores: lista, cql };
}

// GET /api/sensores/uthh-01/lecturas?dia=AAAA-MM-DD&limite=1000
// Lee UNA particion: (sensor, dia)
async function lecturas(id, q) {
  const cql = [];
  const dia = q.get("dia") || diaLocal();
  const limite = Math.min(Number(q.get("limite")) || 1000, 5000);
  const r = await ejecutar(cliente,
    `SELECT hora, temperatura, humedad FROM ${KS}.lecturas_por_sensor_dia
     WHERE sensor = ? AND dia = ? LIMIT ?`,
    [id, LocalDate.fromString(dia), limite], cql);
  const filas = r.rows.map(x => ({
    hora: x.hora, temperatura: x.temperatura, humedad: x.humedad }));
  return { sensor: id, dia, lecturas: filas, cql };
}

// GET /api/alertas?dia=AAAA-MM-DD : alertas de un dia (una particion)
async function alertas(q) {
  const cql = [];
  const dia = q.get("dia") || diaLocal();
  const r = await ejecutar(cliente,
    `SELECT hora, sensor, temperatura, mensaje FROM ${KS}.alertas_por_dia
     WHERE dia = ? LIMIT 200`,
    [LocalDate.fromString(dia)], cql);
  const filas = r.rows.map(x => ({ hora: x.hora, sensor: x.sensor,
    temperatura: x.temperatura, mensaje: x.mensaje }));
  return { dia, alertas: filas, cql };
}

// POST /api/lecturas {"sensor":"uthh-01","temperatura":27.5,"humedad":70}
async function registrar(datos) {
  const cql = [];
  const s = (await leerSensores(cliente, cql))[datos.sensor];
  if (!s) throw new Error("No existe el sensor " + datos.sensor);
  const t = Number(datos.temperatura);
  const h = Number(datos.humedad);
  if (!(t >= -20 && t <= 60)) {
    throw new Error("La temperatura debe estar entre -20 y 60 °C");
  }
  if (!(h >= 0 && h <= 100)) {
    throw new Error("La humedad debe estar entre 0 y 100 %");
  }
  const lectura = { hora: new Date(), temperatura: t, humedad: h };
  const r = await guardarLectura(cliente, s, lectura, cql);
  return { sensor: s.id, dia: r.dia, alerta: r.alerta, cql };
}

// Tipos de archivo que entrega el servidor
const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

// 1) Archivos de la carpeta web/
function archivoWeb(ruta, res) {
  const nombre = ruta === "/" ? "index.html" : path.normalize(ruta);
  const archivo = path.join(WEB, nombre);
  if (!archivo.startsWith(WEB)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(archivo, (e, contenido) => {
    if (e) {
      res.writeHead(404);
      return res.end("No encontrado");
    }
    const tipo = TIPOS[path.extname(archivo)] || "text/plain";
    res.writeHead(200, { "Content-Type": tipo });
    res.end(contenido);
  });
}

// 2) Rutas de la API: siempre responden JSON
async function rutaApi(req, ruta, q) {
  const get = req.method === "GET";
  const m = ruta.match(/^\/api\/sensores\/([\w-]+)\/lecturas$/);
  if (get && ruta === "/api/estado") return estado();
  if (get && ruta === "/api/sensores") return sensores();
  if (get && m) return lecturas(m[1], q);
  if (get && ruta === "/api/alertas") return alertas(q);
  if (req.method === "POST" && ruta === "/api/lecturas") {
    // Lee el JSON que envio la pagina
    let cuerpo = "";
    for await (const parte of req) cuerpo += parte;
    return registrar(JSON.parse(cuerpo || "{}"));
  }
  return null;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const ruta = url.pathname;
  if (!ruta.startsWith("/api/")) return archivoWeb(ruta, res);
  let codigo = 200;
  let respuesta;
  try {
    respuesta = await rutaApi(req, ruta, url.searchParams);
    if (respuesta === null) {
      codigo = 404;
      respuesta = { error: "Ruta no encontrada: " + ruta };
    }
  } catch (e) {
    codigo = 400;
    respuesta = { error: e.message };
    console.error("Error:", e.message);
  }
  const tipo = "application/json; charset=utf-8";
  res.writeHead(codigo, { "Content-Type": tipo });
  res.end(JSON.stringify(respuesta));
}).listen(PUERTO, () => {
  console.log("Estacion UTHH en el puerto " + PUERTO);
});