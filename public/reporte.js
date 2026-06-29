
const API_BASE = '/buscarBeneficiario';
const STORAGE_CEDULA_REPORTE = 'reporte_cedula_actual';
let datosGlobales = null;

let currentAbortController = null;   // ← NUEVO
let busquedaActual = 0;              // ← NUEVO (contador de búsquedas)


// Silenciar errores comunes de media cuando se abre DevTools
window.addEventListener('unhandledrejection', function (event) {
    if (event.reason &&
        (event.reason.name === 'AbortError' ||
            event.reason.message && event.reason.message.includes('play() request was interrupted'))) {
        event.preventDefault();
        return false;
    }
});

// También sobrescribir el método play
const originalPlay = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function () {
    return originalPlay.apply(this, arguments).catch(err => {
        if (err.name === 'AbortError' ||
            (err.message && err.message.includes('play() request was interrupted'))) {
            return; // Silencioso
        }
        throw err; // Re-lanzar otros errores
    });
};

const CODIGOS_EXCEPCION_HABILITADO = new Set([0, 27, 61, 70, 74, 75, 76, 77, 78, 79, 998]);

const PARENTESCO_NUCLEO = {
    1: 'Jefe(a) de Núcleo', 2: 'Esposo(a)/Conviviente', 3: 'Hijo(a)',
    4: 'Otro familiar', 5: 'No familiar', 99: 'No aplica'
};
const PARENTESCO_HOGAR = {
    1: 'Jefe(a) del Hogar', 2: 'Esposo(a)/Conviviente', 3: 'Hijo(a)',
    4: 'Hijastro(a)', 5: 'Padre/Madre', 6: 'Suegro(a)', 7: 'Yerno/Nuera',
    8: 'Nieto(a)', 9: 'Hermano(a)', 10: 'Cuñado(a)', 11: 'Otro familiar',
    12: 'No familiar', 13: 'Servicio doméstico', 99: 'No aplica'
};
function decodificarParentesco(row) {
    const cHogar = parseInt(row.parentescojefe, 10);
    const cNucleo = parseInt(row.parentescojefenucleo, 10);
    return PARENTESCO_HOGAR[cHogar] || PARENTESCO_NUCLEO[cNucleo] || 'NO CONSTA';
}

const EXCEPCION_TEXTO_A_CODIGO = {
    'ABRE TU CUENTA BANCARIA Y COBRA SEGURO TU BONO': 0,
    'BENEFICIARIO CON CUENTA EN LA BANCA': 27,
    'ABRE UNA CUENTA BANCARIA Y COBRA SEGURO TU PENSION': 70,
    'PARA CONTINUAR COBRANDO TU BONO ABRE UNA CUENTA': 74,
    'ABRE UNA CUENTA BANCARIA Y COBRA SEGURO TU BONO': 76,
    'SE CORRESPONSABLE, ENVIA A TUS HIJOS A LA ESCUELA': 78,
    'RETIRE TARJETA PACIFICO GRATIS EN AGENCIA AGUIRRE': 79,
    'UD YA COBRO ADELANTADO': 998
};


// XSS Prevention: Escape HTML special characters
function escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function normalizarTextoSimple(valor) {
    return `${valor || ''}`
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toUpperCase();
}

function obtenerCodigoExcepcionFrontend(...valores) {
    for (const value of valores) {
        const m = `${value || ''}`.match(/\d+/);
        if (m) return Number(m[0]);
    }
    for (const value of valores) {
        const cod = EXCEPCION_TEXTO_A_CODIGO[normalizarTextoSimple(value)];
        if (cod !== undefined) return cod;
    }
    return null;
}

function formatRegistroSocial(valor) {
    const v = `${valor || ''}`.trim();
    const match = v.match(/\d{4}/);
    if (match) {
        const year = parseInt(match[0], 10);
        if (year >= 2000 && year <= 2100) return `${year}`;
    }
    return 'SIN REGISTRO SOCIAL';
}

function esEstadoHabilitado(estado) {
    const txt = `${estado || ''}`.trim().toUpperCase().replace(/\s+/g, ' ');
    return txt === 'HABILITADO' || txt.startsWith('HABILITADO ');
}

function mostrarCargando(mostrar) {
    const overlay = document.getElementById('overlay-cargando');
    if (mostrar) {
        overlay.classList.add('activo');
    } else {
        overlay.classList.remove('activo');
    }
}

function formatearFecha(valor) {
    if (!valor || valor === 'NULL') return 'NO CONSTA';
    // Solo partir por 'T' si parece fecha ISO (ej: 2024-05-07T00:00:00)
    if (/^\d{4}-\d{2}-\d{2}T/.test(valor)) return valor.split('T')[0];
    return valor;
}

function obtenerClaseEstado(estado) {
    const estadoUpper = (estado || '').toUpperCase();
    if (estadoUpper.includes('NO HABILITADO') || estadoUpper.includes('DESHABILITADO')) return 'bad';
    if (estadoUpper === 'HABILITADO' || estadoUpper.includes('HABILITADO')) return 'ok';
    if (estadoUpper === 'NO CONSTA') return '';
    return 'bad';
}

function guardarCedulaEnSesion(cedula) {
    try {
        sessionStorage.setItem(STORAGE_CEDULA_REPORTE, cedula);
    } catch (_) {
        // Ignorar errores de almacenamiento del navegador
    }
}

function leerCedulaDeSesion() {
    try {
        const cedula = (sessionStorage.getItem(STORAGE_CEDULA_REPORTE) || '').trim();
        return /^\d{10}$/.test(cedula) ? cedula : '';
    } catch (_) {
        return '';
    }
}

