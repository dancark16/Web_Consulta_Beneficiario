const express = require('express');
const cors = require('cors');
const sql = require('mssql');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Cargar .env de forma robusta aun si el proceso inicia desde otro directorio.
const envCandidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '.env')
];

let envLoadedFrom = null;
for (const envPath of envCandidates) {
  if (!fs.existsSync(envPath)) continue;
  const result = dotenv.config({ path: envPath, override: true });
  if (!result.error) {
    envLoadedFrom = envPath;
    break;
  }
}

if (!envLoadedFrom) {
  console.warn('[ENV] No se pudo cargar archivo .env desde rutas candidatas.');
}

let oracledb = null;
let oracleDriverReady = false;
let oracleDriverReason = 'Oracle no inicializado.';

try {
  // Carga de driver Oracle
  oracledb = require('oracledb');

  // Forzar Thick mode para compatibilidad con BD Oracle antiguas (evita NJS-138 en Thin)
  const oracleClientLibDir = [
    `${process.env.ORACLE_CLIENT_LIB_DIR || ''}`.trim(),
    'C:\\oracle\\instantclient_19_22',
    'C:\\oracle\\instantclient_21_13'
  ].find((dir) => dir && fs.existsSync(path.join(dir, 'oci.dll'))) || '';

  try {
    if (oracleClientLibDir) {
      oracledb.initOracleClient({ libDir: oracleClientLibDir });
    } else {
      // Si no se define ORACLE_CLIENT_LIB_DIR, intenta usar PATH del sistema
      oracledb.initOracleClient();
    }

    oracleDriverReady = true;
    oracleDriverReason = '';
    console.log('[ORACLE] Thick mode inicializado correctamente');
  } catch (clientErr) {
    oracleDriverReady = false;
    oracleDriverReason = `No se pudo inicializar Instant Client (Thick): ${clientErr.message}`;
    console.warn('[ORACLE] ' + oracleDriverReason);
  }

  oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
} catch (oracleErr) {
  oracleDriverReady = false;
  oracleDriverReason = `Driver no disponible: ${oracleErr.message}`;
  console.warn('[ORACLE] Historial de cobros deshabilitado:', oracleDriverReason);
}
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// =============== SEGURIDAD: Security Middleware ===============
// 1. HELMET: Configuracion compatible con HTTP/LAN actual
// Nota: CSP/COOP/OAC estrictos rompen esta app porque usa scripts inline y no corre en HTTPS aun.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'"
      ],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false,
  originAgentCluster: false,
  hsts: false
}));

// Ocultar firma del servidor
app.disable('x-powered-by');

// 2. CORS: En este entorno sin login, permitir LAN por defecto para evitar bloqueos por IP.
// Si CORS_ALLOW_ALL=false, entonces se aplica whitelist con ALLOWED_ORIGINS.
const corsAllowAll = `${process.env.CORS_ALLOW_ALL || 'true'}`.toLowerCase() !== 'false';
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:5000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    if (corsAllowAll) {
      callback(null, true);
      return;
    }

    // Permitir requests sin Origin (curl, apps internas, health checks)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      // Importante: no lanzar error para evitar 500; solo no agregar headers CORS.
      console.warn(`[CORS] Origen no permitido: ${origin}`);
      callback(null, false);
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
}));

// 3. RATE LIMITING: Máximo 30 solicitudes por IP en 15 minutos
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { success: false, message: 'Demasiadas solicitudes. Intente más tarde.' },
  standardHeaders: false,
  skip: (req) => req.path === '/health'
});

// 4. JSON LIMIT: Limitar tamaño de request body (prevenir DoS)
app.use(express.json({ limit: '10kb' })); // Máximo 10KB por request

