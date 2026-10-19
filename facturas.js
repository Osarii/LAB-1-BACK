// CORE_START: compartido literalmente con el Code node de n8n.
export function fechaISO(valor) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) throw new Error('Fecha inválida: use YYYY-MM-DD');
  const fecha = new Date(valor + 'T00:00:00.000Z');
  if (!Number.isFinite(fecha.getTime()) || fecha.toISOString().slice(0, 10) !== valor) throw new Error('Fecha inválida');
  return fecha;
}

export class CalendarioLaboral {
  constructor(clienteFeriados, pais = 'CR') {
    if (typeof clienteFeriados !== 'function') throw new Error('Cliente de feriados obligatorio');
    if (!/^[A-Z]{2}$/.test(pais)) throw new Error('País inválido');
    this.cliente = clienteFeriados;
    this.pais = pais;
    this.cache = new Map();
  }
  async feriados(anio) {
    if (!this.cache.has(anio)) {
      let datos;
      try { datos = await this.cliente(anio, this.pais); }
      catch (causa) { throw new Error('API_FERIADOS: ' + causa.message); }
      if (!Array.isArray(datos)) throw new Error('API_FERIADOS: respuesta inválida');
      const fechas = new Set();
      for (const dato of datos) {
        if (!dato || typeof dato !== 'object') throw new Error('API_FERIADOS: feriado inválido');
        try { fechaISO(dato.date); } catch { throw new Error('API_FERIADOS: fecha inválida'); }
        if (Number(dato.date.slice(0, 4)) !== anio || dato.countryCode !== this.pais ||
            !Array.isArray(dato.types) || typeof dato.global !== 'boolean') {
          throw new Error('API_FERIADOS: esquema inválido');
        }
        // Política nacional: Public y global; feriados regionales requieren otra jurisdicción.
        if (dato.global && dato.types.includes('Public')) fechas.add(dato.date);
      }
      this.cache.set(anio, fechas);
    }
    return this.cache.get(anio);
  }
  async vencimiento(emision) {
    const fecha = fechaISO(emision);
    let contados = 0;
    while (contados < 15) {
      fecha.setUTCDate(fecha.getUTCDate() + 1);
      if (fecha.getUTCDay() === 0 || fecha.getUTCDay() === 6) continue;
      const feriados = await this.feriados(fecha.getUTCFullYear());
      if (!feriados.has(fecha.toISOString().slice(0, 10))) contados++;
    }
    return fecha.toISOString().slice(0, 10);
  }
}

export class Factura {
  constructor(datos) {
    if (!datos || typeof datos !== 'object' || Array.isArray(datos)) throw new Error('Factura obligatoria');
    if (!((typeof datos.id === 'string' && datos.id.trim()) ||
          (Number.isSafeInteger(datos.id) && datos.id > 0))) throw new Error('ID obligatorio');
    if (typeof datos.cliente !== 'string' || !datos.cliente.trim()) throw new Error('Cliente obligatorio');
    if (typeof datos.monto !== 'number' || !Number.isFinite(datos.monto) || datos.monto <= 0) throw new Error('Monto debe ser positivo');
    fechaISO(datos.fechaEmision);
    if (!['pendiente', 'procesada', 'anulada'].includes(datos.estado)) throw new Error('Estado inválido');
    if (datos.procesada !== undefined && typeof datos.procesada !== 'boolean') throw new Error('Marca procesada inválida');
    this.datos = { ...datos };
  }
  get omitida() { return this.datos.procesada === true || this.datos.estado !== 'pendiente'; }
  clasificar(vencimiento, hoy, umbral) {
    fechaISO(hoy);
    return {
      estadoCobro: vencimiento < hoy ? 'vencida' : vencimiento === hoy ? 'vence_hoy' : 'vigente',
      alerta: vencimiento < hoy ? 'vencida' : vencimiento === hoy ? 'vence_hoy' :
        this.datos.monto >= umbral ? 'monto_alto' : 'normal'
    };
  }
}

export class ServicioFacturacion {
  constructor(calendario, { hoy = new Date().toISOString().slice(0, 10), umbral = 10000 } = {}) {
    fechaISO(hoy);
    if (!Number.isFinite(umbral) || umbral <= 0) throw new Error('Umbral inválido');
    this.calendario = calendario;
    this.hoy = hoy;
    this.umbral = umbral;
  }
  async procesar(datos) {
    let factura;
    try { factura = new Factura(datos); }
    catch (error) { return { actualizar: false, tipo: 'DATOS_INVALIDOS', id: datos?.id ?? null, error: error.message }; }
    if (factura.omitida) return { actualizar: false, tipo: 'OMITIDA', id: factura.datos.id };
    try {
      const fechaVencimiento = await this.calendario.vencimiento(factura.datos.fechaEmision);
      return {
        actualizar: true, tipo: 'PROCESADA', id: factura.datos.id,
        factura: { ...factura.datos, fechaVencimiento, estado: 'procesada', procesada: true,
          ...factura.clasificar(fechaVencimiento, this.hoy, this.umbral) }
      };
    } catch (error) {
      return { actualizar: false, tipo: 'API_FERIADOS', id: factura.datos.id, error: error.message };
    }
  }
  async procesarTodas(datos) {
    if (!Array.isArray(datos)) throw new Error('Se requiere una lista de facturas');
    const resultados = [];
    for (const factura of datos) resultados.push(await this.procesar(factura));
    return resultados;
  }
}
// CORE_END

