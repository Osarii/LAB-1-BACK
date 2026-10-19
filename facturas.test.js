import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CalendarioLaboral, Factura, ServicioFacturacion, fechaISO } from '../src/facturas.js';
import { main, crearClienteNager, datosFicticios } from '../src/main.js';

const base = { id: 'F-1', cliente: 'Cliente Ficticio', monto: 500, fechaEmision: '2026-12-18', estado: 'pendiente' };
const feriado = date => ({ date, countryCode: 'CR', global: true, types: ['Public'] });
const cliente = async anio => [feriado('2026-12-25'), feriado('2027-01-01')].filter(f => f.date.startsWith(String(anio)));
const servicio = (hoy = '2027-01-12', cargar = cliente) =>
  new ServicioFacturacion(new CalendarioLaboral(cargar), { hoy });
const workflow = async () => JSON.parse(await readFile(new URL('../workflows/facturas-dias-habiles.json', import.meta.url), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const ejecutar = async (codigo, entradas, httpRequest = async () => { throw new Error('Red prohibida'); }) =>
  new AsyncFunction('$input', '$helpers', codigo)({ all: () => entradas.map(json => ({ json })) }, { httpRequest });

test('15 días hábiles excluyen emisión, fines de semana y ambos años; caché anual', async () => {
  const llamadas = [];
  const calendario = new CalendarioLaboral(async (anio, pais) => {
    llamadas.push([anio, pais]); return cliente(anio);
  });
  assert.equal(await calendario.vencimiento('2026-12-18'), '2027-01-12');
  assert.equal(await calendario.vencimiento('2026-12-18'), '2027-01-12');
  assert.deepEqual(llamadas, [[2026, 'CR'], [2027, 'CR']]);
});
test('sin feriados: lunes a lunes tres semanas; emisión en sábado', async () => {
  const calendario = new CalendarioLaboral(async () => []);
  assert.equal(await calendario.vencimiento('2026-03-02'), '2026-03-23');
  assert.equal(await calendario.vencimiento('2026-03-07'), '2026-03-27');
});
test('feriados oficiales nacionales, duplicados, fin de semana y bisiesto', async () => {
  const calendario = new CalendarioLaboral(async () => [
    feriado('2026-03-03'), feriado('2026-03-03'), feriado('2026-03-07'),
    { ...feriado('2026-03-04'), global: false },
    { ...feriado('2026-03-05'), types: ['Observance'] }
  ]);
  assert.equal(await calendario.vencimiento('2026-03-02'), '2026-03-24');
  assert.equal(fechaISO('2028-02-29').toISOString().slice(0, 10), '2028-02-29');
  for (const fecha of ['2026-02-29', '2026-04-31', '2026-2-01', '', null]) {
    assert.throws(() => fechaISO(fecha), /Fecha/);
  }
});
test('campos obligatorios, monto positivo y estados válidos', async () => {
  for (const cambio of [
    { id: '' }, { id: {} }, { cliente: ' ' }, { monto: 0 }, { monto: -1 },
    { monto: Infinity }, { monto: NaN }, { monto: '12' }, { estado: 'desconocido' },
    { fechaEmision: '2026-02-30' }, { procesada: 'true' }
  ]) {
    assert.throws(() => new Factura({ ...base, ...cambio }));
    assert.equal((await servicio().procesar({ ...base, ...cambio })).tipo, 'DATOS_INVALIDOS');
  }
  for (const campo of ['id', 'cliente', 'monto', 'fechaEmision', 'estado']) {
    const datos = { ...base }; delete datos[campo];
    assert.equal((await servicio().procesar(datos)).tipo, 'DATOS_INVALIDOS');
  }
  assert.equal((await servicio().procesar(null)).tipo, 'DATOS_INVALIDOS');
});
test('procesadas y anuladas no consultan feriados ni producen actualizaciones', async () => {
  const s = servicio(undefined, async () => { assert.fail('No debe consultar'); });
  for (const cambio of [{ estado: 'anulada' }, { estado: 'procesada' }, { procesada: true }]) {
    assert.deepEqual(await s.procesar({ ...base, ...cambio }), { actualizar: false, tipo: 'OMITIDA', id: base.id });
  }
});
test('clasificación temporal y umbral inclusivo con prioridad de vencimiento', async () => {
  for (const [hoy, estadoCobro, alerta] of [
    ['2027-01-13', 'vencida', 'vencida'], ['2027-01-12', 'vence_hoy', 'vence_hoy'],
    ['2027-01-11', 'vigente', 'normal']
  ]) {
    const resultado = await servicio(hoy).procesar(base);
    assert.equal(resultado.factura.estadoCobro, estadoCobro);
    assert.equal(resultado.factura.alerta, alerta);
  }
  assert.equal((await servicio('2027-01-11').procesar({ ...base, monto: 10000 })).factura.alerta, 'monto_alto');
  assert.throws(() => new ServicioFacturacion(new CalendarioLaboral(cliente), { umbral: 0 }));
});
test('fallos de API y esquema no generan vencimiento; otros elementos continúan', async () => {
  for (const cargar of [
    async () => { throw new Error('timeout'); }, async () => ({}),
    async () => [{ date: 'fecha rota' }],
    async () => [{ ...feriado('2026-12-25'), countryCode: 'US' }]
  ]) {
    const resultado = await servicio(undefined, cargar).procesar(base);
    assert.equal(resultado.tipo, 'API_FERIADOS');
    assert.equal(resultado.actualizar, false);
    assert.equal(resultado.factura, undefined);
  }
  const resultados = await servicio().procesarTodas([{ ...base, monto: -1 }, base]);
  assert.deepEqual(resultados.map(r => r.tipo), ['DATOS_INVALIDOS', 'PROCESADA']);
  await assert.rejects(servicio().procesarTodas({}), /lista/);
});
test('main offline, datos inmutables y reejecución idempotente', async () => {
  const copia = JSON.stringify(datosFicticios);
  const resultados = await main();
  assert.equal(resultados[0].factura.fechaVencimiento, '2027-01-12');
  assert.equal(resultados[1].tipo, 'OMITIDA');
  assert.equal(JSON.stringify(datosFicticios), copia);
  assert.equal((await main({ facturas: [resultados[0].factura] }))[0].tipo, 'OMITIDA');
  let consultas = 0;
  await main({ facturas: [base], clienteFeriados: async anio => { consultas++; return cliente(anio); } });
  assert.equal(consultas, 2);
});
test('adaptador Nager usa transporte inyectado, URL correcta y rechaza HTTP fallido', async () => {
  const adaptador = crearClienteNager(async (url, opciones) => {
    assert.equal(url, 'https://date.nager.at/api/v3/PublicHolidays/2026/CR');
    assert.ok(opciones.signal);
    return { ok: true, json: async () => [feriado('2026-12-25')] };
  });
  assert.deepEqual(await adaptador(2026, 'CR'), [feriado('2026-12-25')]);
  await assert.rejects(crearClienteNager(async () => ({ ok: false, status: 503 }))(2026, 'CR'), /503/);
  assert.throws(() => crearClienteNager(), /Transporte/);
});
test('workflow importable: IF real, ramas conectadas, PATCH y errores de HTTP', async () => {
  const w = await workflow();
  assert.equal(w.active, false);
  assert.equal(new Set(w.nodes.map(n => n.id)).size, w.nodes.length);
  const buscar = nombre => w.nodes.find(n => n.name === nombre);
  for (const [origen, conexiones] of Object.entries(w.connections)) {
    assert.ok(buscar(origen));
    for (const rama of conexiones.main) for (const destino of rama) assert.ok(buscar(destino.node));
  }
  const condicion = buscar('Actualizar factura valida');
  assert.equal(condicion.type, 'n8n-nodes-base.if');
  assert.equal(condicion.parameters.conditions.conditions[0].leftValue, '={{ $json.actualizar }}');
  assert.equal(w.connections[condicion.name].main[0][0].node, 'Actualizar JSON Server');
  assert.equal(w.connections[condicion.name].main[1][0].node, 'Errores y omisiones');
  assert.equal(buscar('Actualizar JSON Server').parameters.method, 'PATCH');
  assert.match(buscar('Actualizar JSON Server').parameters.jsonBody, /factura/);
  for (const nombre of ['Leer facturas', 'Actualizar JSON Server']) {
    assert.equal(buscar(nombre).onError, 'continueRegularOutput');
    assert.equal(buscar(nombre).parameters.options.timeout, 10000);
  }
});
test('Code node contiene el mismo núcleo y produce los mismos resultados que main', async () => {
  const w = await workflow();
  const nodo = w.nodes.find(n => n.name === 'Calcular con POO y Nager');
  assert.equal(nodo.type, 'n8n-nodes-base.code');
  const fuente = await readFile(new URL('../src/facturas.js', import.meta.url), 'utf8');
  const nucleo = texto => texto.slice(0, texto.indexOf('// CORE_END') + '// CORE_END'.length);
  assert.equal(nucleo(nodo.parameters.jsCode), nucleo(fuente).replaceAll('export ', ''));
  const hoy = new Date().toISOString().slice(0, 10);
  const entradas = [base, { ...base, monto: -1 }, { ...base, estado: 'anulada' }];
  const llamadas = [];
  const salida = await ejecutar(nodo.parameters.jsCode, entradas, async opciones => {
    llamadas.push(opciones.url);
    const anio = Number(opciones.url.split('/').at(-2));
    return cliente(anio);
  });
  assert.deepEqual(salida.map(i => i.json), await main({ facturas: entradas, hoy, clienteFeriados: cliente }));
  assert.equal(llamadas.length, 2);
  assert.ok(llamadas.every(url => url.startsWith('https://date.nager.at/api/v3/PublicHolidays/')));
});
test('Code nodes encaminan errores de lectura, feriados y persistencia sin red', async () => {
  const w = await workflow();
  const codigo = nombre => w.nodes.find(n => n.name === nombre).parameters.jsCode;
  const lectura = await ejecutar(codigo('Calcular con POO y Nager'), [{ error: 'ECONNREFUSED' }]);
  assert.equal(lectura[0].json.tipo, 'JSON_SERVER_LECTURA');
  const fallo = await ejecutar(codigo('Calcular con POO y Nager'), [base]);
  assert.equal(fallo[0].json.tipo, 'API_FERIADOS');
  assert.equal(fallo[0].json.actualizar, false);
  const persistencia = await ejecutar(codigo('Resultado de actualizacion'), [{ error: 'HTTP 500' }, { id: 'F-1' }]);
  assert.equal(persistencia[0].json.tipo, 'JSON_SERVER_ACTUALIZACION');
  assert.equal(persistencia[1].json.tipo, 'ACTUALIZADA');
  assert.deepEqual(await ejecutar(codigo('Errores y omisiones'), [fallo[0].json]), fallo);
});

