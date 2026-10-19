import { pathToFileURL } from 'node:url';
import { CalendarioLaboral, Factura, ServicioFacturacion } from './facturas.js';
export { CalendarioLaboral, Factura, ServicioFacturacion };

export const datosFicticios = Object.freeze([
  Object.freeze({ id: 'DEMO-001', cliente: 'Empresa Ejemplo', monto: 12000, fechaEmision: '2026-12-18', estado: 'pendiente' }),
  Object.freeze({ id: 'DEMO-002', cliente: 'Cliente Inventado', monto: 350, fechaEmision: '2026-12-18', estado: 'anulada' })
]);
export const feriadosFicticios = Object.freeze([
  Object.freeze({ date: '2026-12-25', countryCode: 'CR', global: true, types: Object.freeze(['Public']) }),
  Object.freeze({ date: '2027-01-01', countryCode: 'CR', global: true, types: Object.freeze(['Public']) })
]);
export async function clienteFeriadosFicticio(anio, pais) {
  return feriadosFicticios.filter(dato => dato.date.startsWith(String(anio)) && dato.countryCode === pais);
}

// Solo usa red cuando el consumidor inyecta explícitamente un transporte.
export function crearClienteNager(transporte) {
  if (typeof transporte !== 'function') throw new Error('Transporte obligatorio');
  return async (anio, pais) => {
    if (!Number.isInteger(anio) || !/^[A-Z]{2}$/.test(pais)) throw new Error('Parámetros inválidos');
    const respuesta = await transporte(
      'https://date.nager.at/api/v3/PublicHolidays/' + anio + '/' + pais,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!respuesta.ok) throw new Error('HTTP ' + respuesta.status);
    return respuesta.json();
  };
}
export async function main({
  facturas = datosFicticios, clienteFeriados = clienteFeriadosFicticio,
  hoy = '2027-01-12', pais = 'CR', umbral = 10000
} = {}) {
  const calendario = new CalendarioLaboral(clienteFeriados, pais);
  return new ServicioFacturacion(calendario, { hoy, umbral }).procesarTodas(facturas);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(resultados => console.log(JSON.stringify(resultados, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

