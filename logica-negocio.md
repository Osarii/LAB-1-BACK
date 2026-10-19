# Laboratorio 1, escenario 1: facturación centralizada

## Página 1 de 3 — Alcance y reglas de negocio

Esta entrega implementa un servicio de facturación en JavaScript ESM y un
workflow importable de n8n. Cada factura pendiente recibe una fecha de
vencimiento a quince días hábiles de su emisión. El cálculo usa fechas civiles,
sin horas comerciales, en UTC. La ejecución local utiliza exclusivamente
clientes y datos ficticios; el workflow consulta Nager.Date y JSON Server
cuando un operador lo ejecuta. No contiene credenciales.

El alcance territorial es Costa Rica, código CR. Se consideran feriados
nacionales los registros de Nager.Date con countryCode CR, global verdadero
y types que incluya Public. Los feriados regionales y las observancias no
se incluyen: requerirían conocer la jurisdicción del cliente y una política
adicional. La selección territorial es explícita para evitar aplicar días
no laborables de otra región. El cliente debe devolver una lista, incluso
si está vacía; una respuesta mal formada nunca se interpreta como calendario
sin feriados.

Las reglas implementadas son las siguientes:

1. La factura requiere id, cliente, monto, fechaEmision y estado. El identificador
   admite una cadena no vacía o un entero seguro positivo. El cliente debe ser
   una cadena con contenido. El monto debe ser un número finito estrictamente
   positivo; no se convierten cadenas de texto a números.
2. Las fechas deben cumplir YYYY-MM-DD y existir en el calendario gregoriano.
   Se rechazan fechas normalizadas por JavaScript como el 30 de febrero.
   Los años bisiestos se respetan.
3. El día de emisión no cuenta. El recorrido comienza en el siguiente día
   civil y termina al acumular exactamente quince días hábiles.
4. Sábados y domingos no cuentan. Un feriado que cae en fin de semana no
   descuenta un segundo día ni implica trasladarlo al lunes.
5. Los feriados oficiales nacionales tampoco cuentan. Las fechas duplicadas
   se consolidan en un Set. Se consulta cada año que efectivamente atraviesa
   el recorrido, incluido enero del año siguiente.
6. Solo las facturas con estado pendiente y sin marca procesada verdadera
   se actualizan. Los estados procesada y anulada producen una omisión.
   Un estado desconocido o una marca procesada de otro tipo constituye un
   error de datos. La validación precede a la omisión.
7. La clasificación estadoCobro es vencida si el vencimiento es anterior a
   hoy, vence_hoy si coincide y vigente si es posterior. Vence durante el día
   de vencimiento completo; no se usa la hora de ejecución.
8. La alerta prioriza vencida, después vence_hoy y después monto_alto si el
   monto alcanza el umbral inclusivo de 10000. En otro caso es normal.
   El umbral es configurable y debe ser finito y positivo.

No se realizan conversiones monetarias ni cálculos de impuestos. El umbral
presupone una sola unidad monetaria para todo el lote ficticio. La marca de
procesamiento y el estado de cobro son campos distintos: una factura procesada
puede estar vigente o vencida.

<div style="page-break-after: always;"></div>

## Página 2 de 3 — Diseño POO y ejecución

El módulo src/facturas.js exporta CalendarioLaboral, Factura y
ServicioFacturacion, además del validador fechaISO. CalendarioLaboral recibe
una función clienteFeriados(anio, pais), que devuelve una promesa con registros
de Nager.Date. Encapsula el recorrido de fechas y la caché por año. La caché
pertenece a una instancia y no persiste entre ejecuciones; no se guarda una
respuesta fallida.

Factura valida su entrada, conserva una copia superficial y define la
elegibilidad y clasificación. ServicioFacturacion coordina ambas clases sin
mutar los objetos de entrada. procesar devuelve una envoltura con actualizar,
tipo e id; cuando tiene éxito incluye factura con el documento actualizado.
procesarTodas procesa secuencialmente una lista, comparte el calendario y
conserva un resultado por entrada, incluidos errores y omisiones. Esto permite
continuar con facturas sanas aunque otra tenga datos inválidos.

El módulo src/main.js reexporta las clases y publica datosFicticios,
feriadosFicticios, clienteFeriadosFicticio, crearClienteNager y main.
La función main acepta facturas, clienteFeriados, hoy, pais y umbral.
Sus valores predeterminados son ficticios y deterministas. La ejecución
directa prevista es node src/main.js y muestra el resultado como JSON.
Importar el módulo no dispara el ejemplo. El adaptador crearClienteNager
exige un transporte explícito; no existe una llamada implícita a fetch.
El transporte debe tener la interfaz de fetch y respetar la señal de
cancelación de diez segundos.

Como ejemplo reproducible, una emisión el viernes 18 de diciembre de 2026,
con feriados simulados el 25 de diciembre y el 1 de enero, vence el martes
12 de enero de 2027. Los cinco primeros días hábiles terminan el 28 de
diciembre; los siguientes cinco, el 5 de enero; los quince, el 12 de enero.
El ejemplo local fija hoy en esa última fecha y produce alerta vence_hoy.