async function buscarBeneficiario() {
    const cedula = document.getElementById('cedula').value.trim();
    if (!/^\d{10}$/.test(cedula)) {
        alert('Ingrese una cédula válida de 10 dígitos');
        return;
    }

    // Persistir última cédula para mantener contexto tras recarga (sin exponerla en URL)
    guardarCedulaEnSesion(cedula);

    // SECURITY: Use POST to avoid cedula in URL history/logs
    // Clear URL (no cedula query param)
    history.replaceState(null, '', window.location.pathname);

    // Cancelar búsqueda anterior si existe
    if (currentAbortController) {
        currentAbortController.abort();
    }

    // Crear nuevo controlador
    currentAbortController = new AbortController();
    // Incrementar contador de búsqueda
    const busquedaId = ++busquedaActual;

    mostrarCargando(true);

    // Limpiar resultados anteriores mientras carga
    document.getElementById('contenido-dinamico').innerHTML = '';
    document.getElementById('valor-registro-social').textContent = '---';
    document.getElementById('valor-estado').textContent = '---';
    document.getElementById('valor-estado').className = 'status-badge';

    try {
        const response = await fetch(`${API_BASE}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ cedula }),
            signal: currentAbortController.signal
        });

        // Si ya se inició otra búsqueda más nueva, ignorar este resultado
        if (busquedaId !== busquedaActual) return;

        const contentType = response.headers.get('content-type') || '';
        const isJson = contentType.includes('application/json');
        const payload = isJson ? await response.json() : await response.text();

        if (!response.ok) {
            const message = isJson
                ? (payload?.message || `Error HTTP ${response.status}`)
                : `Error HTTP ${response.status}. El servidor no devolvio JSON.`;
            throw new Error(message);
        }

        if (!isJson) {
            throw new Error('Respuesta invalida del servidor: se esperaba JSON.');
        }

        const data = payload;

        if (!data.success) {
            alert(data.message || 'No se encontró información');
            return;
        }

        datosGlobales = data;

        // Registro Social: solo mostrar si es un año válido
        const registroSocialRaw =
            data.datosGenerales?.registroSocial ??
            data.datosRS?.registroSocial ??
            data.registroSocialCorte ?? null;
        const registroSocialTexto = formatRegistroSocial(registroSocialRaw);

        // Reglas directas solicitadas para estado:
        // 1) Si tiene bono 1000 habilitado -> HABILITADO 1000 DÍAS
        // 2) Si tiene TIPO_INCLUSION + GRUPO_INCLUSION:
        //    - con subsidio_final + excepcion_final -> HABILITADO - REACTIVACIÓN DE PUNTAJE
        //    - sin ambos -> NO HABILITADO - POSIBLE REACTIVACIÓN
        const dg = data.datosGenerales || null;
        const drs = data.datosRS || null;
        const inclusionFlags = data.inclusionFlags || {};
        const reactivacion = data.reactivacion || {};
        const bono1000Rows = Array.isArray(data.bono1000) ? data.bono1000 : [];

        const tieneHabilitado1000 = bono1000Rows.some((r) =>
            ((r?.estado || '').toString().trim().toUpperCase().includes('HABILITADO'))
        );

        const hasTextValue = (value) => {
            if (value === undefined || value === null) return false;
            const text = `${value}`.trim().toUpperCase();
            return text !== '' && text !== 'NO CONSTA' && text !== 'NULL' && text !== 'N/A' && text !== '0';
        };

        const tieneInclusion = !!(inclusionFlags.TIPO_INCLUSION && inclusionFlags.GRUPO_INCLUSION);
        const tipoInclusionNorm = normalizarTextoSimple(inclusionFlags.TIPO_INCLUSION);
        const esCasoPrioritarioReactivacion = tipoInclusionNorm.includes('REACTIVACION PUNTAJE');
        const subsidioFinal = dg?.subsidio_final ?? drs?.subsidio_final;
        const excepcionFinal = dg?.excepcion_final ?? drs?.excepcion_final;
        const tieneSubsidio = hasTextValue(subsidioFinal);
        const tieneExcepcion = hasTextValue(excepcionFinal);
        const tieneSubsidioFallback =
            tieneSubsidio ||
            hasTextValue(data?.datosGenerales?.codigo_tipo_subsidio) ||
            hasTextValue(data?.datosGenerales?.subsidio_EDMBEN);
        const tieneExcepcionFallback =
            tieneExcepcion ||
            hasTextValue(data?.datosGenerales?.codigo_tipo_excepcion) ||
            hasTextValue(data?.datosGenerales?.excepcion_EDMBEN);
        const excepcionCodeFront = obtenerCodigoExcepcionFrontend(
            reactivacion.excepcionCodigoDetectado,
            dg?.excepcion_final,
            drs?.excepcion_final
        );
        const tieneCodigoExcepcionHabilitadoFront =
            reactivacion.tieneCodigoExcepcionHabilitado === true ||
            (excepcionCodeFront !== null && CODIGOS_EXCEPCION_HABILITADO.has(excepcionCodeFront));

        const estaProtegida = reactivacion.estaProtegida === true && reactivacion.puntajesDifieren === true;

        let estado;
        if (tieneHabilitado1000) {
            estado = 'HABILITADO 1000 DÍAS';
        } else if (estaProtegida) {
            estado = 'HABILITADO - PROTEGIDO';
        } else if (esCasoPrioritarioReactivacion) {
            estado = (tieneSubsidioFallback && tieneExcepcionFallback)
                ? 'HABILITADO - REACTIVACIÓN DE PUNTAJE'
                : (tieneCodigoExcepcionHabilitadoFront
                    ? 'HABILITADO'
                    : 'NO HABILITADO - POSIBLE REACTIVACIÓN');
        } else if (tieneCodigoExcepcionHabilitadoFront) {
            estado = 'HABILITADO';
        } else if (tieneInclusion && tieneSubsidio && tieneExcepcion) {
            estado = 'HABILITADO - REACTIVACIÓN DE PUNTAJE';
        } else if (tieneInclusion) {
            estado = 'NO HABILITADO - POSIBLE REACTIVACIÓN';
        } else if (excepcionCodeFront !== null) {
            estado = 'NO HABILITADO';
        } else {
            estado = dg?.estado || drs?.estado || 'NO CONSTA';
        }

        const estadoEsHabilitado = esEstadoHabilitado(estado);

        document.getElementById('valor-registro-social').textContent = registroSocialTexto;
        document.getElementById('valor-estado').textContent = estado;
        document.getElementById('valor-estado').dataset.habilitado = estadoEsHabilitado ? '1' : '0';
        document.getElementById('valor-estado').className = `status-badge ${obtenerClaseEstado(estado)}`;

        renderizarTodo(data);

    } catch (error) {
        // Ignorar error si fue por abort (cancelación)
        if (error.name === 'AbortError') return;


        console.error('Error:', error);
        alert('Error al cargar los datos. Verifique su conexión.');
    } finally {
        mostrarCargando(false);
        // Limpiar controlador solo si esta búsqueda es la actual
        if (busquedaId === busquedaActual) {
            currentAbortController = null;
        }
    }
}

function renderizarTodo(data) {
    const container = document.getElementById('contenido-dinamico');
    let html = '';

    html += generarTablaPuntaje(data);
    html += generarTablaDatosGenerales(data);

    const esMilDias = Array.isArray(data.bono1000) && data.bono1000.length > 0;
    if (esMilDias) {
        html += generarTablaGenerica(data.bono1000, 'bono1000',
            ['cedula_beneficiario', 'nombre_ben', 'cedula_receptor', 'estado'],
            'BONO 1000 DIAS', '#1a3a5c', 'SIN REGISTRO EN BONO 1000 DIAS');
    }

    html += generarBloqueHistorialCobros(data);
    html += generarTablaContactabilidad(data);

    // Se oculta sola si no hay nucleo valido
    html += generarTablaNucleoFamiliar(data);

    html += generarTablaGenerica(data.menorDiscapacidad || [], 'discapacidad',
        ['CEDULA_REPRESENTANTE', 'CEDULA_MENOR', 'NOMBRES_MENOR', 'ESTADO'],
        'REPRESENTANTE MENOR CON DISCAPACIDAD', '#6f42c1', 'SIN DATOS DE DISCAPACIDAD');

    if (!esMilDias) {
        html += generarTablaGenerica(data.bono1000 || [], 'bono1000',
            ['cedula_beneficiario', 'nombre_ben', 'cedula_receptor', 'estado'],
            'BONO 1000 DIAS', '#1a3a5c', 'SIN REGISTRO EN BONO 1000 DIAS');
    }
    html += generarTablaGenerica(data.iess || [], 'iess',
        ['CEDULA_BENEFICIARIO', 'NOMBRE', 'ANO', 'MES', 'SEGURO_C', 'vigencia'],
        'AFILIACION IESS', '#1a3a5c', 'SIN AFILIACION IESS');

    html += generarTablaHogar(data);
    html += generarTablaBasesExternas(data);

    container.innerHTML = html;

    const btnHistorialPdf = document.getElementById('btn-exportar-historial-pdf');
    const btnHistorialExcel = document.getElementById('btn-exportar-historial-excel');
    if (btnHistorialPdf) btnHistorialPdf.addEventListener('click', exportarHistorialPDF);
    if (btnHistorialExcel) btnHistorialExcel.addEventListener('click', exportarHistorialExcel);
}

function generarBloqueHistorialCobros(data) {
        const accionesExportacionHistorial = `
            <div class="historial-export-actions" role="group" aria-label="Exportar historial de cobros">
                <span class="historial-export-label">EXPORTAR HISTORIAL -&gt;</span>
                <button type="button" id="btn-exportar-historial-pdf" class="btn-export-historial btn-brand-yellow">PDF</button>
                <button type="button" id="btn-exportar-historial-excel" class="btn-export-historial btn-brand-purple">EXCEL</button>
            </div>
        `;

    const hc = data.historialCobros || {};
    const bonosCuenta = Array.isArray(hc.bonosPagoCuenta) ? hc.bonosPagoCuenta : [];
    const bonosVentanilla = Array.isArray(hc.bonosVentanilla) ? hc.bonosVentanilla : [];
    const milDiasCuenta = Array.isArray(hc.milDiasPagoCuenta) ? hc.milDiasPagoCuenta : [];
    const milDiasVentanilla = Array.isArray(hc.milDiasVentanilla) ? hc.milDiasVentanilla : [];

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

    const SUBSIDIO_POR_SIGLA = Object.values(SUBSIDIO_CATALOGO)
        .filter((item) => item && item.codigo)
        .reduce((acc, item) => {
            `${item.codigo}`
                .split(',')
                .map((sigla) => sigla.trim().toUpperCase())
                .filter(Boolean)
                .forEach((sigla) => {
                    acc[sigla] = item.descripcion;
                });
            return acc;
        }, {});

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

    const formatMonto = (valor) => {
        if (valor === undefined || valor === null || `${valor}`.trim() === '') return 'NO CONSTA';
        const num = Number(valor);
        if (Number.isNaN(num)) return `${valor}`;
        return `$${num.toFixed(2)}`;
    };

    const mapBono = (codSubsidio) => {
        const raw = `${codSubsidio ?? ''}`.trim().toUpperCase();
        if (!raw) return 'NO CONSTA';

        const codNumerico = Number.parseInt(raw, 10);
        if (!Number.isNaN(codNumerico) && SUBSIDIO_CATALOGO[codNumerico]) {
            const item = SUBSIDIO_CATALOGO[codNumerico];
            return item.codigo ? `${item.codigo} - ${item.descripcion}` : item.descripcion;
        }

        if (SUBSIDIO_POR_SIGLA[raw]) {
            return `${raw} - ${SUBSIDIO_POR_SIGLA[raw]}`;
        }

        return raw;
    };

    const mapExcepcionFinal = (codStatus) => {
        const raw = `${codStatus ?? ''}`.trim();
        if (!raw) return 'NO CONSTA';
        const cod = Number.parseInt(raw, 10);
        if (!Number.isNaN(cod) && EXCEPCION_CATALOGO[cod]) {
            return EXCEPCION_CATALOGO[cod];
        }
        return raw;
    };

    const MESES_ORDEN = {
        'ENERO': 1,
        'FEBRERO': 2,
        'MARZO': 3,
        'ABRIL': 4,
        'MAYO': 5,
        'JUNIO': 6,
        'JULIO': 7,
        'AGOSTO': 8,
        'SEPTIEMBRE': 9,
        'OCTUBRE': 10,
        'NOVIEMBRE': 11,
        'DICIEMBRE': 12
    };

    const MESES_LISTA = [
        '', 'ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO',
        'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'
    ];

    const extraerAnio = (row) => {
        const periodo = `${row?.periodo || ''}`.trim().toUpperCase();
        const matchPeriodo = periodo.match(/(\d{4})$/);
        if (matchPeriodo) return matchPeriodo[1];

        const fecha = `${row?.fechaCobro || ''}`.trim();
        const matchFecha = fecha.match(/^(\d{4})-/);
        return matchFecha ? matchFecha[1] : 'SIN ANIO';
    };

    const extraerMes = (row) => {
        const periodo = `${row?.periodo || ''}`.trim().toUpperCase();
        const matchPeriodo = periodo.match(/^(.+?)\s+\d{4}$/);
        if (matchPeriodo) return matchPeriodo[1].trim();

        const fecha = `${row?.fechaCobro || ''}`.trim();
        const matchFecha = fecha.match(/^\d{4}-(\d{2})-/);
        if (matchFecha) {
            const idx = Number.parseInt(matchFecha[1], 10);
            return MESES_LISTA[idx] || 'MES N/D';
        }

        return 'MES N/D';
    };

    const generarTablaHistorial = (rows, titulo) => {
        if (!rows.length) {
            return '';
        }

        const isVentanilla = `${titulo || ''}`.toUpperCase().includes('VENTANILLA');
        const tieneDatosVentanillaCompletos = (row) => {
            const provincia = `${row?.provincia || ''}`.trim();
            const ciudad = `${row?.ciudad || ''}`.trim();
            const parroquia = `${row?.parroquia || ''}`.trim();
            const banco = `${row?.banco || ''}`.trim();
            const agencia = `${row?.agencia || ''}`.trim();
            const direccionAgencia = `${row?.direccionAgencia || ''}`.trim();
            return !!(provincia || ciudad || parroquia || banco || agencia || direccionAgencia);
        };
        const mostrarColumnasVentanilla = isVentanilla;
        const valorDetalle = (valor, fallback = null) => {
            const principal = `${valor || ''}`.trim();
            if (principal) return principal;
            const alterno = `${fallback || ''}`.trim();
            return alterno || 'NO CONSTA';
        };

        const rowsByAnio = rows.reduce((acc, row) => {
            const anio = extraerAnio(row);
            if (!acc[anio]) acc[anio] = [];
            acc[anio].push(row);
            return acc;
        }, {});

        const aniosOrdenados = Object.keys(rowsByAnio).sort((a, b) => {
            if (a === 'SIN ANIO') return 1;
            if (b === 'SIN ANIO') return -1;
            return Number.parseInt(b, 10) - Number.parseInt(a, 10);
        });

        return `
            <div class="historial-identificador">${escapeHTML(titulo)}</div>
            <div class="historial-anios-wrap">
                ${aniosOrdenados.map((anio, indexAnio) => {
                    const registrosAnio = rowsByAnio[anio] || [];
                    const registrosOrdenados = [...registrosAnio].sort((ra, rb) => {
                        const mesA = MESES_ORDEN[extraerMes(ra)] || 0;
                        const mesB = MESES_ORDEN[extraerMes(rb)] || 0;
                        return mesB - mesA;
                    });

                    return `
                        <details class="historial-anio" ${indexAnio === 0 ? 'open' : ''}>
                            <summary class="historial-anio-toggle">${escapeHTML(anio)} (${registrosOrdenados.length})</summary>
                            <div class="table-wrapper">
                                <table class="tabla-historial-cobros ${mostrarColumnasVentanilla ? 'ventanilla-detalle' : ''}">
                                    <thead>
                                        <tr>
                                            <th>MES</th>
                                            <th>BONO</th>
                                            <th>MONTO</th>
                                            <th>FECHA COBRO</th>
                                            ${mostrarColumnasVentanilla ? `
                                            <th>PROVINCIA</th>
                                            <th>CANTON</th>
                                            <th>PARROQUIA</th>
                                            <th>BANCO</th>
                                            <th>AGENCIA</th>
                                            <th>DIRECCION AGENCIA</th>
                                            ` : ''}
                                            <th>EXCEPCION FINAL</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${registrosOrdenados.map((row) => `
                                            <tr>
                                                <td><span class="mes-pill">${escapeHTML(extraerMes(row))}</span></td>
                                                <td><span class="bono-pill">${escapeHTML(mapBono(row.codSubsidio))}</span></td>
                                                <td><span class="monto-pill">${escapeHTML(formatMonto(row.monto))}</span></td>
                                                <td><span class="fecha-pill">${escapeHTML(`${row.fechaCobro || ''}`.trim()) || 'NO CONSTA'}</span></td>
                                                ${mostrarColumnasVentanilla ? `
                                                <td><span class="fecha-pill">${escapeHTML(valorDetalle(row.provincia))}</span></td>
                                                <td><span class="fecha-pill">${escapeHTML(valorDetalle(row.canton, row.ciudad))}</span></td>
                                                <td><span class="fecha-pill">${escapeHTML(valorDetalle(row.parroquia))}</span></td>
                                                <td><span class="fecha-pill">${escapeHTML(valorDetalle(row.banco))}</span></td>
                                                <td><span class="fecha-pill">${escapeHTML(valorDetalle(row.agencia))}</span></td>
                                                <td><span class="fecha-pill">${escapeHTML(valorDetalle(row.direccionAgencia))}</span></td>
                                                ` : ''}
                                                <td><span class="excepcion-pill">${escapeHTML(mapExcepcionFinal(row.codStatus))}</span></td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </details>
                    `;
                }).join('')}
            </div>
        `;
    };

    if (!hc.enabled || hc.available === false) {
        return `
            <div class="section-header">HISTORIAL DE COBROS</div>
            <details class="historial-cobros">
                <summary class="historial-cobros-toggle"><span class="historial-label-ver">Ver historial de cobros</span><span class="historial-label-ocultar">Ocultar historial de cobros</span></summary>
                <div class="historial-cobros-contenido">
                    ${accionesExportacionHistorial}
                    <div class="table-wrapper">
                        <table>
                            <tbody>
                                <tr><td class="text-center">${escapeHTML(hc.message || 'Historial de cobros no disponible en este momento.')}</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </details>
        `;
    }

    const seccionesHistorial = [
        generarTablaHistorial(bonosCuenta, 'PAGO EN CUENTA BONOS'),
        generarTablaHistorial(bonosVentanilla, 'PAGO EN VENTANILLA BONOS'),
        generarTablaHistorial(milDiasCuenta, '1000 DIAS PAGO EN CUENTA'),
        generarTablaHistorial(milDiasVentanilla, '1000 DIAS VENTANILLA')
    ].filter(Boolean);

    if (!seccionesHistorial.length) {
        return `
        <div class="section-header">HISTORIAL DE COBROS</div>
        <details class="historial-cobros">
            <summary class="historial-cobros-toggle"><span class="historial-label-ver">Ver historial de cobros</span><span class="historial-label-ocultar">Ocultar historial de cobros</span></summary>
            <div class="historial-cobros-contenido">
                ${accionesExportacionHistorial}
                <div class="table-wrapper">
                    <table>
                        <tbody>
                            <tr><td class="text-center">SIN REGISTROS DE HISTORIAL</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </details>
    `;
    }

    return `
        <div class="section-header">HISTORIAL DE COBROS</div>
        <details class="historial-cobros">
            <summary class="historial-cobros-toggle"><span class="historial-label-ver">Ver historial de cobros</span><span class="historial-label-ocultar">Ocultar historial de cobros</span></summary>
            <div class="historial-cobros-contenido">
                ${accionesExportacionHistorial}
                ${seccionesHistorial.join('')}
            </div>
        </details>
    `;
}

function generarTablaDatosGenerales(data) {
    const dg = data.datosGenerales || data.datosRS || {};
    const inclusion = data.inclusionFlags || {};
    const decilRaw = [
        dg.decil,
        dg.DECIL,
        dg.decil_rs,
        dg.DECIL_RS,
        dg['[decil]'],
        dg['decil '],
        dg['DECIL ']
    ].find((v) => v !== undefined && v !== null && `${v}`.trim() !== '');
    const decil = decilRaw !== undefined ? `${decilRaw}` : 'NO CONSTA';

    const campos = [
        { label: 'CEDULA', value: escapeHTML(dg.cedula) || 'NO CONSTA' },
        { label: 'FECHA NACIMIENTO', value: formatearFecha(dg.fecha_nacimiento_rs || dg.fechanacimiento) },
        { label: 'NOMBRES', value: escapeHTML(dg.nombres) || 'NO CONSTA' },
        { label: 'APELLIDOS', value: escapeHTML(dg.apellidos) || 'NO CONSTA' },
        { label: 'FECHA ENCUESTA', value: formatearFecha(dg.fechaencuesta) },
        {
            label: 'PUNTAJE RS', value: (() => {
                const pVal = dg.puntaje || dg.puntajers2014 || 'NO CONSTA';
                const protegido = data.reactivacion?.estaProtegida === true && data.reactivacion?.puntajesDifieren === true;
                return protegido
                    ? `${pVal} <span style="background:#1f5f8b;color:#fff;font-size:0.75rem;padding:2px 8px;border-radius:10px;font-weight:700;vertical-align:middle;letter-spacing:0.03em;">PROTEGIDO</span>`
                    : pVal;
            })()
        },
        { label: 'CONDICION CEDULADO', value: dg.condicion_cedulado_rc || 'NO CONSTA' },
        { label: 'EDAD', value: dg.edad_rs || dg.edad_persona || 'NO CONSTA' },
        { label: 'BANDA POBREZA', value: dg.banda_pobreza || 'NO CONSTA' },
        { label: 'DECIL', value: escapeHTML(`${decil}`) || 'NO CONSTA' },
        { label: 'SUBSIDIO FINAL', value: dg.subsidio_final || 'NO CONSTA' },
        { label: 'EXCEPCION FINAL', value: dg.excepcion_final || 'NO CONSTA' },
        // JORDY CHILA NUEVOS CAMPOS (FECHAS DESDE SC_CED_BEN_TOTAL)
        { label: 'FECHA INICIO', value: formatearFecha(dg.FECHA_INICIO) || 'NO CONSTA' },
        { label: 'FECHA FIN', value: formatearFecha(dg.FECHA_FIN) || 'NO CONSTA' },
        { label: 'TIPO INCLUSION', value: inclusion.TIPO_INCLUSION || 'NO CONSTA' },
        { label: 'GRUPO INCLUSION', value: inclusion.GRUPO_INCLUSION || 'NO CONSTA' }
    ];

    const filas = [];
    for (let i = 0; i < campos.length; i += 2) {
        filas.push([campos[i], campos[i + 1] || null]);
    }

    return `
                    <div class="section-header">DATOS GENERALES</div>
                    <div class="table-wrapper">
                        <table class="tabla-datos-generales">
                           
                            <tbody>
                                ${filas.map(([campoA, campoB]) => `
                                    <tr>
                                        <td class="dg-label"><span>${campoA.label}</span></td>
                                        <td class="dg-value">${campoA.value}</td>
                                        <td class="dg-label ${campoB ? '' : 'dg-empty'}"><span>${campoB ? campoB.label : ''}</span></td>
                                        <td class="dg-value ${campoB ? '' : 'dg-empty'}">${campoB ? campoB.value : ''}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                `;
}

function generarTablaContactabilidad(data) {
    const contactos = data.contactabilidad || [];
    if (!contactos.length) return '';

    return `
                <div class="section-header">DIRECCION Y CONTACTO</div>
                <div class="table-wrapper">
                    <table>
                        <thead>
                            <tr>
                                <th>PROVINCIA</th><th>CANTON</th><th>PARROQUIA</th>
                                <th>LOCALIDAD</th><th>REFERENCIA</th><th>CALLE 1</th>
                                <th>CALLE 2</th><th>TELEFONOS</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${contactos.map(c => `
                                <tr>
                                    <td>${escapeHTML(c.provincia) || 'NO CONSTA'}</td>
                                    <td>${escapeHTML(c.canton) || 'NO CONSTA'}</td>
                                    <td>${escapeHTML(c.parroquia) || 'NO CONSTA'}</td>
                                    <td>${escapeHTML(c.localidad) || 'NO CONSTA'}</td>
                                    <td>${escapeHTML(c.referencia) || 'NO CONSTA'}</td>
                                    <td>${escapeHTML(c.calle1) || 'NO CONSTA'}</td>
                                    <td>${escapeHTML(c.calle2) || 'NO CONSTA'}</td>
                                    <td>${escapeHTML([c.celular, c.telefono7, c.telefono8].filter(t => t && t !== 'NULL').join(' / ')) || 'NO CONSTA'}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `;
}

function generarTablaGenerica(datos, id, columnas, titulo, color, mensajeVacio) {
    if (!datos.length) return '';

    const headerClass = color === '#6f42c1' ? 'purple' : '';

    return `
                <div class="section-header ${headerClass}">${escapeHTML(titulo)}</div>
                <div class="table-wrapper">
                    <table>
                        <thead>
                            <tr>${columnas.map(col => `<th>${escapeHTML(col.replace(/_/g, ' '))}</th>`).join('')}</tr>
                        </thead>
                        <tbody>
                            ${datos.map(row => `
                                <tr>${columnas.map(col => `<td>${escapeHTML(row[col]) || 'NO CONSTA'}</td>`).join('')}</tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `;
}

function construirEtiquetasIngresoProgresivo(ingreso) {
    if (!ingreso) return [];

    const reglas = [
        {
            codigoKey: 'BONO_DESARROLLO_HUMANO_CODIGO',
            legacyKey: 'BONO_DESARROLLO_HUMANO',
            etiqueta: 'BDH - BONO_DESARROLLO_HUMANO'
        },
        {
            codigoKey: 'PENSION_MIS_MEJORES_ANOS_CODIGO',
            legacyKey: 'PENSION_MIS_MEJORES_ANOS',
            etiqueta: 'MMA - PENSION_MIS_MEJORES_ANOS'
        },
        {
            codigoKey: 'PENSION_TODA_UNA_VIDA_CODIGO',
            legacyKey: 'PENSION_TODA_UNA_VIDA',
            etiqueta: 'PTV - PENSION_TODA_UNA_VIDA'
        },
        {
            codigoKey: 'BDH_CON_COMPONENTE_VARIABLE_CODIGO',
            legacyKey: 'BDH_CON_COMPONENTE_VARIABLE',
            etiqueta: 'BDHV - BDH_CON_COMPONENTE_VARIABLE'
        }
    ];

    const etiquetas = [];

    for (const r of reglas) {
        const codigo = `${ingreso[r.codigoKey] ?? ''}`.trim();

        if (codigo === '2') {
            etiquetas.push(r.etiqueta);
            continue;
        }

        if (codigo === '1') {
            etiquetas.push(`${r.etiqueta} SIN ACTIVACION`);
            continue;
        }

        if (codigo === '0') {
            etiquetas.push(`${r.etiqueta} CODIGO 0`);
            continue;
        }

        // Fallback para entornos donde aun no llegan los campos *_CODIGO
        if (ingreso[r.legacyKey] === 'SI') {
            etiquetas.push(r.etiqueta);
        }
    }

    return etiquetas;
}

function generarAccionReporteHTML(cedula) {
    const cedulaNormalizada = `${cedula || ''}`.replace(/\D/g, '').trim();
    if (!/^\d{10}$/.test(cedulaNormalizada)) return 'NO DISPONIBLE';

    const url = `reporte.html?cedula=${encodeURIComponent(cedulaNormalizada)}`;
    return `<a href="${url}" class="link-ver-reporte btn-brand-yellow" target="_blank" rel="noopener noreferrer" title="Consultar este beneficiario en una nueva pestaña">Ver Integrante</a>`;
}

function generarTablaNucleoFamiliar(data) {
    const hogar = Array.isArray(data.hogar) ? data.hogar : [];
    if (!hogar.length) return '';

    const normalizarCedula = (v) => `${v || ''}`.replace(/\D/g, '').trim();
    const normalizarNucleo = (v) => `${v ?? ''}`.trim();
    const fuenteIngreso = data.ingresoHogar || data.ingresoProgresivo || [];
    const columnas = ['fechaencuesta', 'cedula', 'apellidos', 'nombres', 'edad_persona', 'puntaje', 'fechanacimiento', 'certificado', 'numeronucleo'];

    const cedulaTitular = normalizarCedula(data.cedula || data.datosGenerales?.cedula || data.datosRS?.cedula);
    const filaTitular = hogar.find((row) => normalizarCedula(row.cedula) === cedulaTitular);
    if (!filaTitular) return '';

    const numeroNucleo = normalizarNucleo(filaTitular.numeronucleo);
    if (!numeroNucleo) return '';

    const filasNucleo = hogar.filter((row) => normalizarNucleo(row.numeronucleo) === numeroNucleo);
    if (!filasNucleo.length) return '';

    return `
                <div class="section-header">NUCLEO FAMILIAR (MISMA VIVIENDA) - NUCLEO ${numeroNucleo}</div>
                <div class="table-wrapper table-wrapper-nucleo">
                    <table class="tabla-familiar tabla-nucleo">
                        <colgroup>
                            ${columnas.map(() => '<col>').join('')}
                            <col style="min-width:140px">
                            <col style="min-width:110px">
                            <col>
                            <col>
                            <col class="col-accion-col">
                        </colgroup>
                        <thead>
                            <tr>${columnas.map(col => `<th>${escapeHTML(col.replace(/_/g, ' ').toUpperCase())}</th>`).join('')}<th>PARENTESCO</th><th>REPRESENTANTE</th><th>INGRESO PROGRESIVO</th><th>HABILITADO</th><th class="col-accion-vacia" aria-label="Acciones"></th></tr>
                        </thead>
                        <tbody>
                            ${filasNucleo.map(row => {
        const cedulaRow = normalizarCedula(row.cedula);
        const ingreso = fuenteIngreso.find(i => normalizarCedula(i.cedula) === cedulaRow);
        const ingresosTexto = construirEtiquetasIngresoProgresivo(ingreso);
        const esTitularConsulta = cedulaRow === cedulaTitular;
        const estadoTitular = `${document.getElementById('valor-estado')?.textContent || ''}`.trim();
        const habilitadoFallbackTitular = esTitularConsulta && esEstadoHabilitado(estadoTitular) ? 'SI' : 'NO';
        const habilitadoMiembro = `${ingreso?.habilitado || habilitadoFallbackTitular}`.toUpperCase();
        const estiloHabilitado = habilitadoMiembro === 'SI'
            ? 'color:#1a7f37;font-weight:bold'
            : 'color:#b42318;font-weight:600';

        const cNucleo = parseInt(row.parentescojefenucleo, 10);
        const parentescoTexto = PARENTESCO_NUCLEO[cNucleo] || 'NO CONSTA';

        const esRepRaw = row.EsRepresentante ?? ingreso?.EsRepresentante;
        const esRep = `${esRepRaw ?? ''}`.trim();
        const esRepresentante = esRep === '1' || esRep.toLowerCase() === 'si' || esRep.toLowerCase() === 'true' || esRep.toLowerCase() === 's';
        const representanteHTML = esRepresentante
            ? '<span style="color:#1a7f37;font-weight:700">Representante</span>'
            : '<span style="color:#888">No</span>';

        return `<tr>
                                    ${columnas.map(col => `<td>${row[col] || 'NO CONSTA'}</td>`).join('')}
                                    <td>${escapeHTML(parentescoTexto)}</td>
                                    <td>${representanteHTML}</td>
                                    <td>${ingresosTexto.length ? ingresosTexto.join(' | ') : 'NO'}</td>
                                    <td style="${estiloHabilitado}">${habilitadoMiembro}</td>
                                    <td class="col-accion">${generarAccionReporteHTML(row.cedula)}</td>
                                </tr>`;
    }).join('')}
                        </tbody>
                    </table>
                </div>
            `;
}

function generarTablaHogar(data) {
    const hogar = data.hogar || [];
    if (!hogar.length) return '';

    const normalizarCedula = (v) => `${v || ''}`.replace(/\D/g, '').trim();
    const fuenteIngreso = data.ingresoHogar || data.ingresoProgresivo || [];

    const columnas = ['fechaencuesta', 'cedula', 'apellidos', 'nombres', 'edad_persona', 'puntaje', 'fechanacimiento', 'certificado', 'numeronucleo'];

    return `
                <div class="section-header">HOGAR FAMILIAR (REGISTRO SOCIAL COMPLETO)</div>
                <div class="table-wrapper table-wrapper-hogar">
                    <table class="tabla-familiar tabla-hogar">
                        <colgroup>
                            ${columnas.map(() => '<col>').join('')}
                            <col>
                            <col>
                            <col class="col-accion-col">
                        </colgroup>
                        <thead>
                            <tr>${columnas.map(col => `<th>${escapeHTML(col.replace(/_/g, ' ').toUpperCase())}</th>`).join('')}<th>INGRESO PROGRESIVO</th><th>HABILITADO</th><th class="col-accion-vacia" aria-label="Acciones"></th></tr>
                        </thead>
                        <tbody>
                            ${hogar.map(row => {
        const cedulaRow = normalizarCedula(row.cedula);
        const ingreso = fuenteIngreso.find(i => normalizarCedula(i.cedula) === cedulaRow);
        const ingresosTexto = construirEtiquetasIngresoProgresivo(ingreso);
        const esTitularConsulta = cedulaRow === normalizarCedula(data.cedula);
        const estadoTitular = `${document.getElementById('valor-estado')?.textContent || ''}`.trim();
        const habilitadoFallbackTitular = esTitularConsulta && esEstadoHabilitado(estadoTitular) ? 'SI' : 'NO';
        const habilitadoMiembro = `${ingreso?.habilitado || habilitadoFallbackTitular}`.toUpperCase();
        const estiloHabilitado = habilitadoMiembro === 'SI'
            ? 'color:#1a7f37;font-weight:bold'
            : 'color:#b42318;font-weight:600';

        return `<tr>
                                    ${columnas.map(col => `<td>${row[col] || 'NO CONSTA'}</td>`).join('')}
                                    <td>${ingresosTexto.length ? ingresosTexto.join(' | ') : 'NO'}</td>
                                    <td style="${estiloHabilitado}">${habilitadoMiembro}</td>
                                    <td class="col-accion">${generarAccionReporteHTML(row.cedula)}</td>
                                </tr>`;
    }).join('')}
                        </tbody>
                    </table>
                </div>
            `;
}

function generarTablaBasesExternas(data) {
    const bases = data.basesExternas || {};
    const campos = [
        'IESS', 'ISSPOL', 'IESS_PUBLICO', 'MEF_PUBLICOS', 'ISSFA',
        'TIPO_DISCAPACIDAD', 'PORC_DISCAPACIDAD', 'FEMICIDIO', 'MUERTES_VIOLENTAS',
        'ACOGIDA', 'UNIDAD', 'DINASED', 'EXCOMBATIENTES', 'JGL_ACTUAL', 'ULTIMO_MES_JGL'
    ];

    if (!Object.keys(bases).length) {
        return `
                    <div class="section-header purple">BASES EXTERNAS</div>
                    <div class="table-wrapper">
                        <table><tr><td class="text-center">SIN DATOS EN BASES EXTERNAS</td></tr></table>
                    </div>
                `;
    }

    return `
                <div class="section-header purple">BASES EXTERNAS</div>
                <div class="table-wrapper">
                    <table>
                        <thead><tr>${campos.map(c => `<th>${escapeHTML(c.replace(/_/g, ' '))}</th>`).join('')}</tr></thead>
                        <tbody>
                            <tr>${campos.map(c => `<td>${escapeHTML(bases[c]) || 'NO'}</td>`).join('')}</tr>
                        </tbody>
                    </table>
                </div>
            `;
}

function generarTablaPuntaje(data) {
    const puntaje = (data.puntajeHistorico && data.puntajeHistorico[0]) || {};
    const campos = ['Puntaje_Actual', 'Puntaje_Anterior_1', 'Puntaje_Anterior_2', 'Puntaje_Anterior_3', 'Puntaje_Anterior_4'];
    const protegido = data.reactivacion?.estaProtegida === true && data.reactivacion?.puntajesDifieren === true;

    const tieneValor = campos.some(c => puntaje[c] && puntaje[c] !== 'NO CONSTA');
    if (!Object.keys(puntaje).length || !tieneValor) return '';

    const renderCeldaPuntaje = (campo) => {
        const valor = escapeHTML(puntaje[campo] || 'NO CONSTA');
        if (campo === 'Puntaje_Actual' && protegido) {
            return `${valor} <span style="background:#1f5f8b;color:#fff;font-size:0.75rem;padding:2px 8px;border-radius:10px;font-weight:700;vertical-align:middle;letter-spacing:0.03em;">PROTEGIDO</span>`;
        }
        return valor;
    };

    return `
                <div class="section-header">HISTORIAL DE PUNTAJE RS</div>
                <div class="table-wrapper">
                    <table>
                        <thead><tr>${campos.map(c => `<th>${c.replace(/_/g, ' ').toUpperCase()}</th>`).join('')}</tr></thead>
                        <tbody>
                            <tr>${campos.map(c => `<td>${renderCeldaPuntaje(c)}</td>`).join('')}</tr>
                        </tbody>
                    </table>
                </div>
            `;
}

function obtenerSeccionesOrdenExportacion() {
    const contenedor = document.getElementById('contenido-dinamico');
    if (!contenedor) return [];

    const ORDEN_PREFERIDO = [
        'HISTORIAL DE PUNTAJE RS',
        'DATOS GENERALES',
        'HISTORIAL DE COBROS PAGO EN CUENTA BONOS',
        'HISTORIAL DE COBROS PAGO EN VENTANILLA BONOS',
        'HISTORIAL DE COBROS 1000 DIAS PAGO EN CUENTA',
        'HISTORIAL DE COBROS 1000 DIAS VENTANILLA',
        'DIRECCION Y CONTACTO',
        'NUCLEO FAMILIAR',
        'REPRESENTANTE MENOR CON DISCAPACIDAD',
        'BONO 1000 DIAS',
        'AFILIACION IESS',
        'HOGAR FAMILIAR',
        'BASES EXTERNAS'
    ];

    const normalizarTitulo = (titulo) => {
        const t = (titulo || '').trim().toUpperCase();
        if (t.startsWith('NUCLEO FAMILIAR')) return 'NUCLEO FAMILIAR';
        if (t.startsWith('HOGAR FAMILIAR')) return 'HOGAR FAMILIAR';
        return t;
    };

    const headers = Array.from(contenedor.querySelectorAll('.section-header'));

    const secciones = headers.map((headerEl, idx) => {
        const wrapperEl = headerEl.nextElementSibling;
        const tabla = wrapperEl && wrapperEl.classList.contains('table-wrapper')
            ? wrapperEl.querySelector('table')
            : null;

        return {
            idx,
            headerEl,
            wrapperEl,
            tabla,
            titulo: (headerEl.textContent || '').trim()
        };
    }).filter(s => s.wrapperEl && s.tabla);

    secciones.sort((a, b) => {
        const pa = ORDEN_PREFERIDO.indexOf(normalizarTitulo(a.titulo));
        const pb = ORDEN_PREFERIDO.indexOf(normalizarTitulo(b.titulo));

        const aNoDef = pa === -1;
        const bNoDef = pb === -1;

        if (aNoDef && bNoDef) return a.idx - b.idx;
        if (aNoDef) return 1;
        if (bNoDef) return -1;
        if (pa !== pb) return pa - pb;

        return a.idx - b.idx;
    });

    return secciones;
}

function clonarTablaSinAcciones(tabla) {
    const copia = tabla.cloneNode(true);

    // Quita la columna de acciones (header y celdas)
    copia.querySelectorAll('th.col-accion-vacia, td.col-accion').forEach(el => el.remove());

    // Respaldo por texto, por si algún header cambia de clase
    copia.querySelectorAll('th').forEach(th => {
        const txt = (th.textContent || '').trim().toUpperCase();
        if (txt === 'VER INTEGRANTE' || txt === 'ACCIONES') th.remove();
    });

    return copia;
}

function obtenerSeccionesHistorialExportacion() {
    const contenedor = document.querySelector('#contenido-dinamico .historial-cobros .historial-cobros-contenido');
    if (!contenedor) return [];

    const bloques = Array.from(contenedor.querySelectorAll('.historial-identificador'));
    const secciones = [];

    bloques.forEach((bloque) => {
        const tituloBase = (bloque.textContent || '').trim();
        const wrapAnios = bloque.nextElementSibling;
        if (!wrapAnios || !wrapAnios.classList.contains('historial-anios-wrap')) return;

        const anios = Array.from(wrapAnios.querySelectorAll('.historial-anio'));
        anios.forEach((anioDetalle) => {
            const tabla = anioDetalle.querySelector('table');
            if (!tabla) return;
            const anioTitulo = (anioDetalle.querySelector('.historial-anio-toggle')?.textContent || '').trim();
            const titulo = anioTitulo
                ? `HISTORIAL DE COBROS ${tituloBase} - ${anioTitulo}`
                : `HISTORIAL DE COBROS ${tituloBase}`;
            secciones.push({ titulo, tabla });
        });
    });

    return secciones;
}

function obtenerNombreBeneficiario() {
    const dg = datosGlobales?.datosGenerales || datosGlobales?.datosRS || {};
    const nombre = `${dg.nombres || ''}`.trim();
    const apellido = `${dg.apellidos || ''}`.trim();
    return `${nombre} ${apellido}`.trim() || 'NO CONSTA';
}

function formatearTituloExcelSeccion(titulo) {
    const base = `${titulo || ''}`.trim();
    const upper = base.toUpperCase();
    if (!upper.startsWith('HISTORIAL DE COBROS')) {
        return upper;
    }

    const candidatos = base.match(/(19\d{2}|20\d{2})/g) || [];
    if (candidatos.length) return candidatos[candidatos.length - 1];

    return '';
}

function extraerAnioSeccionHistorial(titulo) {
    const base = `${titulo || ''}`;
    const candidatos = base.match(/(19\d{2}|20\d{2})/g) || [];
    if (!candidatos.length) return Number.MAX_SAFE_INTEGER;
    return Number.parseInt(candidatos[candidatos.length - 1], 10);
}

function ordenarSeccionesHistorialAsc(secciones) {
    return [...(secciones || [])].sort((a, b) => {
        const aHist = `${a?.titulo || ''}`.toUpperCase().startsWith('HISTORIAL DE COBROS');
        const bHist = `${b?.titulo || ''}`.toUpperCase().startsWith('HISTORIAL DE COBROS');

        if (!aHist && !bHist) return 0;
        if (!aHist || !bHist) return 0;

        const anioA = extraerAnioSeccionHistorial(a.titulo);
        const anioB = extraerAnioSeccionHistorial(b.titulo);
        if (anioA !== anioB) return anioB - anioA;

        return `${b.titulo || ''}`.localeCompare(`${a.titulo || ''}`);
    });
}

function prepararTablaParaExportacion(tabla, tituloSeccion) {
    const copia = clonarTablaSinAcciones(tabla);
    const tituloUpper = `${tituloSeccion || ''}`.toUpperCase();
    const esHistorial = tituloUpper.startsWith('HISTORIAL DE COBROS');
    if (!esHistorial) return copia;

    const headerTh = copia.querySelector('thead tr th:last-child');
    const headerActual = `${headerTh?.textContent || ''}`.trim().toUpperCase();
    if (headerActual !== 'EXCEPCION FINAL') {
        return tabla;
    }

    const esVentanilla = tituloUpper.includes('VENTANILLA');
    const textoPago = esVentanilla ? 'PAGO EN VENTANILLA' : 'PAGO EN CUENTA';

    if (headerTh) {
        headerTh.textContent = 'TIPO DE PAGO';
    }

    copia.querySelectorAll('tbody tr').forEach((tr) => {
        const td = tr.querySelector('td:last-child');
        if (td) {
            td.textContent = textoPago;
        }
    });

    return copia;
}

function obtenerDataTablaParaExport(tabla) {
    if (tabla && Array.isArray(tabla._exportColumns) && Array.isArray(tabla._exportRows)) {
        return {
            columnas: [...tabla._exportColumns],
            filas: [...tabla._exportRows.map((r) => [...r])]
        };
    }

    // Caso especial: tabla-datos-generales (layout 4 celdas por fila: label1|val1|label2|val2, sin thead)
    if (tabla && tabla.classList && tabla.classList.contains('tabla-datos-generales')) {
        const filas = [];
        tabla.querySelectorAll('tbody tr').forEach((tr) => {
            const tds = Array.from(tr.querySelectorAll('td'));
            const label1 = `${tds[0]?.textContent || ''}`.trim();
            const val1   = `${tds[1]?.textContent || ''}`.trim();
            const label2 = `${tds[2]?.textContent || ''}`.trim();
            const val2   = `${tds[3]?.textContent || ''}`.trim();
            if (label1) filas.push([label1, val1 || 'NO CONSTA']);
            if (label2) filas.push([label2, val2 || 'NO CONSTA']);
        });
        return { columnas: ['', ''], filas };
    }

    const headers = Array.from(tabla.querySelectorAll('thead th')).map((th) => `${th.innerText || ''}`.trim());
    const filas = Array.from(tabla.querySelectorAll('tbody tr')).map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) => `${td.innerText || ''}`.trim())
    );
    return { columnas: headers, filas };
}

function obtenerMetaTituloHistorial(titulo) {
    const upper = `${titulo || ''}`.toUpperCase();
    const candidatos = `${titulo || ''}`.match(/(19\d{2}|20\d{2})/g) || [];
    const anio = candidatos.length ? Number.parseInt(candidatos[candidatos.length - 1], 10) : null;
    const tipoPago = upper.includes('VENTANILLA') ? 'PAGO EN VENTANILLA' : 'PAGO EN CUENTA';
    return { anio, tipoPago };
}

function normalizarHeaderHistorial(texto) {
    return `${texto || ''}`
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toUpperCase();
}

function extraerAnioDesdeCobro(row) {
    const fecha = `${row?.fechaCobro || ''}`.trim();
    const mf = fecha.match(/^(19\d{2}|20\d{2})-/);
    if (mf) return Number.parseInt(mf[1], 10);

    const periodo = `${row?.periodo || ''}`.trim();
    const mp = periodo.match(/(19\d{2}|20\d{2})$/);
    if (mp) return Number.parseInt(mp[1], 10);

    return null;
}

function extraerMesDesdeCobro(row) {
    const periodo = `${row?.periodo || ''}`.trim().toUpperCase();
    const matchPeriodo = periodo.match(/^(.+?)\s+\d{4}$/);
    if (matchPeriodo) return matchPeriodo[1].trim();

    const fecha = `${row?.fechaCobro || ''}`.trim();
    const matchFecha = fecha.match(/^\d{4}-(\d{2})-/);
    if (matchFecha) {
        const MESES_LISTA = [
            '', 'ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO',
            'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'
        ];
        const idx = Number.parseInt(matchFecha[1], 10);
        return MESES_LISTA[idx] || 'NO CONSTA';
    }

    return 'NO CONSTA';
}

function formatearMontoCobro(valor) {
    if (valor === undefined || valor === null || `${valor}`.trim() === '') return 'NO CONSTA';
    const num = Number(valor);
    if (Number.isNaN(num)) return `${valor}`;
    return `$${num.toFixed(2)}`;
}

function mapBonoExport(codSubsidio) {
    const raw = `${codSubsidio ?? ''}`.trim().toUpperCase();
    if (!raw) return 'NO CONSTA';

    const catalogo = {
        BDH: 'BONO DE DESARROLLO HUMANO',
        PAM: 'PENSION ADULTO MAYOR',
        PDD: 'PENSION PERSONAS CON DISCAPACIDAD',
        MMA: 'PENSION MIS MEJORES ANOS',
        BVA: 'BONO DE DESARROLLO HUMANO CON COMPONENTE VARIABLE',
        PTUV: 'PENSION TODA UNA VIDA',
        PTVA: 'PENSION TODA UNA VIDA',
        PTVM: 'PENSION TODA UNA VIDA MENORES',
        BMD: 'BONO 1000 DIAS',
        BDD: 'PENSION MENORES DE EDAD CON DISCAPACIDAD'
    };

    if (catalogo[raw]) {
        return `${raw} - ${catalogo[raw]}`;
    }

    return raw;
}

function extraerFilasHistorialDesdeDatos(tipoPago, rows) {
    return (rows || []).map((row) => ({
        _anio: extraerAnioDesdeCobro(row),
        MES: extraerMesDesdeCobro(row),
        BONO: mapBonoExport(row?.codSubsidio),
        MONTO: formatearMontoCobro(row?.monto),
        'FECHA COBRO': `${row?.fechaCobro || ''}`.trim() || 'NO CONSTA',
        PROVINCIA: `${row?.provincia || ''}`.trim() || 'NO CONSTA',
        CANTON: `${row?.canton || row?.ciudad || ''}`.trim() || 'NO CONSTA',
        PARROQUIA: `${row?.parroquia || ''}`.trim() || 'NO CONSTA',
        BANCO: `${row?.banco || ''}`.trim() || 'NO CONSTA',
        AGENCIA: `${row?.agencia || ''}`.trim() || 'NO CONSTA',
        'DIRECCION AGENCIA': `${row?.direccionAgencia || ''}`.trim() || 'NO CONSTA',
        'TIPO DE PAGO': tipoPago
    }));
}

function construirTablaHistorialConsolidada(rows) {
    const tieneDetalleVentanilla = (rows || []).some((row) => {
        const vals = [
            `${row.PROVINCIA || ''}`.trim(),
            `${row.CANTON || ''}`.trim(),
            `${row.PARROQUIA || ''}`.trim(),
            `${row.BANCO || ''}`.trim(),
            `${row.AGENCIA || ''}`.trim(),
            `${row['DIRECCION AGENCIA'] || ''}`.trim()
        ];
        return vals.some((v) => v && v !== 'NO CONSTA');
    });

    const columnasBase = ['MES', 'BONO', 'MONTO', 'FECHA COBRO'];
    const columnasDetalle = ['PROVINCIA', 'CANTON', 'PARROQUIA', 'BANCO', 'AGENCIA', 'DIRECCION AGENCIA'];
    const columnas = [
        ...columnasBase,
        ...(tieneDetalleVentanilla ? columnasDetalle : []),
        'TIPO DE PAGO'
    ];
    const tabla = document.createElement('table');
    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    columnas.forEach((col) => {
        const th = document.createElement('th');
        th.textContent = col;
        trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    tabla.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach((row) => {
        const tr = document.createElement('tr');
        columnas.forEach((col) => {
            const td = document.createElement('td');
            td.textContent = `${row[col] || 'NO CONSTA'}`;
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    tabla.appendChild(tbody);

    tabla._exportColumns = [...columnas];
    tabla._exportRows = rows.map((row) => columnas.map((col) => `${row[col] || 'NO CONSTA'}`));

    return tabla;
}

function consolidarSeccionesHistorialPorAnio(secciones) {
    const entrada = [...(secciones || [])];
    const mapa = new Map();

    const hc = datosGlobales?.historialCobros || {};
    const filasCuentaBonos = extraerFilasHistorialDesdeDatos('PAGO EN CUENTA', hc.bonosPagoCuenta || []);
    const filasVentanillaBonos = extraerFilasHistorialDesdeDatos('PAGO EN VENTANILLA', hc.bonosVentanilla || []);
    const filasCuentaMil = extraerFilasHistorialDesdeDatos('PAGO EN CUENTA', hc.milDiasPagoCuenta || []);
    const filasVentanillaMil = extraerFilasHistorialDesdeDatos('PAGO EN VENTANILLA', hc.milDiasVentanilla || []);
    const filasHistorial = [
        ...filasCuentaBonos,
        ...filasVentanillaBonos,
        ...filasCuentaMil,
        ...filasVentanillaMil
    ];

    filasHistorial.forEach((row) => {
        const anio = row._anio;
        if (!anio) return;
        if (!mapa.has(anio)) mapa.set(anio, []);
        mapa.get(anio).push(row);
    });

    const seccionesHistorialConsolidadas = [...mapa.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([anio, rows]) => {
            const limpia = rows.map(({ _anio, ...resto }) => resto);
            return {
                titulo: `HISTORIAL DE COBROS ${anio}`,
                tabla: construirTablaHistorialConsolidada(limpia)
            };
        });

    const salida = [];
    let insertadoHistorial = false;
    entrada.forEach((seccion) => {
        const tituloUpper = `${seccion?.titulo || ''}`.toUpperCase();
        const esHistorial = tituloUpper.startsWith('HISTORIAL DE COBROS');

        if (esHistorial) {
            if (!insertadoHistorial) {
                salida.push(...seccionesHistorialConsolidadas);
                insertadoHistorial = true;
            }
            return;
        }

        salida.push(seccion);
    });

    return salida;
}

async function exportarPDF() {
    if (!datosGlobales) {
        alert('Primero busque un beneficiario');
        return;
    }

    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF('landscape');
        const cedula = document.getElementById('cedula').value;
        const fecha = new Date().toLocaleString('es-EC');

        const COLOR_CABECERA = [90, 0, 157];
        const COLOR_SECCION = [44, 22, 142];
        const COLOR_FILA_ALTERNA = [246, 244, 255];
        const ANCHO_PAGINA = 287;

        const generarPDF = (logoDataUrl) => {
            // ── Cabecera blanca ───────────────────────────────────
            if (logoDataUrl) {
                doc.addImage(logoDataUrl, 'PNG', 10, 8, 30, 15);
            }

            doc.setTextColor(20, 20, 20);
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(16);
            doc.text('REPORTE BENEFICIARIO HABILITADO', ANCHO_PAGINA / 2, 13, { align: 'center' });
            doc.setFontSize(10);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(80, 80, 80);
            doc.text('Ministerio de Desarrollo Humano - El Nuevo Ecuador', ANCHO_PAGINA / 2, 21, { align: 'center' });
            doc.setFontSize(8);
            doc.setTextColor(120, 120, 120);
            doc.text(`Fecha: ${fecha}`, ANCHO_PAGINA - 10, 8, { align: 'right' });
            doc.setTextColor(0, 0, 0);

            // ── Tarjetas RS / Estado ──────────────────────────────
            const rs = document.getElementById('valor-registro-social').textContent;
            const estado = document.getElementById('valor-estado').textContent;
            const esHab = document.getElementById('valor-estado').dataset.habilitado === '1';
            const estadoColor = esHab ? [26, 127, 55] : [180, 35, 24];
            const estadoBg = esHab ? [234, 249, 239] : [255, 236, 236];

            let y = 30;

            doc.setFillColor(246, 244, 255);
            doc.roundedRect(10, y, 128, 18, 2, 2, 'F');
            doc.setTextColor(120, 120, 120);
            doc.setFontSize(7);
            doc.setFont('helvetica', 'normal');
            doc.text('REGISTRO SOCIAL', 14, y + 6);
            doc.setTextColor(20, 20, 20);
            doc.setFontSize(12);
            doc.setFont('helvetica', 'bold');
            doc.text(rs, 14, y + 14);

            doc.setFillColor(...estadoBg);
            doc.roundedRect(148, y, 128, 18, 2, 2, 'F');
            doc.setTextColor(120, 120, 120);
            doc.setFontSize(7);
            doc.setFont('helvetica', 'normal');
            doc.text('ESTADO', 152, y + 6);
            doc.setTextColor(...estadoColor);
            doc.setFontSize(12);
            doc.setFont('helvetica', 'bold');
            doc.text(estado, 152, y + 14);
            doc.setTextColor(0, 0, 0);

            y += 24;

            // ── Secciones ─────────────────────────────────────────
            const secciones = consolidarSeccionesHistorialPorAnio(
                ordenarSeccionesHistorialAsc(obtenerSeccionesOrdenExportacion())
            );
            const seccionWrappers = Array.from(document.querySelectorAll('#contenido-dinamico .table-wrapper'));

            for (const seccion of secciones) {
                const titulo = seccion.titulo;
                const tabla = seccion.tabla;
                const tablaParaPdf = prepararTablaParaExportacion(tabla, titulo);
                const dataTabla = obtenerDataTablaParaExport(tablaParaPdf);
                const colorBarra = COLOR_SECCION;
                const tituloBarra = formatearTituloExcelSeccion(titulo);
                const esHistorial = `${titulo || ''}`.toUpperCase().startsWith('HISTORIAL DE COBROS');

                if (y + 18 > 195) { doc.addPage(); y = 15; }

                doc.setFillColor(...colorBarra);
                doc.rect(10, y, 277, 6, 'F');
                doc.setTextColor(255, 255, 255);
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(esHistorial ? 11 : 8);
                doc.text(
                    tituloBarra,
                    esHistorial ? (ANCHO_PAGINA / 2) : 13,
                    y + 4.2,
                    esHistorial ? { align: 'center' } : undefined
                );
                doc.setTextColor(0, 0, 0);

                doc.autoTable({
                    head: [dataTabla.columnas],
                    body: dataTabla.filas,
                    startY: y + 6,
                    margin: { left: 10, right: 10 },
                    styles: { fontSize: 7.5, cellPadding: 2.5, textColor: [40, 40, 40] },
                    headStyles: { fillColor: colorBarra, textColor: 255, fontStyle: 'bold', fontSize: 8 },
                    alternateRowStyles: { fillColor: COLOR_FILA_ALTERNA },
                    tableLineColor: [200, 200, 200],
                    tableLineWidth: 0.15,
                    theme: 'grid'
                });

                y = doc.lastAutoTable.finalY + 8;
            }

            // ── Pie de página ─────────────────────────────────────
            const totalPaginas = doc.internal.getNumberOfPages();
            for (let p = 1; p <= totalPaginas; p++) {
                doc.setPage(p);
                doc.setFillColor(237, 231, 255);
                doc.rect(0, 200, ANCHO_PAGINA, 10, 'F');
                doc.setFontSize(7.5);
                doc.setFont('helvetica', 'normal');
                doc.setTextColor(100, 100, 100);
                doc.text('Dirección de Administración de Datos', ANCHO_PAGINA / 2, 206, { align: 'center' });
                doc.text(`Página ${p} de ${totalPaginas}`, ANCHO_PAGINA - 12, 206, { align: 'right' });
            }

            doc.save(`Reporte_Beneficiario_${cedula}.pdf`);
        };

        // Carga logo; si falla genera el PDF sin él
        const img = new Image();
        img.onload = function () {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            canvas.getContext('2d').drawImage(img, 0, 0);
            generarPDF(canvas.toDataURL('image/png'));
        };
        img.onerror = function () { generarPDF(null); };
        img.src = 'logo.png';

    } catch (error) {
        console.error('Error PDF:', error);
        alert('Error al generar PDF');
    }
}

async function exportarExcel() {
    if (!datosGlobales) {
        alert('Primero busque un beneficiario');
        return;
    }

    try {
        const wb = new ExcelJS.Workbook();
        wb.creator = 'Ministerio de Desarrollo Humano';
        wb.created = new Date();

        const cedula = document.getElementById('cedula').value || 'Sin_Cedula';
        const fecha = new Date().toLocaleString('es-EC');
        const ws = wb.addWorksheet('Reporte Completo');
        let fila = 1;

        // ── Logo ──────────────────────────────────────────────────────
        try {
            const resp = await fetch('logo2.png');
            const blob = await resp.blob();
            const base64 = await new Promise(res => {
                const r = new FileReader();
                r.onload = e => res(e.target.result.split(',')[1]);
                r.readAsDataURL(blob);
            });
            const logoId = wb.addImage({ base64, extension: 'png' });
            ws.addImage(logoId, { tl: { col: 0, row: 0 }, br: { col: 2, row: 4 }, editAs: 'oneCell' });
        } catch (_) { /* sin logo */ }

        // ── Encabezado institucional ──────────────────────────────────
        const headerArgb = '5A009D';  // morado principal
        const fillHeader = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + headerArgb } };

        // Fila 1 – título (A:B con fondo + C:N mergeado con texto)
        ws.getCell(`A${fila}`).fill = fillHeader;
        ws.getCell(`B${fila}`).fill = fillHeader;
        ws.mergeCells(`C${fila}:N${fila}`);
        const cTitulo = ws.getCell(`C${fila}`);
        cTitulo.value = 'REPORTE BENEFICIARIO HABILITADO';
        cTitulo.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
        cTitulo.fill = fillHeader;
        cTitulo.alignment = { horizontal: 'center', vertical: 'middle' };
        ws.getRow(fila).height = 26;
        fila++;

        // Fila 2 – subtítulo
        ws.getCell(`A${fila}`).fill = fillHeader;
        ws.getCell(`B${fila}`).fill = fillHeader;
        ws.mergeCells(`C${fila}:N${fila}`);
        const cSub = ws.getCell(`C${fila}`);
        cSub.value = 'Ministerio de Desarrollo Humano - El Nuevo Ecuador';
        cSub.font = { size: 10, color: { argb: 'FFFFFFFF' } };
        cSub.fill = fillHeader;
        cSub.alignment = { horizontal: 'center' };
        ws.getRow(fila).height = 18;
        fila++;

        // Fila 3 – fecha
        ws.getCell(`A${fila}`).fill = fillHeader;
        ws.getCell(`B${fila}`).fill = fillHeader;
        ws.mergeCells(`C${fila}:N${fila}`);
        const cFecha = ws.getCell(`C${fila}`);
        cFecha.value = `Fecha: ${fecha}`;
        cFecha.font = { size: 9, italic: true, color: { argb: 'FFDDDDFF' } };
        cFecha.fill = fillHeader;
        cFecha.alignment = { horizontal: 'center' };
        fila++;

        ws.getRow(fila).height = 8; fila++;   // separador

        // ── Tarjetas RS / Estado ──────────────────────────────────────
        const rsVal = document.getElementById('valor-registro-social').textContent;
        const estVal = document.getElementById('valor-estado').textContent;
        const esHab = document.getElementById('valor-estado').dataset.habilitado === '1';
        const estArgb = esHab ? 'FF1a7f37' : 'FFb42318';
        const estBgArg = esHab ? 'FFeaf9ef' : 'FFffecec';

        ws.getCell(`A${fila}`).value = 'REGISTRO SOCIAL';
        ws.getCell(`A${fila}`).font = { bold: true, size: 8, color: { argb: 'FF888888' } };
        ws.getCell(`D${fila}`).value = 'ESTADO';
        ws.getCell(`D${fila}`).font = { bold: true, size: 8, color: { argb: 'FF888888' } };
        fila++;

        const cRs = ws.getCell(`A${fila}`);
        cRs.value = rsVal;
        cRs.font = { bold: true, size: 14, color: { argb: 'FF141414' } };
        cRs.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5FF' } };
        ws.getRow(fila).height = 22;

        const cEst = ws.getCell(`D${fila}`);
        cEst.value = estVal;
        cEst.font = { bold: true, size: 14, color: { argb: estArgb } };
        cEst.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: estBgArg } };
        fila++;

        ws.getRow(fila).height = 8; fila++;   // separador

        // ── Secciones ─────────────────────────────────────────────────
        const SECCIONES_PURPLE = new Set(['REPRESENTANTE MENOR CON DISCAPACIDAD', 'BASES EXTERNAS']);
        const secciones = consolidarSeccionesHistorialPorAnio(
            ordenarSeccionesHistorialAsc(obtenerSeccionesOrdenExportacion())
        );
        const seccionWrappers = Array.from(document.querySelectorAll('#contenido-dinamico .table-wrapper'));

        for (const seccion of secciones) {
            const titulo = seccion.titulo;
            const tabla = seccion.tabla;
            const tituloUpper = `${titulo || ''}`.trim().toUpperCase();
            const esHistorial = tituloUpper.startsWith('HISTORIAL DE COBROS');
            const colorArgb = esHistorial
                ? '2C168E'
                : (SECCIONES_PURPLE.has(titulo) ? '6F42C1' : '2C168E');
            const colorHeadArgb = '3A1EA4';

            // Separador + barra de sección
            ws.getRow(fila).height = 5; fila++;

            const tablaParaExcel = prepararTablaParaExportacion(tabla, titulo);
            const dataTabla = obtenerDataTablaParaExport(tablaParaExcel);
            const filas = [dataTabla.columnas, ...dataTabla.filas];
            const numCols = dataTabla.columnas.length || 1;
            // Calcular columna final real (máx 26 para la letra, pero extiende el relleno manualmente)
            const colFinIdx = Math.min(numCols, 26);
            const colFin = String.fromCharCode(64 + colFinIdx);

            ws.mergeCells(`A${fila}:${colFin}${fila}`);
            const cSec = ws.getCell(`A${fila}`);
            cSec.value = formatearTituloExcelSeccion(titulo);
            cSec.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + colorArgb } };
            cSec.font = { bold: true, size: esHistorial ? 14 : 10, color: { argb: 'FFFFFFFF' } };
            cSec.alignment = esHistorial
                ? { horizontal: 'center', vertical: 'middle' }
                : { horizontal: 'left', vertical: 'middle', indent: 1 };
            ws.getRow(fila).height = esHistorial ? 24 : 18;
            fila++;

            // Filas de la tabla
            filas.forEach((celdas, rowIdx) => {
                const exRow = ws.getRow(fila);
                const esHead = rowIdx === 0;

                celdas.forEach((valorCelda, colIdx) => {
                    const exCell = exRow.getCell(colIdx + 1);
                    const textoCelda = `${valorCelda || ''}`.trim();
                    exCell.value = esHead ? textoCelda.toUpperCase() : textoCelda;
                    exCell.border = {
                        top: { style: 'thin', color: { argb: 'FFCCCCCC' } },
                        left: { style: 'thin', color: { argb: 'FFCCCCCC' } },
                        bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
                        right: { style: 'thin', color: { argb: 'FFCCCCCC' } }
                    };

                    if (esHead) {
                        exCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + colorHeadArgb } };
                        exCell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
                        exCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
                        exRow.height = 20;
                    } else {
                        const bgFila = rowIdx % 2 === 0 ? 'FFF6F4FF' : 'FFFFFFFF';
                        exCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgFila } };
                        exCell.font = { size: 9 };
                        exCell.alignment = { vertical: 'middle', wrapText: true };
                        exRow.height = 16;
                    }
                });

                fila++;
            });
        }

        // ── Ancho automático de columnas ──────────────────────────────
        ws.columns.forEach(col => {
            let maxLen = 10;
            col.eachCell({ includeEmpty: false }, cell => {
                const len = cell.value ? String(cell.value).length : 0;
                if (len > maxLen) maxLen = len;
            });
            col.width = Math.min(maxLen + 3, 55);
        });

        // Congela encabezado
        ws.views = [{ state: 'frozen', ySplit: 4, topLeftCell: 'A5' }];

        // ── Descarga ──────────────────────────────────────────────────
        const buffer = await wb.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Reporte_Beneficiario_${cedula}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);

    } catch (error) {
        console.error('Error Excel:', error);
        alert('Error al generar Excel. Revisa la consola.');
    }
}

async function exportarHistorialPDF() {
    if (!datosGlobales) {
        alert('Primero busque un beneficiario');
        return;
    }

    const secciones = consolidarSeccionesHistorialPorAnio(
        ordenarSeccionesHistorialAsc(obtenerSeccionesHistorialExportacion())
    );
    if (!secciones.length) {
        alert('No hay historial de cobros para exportar');
        return;
    }

    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF('landscape');
        const cedula = document.getElementById('cedula').value;
        const fecha = new Date().toLocaleString('es-EC');
        const nombreCompleto = obtenerNombreBeneficiario();

        const COLOR_SECCION = [44, 22, 142];
        const COLOR_FILA_ALTERNA = [246, 244, 255];
        const ANCHO_PAGINA = 287;

        const generarPDF = (logoDataUrl) => {
            if (logoDataUrl) {
                doc.addImage(logoDataUrl, 'PNG', 10, 8, 30, 15);
            }

            doc.setTextColor(20, 20, 20);
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(16);
            doc.text('REPORTE HISTORIAL DE COBROS', ANCHO_PAGINA / 2, 13, { align: 'center' });
            doc.setFontSize(10);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(80, 80, 80);
            doc.text('Ministerio de Desarrollo Humano - El Nuevo Ecuador', ANCHO_PAGINA / 2, 21, { align: 'center' });
            doc.setFontSize(8);
            doc.setTextColor(120, 120, 120);
            doc.text(`Fecha: ${fecha}`, ANCHO_PAGINA - 10, 8, { align: 'right' });
            doc.setTextColor(0, 0, 0);

            let y = 30;

            doc.setFillColor(246, 244, 255);
            doc.roundedRect(10, y, 186, 16, 2, 2, 'F');
            doc.setTextColor(120, 120, 120);
            doc.setFontSize(7);
            doc.setFont('helvetica', 'normal');
            doc.text('BENEFICIARIO', 14, y + 5.5);
            doc.setTextColor(20, 20, 20);
            doc.setFontSize(11);
            doc.setFont('helvetica', 'bold');
            doc.text(nombreCompleto, 14, y + 12.2);
            doc.setTextColor(0, 0, 0);

            y += 22;

            for (const seccion of secciones) {
                const titulo = seccion.titulo;
                const tabla = seccion.tabla;
                const tablaParaPdf = prepararTablaParaExportacion(tabla, titulo);
                const dataTabla = obtenerDataTablaParaExport(tablaParaPdf);
                const tituloBarra = formatearTituloExcelSeccion(titulo);

                if (y + 18 > 195) {
                    doc.addPage();
                    y = 15;
                }

                doc.setFillColor(...COLOR_SECCION);
                doc.rect(10, y, 277, 6, 'F');
                doc.setTextColor(255, 255, 255);
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(11);
                doc.text(tituloBarra, ANCHO_PAGINA / 2, y + 4.2, { align: 'center' });
                doc.setTextColor(0, 0, 0);

                doc.autoTable({
                    head: [dataTabla.columnas],
                    body: dataTabla.filas,
                    startY: y + 6,
                    margin: { left: 10, right: 10 },
                    styles: { fontSize: 7.3, cellPadding: 2.3, textColor: [40, 40, 40] },
                    headStyles: { fillColor: COLOR_SECCION, textColor: 255, fontStyle: 'bold', fontSize: 8 },
                    alternateRowStyles: { fillColor: COLOR_FILA_ALTERNA },
                    tableLineColor: [200, 200, 200],
                    tableLineWidth: 0.15,
                    theme: 'grid'
                });

                y = doc.lastAutoTable.finalY + 8;
            }

            const totalPaginas = doc.internal.getNumberOfPages();
            for (let p = 1; p <= totalPaginas; p++) {
                doc.setPage(p);
                doc.setFillColor(237, 231, 255);
                doc.rect(0, 200, ANCHO_PAGINA, 10, 'F');
                doc.setFontSize(7.5);
                doc.setFont('helvetica', 'normal');
                doc.setTextColor(100, 100, 100);
                doc.text('Dirección de Administración de Datos', ANCHO_PAGINA / 2, 206, { align: 'center' });
                doc.text(`Página ${p} de ${totalPaginas}`, ANCHO_PAGINA - 12, 206, { align: 'right' });
            }

            doc.save(`Historial_Cobros_${cedula}.pdf`);
        };

        const img = new Image();
        img.onload = function () {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            canvas.getContext('2d').drawImage(img, 0, 0);
            generarPDF(canvas.toDataURL('image/png'));
        };
        img.onerror = function () { generarPDF(null); };
        img.src = 'logo.png';

    } catch (error) {
        console.error('Error PDF historial:', error);
        alert('Error al generar PDF de historial');
    }
}

async function exportarHistorialExcel() {
    if (!datosGlobales) {
        alert('Primero busque un beneficiario');
        return;
    }

    const secciones = consolidarSeccionesHistorialPorAnio(
        ordenarSeccionesHistorialAsc(obtenerSeccionesHistorialExportacion())
    );
    if (!secciones.length) {
        alert('No hay historial de cobros para exportar');
        return;
    }

    try {
        const wb = new ExcelJS.Workbook();
        wb.creator = 'Ministerio de Desarrollo Humano';
        wb.created = new Date();

        const cedula = document.getElementById('cedula').value || 'Sin_Cedula';
        const fecha = new Date().toLocaleString('es-EC');
        const nombreCompleto = obtenerNombreBeneficiario();
        const ws = wb.addWorksheet('Historial Cobros');
        let fila = 1;

        try {
            const resp = await fetch('logo2.png');
            const blob = await resp.blob();
            const base64 = await new Promise(res => {
                const r = new FileReader();
                r.onload = e => res(e.target.result.split(',')[1]);
                r.readAsDataURL(blob);
            });
            const logoId = wb.addImage({ base64, extension: 'png' });
            ws.addImage(logoId, { tl: { col: 0, row: 0 }, br: { col: 2, row: 4 }, editAs: 'oneCell' });
        } catch (_) { }

        const headerArgb = '5A009D';
        const fillHeader = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + headerArgb } };

        ws.getCell(`A${fila}`).fill = fillHeader;
        ws.getCell(`B${fila}`).fill = fillHeader;
        ws.mergeCells(`C${fila}:N${fila}`);
        const cTitulo = ws.getCell(`C${fila}`);
        cTitulo.value = 'REPORTE HISTORIAL DE COBROS';
        cTitulo.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
        cTitulo.fill = fillHeader;
        cTitulo.alignment = { horizontal: 'center', vertical: 'middle' };
        ws.getRow(fila).height = 26;
        fila++;

        ws.getCell(`A${fila}`).fill = fillHeader;
        ws.getCell(`B${fila}`).fill = fillHeader;
        ws.mergeCells(`C${fila}:N${fila}`);
        const cSub = ws.getCell(`C${fila}`);
        cSub.value = 'Ministerio de Desarrollo Humano - El Nuevo Ecuador';
        cSub.font = { size: 10, color: { argb: 'FFFFFFFF' } };
        cSub.fill = fillHeader;
        cSub.alignment = { horizontal: 'center' };
        ws.getRow(fila).height = 18;
        fila++;

        ws.getCell(`A${fila}`).fill = fillHeader;
        ws.getCell(`B${fila}`).fill = fillHeader;
        ws.mergeCells(`C${fila}:N${fila}`);
        const cFecha = ws.getCell(`C${fila}`);
        cFecha.value = `Fecha: ${fecha}`;
        cFecha.font = { size: 9, italic: true, color: { argb: 'FFDDDDFF' } };
        cFecha.fill = fillHeader;
        cFecha.alignment = { horizontal: 'center' };
        fila++;

        ws.getCell(`A${fila}`).value = 'BENEFICIARIO';
        ws.getCell(`A${fila}`).font = { bold: true, size: 8, color: { argb: 'FF888888' } };
        fila++;

        const cNombre = ws.getCell(`A${fila}`);
        cNombre.value = nombreCompleto;
        cNombre.font = { bold: true, size: 13, color: { argb: 'FF141414' } };
        cNombre.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5FF' } };
        ws.mergeCells(`A${fila}:D${fila}`);
        ws.getRow(fila).height = 22;
        fila++;

        ws.getRow(fila).height = 8;
        fila++;

        for (const seccion of secciones) {
            const titulo = seccion.titulo;
            const tabla = seccion.tabla;
            const colorArgb = '2C168E';
            const colorHeadArgb = '3A1EA4';

            ws.getRow(fila).height = 5;
            fila++;

            const tablaParaExcel = prepararTablaParaExportacion(tabla, titulo);
            const dataTabla = obtenerDataTablaParaExport(tablaParaExcel);
            const filas = [dataTabla.columnas, ...dataTabla.filas];
            const numCols = dataTabla.columnas.length || 1;
            const colFinIdx = Math.min(numCols, 26);
            const colFin = String.fromCharCode(64 + colFinIdx);

            ws.mergeCells(`A${fila}:${colFin}${fila}`);
            const cSec = ws.getCell(`A${fila}`);
            cSec.value = formatearTituloExcelSeccion(titulo);
            cSec.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + colorArgb } };
            cSec.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
            cSec.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
            ws.getRow(fila).height = 24;
            fila++;

            filas.forEach((celdas, rowIdx) => {
                const exRow = ws.getRow(fila);
                const esHead = rowIdx === 0;

                celdas.forEach((valorCelda, colIdx) => {
                    const exCell = exRow.getCell(colIdx + 1);
                    const textoCelda = `${valorCelda || ''}`.trim();
                    exCell.value = esHead ? textoCelda.toUpperCase() : textoCelda;
                    exCell.border = {
                        top: { style: 'thin', color: { argb: 'FFCCCCCC' } },
                        left: { style: 'thin', color: { argb: 'FFCCCCCC' } },
                        bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
                        right: { style: 'thin', color: { argb: 'FFCCCCCC' } }
                    };

                    if (esHead) {
                        exCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + colorHeadArgb } };
                        exCell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
                        exCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
                        exRow.height = 20;
                    } else {
                        const bgFila = rowIdx % 2 === 0 ? 'FFF6F4FF' : 'FFFFFFFF';
                        exCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgFila } };
                        exCell.font = { size: 9 };
                        exCell.alignment = { vertical: 'middle', wrapText: true };
                        exRow.height = 16;
                    }
                });

                fila++;
            });
        }

        ws.columns.forEach(col => {
            let maxLen = 10;
            col.eachCell({ includeEmpty: false }, cell => {
                const len = cell.value ? String(cell.value).length : 0;
                if (len > maxLen) maxLen = len;
            });
            col.width = Math.min(maxLen + 3, 55);
        });

        ws.views = [{ state: 'frozen', ySplit: 5, topLeftCell: 'A6' }];

        const buffer = await wb.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Historial_Cobros_${cedula}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);

    } catch (error) {
        console.error('Error Excel historial:', error);
        alert('Error al generar Excel de historial. Revisa la consola.');
    }
}

function volverInicio() {
    window.location.href = 'index.html';
}

window.addEventListener('DOMContentLoaded', () => {
    const logo = document.querySelector('.logo-header');
    if (logo) {
        logo.addEventListener('error', () => {
            logo.style.display = 'none';
        });
    }

    const fechaPill = document.getElementById('header-fecha');
    if (fechaPill) {
        const ahora = new Date();
        const fechaTexto = ahora.toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        const fechaCapitalizada = fechaTexto.charAt(0).toUpperCase() + fechaTexto.slice(1);
        const calSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="#ffc003" style="flex-shrink:0;vertical-align:middle"><path d="M19 3h-1V1h-2v2H8V1H6v2H5C3.9 3 3 3.9 3 5v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM7 10h5v5H7z"/></svg>`;
        fechaPill.innerHTML = `${calSVG}${fechaCapitalizada}`;
    }

    const btnBuscar = document.getElementById('btn-buscar');
    const btnVolver = document.getElementById('btn-volver');
    const btnPdf = document.getElementById('btn-exportar-pdf');
    const btnExcel = document.getElementById('btn-exportar-excel');

    if (btnBuscar) btnBuscar.addEventListener('click', buscarBeneficiario);
    if (btnVolver) btnVolver.addEventListener('click', volverInicio);
    if (btnPdf) btnPdf.addEventListener('click', exportarPDF);
    if (btnExcel) btnExcel.addEventListener('click', exportarExcel);

    // Si llega cédula desde index, autocompleta y ejecuta la búsqueda una sola vez.
    const params = new URLSearchParams(window.location.search);
    const cedulaDesdeUrl = (params.get('cedula') || '').trim();
    const cedulaInicial = /^\d{10}$/.test(cedulaDesdeUrl) ? cedulaDesdeUrl : leerCedulaDeSesion();
    if (/^\d{10}$/.test(cedulaInicial)) {
        const cedulaInput = document.getElementById('cedula');
        if (cedulaInput) {
            cedulaInput.value = cedulaInicial;
            buscarBeneficiario();
        }
    }
});

document.getElementById('cedula').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') buscarBeneficiario();
});