// 5. REQUEST LOGGING SEGURO: No loguear cedulas ni datos sensibles
app.use((req, res, next) => {
  // Log solo método y ruta, sin query strings que puedan contener cedulas
  const safeUrl = req.path; // Solo el path, no el query string
  console.log(`[${new Date().toISOString()}] ${req.method} ${safeUrl}`);
  next();
});
app.use(express.static('public', {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    const isLib = filePath.includes(`${path.sep}libs${path.sep}`);
    if (isLib) {
      // Librerías externas: cachear 7 días (no cambian)
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    } else {
      // Archivos de la app: revalidar siempre con ETag (no re-descarga si no cambió)
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

const baseDbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  options: {
    encrypt: false,
    trustServerCertificate: true
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  },
  connectionTimeout: 15000,
  requestTimeout: 120000
};

const dbServers = [
  process.env.DB_SERVER,
  ...(process.env.DB_SERVER_FALLBACKS || '')
    .split(',')
    .map(server => server.trim())
    .filter(Boolean)
].filter((server, index, arr) => server && arr.indexOf(server) === index);

let poolPromise = null;
let currentDbServer = null;
let oraclePoolPromise = null;

const oracleConfig = {
  user: process.env.ORACLE_USER,
  password: process.env.ORACLE_PASSWORD,
  connectString: process.env.ORACLE_CONNECT_STRING || process.env.ORACLE_DSN || '192.168.201:1521/ppsorapr',
  poolMin: 0,
  poolMax: 4,
  poolIncrement: 1,
  poolTimeout: 60,
};

const hasOracleConfig = () => (
  !!oracledb &&
  oracleDriverReady &&
  !!oracleConfig.user &&
  !!oracleConfig.password &&
  !!oracleConfig.connectString
);

async function getOraclePool() {
  if (!hasOracleConfig()) {
    return null;
  }

  if (oraclePoolPromise) {
    return oraclePoolPromise;
  }

  oraclePoolPromise = (async () => {
    console.log('[ORACLE] Inicializando pool');
    return oracledb.createPool(oracleConfig);
  })();

  try {
    return await oraclePoolPromise;
  } catch (err) {
    oraclePoolPromise = null;
    throw err;
  }
}

// =============== JOVENES EN ACCION: credenciales/servidor propios (192.168.98.206) ===============
let jovenesPoolPromise = null;

const jovenesDbConfig = {
  user: process.env.JOVENES_DB_USER,
  password: process.env.JOVENES_DB_PASSWORD,
  server: process.env.JOVENES_DB_SERVER || '192.168.98.206',
  database: process.env.JOVENES_DB_NAME || 'JOVENES_ACCION_3_HISTORICO',
  options: {
    encrypt: false,
    trustServerCertificate: true
  },
  pool: {
    max: 5,
    min: 0,
    idleTimeoutMillis: 30000
  },
  connectionTimeout: 15000,
  requestTimeout: 30000
};

const hasJovenesConfig = () => (
  !!jovenesDbConfig.user &&
  !!jovenesDbConfig.password &&
  !!jovenesDbConfig.server &&
  !!jovenesDbConfig.database
);

async function getJovenesPool() {
  if (!hasJovenesConfig()) {
    return null;
  }

  if (jovenesPoolPromise) {
    return jovenesPoolPromise;
  }

  jovenesPoolPromise = (async () => {
    console.log('[JOVENES] Inicializando pool de conexion');
    return new sql.ConnectionPool(jovenesDbConfig).connect();
  })();

  try {
    return await jovenesPoolPromise;
  } catch (err) {
    jovenesPoolPromise = null;
    throw err;
  }
}

async function obtenerJovenesAccion(cedula) {
  const emptyResponse = {
    enabled: false,
    available: false,
    message: 'Consulta a Jovenes en Accion no configurada (faltan credenciales JOVENES_DB_*).',
    rows: []
  };

  if (!hasJovenesConfig()) {
    return emptyResponse;
  }

  let pool;
  try {
    pool = await getJovenesPool();
  } catch (err) {
    console.warn('[JOVENES] Error conectando al pool:', err.message);
    return {
      ...emptyResponse,
      enabled: true,
      message: `No se pudo conectar a la base Jovenes en Accion: ${err.message}`
    };
  }

  if (!pool) {
    return emptyResponse;
  }

  try {
    const qJovenesAccion = `
      SELECT
        [NUMERO_REFERENCIA],
        [MONTO],
        [CODIGO_OPI],
        [CUENTA_BENEFICIARIO],
        [NOMBRES],
        [CEDULA],
        [EJECUTOR],
        [area],
        [destreza],
        [PROVINCIA],
        [CANTON],
        [PARROQUIA],
        [direccion],
        [telefono],
        [correo],
        [ENTIDAD BANCARIA],
        [FECHATRANSACCION],
        [ESTADO]
      FROM [JOVENES_ACCION_3_HISTORICO].[dbo].[BASE_TOTAL_JOVENES_DPA]
      WHERE [CEDULA] = @cedula
      ORDER BY [FECHATRANSACCION] DESC
    `;

    const rs = await pool.request()
      .input('cedula', sql.VarChar(20), cedula)
      .query(qJovenesAccion);

    // Regla de negocio: 'OPI ACREDITADA' = pagado; cualquier otro estado = no pagado.
    // Nunca se muestra la sigla "OPI" al usuario, solo PAGADO/NO PAGADO + la observacion original sin "OPI".
        const rows = (rs.recordset || []).map((r) => {
      const estadoRaw = `${r.ESTADO || ''}`.trim();
      const pagado = estadoRaw.toUpperCase() === 'OPI ACREDITADA';
      const observacion = estadoRaw
        .replace(/OPI/gi, '')
        .replace(/RECHAZAD[OA]S?/gi, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s,]+|[\s,]+$/g, '')
        .trim();

      return {
        ...r,
        ESTADO_PAGO: pagado ? 'PAGADO' : 'NO PAGADO',
        OBSERVACION: observacion || (pagado ? 'ACREDITADA' : estadoRaw)
      };
    });

    return {
      enabled: true,
      available: rows.length > 0,
      message: rows.length ? null : 'No se encontraron registros en Jovenes en Accion para esta cedula.',
      rows
    };
  } catch (err) {
    console.warn('[JOVENES] Error consultando BASE_TOTAL_JOVENES_DPA:', err.message);
    return {
      enabled: true,
      available: false,
      message: `Error consultando Jovenes en Accion: ${err.message}`,
      rows: []
    };
  }
}

function normalizarCodigoben(valor) {
  const raw = `${valor ?? ''}`;
  return raw.replace(/\D/g, '');
}

function toIsoDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function inferirEsMilDias(codSubsidio) {
  const cod = `${codSubsidio || ''}`.trim().toUpperCase().replace(/\s+/g, '');
  return /1000|BMD/.test(cod);
}

function inferirCanalPago(histRow) {
  const codStatus = `${histRow?.CODSTATUS ?? histRow?.codStatus ?? ''}`.trim();

  // Regla de negocio: 27 implica envio a cuenta, aunque no este conciliado.
  if (codStatus === '27') return 'CUENTA';

  // Estados de "abre tu cuenta..." y CDH/Ahorro se tratan como ventanilla.
  const codStatusVentanilla = new Set(['61', '70', '74', '75', '76', '77']);
  if (codStatusVentanilla.has(codStatus)) return 'VENTANILLA';

  const tieneReferencias = [histRow?.MID, histRow?.TID, histRow?.REFERENCIA]
    .some((v) => v !== undefined && v !== null && `${v}`.trim() !== '');
  return tieneReferencias ? 'CUENTA' : 'VENTANILLA';
}

function buildPeriodoLabel(codPeriodo, codSubperiodo) {
  const periodo = Number.parseInt(`${codPeriodo ?? ''}`, 10);
  const subperiodo = Number.parseInt(`${codSubperiodo ?? ''}`, 10);
  const meses = [
    '', 'ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO',
    'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'
  ];

  if (!Number.isNaN(periodo) && !Number.isNaN(subperiodo) && subperiodo >= 1 && subperiodo <= 12) {
    const anioFiscal = 2011 + periodo;
    return `${meses[subperiodo]} ${anioFiscal}`;
  }

  return `PERIODO ${codPeriodo || 'N/D'} - SUBPERIODO ${codSubperiodo || 'N/D'}`;
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });

  return Promise.race([promise, timeoutPromise])
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

function parseNumber(value) {
  if (value === undefined || value === null || `${value}`.trim() === '') return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

function pickFirstNonEmptyField(row, keys) {
  if (!row) return '';
  for (const key of keys || []) {
    const value = row[key];
    if (value !== undefined && value !== null && `${value}`.trim() !== '') {
      return `${value}`.trim();
    }
  }
  return '';
}

function extraerDatosVentanillaDesdeBeneficiario(beneficiario) {
  if (!beneficiario) return null;

  const provincia = pickFirstNonEmptyField(beneficiario, ['PROVINCIA', 'provincia']);
  const ciudad = pickFirstNonEmptyField(beneficiario, ['CIUDAD', 'ciudad', 'CANTON', 'canton']);
  const parroquia = pickFirstNonEmptyField(beneficiario, ['PARROQUIA', 'parroquia']);
  const banco = pickFirstNonEmptyField(beneficiario, ['BANCO', 'banco', 'NOMBREBANCO', 'nombreBanco']);
  const agencia = pickFirstNonEmptyField(beneficiario, ['AGENCIA', 'agencia', 'NOMBREAGENCIA', 'nombreAgencia']);
  const direccionAgencia = pickFirstNonEmptyField(beneficiario, [
    'DIRECCION_AGENCIA',
    'direccion_agencia',
    'DIRECCIONAGENCIA',
    'direccionAgencia',
    'DIRECCION',
    'direccion'
  ]);

  const tieneAlgunDato = !!(provincia || ciudad || parroquia || banco || agencia || direccionAgencia);
  if (!tieneAlgunDato) return null;

  return {
    provincia,
    ciudad,
    parroquia,
    banco,
    agencia,
    direccionAgencia
  };
}

function obtenerYearMonth(value) {
  const iso = toIsoDate(value);
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-/);
  return m ? `${m[1]}-${m[2]}` : '';
}

function keyDetalleVentanilla(fechaIso, codSubsidio) {
  const fecha = `${fechaIso || ''}`.trim();
  const cod = normalizarCodSubsidioCanonico(codSubsidio);
  return `${fecha}|${cod}`;
}

function tieneDatosVentanillaCompletos(row) {
  if (!row) return false;
  const provincia = `${row.provincia || ''}`.trim();
  const ciudad = `${row.ciudad || ''}`.trim();
  const parroquia = `${row.parroquia || ''}`.trim();
  const banco = `${row.banco || ''}`.trim();
  const agencia = `${row.agencia || ''}`.trim();
  const direccionAgencia = `${row.direccionAgencia || ''}`.trim();
  return !!(provincia && ciudad && parroquia && banco && agencia && direccionAgencia);
}

function tieneAlgunDatoVentanilla(row) {
  if (!row) return false;
  return !!(
    `${row.provincia || ''}`.trim() ||
    `${row.ciudad || ''}`.trim() ||
    `${row.parroquia || ''}`.trim() ||
    `${row.banco || ''}`.trim() ||
    `${row.agencia || ''}`.trim() ||
    `${row.direccionAgencia || ''}`.trim()
  );
}

function mapAuxPagoToDatosVentanilla(auxRow) {
  return {
    provincia: `${auxRow.PROVINCIA || ''}`.trim() || null,
    ciudad: `${auxRow.CIUDAD || ''}`.trim() || null,
    parroquia: `${auxRow.PARROQUIA || ''}`.trim() || null,
    banco: `${auxRow.BANCO || ''}`.trim() || null,
    agencia: `${auxRow.AGENCIA || ''}`.trim() || null,
    direccionAgencia: `${auxRow.DIRECCION_AGENCIA || ''}`.trim() || null,
    codSubsidioAux: normalizarCodSubsidioCanonico(
      `${auxRow.CODIGO_TIPO_SUBSIDIO || ''}`.trim() || extraerSubsidioDesdeTexto(auxRow.TIPO_BONO)
    )
  };
}

function construirIndiceAuxPago(rows) {
  const index = new Map();
  for (const raw of rows || []) {
    const ym = obtenerYearMonth(raw.FECHA_PAGO || raw.FECHA_PAGO_CON || raw.FECHA_CONTABLE || raw.FECHA_PAGO_TRA || raw.FECHA_PAGO_CRE || raw.FECHA_HORA_CRE);
    if (!ym) continue;

    const mapped = mapAuxPagoToDatosVentanilla(raw);
    if (!tieneAlgunDatoVentanilla(mapped)) continue;

    const arr = index.get(ym) || [];
    arr.push(mapped);
    index.set(ym, arr);
  }
  return index;
}

function seleccionarDatosVentanillaPorCobro(auxIndex, cobroFecha, codSubsidioCobro, fallbackDatos) {
  const ym = obtenerYearMonth(cobroFecha);
  if (!ym) return fallbackDatos;

  const candidates = auxIndex.get(ym) || [];
  if (!candidates.length) return fallbackDatos;

  const codCanon = normalizarCodSubsidioCanonico(codSubsidioCobro);
  if (codCanon) {
    const match = candidates.find((c) => c.codSubsidioAux && c.codSubsidioAux === codCanon);
    if (match) return match;
  }

  return candidates[0] || fallbackDatos;
}

const SUBSIDIO_CANONICO_POR_CODIGO = {
  1: 'BDH',
  2: 'PAM',
  3: 'PDD',
  5: 'MMA',
  6: 'BVA',
  7: 'PTVA',
  8: 'PTVM',
  9: 'BMD',
  88: 'JGL',
  99: 'BDD'
};

const SUBSIDIO_CANONICO_POR_SIGLA = {
  BDH: 'BDH',
  PAM: 'PAM',
  PDD: 'PDD',
  MMA: 'MMA',
  BVA: 'BVA',
  PTVA: 'PTVA',
  PTUV: 'PTVA',
  PTVM: 'PTVM',
  PTUVM: 'PTVM',
  BMD: 'BMD',
  BDD: 'BDD',
  JGL: 'JGL'
};

const MONTO_POR_SUBSIDIO_CANONICO = {
  BDH: 50,
  PAM: 50,
  PDD: 50,
  MMA: 100,
  PTVA: 100,
  PTVM: 100,
  JGL: 240,
  BDD: 50
};

function normalizarCodSubsidioCanonico(codSubsidio) {
  const raw = `${codSubsidio ?? ''}`.trim().toUpperCase();
  if (!raw) return '';

  const codNum = Number.parseInt(raw, 10);
  if (!Number.isNaN(codNum) && SUBSIDIO_CANONICO_POR_CODIGO[codNum]) {
    return SUBSIDIO_CANONICO_POR_CODIGO[codNum];
  }

  return SUBSIDIO_CANONICO_POR_SIGLA[raw] || raw;
}

function montoDefectoPorSubsidio(codSubsidio) {
  const canon = normalizarCodSubsidioCanonico(codSubsidio);
  return MONTO_POR_SUBSIDIO_CANONICO[canon] ?? null;
}

function elegirCodSubsidioPreferido(actualCodSubsidio, incomingCodSubsidio) {
  const a = `${actualCodSubsidio ?? ''}`.trim();
  const b = `${incomingCodSubsidio ?? ''}`.trim();
  if (!a) return b;
  if (!b) return a;

  const aCanon = normalizarCodSubsidioCanonico(a);
  const bCanon = normalizarCodSubsidioCanonico(b);

  // Regla de negocio: BDH de continuidad puede ser genérico; preferir el otro subsidio si existe.
  if (aCanon === 'BDH' && bCanon && bCanon !== 'BDH') return b;
  if (bCanon === 'BDH' && aCanon && aCanon !== 'BDH') return a;

  return a;
}

function hasText(value) {
  return value !== undefined && value !== null && `${value}`.trim() !== '';
}

function pickMontoPreferido(actual, incoming) {
  const a = parseNumber(actual);
  const b = parseNumber(incoming);

  // Prioriza monto distinto de 0 cuando exista.
  if (a !== null && a !== 0) return a;
  if (b !== null && b !== 0) return b;
  if (a !== null) return a;
  if (b !== null) return b;
  return null;
}

function pickFechaPreferida(actual, incoming) {
  const a = `${actual || ''}`.trim();
  const b = `${incoming || ''}`.trim();
  if (!a) return b || null;
  if (!b) return a || null;
  return a >= b ? a : b;
}

function mergeCobroRecord(actual, incoming) {
  const codSubsidio = elegirCodSubsidioPreferido(actual.codSubsidio, incoming.codSubsidio);
  const montoBase = pickMontoPreferido(actual.monto, incoming.monto);
  const montoNormalizado = (montoBase === null || montoBase === 0)
    ? (montoDefectoPorSubsidio(codSubsidio) ?? montoBase)
    : montoBase;
  const ciudadBase = hasText(actual.ciudad)
    ? actual.ciudad
    : (hasText(actual.canton) ? actual.canton : (incoming.ciudad || incoming.canton || null));

  return {
    codigoben: hasText(actual.codigoben) ? actual.codigoben : incoming.codigoben,
    codSubsidio,
    codPeriodo: hasText(actual.codPeriodo) ? actual.codPeriodo : incoming.codPeriodo,
    codSubperiodo: hasText(actual.codSubperiodo) ? actual.codSubperiodo : incoming.codSubperiodo,
    periodo: hasText(actual.periodo) ? actual.periodo : incoming.periodo,
    monto: montoNormalizado,
    flagPago: hasText(actual.flagPago) ? actual.flagPago : incoming.flagPago,
    codStatus: hasText(actual.codStatus) ? actual.codStatus : incoming.codStatus,
    codAccion: hasText(actual.codAccion) ? actual.codAccion : incoming.codAccion,
    fechaCobro: pickFechaPreferida(actual.fechaCobro, incoming.fechaCobro),
    fechaRegistro: pickFechaPreferida(actual.fechaRegistro, incoming.fechaRegistro),
    referencia: hasText(actual.referencia) ? actual.referencia : (incoming.referencia || null),
    mid: hasText(actual.mid) ? actual.mid : (incoming.mid || null),
    tid: hasText(actual.tid) ? actual.tid : (incoming.tid || null),
    codRepres: hasText(actual.codRepres) ? actual.codRepres : (incoming.codRepres || null),
    tipoPrograma: hasText(actual.tipoPrograma) ? actual.tipoPrograma : incoming.tipoPrograma,
    canalPago: hasText(actual.canalPago) ? actual.canalPago : incoming.canalPago,
    provincia: hasText(actual.provincia) ? actual.provincia : (incoming.provincia || null),
    ciudad: ciudadBase,
    canton: ciudadBase,
    parroquia: hasText(actual.parroquia) ? actual.parroquia : (incoming.parroquia || null),
    banco: hasText(actual.banco) ? actual.banco : (incoming.banco || null),
    agencia: hasText(actual.agencia) ? actual.agencia : (incoming.agencia || null),
    direccionAgencia: hasText(actual.direccionAgencia) ? actual.direccionAgencia : (incoming.direccionAgencia || null)
  };
}

function resolvePeriodoParaKey(row) {
  const codPeriodoNum = Number.parseInt(`${row?.codPeriodo || ''}`, 10);
  const codSubperiodoNum = Number.parseInt(`${row?.codSubperiodo || ''}`, 10);
  if (!Number.isNaN(codPeriodoNum) && !Number.isNaN(codSubperiodoNum) && codSubperiodoNum >= 1 && codSubperiodoNum <= 12) {
    return { codPeriodo: `${codPeriodoNum}`, codSubperiodo: `${codSubperiodoNum}` };
  }

  const mesMap = {
    ENERO: 1,
    FEBRERO: 2,
    MARZO: 3,
    ABRIL: 4,
    MAYO: 5,
    JUNIO: 6,
    JULIO: 7,
    AGOSTO: 8,
    SEPTIEMBRE: 9,
    OCTUBRE: 10,
    NOVIEMBRE: 11,
    DICIEMBRE: 12
  };

  const periodoTxt = `${row?.periodo || ''}`.trim().toUpperCase();
  const periodoMatch = periodoTxt.match(/(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)\s+(\d{4})/);
  if (periodoMatch) {
    const mes = mesMap[periodoMatch[1]] || null;
    const anio = Number.parseInt(periodoMatch[2], 10);
    const codPeriodoFiscal = buildCodPeriodoFiscal(anio);
    if (mes && codPeriodoFiscal) {
      return { codPeriodo: codPeriodoFiscal, codSubperiodo: `${mes}` };
    }
  }

  const fecha = `${row?.fechaCobro || row?.fechaRegistro || ''}`.trim();
  const fechaMatch = fecha.match(/^(\d{4})-(\d{2})-/);
  if (fechaMatch) {
    const anio = Number.parseInt(fechaMatch[1], 10);
    const mes = Number.parseInt(fechaMatch[2], 10);
    const codPeriodoFiscal = buildCodPeriodoFiscal(anio);
    if (!Number.isNaN(mes) && mes >= 1 && mes <= 12 && codPeriodoFiscal) {
      return { codPeriodo: codPeriodoFiscal, codSubperiodo: `${mes}` };
    }
  }

  return {
    codPeriodo: `${row?.codPeriodo || ''}`.trim(),
    codSubperiodo: `${row?.codSubperiodo || ''}`.trim()
  };
}

function keyCobroRow(row) {
  const periodoKey = resolvePeriodoParaKey(row);
  return [
    `${periodoKey.codPeriodo || ''}`.trim(),
    `${periodoKey.codSubperiodo || ''}`.trim(),
    `${row.canalPago || ''}`.trim().toUpperCase(),
    `${row.tipoPrograma || ''}`.trim().toUpperCase()
  ].join('|');
}

function mergeCobros(primaryRows, secondaryRows) {
  const map = new Map();

  const appendRows = (rows) => {
    for (const row of rows || []) {
      const key = keyCobroRow(row);
      const actual = map.get(key);
      if (!actual) {
        map.set(key, row);
        continue;
      }
      map.set(key, mergeCobroRecord(actual, row));
    }
  };

  appendRows(primaryRows);
  appendRows(secondaryRows);

  const out = [...map.values()];

  return out.sort((a, b) => {
    const yearA = Number.parseInt(`${a.codPeriodo || ''}`, 10) || 0;
    const yearB = Number.parseInt(`${b.codPeriodo || ''}`, 10) || 0;
    if (yearA !== yearB) return yearB - yearA;

    const monthA = Number.parseInt(`${a.codSubperiodo || ''}`, 10) || 0;
    const monthB = Number.parseInt(`${b.codSubperiodo || ''}`, 10) || 0;
    if (monthA !== monthB) return monthB - monthA;

    return `${b.fechaCobro || ''}`.localeCompare(`${a.fechaCobro || ''}`);
  });
}

function pickLatestBonoRef(rows) {
  const list = (rows || [])
    .filter((r) => `${r.tipoPrograma || ''}`.toUpperCase() === 'BONOS')
    .sort((a, b) => {
      const yearA = Number.parseInt(`${a.codPeriodo || ''}`, 10) || 0;
      const yearB = Number.parseInt(`${b.codPeriodo || ''}`, 10) || 0;
      if (yearA !== yearB) return yearB - yearA;

      const monthA = Number.parseInt(`${a.codSubperiodo || ''}`, 10) || 0;
      const monthB = Number.parseInt(`${b.codSubperiodo || ''}`, 10) || 0;
      if (monthA !== monthB) return monthB - monthA;

      return `${b.fechaCobro || ''}`.localeCompare(`${a.fechaCobro || ''}`);
    });

  return list[0] || null;
}

function mapPeriodoPagoCodigoToMesAnio(codigoRaw) {
  const codigo = `${codigoRaw || ''}`.trim().toUpperCase();

  const mesMap = {
    ENE: 1,
    FEB: 2,
    MAR: 3,
    ABR: 4,
    MAY: 5,
    JUN: 6,
    JUL: 7,
    AGO: 8,
    SEP: 9,
    OCT: 10,
    NOV: 11,
    DIC: 12
  };

  const mesMapLargo = {
    ENERO: 1,
    FEBRERO: 2,
    MARZO: 3,
    ABRIL: 4,
    MAYO: 5,
    JUNIO: 6,
    JULIO: 7,
    AGOSTO: 8,
    SEPTIEMBRE: 9,
    OCTUBRE: 10,
    NOVIEMBRE: 11,
    DICIEMBRE: 12
  };

  // Formato abreviado: AGO2024, AGO-2024, AGO 2024, BDHAGO2024
  const match = codigo.match(/(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|OCT|NOV|DIC)\D*(\d{4})/);
  if (match) {
    return {
      mes: mesMap[match[1]] || null,
      anio: Number.parseInt(match[2], 10) || null
    };
  }

  // Formato largo incrustado: BDHAGOSTO2024, BDHSEPTIEMBRE2025, etc.
  const matchLargo = codigo.match(/(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)\s*(\d{4})/);
  if (matchLargo) {
    return {
      mes: mesMapLargo[matchLargo[1]] || null,
      anio: Number.parseInt(matchLargo[2], 10) || null
    };
  }

  return {
    mes: null,
    anio: null
  };
}

function inferirCodSubsidioDesdePeriodoPago(row, fallbackCodSubsidio) {
  const raw = `${row?.Codigo || row?.CODIGO || row?.Periodo || row?.PERIODO || ''}`.trim().toUpperCase();
  if (!raw) return fallbackCodSubsidio;

  const match = raw.match(/(BDH|BVA|MMA|PAM|PDD|PTVM|PTUVM|PTVA|PTUV|BMD|BDD)/);
  return match ? match[1] : fallbackCodSubsidio;
}

function extraerSubsidioDesdeTexto(value) {
  const raw = `${value || ''}`.trim().toUpperCase();
  if (!raw) return '';
  const match = raw.match(/(BMD|BDD|PTVM|PTUVM|PTVA|PTUV|MMA|PAM|PDD|BVA|BDH)/);
  if (!match) return '';
  return normalizarCodSubsidioCanonico(match[1]);
}

function resolverSubsidioPreferidoHistorial({ bonoRef, datosGenerales, bono1000Rows }) {
  const bonoRefCod = normalizarCodSubsidioCanonico(`${bonoRef?.codSubsidio || ''}`.trim());
  if (bonoRefCod) return bonoRefCod;

  const dg = datosGenerales || {};
  const subsidioDesdeDG =
    extraerSubsidioDesdeTexto(dg.subsidio_final) ||
    extraerSubsidioDesdeTexto(dg.codigo_tipo_subsidio) ||
    extraerSubsidioDesdeTexto(dg.CODIGO_TIPO_SUBSIDIO);
  if (subsidioDesdeDG) return subsidioDesdeDG;

  if (Array.isArray(bono1000Rows) && bono1000Rows.length > 0) {
    return 'BMD';
  }

  return 'BDH';
}

function inferirMesAnioDesdeFecha(value) {
  const iso = toIsoDate(value);
  if (!iso) return { mes: null, anio: null };

  const m = iso.match(/^(\d{4})-(\d{2})-/);
  if (!m) return { mes: null, anio: null };

  return {
    anio: Number.parseInt(m[1], 10) || null,
    mes: Number.parseInt(m[2], 10) || null
  };
}

function buildCodPeriodoFiscal(anio) {
  const n = Number.parseInt(`${anio ?? ''}`, 10);
  if (Number.isNaN(n) || n < 2012) return null;
  return `${n - 2011}`;
}

async function obtenerHistorialCobrosSqlContinuidad(pool, cedula, bonoRef, options = {}) {
  const qContinuidad = `
    WITH cp_filtrado AS (
      SELECT
        IdPeriodo,
        MAX(CODIGO_TIPO_EXCEPCION_NEW) AS CODIGO_TIPO_EXCEPCION_NEW
      FROM [192.168.1.6].[SippsDataPago].[sipps].[CUADRE_PAGO_CUENTA]
      WHERE Cedula = @cedula
      GROUP BY IdPeriodo
    )
    SELECT
      pp.*,
      cpf.CODIGO_TIPO_EXCEPCION_NEW
    FROM [192.168.1.6].[SippsDataPago].[sipps].[PeriodoPago] pp
    INNER JOIN cp_filtrado cpf
      ON cpf.IdPeriodo = pp.IdPeriodoPago
    ORDER BY pp.IdPeriodoPago DESC
  `;

  const qUltimoPeriodoGlobal = `
    SELECT TOP (1)
      IdPeriodoPago,
      Descripcion,
      DescripcionLarga,
      FechaInicio,
      FechaFin,
      MesAplica,
      AnioAplica
    FROM [192.168.1.6].[SippsDataPago].[sipps].[PeriodoPago]
    ORDER BY IdPeriodoPago DESC
  `;

  const rs = await pool.request()
    .input('cedula', sql.VarChar(20), cedula)
    .query(qContinuidad);

  const preferredCodSubsidio = normalizarCodSubsidioCanonico(
    `${options.fallbackCodSubsidio || bonoRef?.codSubsidio || 'BDH'}`.trim()
  ) || 'BDH';
  const defaultMonto = parseNumber(bonoRef?.monto) ?? montoDefectoPorSubsidio(preferredCodSubsidio);
  const defaultCodStatus = `${bonoRef?.codStatus || ''}`.trim() || '27';

  const rows = (rs.recordset || []).map((r) => {
    const parsedPeriodo = mapPeriodoPagoCodigoToMesAnio(r.Periodo || r.PERIODO);
    const parsedCodigo = mapPeriodoPagoCodigoToMesAnio(r.Codigo || r.CODIGO);
    const parsedFecha = inferirMesAnioDesdeFecha(r.FechaFin || r.FECHAFIN || r.FechaCobro || r.FECHACOBRO || r.FechaRegistro || r.FECHAREGISTRO);

    const mes = Number.parseInt(`${r.Mes || r.MES || r.MesAplica || r.MESAPLICA || parsedPeriodo.mes || parsedCodigo.mes || parsedFecha.mes || ''}`, 10);
    const anio = Number.parseInt(`${r.Anio || r.ANIO || r.AnioAplica || r.ANIOAPLICA || parsedPeriodo.anio || parsedCodigo.anio || parsedFecha.anio || ''}`, 10);
    const codPeriodo = buildCodPeriodoFiscal(anio);
    const codSubperiodo = !Number.isNaN(mes) && mes >= 1 && mes <= 12 ? `${mes}` : '';
    // Regla de negocio: en continuidad SQL ignoramos el prefijo BDH del campo Codigo/Periodo.
    // El subsidio real se hereda de Oracle (bonoRef) para unificar el mes en una sola fila.
    const codSubsidio = `${preferredCodSubsidio || ''}`.trim() || inferirCodSubsidioDesdePeriodoPago(r, 'BDH');
    const montoSql = parseNumber(r.Monto || r.MONTO);
    const montoDefecto = montoDefectoPorSubsidio(codSubsidio);
    const montoNormalizado = (montoSql !== null && montoSql !== 0)
      ? montoSql
      : (defaultMonto && defaultMonto !== 0)
        ? defaultMonto
        : montoDefecto;

    const codStatusSql = `${r.CODIGO_TIPO_EXCEPCION_NEW || defaultCodStatus}`.trim();
    return {
      codigoben: `${cedula}`,
      codSubsidio,
      codPeriodo: codPeriodo || `${r.CodPeriodo || r.CODPERIODO || ''}`.trim(),
      codSubperiodo,
      periodo: buildPeriodoLabel(codPeriodo, codSubperiodo),
      monto: montoNormalizado,
      flagPago: '1',
      codStatus: codStatusSql,
      codAccion: '000',
      fechaCobro: toIsoDate(r.FechaFin || r.FECHAFIN || r.FechaRegistro || r.FECHAREGISTRO || r.FechaInicio || r.FECHAINICIO),
      fechaRegistro: toIsoDate(r.FechaRegistro || r.FECHAREGISTRO),
      referencia: null,
      mid: null,
      tid: null,
      codRepres: null,
      tipoPrograma: inferirEsMilDias(codSubsidio) ? '1000_DIAS' : 'BONOS',
      canalPago: codStatusSql === '61' ? 'VENTANILLA' : 'CUENTA'
    };
  });

  const rawRows = rs.recordset || [];
  const ultimoSql = rawRows[0] || null;
  const ultimoSql53 = rawRows.find((r) => `${r.CODIGO_TIPO_EXCEPCION_NEW || ''}`.trim() === '53') || null;
  const rsUltimoGlobal = await pool.request().query(qUltimoPeriodoGlobal);
  const ultimoGlobal = (rsUltimoGlobal.recordset && rsUltimoGlobal.recordset[0]) ? rsUltimoGlobal.recordset[0] : null;
  const coincideUltimoMesGlobal = !!(
    ultimoSql53 &&
    ultimoGlobal &&
    Number.parseInt(`${ultimoSql53.IdPeriodoPago ?? ''}`, 10) === Number.parseInt(`${ultimoGlobal.IdPeriodoPago ?? ''}`, 10)
  );

  const ultimoPeriodoContinuidad = ultimoSql ? {
    idPeriodoPago: ultimoSql.IdPeriodoPago ?? null,
    descripcion: `${ultimoSql.Descripcion || ''}`.trim() || null,
    descripcionLarga: `${ultimoSql.DescripcionLarga || ''}`.trim() || null,
    fechaInicio: toIsoDate(ultimoSql.FechaInicio),
    fechaFin: toIsoDate(ultimoSql.FechaFin),
    mesAplica: ultimoSql.MesAplica ?? null,
    anioAplica: ultimoSql.AnioAplica ?? null,
    referenciaExcepcion53: ultimoSql53 ? {
      idPeriodoPago: ultimoSql53.IdPeriodoPago ?? null,
      descripcion: `${ultimoSql53.Descripcion || ''}`.trim() || null,
      descripcionLarga: `${ultimoSql53.DescripcionLarga || ''}`.trim() || null,
      fechaInicio: toIsoDate(ultimoSql53.FechaInicio),
      fechaFin: toIsoDate(ultimoSql53.FechaFin),
      mesAplica: ultimoSql53.MesAplica ?? null,
      anioAplica: ultimoSql53.AnioAplica ?? null,
      esUltimoMesGlobal: coincideUltimoMesGlobal
    } : null,
    cobraMesActual: coincideUltimoMesGlobal
  } : null;

  return {
    rows,
    ultimoPeriodoContinuidad
  };
}

async function obtenerHistorialCobrosOracle(cedula) {
  // DESPUÉS — agregar las nuevas propiedades:
  const emptyResponse = {
    enabled: false,
    available: false,
    message: oracleDriverReason || 'Historial de cobros no configurado.',
    beneficiario: null,
    detalleTransaccionRows: [],
    historialPermanenteRows: [],
    // Mantener estas por si algo del código viejo las referencia
    bonosPagoCuenta: [],
    bonosVentanilla: [],
    milDiasPagoCuenta: [],
    milDiasVentanilla: []
  };

  if (!hasOracleConfig()) {
    return emptyResponse;
  }

  const pool = await getOraclePool();
  if (!pool) {
    return emptyResponse;
  }

  let connection;
  try {
    connection = await pool.getConnection();
    // Timeout corto para queries rapidas (beneficiario, historial permanente)
    const oracleCallTimeoutMs = Number.parseInt(`${process.env.ORACLE_CALL_TIMEOUT_MS || '8000'}`, 10) || 8000;
    connection.callTimeout = oracleCallTimeoutMs;

    const tBenef0 = Date.now();
    const beneficiarioRs = await connection.execute(
      `
        SELECT
          *
        FROM TB_BENEFICIARIO_PERMANENTE
        WHERE CEDULA = :cedula
          AND ROWNUM = 1
      `,
      { cedula }
    );
    console.log(`[ORACLE TIMING] beneficiario: ${Date.now() - tBenef0}ms`);

    const beneficiario = beneficiarioRs.rows && beneficiarioRs.rows[0] ? beneficiarioRs.rows[0] : null;
    if (!beneficiario) {
      return {
        ...emptyResponse,
        enabled: true,
        available: false,
        message: 'No existe CODIGOBEN en Oracle para la cedula consultada.'
      };
    }

    const codigoBenRaw = `${beneficiario.CODIGOBEN ?? ''}`.trim();
    const codigoBenNormalizado = normalizarCodigoben(beneficiario.CODIGOBEN);
    if (!codigoBenNormalizado) {
      return {
        ...emptyResponse,
        enabled: true,
        available: true,
        message: 'CODIGOBEN invalido en Oracle.',
        beneficiario
      };
    }

    const qHistorialBase = `
      SELECT
        CODIGOBEN,
        CODSUBSIDIO,
        CODPERIODO,
        CODSUBPERIODO,
        MONTO,
        FLAGPAGO,
        CODSTATUS,
        CODACCION,
        FECHACOBRO,
        CODREPRES,
        MID,
        TID,
        REFERENCIA,
        FECHAREGISTRO
      FROM TB_HISTORIAL_PERMANENTE_ACUM
    `;

    let rows = [];

    // Primera opcion (rapida): comparar con CODIGOBEN exacto devuelto por Oracle.
    const tHist0 = Date.now();
    const historialExactoRs = await connection.execute(
      `${qHistorialBase}
       WHERE CODIGOBEN = :codigoBenExacto
       ORDER BY TO_NUMBER(CODPERIODO) DESC, TO_NUMBER(CODSUBPERIODO) DESC`,
      { codigoBenExacto: codigoBenRaw }
    );
    rows = historialExactoRs.rows || [];
    console.log(`[ORACLE TIMING] historialExacto (${rows.length} filas): ${Date.now() - tHist0}ms`);

    // Fallback: algunos registros guardan CODIGOBEN en otro formato (con/sin puntos).
    // Usa REPLACE/TO_CHAR = full table scan sin indice, necesita mas tiempo.
    if (!rows.length) {
      const oracleHistNormTimeoutMs = Number.parseInt(`${process.env.ORACLE_HIST_NORM_TIMEOUT_MS || '25000'}`, 10) || 25000;
      const prevTimeoutNorm = connection.callTimeout;
      connection.callTimeout = oracleHistNormTimeoutMs;
      try {
        const tHistN0 = Date.now();
        const historialNormalizadoRs = await connection.execute(
          `${qHistorialBase}
           WHERE REPLACE(TO_CHAR(CODIGOBEN), '.', '') = :codigoBenNormalizado
           ORDER BY TO_NUMBER(CODPERIODO) DESC, TO_NUMBER(CODSUBPERIODO) DESC`,
          { codigoBenNormalizado: codigoBenNormalizado }
        );
        rows = historialNormalizadoRs.rows || [];
        console.log(`[ORACLE TIMING] historialNormalizado (${rows.length} filas): ${Date.now() - tHistN0}ms`);
      } catch (histNormErr) {
        console.warn('[ORACLE] historialNormalizado timeout/error:', histNormErr.message);
        rows = [];
      } finally {
        connection.callTimeout = prevTimeoutNorm;
      }
    }
    const datosVentanillaBeneficiario = extraerDatosVentanillaDesdeBeneficiario(beneficiario);
    let detalleVentanillaRows = [];
    const previousCallTimeout = connection.callTimeout;
    try {
      const oracleVentanillaTimeoutMs = Number.parseInt(`${process.env.ORACLE_VENTANILLA_QUERY_TIMEOUT_MS || '15000'}`, 10) || 15000;
      connection.callTimeout = oracleVentanillaTimeoutMs;
      console.log(`[ORACLE TIMING] ventanilla iniciando (callTimeout=${oracleVentanillaTimeoutMs}ms)`);
      const tVent0 = Date.now();

      const detalleVentanillaRs = await connection.execute(
        `
          SELECT
            DT.CEDULABEN AS CEDULA_TITULAR,
            DT.NONBREBEN AS NOMBRES_TITULAR,
            DT.CODBONO AS BONO_TITULAR,
            DT.FECHACOBRO AS FECHA_COBRO,
            REPLACE(TO_CHAR(DT.TOTALCOBRO), ',', '.') AS MONTO_COBRADO,
            TB_PROVINCIA.DESCRIPCION AS PROVINCIA,
            TB_CIUDAD.DESCRIPCION AS CIUDAD,
            TB_PARROQUIA.DESCRIPCION AS PARROQUIA,
            TB_CADENA.DESCRIPCION AS BANCO,
            TB_COMERCIO.DESCRIPCION AS AGENCIA,
            TB_COMERCIO.DIRECCION_PRIMARIA AS DIRECCION_AGENCIA,
            LPAD(TB_COMERCIO.COD_PROVINCIA,2,'0') ||
            LPAD(TB_COMERCIO.COD_CIUDAD,2,'0') ||
            LPAD(TB_COMERCIO.COD_PARROQUIA,2,'0') AS DPA_AGENCIA,
            DT.CODEVENTO
          FROM TB_PROVINCIA
          JOIN TB_COMERCIO
            ON TB_PROVINCIA.COD_PROVINCIA = TB_COMERCIO.COD_PROVINCIA
          JOIN TB_CIUDAD
            ON TB_COMERCIO.COD_PROVINCIA = TB_CIUDAD.COD_PROVINCIA
           AND TB_COMERCIO.COD_CIUDAD = TB_CIUDAD.COD_CIUDAD
          JOIN TB_PARROQUIA
            ON TB_COMERCIO.COD_PARROQUIA = TB_PARROQUIA.COD_PARROQUIA
           AND TB_COMERCIO.COD_PROVINCIA = TB_PARROQUIA.COD_PROVINCIA
           AND TB_COMERCIO.COD_CIUDAD = TB_PARROQUIA.COD_CIUDAD
          JOIN TB_LOG_TRANSACCION
            ON TB_COMERCIO.CODIGO_MERCHANT = TB_LOG_TRANSACCION.MERCHANTID
          JOIN TB_DETALLE_TRANSACCION DT
            ON TB_LOG_TRANSACCION.NTXGENCOUNTER = DT.NTXGENCOUNTER
          JOIN TB_CADENA
            ON TB_LOG_TRANSACCION.IDCADENA = TB_CADENA.ID
          JOIN ADMINCONC.tbconfigentfin@DBLINKCONCILIACION tconfigentfin
            ON tconfigentfin.icodigoentidadfinanciera = TB_CADENA.ID
          JOIN ADMINCONC.tbcomisionista@DBLINKCONCILIACION tbcomisionista
            ON tconfigentfin.icodigocomisionista = tbcomisionista.icodigocomisionista
          JOIN ADMINCONC.tbconciliados@DBLINKCONCILIACION conciliado
            ON conciliado.INTXGENCOUNTER = DT.NTXGENCOUNTER
          JOIN ADMINCONC.tbcomisionista@DBLINKCONCILIACION tbcomisionista1
            ON conciliado.ICODIGOCOMISIONISTA = tbcomisionista1.icodigocomisionista
          WHERE TB_LOG_TRANSACCION.TIPO_TRANSACCION = 20
            AND TB_LOG_TRANSACCION.ESTADO = 0
            AND TB_LOG_TRANSACCION.ESTADO_CIERRE = 1
            AND TB_LOG_TRANSACCION.NUMERO_AUTORIZACION IS NOT NULL
            AND DT.CEDULABEN = :cedula
          ORDER BY DT.FECHACOBRO DESC
        `,
        { cedula }
      );
      detalleVentanillaRows = detalleVentanillaRs.rows || [];
      console.log(`[ORACLE TIMING] ventanilla (${detalleVentanillaRows.length} filas): ${Date.now() - tVent0}ms`);
    } catch (detalleErr) {
      console.warn('[ORACLE] No se pudo consultar detalle ventanilla de transacciones:', detalleErr.message);
      detalleVentanillaRows = [];
    } finally {
      connection.callTimeout = previousCallTimeout;
    }

    const detalleVentanillaByKey = new Map();
    const detalleVentanillaByFecha = new Map();
    for (const row of detalleVentanillaRows) {
      const fechaIso = toIsoDate(row.FECHA_COBRO);
      if (!fechaIso) continue;

      const detalle = {
        provincia: `${row.PROVINCIA || ''}`.trim() || null,
        ciudad: `${row.CIUDAD || ''}`.trim() || null,
        canton: `${row.CIUDAD || ''}`.trim() || null,
        parroquia: `${row.PARROQUIA || ''}`.trim() || null,
        banco: `${row.BANCO || ''}`.trim() || null,
        agencia: `${row.AGENCIA || ''}`.trim() || null,
        direccionAgencia: `${row.DIRECCION_AGENCIA || ''}`.trim() || null
      };

      const key = keyDetalleVentanilla(fechaIso, row.BONO_TITULAR);
      if (!detalleVentanillaByKey.has(key)) {
        detalleVentanillaByKey.set(key, detalle);
      }
      if (!detalleVentanillaByFecha.has(fechaIso)) {
        detalleVentanillaByFecha.set(fechaIso, detalle);
      }
    }

    const cobros = rows
      .filter((r) => {
        const codStatus = `${r.CODSTATUS ?? ''}`.trim();
        const tieneFechaCobro = !!toIsoDate(r.FECHACOBRO);

        // 27 = enviado a cuenta (se muestra aun sin fecha de cobro).
        if (codStatus === '27') return true;

        // Estados ventanilla solo cuentan como cobro real si existe FECHACOBRO.
        if (['70', '74', '75', '76', '77'].includes(codStatus)) {
          return tieneFechaCobro;
        }

        // Regla general de historial de cobros.
        return tieneFechaCobro;
      })
      .map((r) => {
        const esMilDias = inferirEsMilDias(r.CODSUBSIDIO);
        const canal = inferirCanalPago(r);
        const montoOracle = parseNumber(r.MONTO);
        const montoDefecto = montoDefectoPorSubsidio(r.CODSUBSIDIO);
        const montoNormalizado = (montoOracle !== null && montoOracle !== 0)
          ? montoOracle
          : montoDefecto;
        const fechaCobroIso = toIsoDate(r.FECHACOBRO);
        const datosVentanilla = (canal === 'VENTANILLA')
          ? (
            detalleVentanillaByKey.get(keyDetalleVentanilla(fechaCobroIso, r.CODSUBSIDIO)) ||
            detalleVentanillaByFecha.get(fechaCobroIso) ||
            datosVentanillaBeneficiario
          )
          : null;
        return {
          codigoben: `${r.CODIGOBEN ?? ''}`.trim(),
          codSubsidio: `${r.CODSUBSIDIO ?? ''}`.trim(),
          codPeriodo: `${r.CODPERIODO ?? ''}`.trim(),
          codSubperiodo: `${r.CODSUBPERIODO ?? ''}`.trim(),
          periodo: buildPeriodoLabel(r.CODPERIODO, r.CODSUBPERIODO),
          monto: montoNormalizado,
          flagPago: `${r.FLAGPAGO ?? ''}`.trim(),
          codStatus: `${r.CODSTATUS ?? ''}`.trim(),
          codAccion: `${r.CODACCION ?? ''}`.trim(),
          fechaCobro: fechaCobroIso,
          fechaRegistro: toIsoDate(r.FECHAREGISTRO),
          referencia: `${r.REFERENCIA ?? ''}`.trim() || null,
          mid: `${r.MID ?? ''}`.trim() || null,
          tid: `${r.TID ?? ''}`.trim() || null,
          codRepres: `${r.CODREPRES ?? ''}`.trim() || null,
          tipoPrograma: esMilDias ? '1000_DIAS' : 'BONOS',
          canalPago: canal,
          provincia: (canal === 'VENTANILLA' && datosVentanilla) ? datosVentanilla.provincia : null,
          ciudad: (canal === 'VENTANILLA' && datosVentanilla) ? datosVentanilla.ciudad : null,
          canton: (canal === 'VENTANILLA' && datosVentanilla) ? (datosVentanilla.canton || datosVentanilla.ciudad) : null,
          parroquia: (canal === 'VENTANILLA' && datosVentanilla) ? datosVentanilla.parroquia : null,
          banco: (canal === 'VENTANILLA' && datosVentanilla) ? datosVentanilla.banco : null,
          agencia: (canal === 'VENTANILLA' && datosVentanilla) ? datosVentanilla.agencia : null,
          direccionAgencia: (canal === 'VENTANILLA' && datosVentanilla) ? datosVentanilla.direccionAgencia : null
        };
      });

    return {
      enabled: true,
      available: true,
      message: null,
      beneficiario: {
        codigoben: `${beneficiario.CODIGOBEN ?? ''}`.trim(),
        cedula: `${beneficiario.CEDULA ?? ''}`.trim(),
        nombres: `${beneficiario.NOMBRES ?? ''}`.trim(),
        codSubsidio: `${beneficiario.CODSUBSIDIO ?? ''}`.trim(),
        monto: beneficiario.MONTO ?? null,
        fechaInicio: toIsoDate(beneficiario.FECHAINICIO),
        fechaFin: toIsoDate(beneficiario.FECHAFIN),
        fechaRegistro: toIsoDate(beneficiario.FECHAREGISTRO)
      },
      // TB_DETALLE_TRANSACCION — fuente principal (ventanilla confirmada)
      detalleTransaccionRows: detalleVentanillaRows,
      // TB_HISTORIAL_PERMANENTE_ACUM — soporte/fallback
      historialPermanenteRows: cobros
    };
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (closeErr) {
        console.warn('[ORACLE] No se pudo cerrar la conexion:', closeErr.message);
      }
    }
  }
}