La separación de dependencias permite verificar todo sin servicios externos.
Las pruebas usan node:test y node:assert/strict. Sustituyen el cliente anual,
el transporte HTTP y los objetos $input/$helpers del Code node. Verifican
fechas esperadas, validación, umbrales, omisiones, caché, errores, cambio de
año y equivalencia del módulo con el código del workflow. También inspeccionan
las conexiones y ejecutan las rutas Code de error con entradas simuladas.

ORCHESTOR debe ejecutar node --test directamente bajo el contrato S0.
Esta entrega no modifica package.json; presupone el contexto ESM indicado
por el supervisor. No se ejecutaron pruebas, scripts, instalaciones ni
comandos de shell durante la implementación. Las pruebas quedan preparadas
para la validación del candidato integrado. La importación y ejecución en una
instancia real de n8n tampoco se verificaron en este entorno.

<div style="page-break-after: always;"></div>

## Página 3 de 3 — Workflow n8n, errores y operación

El archivo workflows/facturas-dias-habiles.json es una exportación con nodos,
conexiones, configuración y active falso. Se importa desde archivo en n8n.
El disparador es manual para que importar el documento no genere solicitudes
ni escrituras. Los nodos no requieren credenciales.

La secuencia de ejecución es:

1. Inicio manual inicia la lectura HTTP GET de
   http://localhost:3000/facturas. JSON Server debe devolver la colección
   de facturas ficticias como un arreglo de documentos.
2. Calcular con POO y Nager recibe los documentos y utiliza el mismo núcleo
   de clases de src/facturas.js, sin las palabras export. Su adaptador usa
   $helpers.httpRequest para consultar
   https://date.nager.at/api/v3/PublicHolidays/{anio}/CR.
   No se importan módulos externos dentro del sandbox de n8n.
3. Actualizar factura valida es un nodo IF real. Evalúa como booleano
   estricto el campo actualizar. La salida verdadera recibe únicamente
   resultados procesados; la falsa va a Errores y omisiones.
4. Actualizar JSON Server ejecuta PATCH sobre /facturas/{id}, codificando el
   identificador en la URL. El cuerpo contiene el documento factura con
   fechaVencimiento, estado procesada, procesada true, estadoCobro y alerta.
5. Resultado de actualizacion diferencia una respuesta persistida de un
   error HTTP. Las incidencias quedan disponibles en la salida de ejecución.

El servicio n8n usa la fecha UTC del momento de ejecución para hoy. La
prueba de equivalencia proporciona esa misma fecha al módulo. El núcleo está
delimitado por CORE_START y CORE_END; la prueba exige igualdad literal para
detectar cambios en una copia que no se hayan trasladado a la otra.

JSON Server debe estar accesible desde el proceso n8n. En contenedores,
localhost apunta al propio contenedor: el operador debe ajustar las dos URLs
de JSON Server a su red local. Los registros necesitan los campos obligatorios
descritos arriba. Solo deben cargarse datos inventados. Esta entrega no crea
una base de datos ni modifica la configuración del entorno.

### Manejo explícito de errores

| Escenario | Resultado y tratamiento |
| --- | --- |
| Lectura de JSON Server: red, HTTP o timeout | El nodo continúa con la salida de error y Code genera JSON_SERVER_LECTURA; el IF evita cualquier PATCH. |
| Datos de factura inválidos | DATOS_INVALIDOS con motivo e identificador disponible; las demás facturas siguen procesándose. |
| Nager.Date: red, HTTP, timeout o esquema inválido | API_FERIADOS; no se inventa una fecha ni se actualiza esa factura. |
| Factura procesada o anulada | OMITIDA; no consulta feriados ni se escribe en JSON Server. |
| Error al persistir por PATCH | JSON_SERVER_ACTUALIZACION; el resultado no se anuncia como guardado. |

Las solicitudes tienen un timeout de diez segundos. No se activan reintentos
automáticos de escritura, ni se almacenan errores como estados de negocio.
Una caída de feriados puede generar varios errores por lote; se debe resolver
la conexión y volver a ejecutar las facturas pendientes. Las salidas de
incidencias se consultan en la ejecución n8n; no se envían notificaciones
externas ni se persisten en una colección adicional.

El procesamiento es idempotente en reejecuciones secuenciales: después de un
PATCH correcto, la lectura siguiente encuentra la marca procesada y omite la
factura. JSON Server no ofrece una transacción de lectura y escritura en este
flujo. Deben evitarse ejecuciones simultáneas y cambios concurrentes sobre la
misma factura; una solución de producción requeriría control de versión o
actualización condicional. La clasificación corresponde al momento de
procesamiento y no se recalcula diariamente para facturas ya procesadas.

La cobertura offline verifica los resultados y el contrato del workflow,
pero no sustituye una prueba de importación en la versión de n8n utilizada
por el operador. El workflow emplea HTTP Request 4.2, Code 2 e IF 2.2 y deja
la activación bajo control del operador.