/**
 * Merge de 3 fuentes con prioridad:
 * 1° TB_DETALLE_TRANSACCION  → ventanilla confirmada (fuente principal)
 * 2° CUADRE_PAGO_CUENTA      → cuenta confirmada (complementa períodos nuevos)
 * 3° TB_HISTORIAL_PERMANENTE → soporte para períodos no cubiertos por las anteriores
 */
function mergeCobros3Fuentes({ detalleTransaccionRows, sqlContinuidadRows, historialPermanenteRows }) {
  // ─── FUENTE 1: TB_DETALLE_TRANSACCION (ventanilla confirmada) ───────────────
  const ventanillaRows = (detalleTransaccionRows || [])
    .map((r) => {
      const { mes, anio } = inferirMesAnioDesdeFecha(r.FECHA_COBRO);
      const codPeriodo = buildCodPeriodoFiscal(anio);
      const codSubperiodo = mes ? `${mes}` : '';
      const codSubsidio = normalizarCodSubsidioCanonico(
        `${r.BONO_TITULAR || ''}`.trim()
      );
      const esMilDias = inferirEsMilDias(codSubsidio);
      const monto = parseNumber(r.MONTO_COBRADO);

      return {
        codigoben: `${r.CEDULA_TITULAR || ''}`.trim(),
        codSubsidio,
        codPeriodo: codPeriodo || '',
        codSubperiodo,
        periodo: buildPeriodoLabel(codPeriodo, codSubperiodo),
        monto: monto !== null && monto !== 0
          ? monto
          : (montoDefectoPorSubsidio(codSubsidio) ?? null),
        flagPago: '1',
        codStatus: '70',   // ventanilla confirmada
        codAccion: '000',
        fechaCobro: toIsoDate(r.FECHA_COBRO),
        fechaRegistro: null,
        referencia: null,
        mid: null,
        tid: null,
        codRepres: null,
        tipoPrograma: esMilDias ? '1000_DIAS' : 'BONOS',
        canalPago: 'VENTANILLA',
        provincia: `${r.PROVINCIA || ''}`.trim() || null,
        ciudad: `${r.CIUDAD || ''}`.trim() || null,
        canton: `${r.CIUDAD || ''}`.trim() || null,
        parroquia: `${r.PARROQUIA || ''}`.trim() || null,
        banco: `${r.BANCO || ''}`.trim() || null,
        agencia: `${r.AGENCIA || ''}`.trim() || null,
        direccionAgencia: `${r.DIRECCION_AGENCIA || ''}`.trim() || null,
      };
    })
    .filter((r) => r.codPeriodo && r.codSubperiodo && r.fechaCobro);

  // Set de períodos cubiertos por TB_DETALLE_TRANSACCION (incluye tipoPrograma para no bloquear cruzado entre BONOS y 1000_DIAS)
  const periodosCubiertosDetalle = new Set(
    ventanillaRows.map((r) => `${r.codPeriodo}|${r.codSubperiodo}|${r.tipoPrograma}`)
  );

  // ─── FUENTE 2: CUADRE_PAGO_CUENTA (cuenta confirmada) ──────────────────────
  // Solo toma períodos que TB_DETALLE_TRANSACCION NO cubre (por el mismo programa)
  const cuentaRows = (sqlContinuidadRows || [])
    .filter((r) => {
      const baseKey = `${r.codPeriodo || ''}|${r.codSubperiodo || ''}`;
      const fullKey = `${baseKey}|${r.tipoPrograma || ''}`;
      return baseKey !== '|' && !periodosCubiertosDetalle.has(fullKey);
    });

  // Set de períodos cubiertos por las 2 fuentes principales
  const periodosCubiertosTotal = new Set([
    ...periodosCubiertosDetalle,
    ...cuentaRows.map((r) => `${r.codPeriodo}|${r.codSubperiodo}|${r.tipoPrograma}`)
  ]);

  // ─── FUENTE 3: TB_HISTORIAL_PERMANENTE_ACUM (soporte/fallback) ─────────────
  // Solo toma períodos que ninguna de las dos fuentes anteriores cubre (por el mismo programa)
  const historialRows = (historialPermanenteRows || [])
    .filter((r) => {
      const baseKey = `${r.codPeriodo || ''}|${r.codSubperiodo || ''}`;
      const fullKey = `${baseKey}|${r.tipoPrograma || ''}`;
      return baseKey !== '|' && !periodosCubiertosTotal.has(fullKey);
    });

  // ─── Unir y ordenar ────────────────────────────────────────────────────────
  const todas = [...ventanillaRows, ...cuentaRows, ...historialRows];

  return todas.sort((a, b) => {
    const yearA = Number.parseInt(`${a.codPeriodo || ''}`, 10) || 0;
    const yearB = Number.parseInt(`${b.codPeriodo || ''}`, 10) || 0;
    if (yearA !== yearB) return yearB - yearA;
    const monthA = Number.parseInt(`${a.codSubperiodo || ''}`, 10) || 0;
    const monthB = Number.parseInt(`${b.codSubperiodo || ''}`, 10) || 0;
    return monthB - monthA;
  });
}

function buildDbConfig(server) {
  return {
    ...baseDbConfig,
    server
  };
}

async function getPool() {
  if (poolPromise) {
    return poolPromise;
  }

  if (dbServers.length === 0) {
    throw new Error('No hay servidores SQL configurados. Defina DB_SERVER en el archivo .env.');
  }

  poolPromise = (async () => {
    let lastError = null;

    for (const server of dbServers) {
      try {
        console.log(`[DB] Intentando conectar a ${server}`);
        const pool = await sql.connect(buildDbConfig(server));
        currentDbServer = server;
        console.log(`[DB] Conectado a ${server}`);
        return pool;
      } catch (err) {
        lastError = err;
        currentDbServer = null;
        console.error(`[DB] Fallo de conexión a ${server}: ${err.message}`);
        try {
          await sql.close();
        } catch (closeErr) {
          console.warn('[DB] No se pudo cerrar la conexión fallida:', closeErr.message);
        }
      }
    }

    throw lastError || new Error('No fue posible conectarse a ningún servidor SQL configurado.');
  })();

  try {
    return await poolPromise;
  } catch (err) {
    poolPromise = null;
    throw err;
  }
}

// =============== HEALTH CHECK ===============
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    currentDbServer
  });
});

app.post('/buscarBeneficiario', limiter, async (req, res) => {
  const reqStartedAt = Date.now();
  const cedulaRaw = (req.body?.cedula || '').trim();
  if (!/^[0-9]{10}$/.test(cedulaRaw) || cedulaRaw === '0000000000') {
    return res.status(400).json({ success: false, message: 'Cedula invalida. Debe tener exactamente 10 digitos numericos.' });
  }
  const cedula = cedulaRaw;
  console.log(`[TIMING] buscarBeneficiario START cedula=${cedula}`);

  try {
    const pool = await getPool();

    const qUltimaTablaCorte = `
      SELECT TOP (1)
        TABLE_NAME
      FROM [192.168.98.210].[SippsDataBono].[INFORMATION_SCHEMA].[TABLES]
      WHERE TABLE_SCHEMA = 'dbo'
        AND TABLE_TYPE = 'BASE TABLE'
        AND TABLE_NAME LIKE 'tabla_general_Corte20%'
      ORDER BY TABLE_NAME DESC
    `;

    const rUltimaTablaCorte = await pool.request().query(qUltimaTablaCorte);
    const tablaCorteNombre = rUltimaTablaCorte.recordset && rUltimaTablaCorte.recordset[0] && rUltimaTablaCorte.recordset[0].TABLE_NAME;
    if (!tablaCorteNombre) {
      throw new Error('No se encontro ninguna tabla_general_Corte en el servidor 210.');
    }
    const tablaCorteActual = `[192.168.98.210].[SippsDataBono].[dbo].[${tablaCorteNombre}]`;

    const qColumnasVistaDatosGenerales = `
      SELECT UPPER(c.name) AS col
      FROM sys.columns c
      INNER JOIN sys.objects o ON o.object_id = c.object_id
      INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = 'dbo'
        AND o.name = 'VISTA_REP_DATOS_GENERALES'
    `;

    const rColumnasVistaDatosGenerales = await pool.request().query(qColumnasVistaDatosGenerales);
    const columnasVistaDatosGenerales = new Set((rColumnasVistaDatosGenerales.recordset || []).map((r) => `${r.col || ''}`.trim().toUpperCase()));

    const colCodigoTipoSubsidio = columnasVistaDatosGenerales.has('CODIGO_TIPO_SUBSIDIO')
      ? 'codigo_tipo_subsidio'
      : 'CAST(NULL AS VARCHAR(50)) AS codigo_tipo_subsidio';

    const colCodigoTipoExcepcion = columnasVistaDatosGenerales.has('CODIGO_TIPO_EXCEPCION')
      ? 'codigo_tipo_excepcion'
      : 'CAST(NULL AS VARCHAR(50)) AS codigo_tipo_excepcion';

    const qDatosGenerales = `
      SELECT TOP (1)
        registroSocial,
        edad_rs,
        fecha_nacimiento_rs,
        fechaencuesta,
        cedula,
        condicion_cedulado_rc,
        nombres,
        apellidos,
        puntaje,
        FECHA_DE_ENCUESTA,
        banda_pobreza,
        FECHA_SALIDA,
        MOTIVO_SALIDA,
        ${colCodigoTipoSubsidio},
        ${colCodigoTipoExcepcion},
        estado
      FROM dbo.VISTA_REP_DATOS_GENERALES
      WHERE cedula = @cedula
      ORDER BY
        CASE
          WHEN TRY_CONVERT(INT, registroSocial) BETWEEN 2000 AND 2100 THEN 0
          ELSE 1
        END,
        TRY_CONVERT(DATE, COALESCE(fechaencuesta, FECHA_DE_ENCUESTA)) DESC
    `;

    // Una sola consulta al corte mensual (reemplaza qDatosGeneralesCorte + qRegistroSocialCorte + qInclusionFlags)
    const qCorteUnico = `
      SELECT TOP (1) *
      FROM ${tablaCorteActual}
      WHERE [cedula] = @cedula OR [cedula_beneficiario] = @cedula
      ORDER BY
        CASE
          WHEN TRY_CONVERT(INT, registroSocial) BETWEEN 2000 AND 2100 THEN 0
          ELSE 1
        END
    `;

    const qDatosRS = `
      SELECT TOP (1)
        cedula,
        apellidos,
        nombres,
        certificado,
        puntajers2014,
        numeronucleo,
        fechanacimiento,
        fechafallecido,
        fechaencuesta,
        edad_persona,
        BONO_DESARROLLO_HUMANO
      FROM dbo.VISTA_REP_DATOS_RS
      WHERE cedula = @cedula
    `;

    const qIess = `
      SELECT
        CEDULA_BENEFICIARIO,
        NOMBRE,
        AÑO,
        MES,
        SEGURO_C,
        vigencia,
        CedulaBeneficiario
      FROM dbo.VISTA_REP_DATOS_IESS
      WHERE (CedulaBeneficiario = @cedula OR CEDULA_BENEFICIARIO = @cedula)
    `;

    const qBono1000 = `
      SELECT
        cedula_beneficiario,
        cedula_receptor,
        menor_de_edad,
        tipo_beneficio,
        monto_a_pagar,
        nombre_ben,
        nombre_rec,
        ced_rec_cobro,
        edad_rec_cobro,
        nombre_cobro,
        pago_cuenta,
        pago_cuenta_menor,
        estado,
        consta_plataforma,
        codstatus,
        bloqueo
      FROM dbo.VISTA_REP_1000_DIAS
      WHERE cedula_beneficiario = @cedula OR cedula_receptor = @cedula
    `;

    const qMenores = `
      SELECT
        CEDULA_REPRESENTANTE,
        CEDULA_MENOR,
        NOMBRES_MENOR,
        ESTADO
      FROM dbo.VISTA_REP_MENORES_DISCAPACIDAD
      WHERE CEDULA_REPRESENTANTE = @cedula OR CEDULA_MENOR = @cedula
    `;

    const qPuntajeHistorico = `
      ;WITH puntajes AS
      (
        SELECT
          cedula,
          Puntaje_Actual,
          ROW_NUMBER() OVER (
            PARTITION BY cedula
            ORDER BY
              TRY_CONVERT(INT, RIGHT(Mes_vigente, 4)) DESC,
              TRY_CONVERT(INT, LEFT(Mes_vigente, 2)) DESC
          ) AS rn
        FROM [Reportes_2025].[dbo].[TB_GENERAL_2026]
        WHERE cedula = @cedula
      ),
      hist_agg AS
      (
        SELECT
          MAX(CASE WHEN rn = 1 THEN CONVERT(VARCHAR(30), Puntaje_Actual) END) AS Puntaje_Anterior_1,
          MAX(CASE WHEN rn = 2 THEN CONVERT(VARCHAR(30), Puntaje_Actual) END) AS Puntaje_Anterior_2,
          MAX(CASE WHEN rn = 3 THEN CONVERT(VARCHAR(30), Puntaje_Actual) END) AS Puntaje_Anterior_3,
          MAX(CASE WHEN rn = 4 THEN CONVERT(VARCHAR(30), Puntaje_Actual) END) AS Puntaje_Anterior_4
        FROM puntajes
        WHERE rn <= 4
      ),
      actual_rs AS
      (
        SELECT TOP (1)
          CONVERT(VARCHAR(30), n.puntajers2014) AS Puntaje_Actual
        FROM [Reportes_2025].[dbo].[mcds_persona_RS18] p
        INNER JOIN [Reportes_2025].[dbo].[mcds_nucleo_RS18] n
          ON p.certificado = n.certificado
         AND p.numeronucleo = n.numeronucleo
        WHERE p.cedula = @cedula
          AND p.statusp = 'V'
          AND n.statusn = 'V'
      )
      SELECT
        COALESCE((SELECT Puntaje_Actual FROM actual_rs), (SELECT Puntaje_Anterior_1 FROM hist_agg), 'NO CONSTA') AS Puntaje_Actual,
        COALESCE((SELECT Puntaje_Anterior_1 FROM hist_agg), 'NO CONSTA') AS Puntaje_Anterior_1,
        COALESCE((SELECT Puntaje_Anterior_2 FROM hist_agg), 'NO CONSTA') AS Puntaje_Anterior_2,
        COALESCE((SELECT Puntaje_Anterior_3 FROM hist_agg), 'NO CONSTA') AS Puntaje_Anterior_3,
        COALESCE((SELECT Puntaje_Anterior_4 FROM hist_agg), 'NO CONSTA') AS Puntaje_Anterior_4
    `;

    const qBasesExternas = `
      SELECT
        CASE WHEN EXISTS (SELECT 1 FROM [192.168.98.212].[seguros].DBO.IESS WHERE CEDULA_BENEFICIARIO = @cedula AND SEGURO_C NOT IN (4,11)) THEN 'SI' ELSE 'NO' END AS IESS,
        CASE WHEN EXISTS (SELECT 1 FROM [192.168.98.212].[seguros].DBO.ISSPOL WHERE cedula = @cedula) THEN 'SI' ELSE 'NO' END AS ISSPOL,
        CASE WHEN EXISTS (SELECT 1 FROM [192.168.98.212].[seguros].DBO.FUNCIONARIOS_PUB_IESS WHERE CEDULA_BENEFICIARIO = @cedula) THEN 'SI' ELSE 'NO' END AS IESS_PUBLICO,
        CASE WHEN EXISTS (SELECT 1 FROM [192.168.98.213].BS.DBO.SERVIDORES_PUBLICOS_FINANZAS WHERE Identificacion = @cedula) THEN 'SI' ELSE 'NO' END AS MEF_PUBLICOS,
        ISNULL((SELECT TOP 1 tipo      FROM [192.168.98.210].[SippsDataBdh].[dbo].[conadis] WHERE cedula = TRY_CAST(@cedula AS NUMERIC)), 'NO') AS TIPO_DISCAPACIDAD,
        ISNULL((SELECT TOP 1 porcentaje FROM [192.168.98.210].[SippsDataBdh].[dbo].[conadis] WHERE cedula = TRY_CAST(@cedula AS NUMERIC)), 'NO') AS PORC_DISCAPACIDAD,
        CASE WHEN EXISTS (SELECT 1 FROM [192.168.98.210].[SippsBasesExternas].[dbo].[FEMICIDIO] WHERE CEDULA = @cedula) THEN 'SI' ELSE 'NO' END AS FEMICIDIO,
        CASE WHEN EXISTS (SELECT 1 FROM [192.168.98.210].[SippsBasesExternas].[dbo].[MUERTES_VIOLENTAS] WHERE CEDULA = @cedula) THEN 'SI' ELSE 'NO' END AS MUERTES_VIOLENTAS,
        CASE WHEN EXISTS (SELECT 1 FROM [192.168.98.210].[SippsBasesExternas].[dbo].[CENTROS_RESIDENCIALES_VIS] WHERE CEDULA = @cedula) THEN 'SI' ELSE 'NO' END AS ACOGIDA,
        ISNULL((SELECT TOP 1 [NOMBRE_UNIDAD_ATENCION] FROM [192.168.98.210].[SippsBasesExternas].[dbo].[CENTROS_RESIDENCIALES_VIS] WHERE CEDULA = @cedula), '') AS UNIDAD,
        CASE WHEN EXISTS (SELECT 1 FROM [192.168.98.210].[SippsBasesExternas].dbo.DESAPARECIDOS WHERE DOCUMENTO = @cedula AND [Situación Actual] IN ('DESAPARECIDO','FALLECIDO')) THEN 'SI' ELSE 'NO' END AS DINASED,
        ISNULL((SELECT TOP 1 CASE condicion WHEN 0 THEN 'NO_VULNERABLE' ELSE 'VULNERABLE' END FROM [192.168.98.206].[HeroesHeroinas].[dbo].[Heroes_Heroinas_0426] WHERE CAST(cedula AS NUMERIC) = TRY_CAST(@cedula AS NUMERIC)), 'NO') AS EXCOMBATIENTES,
        ISNULL((SELECT TOP 1 CASE WHEN tipo = 'X' THEN 'EX-COMBATIENTE' ELSE 'ISSFA' END FROM [192.168.98.212].[seguros].DBO.ISSFA WHERE cedula = @cedula), 'NO') AS ISSFA,
        CASE WHEN EXISTS (SELECT 1 FROM [192.168.98.210].[SippsBasesExternas].[dbo].[BENEFICIARIOS_BJGL] WHERE CEDULA = @cedula) THEN 'SI' ELSE 'NO' END AS JGL_ACTUAL,
        ISNULL(
          (SELECT TOP 1 CONVERT(VARCHAR, MAX(CONVERT(DATE, a.FechaRegistro, 103)))
           FROM [Reportes_2025].[sipps].[HistoricoJGL] h
           INNER JOIN [Reportes_2025].[sipps].[Archivo] a ON a.IdArchivo = h.IdArchivo
           WHERE h.CedulaBeneficiario = @cedula AND h.Estado = 'ACT' AND ISNUMERIC(h.CedulaBeneficiario) = 1),
        'NO') AS ULTIMO_MES_JGL
    `;

    const qContactabilidad = `
      SELECT [PROVINCIA] AS provincia,[CANTON] AS canton,[PARROQUIA] AS parroquia,
             [LOCALIDAD] AS localidad,[REFERENCIA VV] AS referencia,[CALLE 1] AS calle1,
             [CALLE 2] AS calle2,[CELULAR] AS celular,[TELEFONO 7] AS telefono7,[TELEFONO 8] AS telefono8
      FROM [192.168.98.210].[SippsDataBono].[dbo].[DWContactabilidad]
      WHERE [CEDULA] = @cedula
      UNION
      SELECT [PROVINCIA],[CANTON],[PARROQUIA],[LOCALIDAD],[REFERENCIA VV],
             [CALLE 1],[CALLE 2],[CELULAR],[TELEFONO 7],[TELEFONO 8]
      FROM [192.168.98.210].[SippsDataBono].[dbo].[DWContactabilidad]
      WHERE [CEDULA BENEFICIARIO] = @cedula
      ORDER BY provincia, canton, parroquia, localidad
    `;


    //Jordy chila 
    // Consulta para SC_CED_BEN_TOTAL (FECHAS DE INICIO Y FIN) - ACEPTA NÚMEROS Y LETRAS
    const qFechasBono = `
      WITH CTE_BENEFICIARIO AS (
        SELECT
            CEDULA_BENEFICIARIO,
            CEDULA_RECEPTOR,
            fecha_inscripcion,
            FECHA_SALIDA,
            MOTIVO_SALIDA,
    
          -- Normalización de fechas (una sola vez)
          TRY_CONVERT(DATE, fecha_inscripcion) AS FECHA_INICIO_DATE,
          TRY_CONVERT(DATE, FECHA_SALIDA) AS FECHA_FIN_DATE,
    
          ROW_NUMBER() OVER (
            ORDER BY
                CASE
                    WHEN CEDULA_BENEFICIARIO = TRY_CAST(@cedula AS BIGINT) THEN 1
                    WHEN CEDULA_RECEPTOR     = TRY_CAST(@cedula AS BIGINT) THEN 2
                    ELSE 3
                END,
                TRY_CONVERT(DATE, FECHA_SALIDA) DESC
        ) AS rn

    FROM [192.168.98.210].[SippsDataBdh].[dbo].[SC_CED_BEN_TOTAL]
    WHERE
        CEDULA_BENEFICIARIO = TRY_CAST(@cedula AS BIGINT)
        OR CEDULA_RECEPTOR  = TRY_CAST(@cedula AS BIGINT)
)
    
SELECT
    CEDULA_BENEFICIARIO,
    CEDULA_RECEPTOR,
    
    -- FECHA INICIO (fecha válida o texto)
    CASE
        WHEN FECHA_INICIO_DATE IS NOT NULL
        THEN CONVERT(VARCHAR(10), FECHA_INICIO_DATE, 120)
        ELSE CAST(fecha_inscripcion AS VARCHAR(MAX))
    END AS FECHA_INICIO,
    
    -- FECHA FIN (fecha válida o texto)
    CASE
        WHEN FECHA_FIN_DATE IS NOT NULL
        THEN CONVERT(VARCHAR(20), FECHA_FIN_DATE, 120)
        ELSE CAST(FECHA_SALIDA AS VARCHAR(MAX))
    END AS FECHA_FIN,
    
    ISNULL(MOTIVO_SALIDA, '') AS MOTIVO_SALIDA
    
FROM CTE_BENEFICIARIO
WHERE rn = 1;
`;

    const tq = (name, promise) => {
      const t0 = Date.now();
      return promise.then(r => { console.log(`[TIMING] ${name}: ${Date.now() - t0}ms`); return r; })
        .catch(err => { console.log(`[TIMING] ${name}: ERROR ${Date.now() - t0}ms – ${err.message}`); return { recordset: [] }; });
    };

    // OPTIMIZACIÓN: Reutilizar request object cuando posible, definir inputs una sola vez
    const createRequest = () => pool.request().input('cedula', sql.VarChar(20), cedula);

    const [
      resultDatosGenerales,
      resultCorteUnico,
      resultDatosRS,
      resultIess,
      resultBono1000,
      resultMenores,
      resultPuntajeHistorico,
      resultBasesExternas,
      resultContactabilidad,
      resultFechasBono,
    ] = await Promise.all([
      tq('datosGenerales', createRequest().query(qDatosGenerales)),
      tq('corteUnico', createRequest().query(qCorteUnico)),
      tq('datosRS', createRequest().query(qDatosRS)),
      tq('iess', createRequest().query(qIess)),
      tq('bono1000', createRequest().query(qBono1000)),
      tq('menores', createRequest().query(qMenores)),
      tq('puntajeHistorico', createRequest().query(qPuntajeHistorico)),
      tq('basesExternas', createRequest().query(qBasesExternas)),
      tq('contactabilidad', createRequest().query(qContactabilidad)),
      tq('fechasBono', createRequest().query(qFechasBono)),
    ]);

    const datosGeneralesVista = (resultDatosGenerales.recordset && resultDatosGenerales.recordset[0]) || null;
    const datosGeneralesCorte = (resultCorteUnico.recordset && resultCorteUnico.recordset[0]) || null;

    const pickFirstValue = (row, keys) => {
      if (!row) return undefined;
      for (const k of keys) {
        const v = row[k];
        if (v !== undefined && v !== null && `${v}`.trim() !== '') return v;
      }
      return undefined;
    };

    // Catalogos locales (codigo -> descripcion / monto)
    const EXCEPCION_CATALOGO = {
      0: 'ABRE TU CUENTA BANCARIA Y COBRA SEGURO TU BONO',
      1: 'REALICE TRAMITE PENSION EX COMBATIENTES',
      2: 'NO CUMPLE EDAD PARA BONO 3RA EDAD',
      3: 'HIJO CUMPLE MAYORIA DE EDAD',
      4: 'R.CIVIL REPORTA CIUDADANO EXTRANJERO',
      5: 'FALTA DOCUMENTOS (CEDULA)',
      6: 'FALTA DOCUMENTOS (PARTIDA)',
      7: 'INGRESOS MAYORES A 1 MILLON',
      8: 'CASO NO ACEPTADO/PADRE VIUDO',
      9: 'CASO NO ACEPTADO/PADRE A CARGO HIJO',
      10: 'CASO NO ACEPTADO/ABUELO A CARGO NIETO',
      11: 'DATOS DE HIJO/A NO CORRESPONDEN',
      12: 'CASO NO ACEPTADO/FAMILIAR DE MENOR',
      15: 'SOLIC.CON DOC. FALSOS PARTIDA O CEDULA',
      16: 'CASO NO ACEPT/SOLICIT.CON MENOR ADOPT.',
      17: 'CASO NO ACEPTADO/HERMANO A CARGO MENOR',
      18: 'CEDULA EN VERIFICACION',
      19: 'NUM.CEDULA ERRADO REG.CIV.(DUPLICADA)',
      20: 'CONSTA EN LA BASE DE IESS',
      21: 'AFILIADO VOLUNTARIO GANA MAS DEL MILLON',
      22: 'AFILIADO VOLUNTARIO GANA MAS DE 500 MIL',
      23: 'UD. ES GARANTE O TIENE CREDITO BANCARIO',
      24: 'CONYUGE ES GARANTE O TIENE CRD.BANCARIO',
      25: 'SU CONSUMO DE LUZ ES MAYOR LIMITE BONO',
      26: 'CONSUMO DE LUZ CONYUG.MAYOR LIMITE BONO',
      27: 'BENEFICIARIO CON CUENTA EN LA BANCA',
      28: 'CONYUGE CON CUENTA EN LA BANCA',
      29: 'CONSTA EN LA BASE DE ISSFA',
      30: 'CONSTA EN LA BASE DE ISSPOL',
      31: 'CONSTA EN LA BASE DE DINASED',
      32: 'USUARIO EN SERVICIO RESIDENCIAL',
      33: 'CIUDADANO CONSTA EN MUNICIPIO-CATASTRO',
      34: 'R.CIVIL REPORTA DIGITO VERIFICADOR ERRADO',
      35: 'CUMPLE CORRESPONSABILIDAD, INGRESO PROGRESIVO',
      36: 'R.CIVIL REPORTA BENEFICIARIO NO CONSTA EN BASE',
      37: 'R.CIVIL REPORTA BENEFICIARIO FALLECIDO',
      38: 'DOCUMENTO DE IDENTIDAD NO VALIDO PARA COBRO',
      39: 'URGENTE LLAME AL 1800 002 002 ANTES DEL 15 DEL MES',
      40: 'UD. O CONY. TIENE LINEA TELEFONICA',
      41: 'INFORMACION NO VERIFICABLE, ACERCARSE AL MIES',
      44: 'CEDULA NO ESTA VIGENTE PARA COBRO',
      45: 'CIUDADANO CONSTA EN SRI',
      46: 'SU CONYUGE COBRA BONO DE MADRE',
      47: 'FALTA CEDULA CONYUGE',
      48: 'R.CIVIL REPORTA QUE UD. DEBE ACERCARSE PERSONALMENTE',
      49: 'FALTA CARNET DEL CONADIS',
      50: 'NO CALIFICA AL BONO DE DESARROLLO HUMANO',
      51: 'NO CALIFICA AL BONO DE DESARROLLO HUMANO',
      52: 'ACERQUESE PERSONALMENTE AL CENTRO DE INFORMACION',
      53: 'NO CALIFICA AL BONO/PENSION',
      54: 'BENEFICIARIO CON BLOQUEO TEMPORAL',
      55: 'JEFE DE FAMILIA YA COBRA EL BONO',
      56: 'NO CALIFICA AL BONO DE DESARROLLO HUMANO',
      57: 'FALTA INSCRIPCION LLAME 1800-272727',
      58: 'SIN ENCUESTA, NUEVO REGISTRO SOCIAL',
      59: 'SUSPENDIDO POR EDUCACION DE HIJOS LLAME 1800002002',
      61: 'CDH/AHORRO',
      70: 'ABRE UNA CUENTA BANCARIA Y COBRA SEGURO TU PENSION',
      74: 'PARA CONTINUAR COBRANDO TU BONO ABRE UNA CUENTA',
      75: 'ABRE UNA CUENTA BANCARIA Y COBRA SEGURO TU PENSION',
      76: 'ABRE UNA CUENTA BANCARIA Y COBRA SEGURO TU BONO',
      77: 'ABRE UNA CUENTA BANCARIA Y COBRA SEGURO TU PENSION',
      78: 'SE CORRESPONSABLE, ENVIA A TUS HIJOS A LA ESCUELA',
      79: 'RETIRE TARJETA PACIFICO GRATIS EN AGENCIA AGUIRRE',
      88: 'JOAQUIN GALLEGOS LARA',
      90: 'DISCAPACITADO NO CUMPLE REQUISITOS (MSP)',
      91: 'MADRE EMBARAZADA',
      92: 'BONO SUSPENDIDO LLAME 1800 002002-RECIBE JOAQUIN GALLEGOS LARA',
      93: 'BLOQUEO TEMPORAL BMD POR NO APERTURA DE CUENTA',
      94: 'BONO SUSPENDIDO LLAME A 1800 002002 - SERVIDOR PUBLICO',
      99: 'SOLICITUD DE BLOQUEO VOLUNTARIO',
      200: 'DISTRITO METROPOLITANO DE QUITO',
      888: 'JOAQUIN GALLEGOS LARA',
      998: 'UD YA COBRO ADELANTADO',
      999: 'COBRA REPRESENTANTE ENCUESTA'
    };

    const SUBSIDIO_CATALOGO = {
      1: { codigo: 'BDH', descripcion: 'BONO DE DESARROLLO HUMANO', monto: 50.00 },
      2: { codigo: 'PAM', descripcion: 'PENSION ADULTO MAYOR', monto: 50.00 },
      3: { codigo: 'PDD', descripcion: 'PENSION PERSONAS CON DISCAPACIDAD', monto: 50.00 },
      4: { codigo: null, descripcion: 'MADRES', monto: null },
      5: { codigo: 'MMA', descripcion: 'PENSION MIS MEJORES ANOS', monto: 100.00 },
      6: { codigo: 'BVA', descripcion: 'BONO DE DESARROLLO HUMANO CON COMPONENTE VARIABLE', monto: null },
      7: { codigo: 'PTUV, PTVA', descripcion: 'PENSION TODA UNA VIDA', monto: 100.00 },
      8: { codigo: 'PTVM', descripcion: 'PENSION TODA UNA VIDA MENORES', monto: 100.00 },
      9: { codigo: 'BMD', descripcion: 'BONO 1000 DIAS', monto: null },
      20: { codigo: null, descripcion: 'DISTRITO METROPOLITANO DE QUITO', monto: null },
      88: { codigo: null, descripcion: 'JOAQUIN GALLEGOS LARA', monto: 240.00 },
      99: { codigo: 'BDD', descripcion: 'PENSIÓN MENORES DE EDAD CON DISCAPACIDAD', monto: 50.00 }
    };

    const parseCodigo = (value) => {
      if (value === undefined || value === null) return null;
      const s = `${value}`.trim();
      if (!s) return null;
      const m = s.match(/\d+/);
      return m ? Number(m[0]) : null;
    };

    const normalizarTexto = (value) => `${value || ''}`
      .toString()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toUpperCase();

    const CODIGO_EXCEPCION_POR_TEXTO = Object.entries(EXCEPCION_CATALOGO)
      .reduce((acc, [codigo, descripcion]) => {
        acc[normalizarTexto(descripcion)] = Number(codigo);
        return acc;
      }, {});

    const resolverCodigoExcepcion = (...valores) => {
      for (const value of valores) {
        const cod = parseCodigo(value);
        if (cod !== null) return cod;
      }
      for (const value of valores) {
        const cod = CODIGO_EXCEPCION_POR_TEXTO[normalizarTexto(value)];
        if (cod !== undefined) return cod;
      }
      return null;
    };

    const mapExcepcionTexto = (raw) => {
      if (raw === undefined || raw === null || `${raw}`.trim() === '') return raw;
      const cod = parseCodigo(raw);
      if (cod !== null && EXCEPCION_CATALOGO[cod]) return EXCEPCION_CATALOGO[cod];
      return raw;
    };

    const mapSubsidioTexto = (raw) => {
      if (raw === undefined || raw === null || `${raw}`.trim() === '') return raw;
      const cod = parseCodigo(raw);
      if (cod !== null && SUBSIDIO_CATALOGO[cod]) {
        const item = SUBSIDIO_CATALOGO[cod];
        const montoTxt = item.monto != null ? ` ($${item.monto.toFixed(2)})` : '';
        const codigoTxt = item.codigo ? ` [${item.codigo}]` : '';
        return `${item.descripcion}${codigoTxt}${montoTxt}`;
      }
      return raw;
    };

    let excepcionCodigoDetectado = null;

    const datosGenerales = (() => {
      if (!datosGeneralesVista && !datosGeneralesCorte) return null;
      const base = { ...(datosGeneralesVista || {}) };

      // Campos críticos priorizados desde el corte mensual cuando existan
      const overrides = {
        registroSocial: ['registroSocial', 'registrosocial', 'REGISTROSOCIAL'],
        estado: ['estado', 'ESTADO'],
        condicion_cedulado_rc: ['condicion_cedulado_rc', 'CONDICION_CEDULADO_RC', 'condicion_cedulado', 'CONDICION_CEDULADO'],
        FECHA_SALIDA: ['FECHA_SALIDA', 'fecha_salida', 'FECHA SALIDA'],
        MOTIVO_SALIDA: ['MOTIVO_SALIDA', 'motivo_salida', 'MOTIVO SALIDA'],
        banda_pobreza: ['banda_pobreza', 'BANDA_POBREZA'],
        decil: ['decil', 'DECIL', '[decil]', '[DECIL]', 'decil_rs', 'DECIL_RS', 'decil rs', 'DECIL RS', 'decil ', 'DECIL '],
        fechaencuesta: ['fechaencuesta', 'FECHA_DE_ENCUESTA', 'FECHA ENCUESTA']
      };


      for (const [dest, sourceKeys] of Object.entries(overrides)) {
        const fromCorte = pickFirstValue(datosGeneralesCorte, sourceKeys);
        if (fromCorte !== undefined) base[dest] = fromCorte;
      }

      // NUEVO BLOQUE: Validación inteligente de subsidio y excepción
      // Primero intenta subsidio_final de corte; si vacío, usa codigo_tipo_subsidio de corte; si vacío, usa vista
      const subsidioCorteRaw = pickFirstValue(datosGeneralesCorte, [
        'subsidio_final',
        'SUBSIDIO_FINAL',
        'cod_subsidiofinal',
        'COD_SUBSIDIOFINAL',
        'subsidio_EDMBEN',
        'SUBSIDIO_EDMBEN'
      ]);
      const subsidioCodigoCorte = pickFirstValue(datosGeneralesCorte, ['codigo_tipo_subsidio', 'CODIGO_TIPO_SUBSIDIO']);
      const subsidioVistaRaw = pickFirstValue(datosGeneralesVista, [
        'codigo_tipo_subsidio',
        'CODIGO_TIPO_SUBSIDIO',
        'subsidio_final',
        'SUBSIDIO_FINAL',
        'subsidio',
        'SUBSIDIO'
      ]);

      const subsidioRaw =
        (subsidioCorteRaw !== undefined && `${subsidioCorteRaw}`.trim() !== '' ? subsidioCorteRaw : null) ??
        (subsidioCodigoCorte !== undefined && `${subsidioCodigoCorte}`.trim() !== '' ? subsidioCodigoCorte : null) ??
        subsidioVistaRaw;

      // Lo mismo para excepción
      const excepcionCorteRaw = pickFirstValue(datosGeneralesCorte, [
        'excepcion_final',
        'EXCEPCION_FINAL',
        'excepcion fina',
        'EXCEPCION FINA',
        'excepcion_EDMBEN',
        'EXCEPCION_EDMBEN'
      ]);
      const excepcionCodigoCorte = pickFirstValue(datosGeneralesCorte, ['codigo_tipo_excepcion', 'CODIGO_TIPO_EXCEPCION']);
      const excepcionVistaRaw = pickFirstValue(datosGeneralesVista, [
        'codigo_tipo_excepcion',
        'CODIGO_TIPO_EXCEPCION',
        'excepcion_final',
        'EXCEPCION_FINAL',
        'excepcion',
        'EXCEPCION'
      ]);

      const excepcionRaw =
        (excepcionCorteRaw !== undefined && `${excepcionCorteRaw}`.trim() !== '' ? excepcionCorteRaw : null) ??
        (excepcionCodigoCorte !== undefined && `${excepcionCodigoCorte}`.trim() !== '' ? excepcionCodigoCorte : null) ??
        excepcionVistaRaw;

      excepcionCodigoDetectado = resolverCodigoExcepcion(excepcionCodigoCorte, excepcionCorteRaw, excepcionVistaRaw, excepcionRaw);

      // Si el corte tiene un código o texto que mapea a código forzado-no-habilitado,
      // tiene prioridad sobre lo que la vista haya aportado
      const CODIGOS_FORZADO_NO_HABILITADO = new Set([41]);
      const codigoCorteDirecto = parseCodigo(excepcionCodigoCorte);
      if (codigoCorteDirecto !== null && CODIGOS_FORZADO_NO_HABILITADO.has(codigoCorteDirecto)) {
        excepcionCodigoDetectado = codigoCorteDirecto;
      } else if (!CODIGOS_FORZADO_NO_HABILITADO.has(excepcionCodigoDetectado ?? -1)) {
        const codCorteTexto = CODIGO_EXCEPCION_POR_TEXTO[normalizarTexto(excepcionCorteRaw)];
        if (codCorteTexto !== undefined && CODIGOS_FORZADO_NO_HABILITADO.has(codCorteTexto)) {
          excepcionCodigoDetectado = codCorteTexto;
        }
      }

      console.log(`[DEBUG excepcion] cedula=${cedula} | codigoCorte=${excepcionCodigoCorte} | corteRaw=${excepcionCorteRaw} | vistaRaw=${excepcionVistaRaw} | detectado=${excepcionCodigoDetectado}`);

      base.subsidio_final = mapSubsidioTexto(subsidioRaw);
      base.excepcion_final = mapExcepcionTexto(excepcionRaw);

      // Si no hay vista, al menos retornamos el corte para no perder datos.
      return Object.keys(base).length > 0 ? base : { ...(datosGeneralesCorte || {}) };

    })();

    const datosRS = (resultDatosRS.recordset && resultDatosRS.recordset[0]) || null;


    // Normalizar fechas con prioridades unificadas
    if (datosGenerales) {
      const fechasBono = resultFechasBono?.recordset?.[0] ?? {};

      // FECHA_INICIO: prioridad 1) resultFechasBono.FECHA_INICIO, 2) datosGenerales.FECHA_INICIO
      const isValidDate = (val) => val && `${val}`.trim() !== '' && `${val}`.toUpperCase() !== 'NULL';

      datosGenerales.FECHA_INICIO = isValidDate(fechasBono.FECHA_INICIO)
        ? fechasBono.FECHA_INICIO
        : (isValidDate(datosGenerales.FECHA_INICIO) ? datosGenerales.FECHA_INICIO : null);

      // FECHA_FIN: prioridad 1) resultFechasBono.FECHA_FIN, 2) datosGenerales.FECHA_FIN, 3) datosGenerales.FECHA_SALIDA
      datosGenerales.FECHA_FIN = isValidDate(fechasBono.FECHA_FIN)
        ? fechasBono.FECHA_FIN
        : (isValidDate(datosGenerales.FECHA_FIN)
          ? datosGenerales.FECHA_FIN
          : (isValidDate(datosGenerales.FECHA_SALIDA) ? datosGenerales.FECHA_SALIDA : null));

      // Eliminar FECHA_SALIDA para evitar inconsistencias (no debe exponerse al frontend)
      delete datosGenerales.FECHA_SALIDA;

      // Debug log removido por seguridad (no exponemos cedula)
    }


    // Si datosGenerales viene parcial (caso frecuente fuera de padrón de bonos),
    // completar campos básicos desde RS para no mostrar "NO CONSTA" en nombre/edad.
    if (datosGenerales && datosRS) {
      if (!datosGenerales.cedula || `${datosGenerales.cedula}`.trim() === '') {
        datosGenerales.cedula = datosRS.cedula || datosGenerales.cedula;
      }
      if (!datosGenerales.apellidos || `${datosGenerales.apellidos}`.trim() === '') {
        datosGenerales.apellidos = datosRS.apellidos || datosGenerales.apellidos;
      }
      if (!datosGenerales.nombres || `${datosGenerales.nombres}`.trim() === '') {
        datosGenerales.nombres = datosRS.nombres || datosGenerales.nombres;
      }
      if (!datosGenerales.edad_rs || `${datosGenerales.edad_rs}`.trim() === '') {
        datosGenerales.edad_rs = datosRS.edad_persona || datosGenerales.edad_rs;
      }
      if (!datosGenerales.fecha_nacimiento_rs || `${datosGenerales.fecha_nacimiento_rs}`.trim() === '') {
        datosGenerales.fecha_nacimiento_rs = datosRS.fechanacimiento || datosGenerales.fecha_nacimiento_rs;
      }
      if (!datosGenerales.nucleo || `${datosGenerales.nucleo}`.trim() === '') {
        datosGenerales.nucleo = datosRS.numeronucleo || datosGenerales.nucleo;
      }
      if (datosGenerales.puntaje === undefined || datosGenerales.puntaje === null || `${datosGenerales.puntaje}`.trim() === '') {
        datosGenerales.puntaje = datosRS.puntajers2014 || datosGenerales.puntaje;
      }
    }

    const certificado = `${datosRS?.certificado || ''}`.trim();
    const numeronucleo = `${datosRS?.numeronucleo || datosGenerales?.nucleo || ''}`.trim();

    let hogar = [];
    try {
      if (certificado) {
        const qHogarByCert = `
          SELECT
            fechaencuesta,
            cedula,
            apellidos,
            nombres,
            edad_persona,
            puntajers2014 AS puntaje,
            fechanacimiento,
            fechafallecido,
            certificado,
            numeronucleo,
            BONO_DESARROLLO_HUMANO
          FROM dbo.VISTA_REP_DATOS_RS
          WHERE certificado = @certificado
          ORDER BY apellidos, nombres
        `;
        const tH0 = Date.now();
        const r = await pool.request().input('certificado', sql.VarChar(50), certificado).query(qHogarByCert);
        console.log(`[TIMING] hogar(cert): ${Date.now() - tH0}ms`);
        hogar = r.recordset || [];
      } else if (numeronucleo) {
        const qHogarByNucleo = `
          SELECT
            fechaencuesta,
            cedula,
            apellidos,
            nombres,
            edad_persona,
            puntajers2014 AS puntaje,
            fechanacimiento,
            fechafallecido,
            certificado,
            numeronucleo,
            BONO_DESARROLLO_HUMANO
          FROM dbo.VISTA_REP_DATOS_RS
          WHERE numeronucleo = @nucleo
          ORDER BY apellidos, nombres
        `;
        const tH0 = Date.now();
        const r = await pool.request().input('nucleo', sql.VarChar(50), numeronucleo).query(qHogarByNucleo);
        console.log(`[TIMING] hogar(nucleo): ${Date.now() - tH0}ms`);
        hogar = r.recordset || [];
      }
    } catch (errH) {
      console.warn('Error consultando hogar familiar:', errH);
      hogar = [];
    }

    // Enriquecer hogar con parentesco + EsRepresentante desde SippsDataBono (tablaCorteActual)
    if (hogar.length > 0) {
      try {
        const cedulasParentesco = [...new Set(hogar.map(m => m.cedula).filter(Boolean))];
        const inListP = cedulasParentesco.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
        const qParentesco = `
          SELECT CAST(cedula AS VARCHAR(20)) AS cedula,
                 parentescojefe,
                 parentescojefenucleo,
                 EsRepresentante
          FROM ${tablaCorteActual}
          WHERE CAST(cedula AS VARCHAR(20)) IN (${inListP})
        `;
        const rPar = await pool.request().query(qParentesco);
        const parMap = new Map(
          (rPar.recordset || []).map(r => [`${r.cedula || ''}`.trim(), r])
        );
        hogar = hogar.map(m => {
          const par = parMap.get(`${m.cedula || ''}`.trim());
          return {
            ...m,
            parentescojefe: par?.parentescojefe ?? null,
            parentescojefenucleo: par?.parentescojefenucleo ?? null,
            EsRepresentante: par?.EsRepresentante ?? null
          };
        });
      } catch (ePar) {
        console.warn('[HOGAR] parentesco/representante no disponible:', ePar.message);
      }
    }

    // Lanzar Oracle historial en paralelo antes de esperar ingresoHogar
    const oracleHistorialEnabled = `${process.env.ORACLE_HISTORIAL_ENABLED || 'true'}`.toLowerCase() !== 'false';
    const sqlContinuidadEnabled = `${process.env.SQL_CONTINUIDAD_HISTORIAL_ENABLED || 'true'}`.toLowerCase() !== 'false';
    const oracleTimeoutMs = Number.parseInt(`${process.env.ORACLE_QUERY_TIMEOUT_MS || '7000'}`, 10) || 7000;
    const tOracle0 = Date.now();
    const _oracleHistorialFallback = {
      enabled: true, available: false,
      message: 'Historial Oracle deshabilitado por configuracion.',
      beneficiario: null, detalleTransaccionRows: [], historialPermanenteRows: [],
      milDiasPagoCuenta: [], milDiasVentanilla: []
    };
    const oracleHistorialPromise = oracleHistorialEnabled
      ? withTimeout(obtenerHistorialCobrosOracle(cedula), oracleTimeoutMs, `Oracle excedio el tiempo maximo de ${oracleTimeoutMs}ms`)
          .then(r  => { console.log(`[TIMING] oracleHistorial: ${Date.now() - tOracle0}ms`); return r; })
          .catch(e => {
            console.warn('[ORACLE] Error consultando historial de cobros:', e.message);
            return { ..._oracleHistorialFallback, message: `No se pudo consultar Oracle en este momento. ${e.message || ''}`.trim() };
          })
      : Promise.resolve(_oracleHistorialFallback);

    // Lanzar consulta a Jovenes en Accion en paralelo (servidor/credenciales propios)
    const tJovenes0 = Date.now();
    const jovenesAccionPromise = obtenerJovenesAccion(cedula)
      .then((r) => { console.log(`[TIMING] jovenesAccion: ${Date.now() - tJovenes0}ms`); return r; })
      .catch((e) => {
        console.warn('[JOVENES] Error inesperado consultando Jovenes en Accion:', e.message);
        return { enabled: true, available: false, message: `Error inesperado: ${e.message || ''}`.trim(), rows: [] };
      });

    // Batch: ingreso progresivo de cada miembro del hogar
    let ingresoHogar = [];
    if (hogar.length > 0) {
      const cedulasHogar = [...new Set(hogar.map(m => m.cedula).filter(Boolean))];
      if (cedulasHogar.length > 0) {
        const inList = cedulasHogar.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
        try {
          const qIngresoHogar = `
            SELECT
              cedula,
              CASE WHEN ingresos_bdh IN ('0','1','2') THEN ingresos_bdh ELSE NULL END AS BONO_DESARROLLO_HUMANO_CODIGO,
              CASE
                WHEN ingresos_pam IN ('2') OR ingresos_mma IN ('2') THEN '2'
                WHEN ingresos_pam IN ('1') OR ingresos_mma IN ('1') THEN '1'
                WHEN ingresos_pam IN ('0') OR ingresos_mma IN ('0') THEN '0'
                ELSE NULL
              END AS PENSION_MIS_MEJORES_ANOS_CODIGO,
              CASE
                WHEN ingresos_pdd IN ('2') OR ingresos_ptv IN ('2') OR ingresos_ptvm IN ('2') OR ingresos_bdd IN ('2') THEN '2'
                WHEN ingresos_pdd IN ('1') OR ingresos_ptv IN ('1') OR ingresos_ptvm IN ('1') OR ingresos_bdd IN ('1') THEN '1'
                WHEN ingresos_pdd IN ('0') OR ingresos_ptv IN ('0') OR ingresos_ptvm IN ('0') OR ingresos_bdd IN ('0') THEN '0'
                ELSE NULL
              END AS PENSION_TODA_UNA_VIDA_CODIGO,
              CASE WHEN ingresos_bva IN ('0','1','2') THEN ingresos_bva ELSE NULL END AS BDH_CON_COMPONENTE_VARIABLE_CODIGO,

              -- Compatibilidad frontend legado (ahora SI si existe codigo 0/1/2)
              CASE WHEN ingresos_bdh IN ('0','1','2') THEN 'SI' ELSE 'NO' END AS BONO_DESARROLLO_HUMANO,
              CASE WHEN ingresos_pam IN ('0','1','2') OR ingresos_mma IN ('0','1','2') THEN 'SI' ELSE 'NO' END AS PENSION_MIS_MEJORES_ANOS,
              CASE WHEN ingresos_pdd IN ('0','1','2') OR ingresos_ptv IN ('0','1','2') OR ingresos_ptvm IN ('0','1','2') OR ingresos_bdd IN ('0','1','2') THEN 'SI' ELSE 'NO' END AS PENSION_TODA_UNA_VIDA,
              CASE WHEN ingresos_bva IN ('0','1','2') THEN 'SI' ELSE 'NO' END AS BDH_CON_COMPONENTE_VARIABLE,
              excepcion_final
            FROM [Reportes_2025].[dbo].[tabla_general_Corte]
            WHERE cedula IN (${inList})
          `;

          const tIH = Date.now();
          const rIngresoHogar = await pool.request().query(qIngresoHogar);

          ingresoHogar = (rIngresoHogar.recordset || []).map(row => {
            const excepcionCodigo = resolverCodigoExcepcion(row.excepcion_final);
            const habPorCodigo = excepcionCodigo !== null && [0, 27, 61, 70, 74, 75, 76, 77, 78, 79, 998].includes(excepcionCodigo);
            return {
              ...row,
              excepcion_final: row.excepcion_final || null,
              habilitado: habPorCodigo ? 'SI' : 'NO'
            };
          });
          console.log(`[TIMING] ingresoHogar(${cedulasHogar.length} miembros): ${Date.now() - tIH}ms`);
        } catch (eH) {
          console.warn('Error consultando ingresoHogar:', eH.message);
        }
      }
    }

    const iess = resultIess.recordset || [];
    const bono1000 = resultBono1000.recordset || [];
    const menorDiscapacidad = resultMenores.recordset || [];
    const puntajeHistorico = resultPuntajeHistorico.recordset || [];
    const ingresoProgresivo = ingresoHogar;
    const basesExternas = (resultBasesExternas.recordset && resultBasesExternas.recordset[0]) || null;
    const contactabilidad = resultContactabilidad.recordset || [];
    let historialEventos = [];
    const registroSocialCorte = datosGeneralesCorte?.registroSocial || null;
    const inclusionFlags = datosGeneralesCorte
      ? { TIPO_INCLUSION: datosGeneralesCorte.TIPO_INCLUSION ?? null, GRUPO_INCLUSION: datosGeneralesCorte.GRUPO_INCLUSION ?? null }
      : { TIPO_INCLUSION: null, GRUPO_INCLUSION: null };

    const hasTextValue = (value) => {
      if (value === undefined || value === null) return false;
      const text = `${value}`.trim().toUpperCase();
      return text !== '' && text !== 'NO CONSTA' && text !== 'NULL' && text !== 'N/A' && text !== '0';
    };

    const normalizeSimple = (value) => `${value || ''}`
      .toString()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toUpperCase();

    const tieneInclusionFlag = !!(inclusionFlags.TIPO_INCLUSION && inclusionFlags.GRUPO_INCLUSION);
    const esCasoPrioritarioReactivacion = normalizeSimple(inclusionFlags.TIPO_INCLUSION).includes('REACTIVACION PUNTAJE');
    const tieneSubsidioFinal =
      hasTextValue(datosGenerales?.subsidio_final) ||
      hasTextValue(datosGeneralesCorte?.subsidio_final) ||
      hasTextValue(datosGeneralesCorte?.subsidio_EDMBEN) ||
      hasTextValue(datosGeneralesCorte?.codigo_tipo_subsidio);
    const tieneExcepcionFinal =
      hasTextValue(datosGenerales?.excepcion_final) ||
      hasTextValue(datosGeneralesCorte?.excepcion_final) ||
      hasTextValue(datosGeneralesCorte?.excepcion_EDMBEN) ||
      hasTextValue(datosGeneralesCorte?.codigo_tipo_excepcion);
    const CODIGOS_EXCEPCION_HABILITADO = new Set([0, 27, 61, 70, 74, 75, 76, 77, 78, 79, 998]);
    const CODIGOS_EXCEPCION_SIEMPRE_NO_HABILITADO = new Set([41, 55]);
    const _candCorte1 = parseCodigo(datosGeneralesCorte?.codigo_tipo_excepcion);
    const _candCorte2 = parseCodigo(datosGeneralesCorte?.excepcion_final);
    let excepcionForzadaCodigo = null;
    if (CODIGOS_EXCEPCION_SIEMPRE_NO_HABILITADO.has(excepcionCodigoDetectado)) {
      excepcionForzadaCodigo = excepcionCodigoDetectado;
    } else if (CODIGOS_EXCEPCION_SIEMPRE_NO_HABILITADO.has(_candCorte1)) {
      excepcionForzadaCodigo = _candCorte1;
    } else if (CODIGOS_EXCEPCION_SIEMPRE_NO_HABILITADO.has(_candCorte2)) {
      excepcionForzadaCodigo = _candCorte2;
    }
    const excepcionForzadaNoHabilitadoServer = excepcionForzadaCodigo !== null;
    const tieneCodigoExcepcionHabilitado = !excepcionForzadaNoHabilitadoServer &&
      excepcionCodigoDetectado !== null && CODIGOS_EXCEPCION_HABILITADO.has(excepcionCodigoDetectado);
    const estaReactivado = !excepcionForzadaNoHabilitadoServer && tieneInclusionFlag && tieneSubsidioFinal && tieneExcepcionFinal;

    // ESTA_PROT: persona protegida (puntaje no se actualiza en tabla general)
    const estaProtegida = datosGeneralesCorte?.ESTA_PROT == 1 || datosGeneralesCorte?.ESTA_PROT === '1';
    const puntajeCorte = `${datosGeneralesCorte?.puntaje ?? ''}`.trim();
    const puntajeRS = `${datosRS?.puntajers2014 ?? ''}`.trim();
    const puntajesDifieren = estaProtegida && puntajeCorte !== '' && puntajeRS !== '' && puntajeCorte !== puntajeRS;

    const reactivacion = {
      tieneInclusionFlag,
      esCasoPrioritarioReactivacion,
      tieneSubsidioFinal,
      tieneExcepcionFinal,
      excepcionCodigoDetectado,
      tieneCodigoExcepcionHabilitado,
      excepcionForzadaNoHabilitado: excepcionForzadaNoHabilitadoServer,
      excepcionForzadaCodigo,
      estaReactivado,
      estaProtegida,
      puntajesDifieren,
      estadoSugerido: esCasoPrioritarioReactivacion
        ? (estaReactivado
          ? 'HABILITADO - REACTIVACIÓN DE PUNTAJE'
          : (tieneCodigoExcepcionHabilitado ? 'HABILITADO' : 'NO HABILITADO - POSIBLE REACTIVACIÓN'))
        : (tieneCodigoExcepcionHabilitado
          ? 'HABILITADO'
          : (estaReactivado
            ? 'HABILITADO - REACTIVACIÓN DE PUNTAJE'
            : (tieneInclusionFlag ? 'NO HABILITADO - POSIBLE REACTIVACIÓN' : null)))
    };

    if (inclusionFlags.TIPO_INCLUSION && inclusionFlags.GRUPO_INCLUSION) {
      historialEventos.unshift({
        tipo_evento: 'PENDIENTE_REACTIVACION',
        descripcion: 'Posible reactivación detectada',
        fecha: null,
        detalle: `${inclusionFlags.TIPO_INCLUSION} / ${inclusionFlags.GRUPO_INCLUSION}`,
        fuente: 'tabla_general_Corte'
      });
    }

    let historialCobros = {
      enabled: false,
      available: false,
      message: 'Historial de cobros no consultado.',
      beneficiario: null,
      bonosPagoCuenta: [],
      bonosVentanilla: [],
      milDiasPagoCuenta: [],
      milDiasVentanilla: []
    };

    // Oracle ya fue lanzado en paralelo con ingresoHogar — solo esperamos el resultado aquí
    const historialOracle = await oracleHistorialPromise;
    const jovenesAccion = await jovenesAccionPromise;

    let continuidadSqlRows = [];
    let continuidadSqlMeta = null;
    if (sqlContinuidadEnabled) {
      try {
        const oracleRowsBase = [
          ...(historialOracle.historialPermanenteRows || [])
        ];
        const bonoRef = pickLatestBonoRef(oracleRowsBase);
        const subsidioPreferido = resolverSubsidioPreferidoHistorial({
          bonoRef,
          datosGenerales,
          bono1000Rows: bono1000
        });
        const tSqlContinuidad0 = Date.now();
        const continuidadSqlRs = await obtenerHistorialCobrosSqlContinuidad(pool, cedula, bonoRef, {
          fallbackCodSubsidio: subsidioPreferido
        });
        continuidadSqlRows = continuidadSqlRs.rows || [];
        continuidadSqlMeta = continuidadSqlRs.ultimoPeriodoContinuidad || null;
        console.log(`[TIMING] sqlHistorialContinuidad: ${Date.now() - tSqlContinuidad0}ms`);
        console.log(`[HISTORIAL] continuidadSqlRows: ${continuidadSqlRows.length}`);
        const resumenContinuidad = continuidadeSqlRows => {
          const acc = new Map();
          for (const row of continuidadeSqlRows) {
            const k = `${row.codPeriodo || 'ND'}-${row.codSubperiodo || 'ND'}`;
            acc.set(k, (acc.get(k) || 0) + 1);
          }
          return [...acc.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 30);
        };
        console.log('[HISTORIAL] continuidad por periodo/subperiodo:', JSON.stringify(resumenContinuidad(continuidadSqlRows)));
      } catch (sqlHistErr) {
        console.warn('[SQL] Error consultando continuidad de historial:', sqlHistErr.message);
        continuidadSqlRows = [];
        continuidadSqlMeta = null;
      }
    }

    // DESPUÉS — reemplaza todo lo anterior con esto:
    const todasLasFilas = mergeCobros3Fuentes({
      detalleTransaccionRows: historialOracle.detalleTransaccionRows || [],
      sqlContinuidadRows: continuidadSqlRows,
      historialPermanenteRows: historialOracle.historialPermanenteRows || []
    });

    historialCobros = {
      enabled: oracleHistorialEnabled || sqlContinuidadEnabled,
      available: todasLasFilas.length > 0,
      message: null,
      beneficiario: historialOracle.beneficiario || null,
      referenciaContinuidadSql: continuidadSqlMeta,
      bonosPagoCuenta: todasLasFilas.filter((r) => r.tipoPrograma === 'BONOS' && r.canalPago === 'CUENTA'),
      bonosVentanilla: todasLasFilas.filter((r) => r.tipoPrograma === 'BONOS' && r.canalPago === 'VENTANILLA'),
      milDiasPagoCuenta: todasLasFilas.filter((r) => r.tipoPrograma === '1000_DIAS' && r.canalPago === 'CUENTA'),
      milDiasVentanilla: todasLasFilas.filter((r) => r.tipoPrograma === '1000_DIAS' && r.canalPago === 'VENTANILLA'),
    };

    if (!historialCobros.available) {
      const oracleMsg = (historialOracle && historialOracle.message) || '';
      const noCodigoBenOracle = oracleMsg.toUpperCase().includes('NO EXISTE CODIGOBEN');
      const apellidos = datosGenerales?.apellidos || '';
      const nombres = datosGenerales?.nombres || '';
      const quien = [apellidos, nombres].filter(Boolean).join(', ');
      historialCobros.message = noCodigoBenOracle
        ? 'No existen pagos para este usuario.'
        : (oracleMsg || (quien
          ? `No se encontraron registros de historial de cobros para ${quien}.`
          : 'No se encontraron registros de historial de cobros.'));
    }

    return res.json({
      success: true,
      cedula,
      datosGenerales,
      datosRS,
      hogar,
      ingresoProgresivo,
      ingresoHogar,
      iess,
      bono1000,
      menorDiscapacidad,
      contactabilidad,
      basesExternas,
      puntajeHistorico,
      historialEventos,
      registroSocialCorte,
      inclusionFlags,
      reactivacion,
      historialCobros,
      jovenesAccion
    });
  } catch (err) {
    console.error('Error en /buscarBeneficiario:', err.message || err);
    const isConnectionError = err && (
      err.code === 'ESOCKET' ||
      err.code === 'ECONNCLOSED' ||
      err.code === 'ETIMEOUT' ||
      /Failed to connect|Could not connect|No fue posible conectarse/i.test(err.message || '')
    );

    if (isConnectionError) {
      poolPromise = null;
      return res.status(503).json({
        success: false,
        message: 'No fue posible conectarse a la base de datos.',
        details: currentDbServer
          ? `Servidor SQL no disponible: ${currentDbServer}`
          : 'Ninguno de los servidores SQL configurados respondió.'
      });
    }

    return res.status(500).json({ success: false, message: 'Error interno al consultar la base de datos.' });
  } finally {
    console.log(`[TIMING] buscarBeneficiario END cedula=${cedula} total=${Date.now() - reqStartedAt}ms`);
  }
});

// Manejador global de errores: forzar JSON en API para evitar HTML inesperado en frontend.
app.use((err, req, res, next) => {
  if (!err) return next();

  console.error('Middleware error:', err.message || err);
  if (req.path === '/buscarBeneficiario') {
    return res.status(500).json({
      success: false,
      message: err.message || 'Error interno del servidor.'
    });
  }

  return res.status(500).json({ success: false, message: 'Error interno del servidor.' });
});


// Pre-calentar pools al arrancar para que la primera petición no pierda tiempo
if (hasOracleConfig()) {
  getOraclePool()
    .then(() => console.log('[ORACLE] Pool pre-calentado correctamente'))
    .catch((err) => console.warn('[ORACLE] No se pudo pre-calentar el pool:', err.message));
}

getPool()
  .then(() => console.log('[SQL] Pool pre-calentado correctamente'))
  .catch((err) => console.warn('[SQL] No se pudo pre-calentar el pool:', err.message));

if (hasJovenesConfig()) {
  getJovenesPool()
    .then(() => console.log('[JOVENES] Pool pre-calentado correctamente'))
    .catch((err) => console.warn('[JOVENES] No se pudo pre-calentar el pool:', err.message));
} else {
  console.warn('[JOVENES] Consulta deshabilitada: defina JOVENES_DB_USER/JOVENES_DB_PASSWORD en .env.');
}

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', function () {
  const address = this.address();
  const host = address && address.address === '::' ? '0.0.0.0' : address?.address || '0.0.0.0';
  const port = address?.port || PORT;
  console.log(`Servidor iniciado en http://${host}:${port}`);
  console.log('PID del servidor:', process.pid);
  console.log('Escuchando en todas las interfaces (0.0.0.0)');
  console.log('Presiona Ctrl+C para detener el servidor');
  if (app.router && app.router.stack) {
    const routes = app.router.stack
      .filter(r => r.route)
      .map(r => ({ path: r.route.path, methods: r.route.methods }));
    console.log('Rutas registradas:', routes);
  } else {
    console.log('No se encontró app.router');
  }
});

process.stdin.resume();