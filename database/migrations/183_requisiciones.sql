-- 183_requisiciones.sql
--
-- La requisicion, hecha de cero. Es el papel que un PROYECTO le manda a la
-- oficina central para que le consiga materiales, servicios o un pago: dice que
-- se necesita, para que y para cuando. La seccion vieja (migraciones 029/030)
-- respondia a otra idea y nunca se uso; Ivan pidio rehacerla sin reusar nada.
-- Decisiones de Ivan, 2026-10-02 al 2026-10-06:
--
--   * La escribe alguien del proyecto (Cecilia) y la aprueba el jefe del
--     proyecto (Hilario), con su contraseña. Mientras no esta aprobada solo la
--     ven quien la escribio, quien la aprueba y los admins; Compras no.
--   * Antes de aprobarse, quien la escribio la puede corregir. Si la corrige el
--     que aprueba, queda aprobada al guardar. Lo que cambie queda anotado.
--   * El que aprueba la puede anular antes de aprobarla. Ya aprobada, solo
--     Martina (Atender) y los admins la "cancelan", marcando sus lineas.
--   * Prioridad y fecha requerida van para toda la requisicion, no por linea.
--   * Cada linea lleva una MARCA que pone Martina: pendiente, atendida, parcial
--     o cancelada. Es solo informativa: no bloquea ni cierra nada.
--   * El renglon del desglose es un texto libre y opcional («3.10, 3.12»): no
--     tiene nada que ver con control de costos.
--   * Las cotizaciones que Martina agrega quedan tambien en Cotizaciones, UNA
--     ENTRADA POR LINEA (son materiales distintos). Una cotizacion que cubre
--     varias lineas va entera, con su total, en la entrada de cada una.

-- ---------------------------------------------------------------------------
-- 1. La seccion vieja se va entera
-- ---------------------------------------------------------------------------
-- Ivan, 2026-10-02: «Borra todo eso. Si encuentras algo ahí, borra.» Es la
-- excepcion explicita a la regla de no borrar registros del negocio, y solo
-- para estas tres tablas. Las solicitudes de pago que apuntaban a una
-- requisicion vieja se quedan; lo unico que pierden es esa referencia. Los
-- gastos que la seccion vieja creaba al «pagar» (proyecto_gastos) no se tocan:
-- son del control de costos, no de la seccion.
UPDATE solicitudes_pago SET requisicion_id = NULL WHERE requisicion_id IS NOT NULL;
ALTER TABLE solicitudes_pago DROP CONSTRAINT IF EXISTS solicitudes_pago_requisicion_id_fkey;
DROP TABLE IF EXISTS requisiciones_historial;
DROP TABLE IF EXISTS requisicion_items;
DROP TABLE IF EXISTS requisiciones;
DELETE FROM audit_log WHERE entidad IN ('requisicion', 'requisiciones');

-- Las dos llaves viejas tambien: requisiciones_ver vuelve a nacer abajo, en
-- false para todos, porque la seccion nueva es otra cosa y nadie la ve hasta
-- que Ivan se la da.
ALTER TABLE user_permissions DROP COLUMN IF EXISTS requisiciones_editar_todas;
ALTER TABLE user_permissions DROP COLUMN IF EXISTS requisiciones_ver;

-- ---------------------------------------------------------------------------
-- 2. Lo que cada proyecto configura
-- ---------------------------------------------------------------------------
-- Quien aprueba sus requisiciones: UNA persona, al lado de los aprobadores de
-- pagos. Sin ella el proyecto no puede crear requisiciones, igual que sin
-- aprobadores no puede crear solicitudes.
--
-- El numero con que arranca: Santa Isabel ya va por la 174 en papel, asi que la
-- primera del sistema es la 175. Se usa solo mientras no haya ninguna mas alta.
ALTER TABLE proyectos
  ADD COLUMN IF NOT EXISTS requisicion_aprobador_id INTEGER REFERENCES users(id);
ALTER TABLE proyectos
  ADD COLUMN IF NOT EXISTS requisicion_numero_inicial INTEGER NOT NULL DEFAULT 1;
ALTER TABLE proyectos DROP CONSTRAINT IF EXISTS proyectos_requisicion_numero_inicial_valido;
ALTER TABLE proyectos
  ADD CONSTRAINT proyectos_requisicion_numero_inicial_valido CHECK (requisicion_numero_inicial >= 1);

-- ---------------------------------------------------------------------------
-- 3. La requisicion
-- ---------------------------------------------------------------------------
-- numero: REQ-<sp_prefijo del proyecto>-NNN, el mismo prefijo de sus solicitudes
-- y ordenes. Se guarda escrito porque el prefijo de un proyecto puede cambiar y
-- una requisicion ya mandada no cambia de nombre; consecutivo es el numero solo,
-- para contar sin desarmar el texto.
--
-- No lleva columna activo: anularla ES quitarla. Dos maneras de borrar algo son
-- dos verdades que algun dia se contradicen.
CREATE TABLE IF NOT EXISTS requisiciones (
  id SERIAL PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id),
  consecutivo INTEGER NOT NULL,
  numero VARCHAR(50) NOT NULL,
  descripcion VARCHAR(300) NOT NULL,
  fecha_requerida DATE NOT NULL,
  prioridad VARCHAR(10) NOT NULL DEFAULT 'normal',
  notas TEXT,
  -- Datos bancarios, opcionales: los alquileres y depositos los traen. Pasan
  -- tal cual a la solicitud de pago que salga de aqui.
  beneficiario VARCHAR(255),
  banco VARCHAR(255),
  tipo_cuenta VARCHAR(20),
  numero_cuenta VARCHAR(100),
  estado VARCHAR(20) NOT NULL DEFAULT 'por_aprobar',
  creado_por INTEGER NOT NULL REFERENCES users(id),
  aprobada_por INTEGER REFERENCES users(id),
  aprobada_at TIMESTAMP WITH TIME ZONE,
  anulada_por INTEGER REFERENCES users(id),
  anulada_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT requisiciones_numero_unico UNIQUE (numero),
  CONSTRAINT requisiciones_consecutivo_unico UNIQUE (proyecto_id, consecutivo),
  CONSTRAINT requisiciones_prioridad_valida CHECK (prioridad IN ('normal', 'urgente')),
  CONSTRAINT requisiciones_estado_valido CHECK (estado IN ('por_aprobar', 'aprobada', 'anulada')),
  CONSTRAINT requisiciones_tipo_cuenta_valido
    CHECK (tipo_cuenta IS NULL OR tipo_cuenta IN ('ahorro', 'corriente')),
  CONSTRAINT requisiciones_consecutivo_valido CHECK (consecutivo >= 1)
);

CREATE INDEX IF NOT EXISTS idx_requisiciones_proyecto_estado ON requisiciones(proyecto_id, estado);
CREATE INDEX IF NOT EXISTS idx_requisiciones_creado_por ON requisiciones(creado_por);
CREATE INDEX IF NOT EXISTS idx_requisiciones_aprobada_por ON requisiciones(aprobada_por);
CREATE INDEX IF NOT EXISTS idx_requisiciones_anulada_por ON requisiciones(anulada_por);
CREATE INDEX IF NOT EXISTS idx_proyectos_requisicion_aprobador ON proyectos(requisicion_aprobador_id);

-- La solicitud de pago que nazca de una requisicion vuelve a apuntarle. La
-- columna ya existia (la usaba la seccion vieja); ahora apunta a la nueva.
ALTER TABLE solicitudes_pago
  ADD CONSTRAINT solicitudes_pago_requisicion_id_fkey
  FOREIGN KEY (requisicion_id) REFERENCES requisiciones(id);

-- ---------------------------------------------------------------------------
-- 4. Sus lineas
-- ---------------------------------------------------------------------------
-- Las lineas se reescriben al corregir una requisicion por aprobar: todavia no
-- tienen marcas ni cotizaciones encima. Ya aprobada no se corrigen; solo se
-- marcan.
CREATE TABLE IF NOT EXISTS requisicion_lineas (
  id SERIAL PRIMARY KEY,
  requisicion_id INTEGER NOT NULL REFERENCES requisiciones(id) ON DELETE CASCADE,
  orden INTEGER NOT NULL,
  cantidad NUMERIC(14,3) NOT NULL,
  unidad VARCHAR(50),
  descripcion VARCHAR(500) NOT NULL,
  renglon_desglose VARCHAR(100),
  marca VARCHAR(12) NOT NULL DEFAULT 'pendiente',
  marca_por INTEGER REFERENCES users(id),
  marca_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT requisicion_lineas_cantidad_valida CHECK (cantidad > 0),
  CONSTRAINT requisicion_lineas_marca_valida
    CHECK (marca IN ('pendiente', 'atendida', 'parcial', 'cancelada'))
);

CREATE INDEX IF NOT EXISTS idx_requisicion_lineas_requisicion ON requisicion_lineas(requisicion_id);
CREATE INDEX IF NOT EXISTS idx_requisicion_lineas_marca_por ON requisicion_lineas(marca_por);

-- ---------------------------------------------------------------------------
-- 5. Los cambios antes de aprobarla
-- ---------------------------------------------------------------------------
-- Mismo patron que orden_compra_cambios: las lineas ya armadas en JSONB
-- ([{campo, antes, despues}]). Aqui no hay motivo obligatorio: lo que se diga,
-- Hilario se lo dice a Cecilia en la oficina (Ivan, 2026-10-03).
CREATE TABLE IF NOT EXISTS requisicion_cambios (
  id SERIAL PRIMARY KEY,
  requisicion_id INTEGER NOT NULL REFERENCES requisiciones(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  cambios JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_requisicion_cambios_requisicion ON requisicion_cambios(requisicion_id);
CREATE INDEX IF NOT EXISTS idx_requisicion_cambios_user ON requisicion_cambios(user_id);

-- ---------------------------------------------------------------------------
-- 6. Adjuntos: los del proyecto y los cuadros comparativos de Compras
-- ---------------------------------------------------------------------------
-- 'adjunto' lo sube el proyecto al escribirla (una foto, un plano, una
-- cotizacion que ya traia). 'cuadro_comparativo' lo sube Compras y se amarra a
-- las lineas que compara. Las cotizaciones NO van aqui: van en
-- requisicion_cotizaciones, porque llevan proveedor y monto.
CREATE TABLE IF NOT EXISTS requisicion_adjuntos (
  id SERIAL PRIMARY KEY,
  requisicion_id INTEGER NOT NULL REFERENCES requisiciones(id) ON DELETE CASCADE,
  tipo VARCHAR(20) NOT NULL DEFAULT 'adjunto',
  nombre_original VARCHAR(255) NOT NULL,
  r2_key VARCHAR(500) NOT NULL,
  tipo_mime VARCHAR(100),
  tamano INTEGER,
  descripcion VARCHAR(255),
  subido_por INTEGER NOT NULL REFERENCES users(id),
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT requisicion_adjuntos_tipo_valido CHECK (tipo IN ('adjunto', 'cuadro_comparativo'))
);

CREATE INDEX IF NOT EXISTS idx_requisicion_adjuntos_requisicion ON requisicion_adjuntos(requisicion_id);
CREATE INDEX IF NOT EXISTS idx_requisicion_adjuntos_subido_por ON requisicion_adjuntos(subido_por);

CREATE TABLE IF NOT EXISTS requisicion_adjunto_lineas (
  adjunto_id INTEGER NOT NULL REFERENCES requisicion_adjuntos(id) ON DELETE CASCADE,
  linea_id INTEGER NOT NULL REFERENCES requisicion_lineas(id) ON DELETE CASCADE,
  PRIMARY KEY (adjunto_id, linea_id)
);

CREATE INDEX IF NOT EXISTS idx_requisicion_adjunto_lineas_linea ON requisicion_adjunto_lineas(linea_id);

-- ---------------------------------------------------------------------------
-- 7. Las cotizaciones de Compras, y su lugar en Cotizaciones
-- ---------------------------------------------------------------------------
-- La cotizacion como la ve la requisicion: un archivo de un proveedor, con su
-- total (opcional) y las lineas que cubre. ESTA fila es la verdad.
--
-- En Cotizaciones se ve como UNA ENTRADA POR LINEA (cotizaciones con
-- requisicion_linea_id), y la cotizacion aparece como una oferta en la entrada
-- de cada linea que cubre (cotizacion_ofertas con requisicion_cotizacion_id),
-- con el mismo proveedor, el mismo total y el mismo archivo. Esas filas las
-- escribe SOLO la requisicion, en la misma transaccion, y Cotizaciones no las
-- deja tocar: asi el buscador, la pestaña «Por proveedor» y los costos las ven
-- sin cambiar nada, y no hay dos lugares desde donde cambiar la misma cotizacion.
--
-- Las lineas que cubre se leen de esas ofertas (cada una vive en la entrada de
-- una linea). No hay otra tabla que lo diga, para que no se puedan separar.
CREATE TABLE IF NOT EXISTS requisicion_cotizaciones (
  id SERIAL PRIMARY KEY,
  requisicion_id INTEGER NOT NULL REFERENCES requisiciones(id) ON DELETE CASCADE,
  proveedor VARCHAR(255) NOT NULL,
  monto NUMERIC(14,2),
  nombre_original VARCHAR(255) NOT NULL,
  r2_key VARCHAR(500) NOT NULL,
  tipo_mime VARCHAR(100),
  tamano INTEGER,
  subido_por INTEGER NOT NULL REFERENCES users(id),
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT requisicion_cotizaciones_monto_valido CHECK (monto IS NULL OR monto >= 0)
);

CREATE INDEX IF NOT EXISTS idx_requisicion_cotizaciones_requisicion ON requisicion_cotizaciones(requisicion_id);
CREATE INDEX IF NOT EXISTS idx_requisicion_cotizaciones_subido_por ON requisicion_cotizaciones(subido_por);

ALTER TABLE cotizaciones
  ADD COLUMN IF NOT EXISTS requisicion_linea_id INTEGER REFERENCES requisicion_lineas(id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cotizaciones_requisicion_linea
  ON cotizaciones(requisicion_linea_id) WHERE requisicion_linea_id IS NOT NULL;

ALTER TABLE cotizacion_ofertas
  ADD COLUMN IF NOT EXISTS requisicion_cotizacion_id INTEGER REFERENCES requisicion_cotizaciones(id);
CREATE INDEX IF NOT EXISTS idx_cotizacion_ofertas_requisicion_cotizacion
  ON cotizacion_ofertas(requisicion_cotizacion_id);

-- ---------------------------------------------------------------------------
-- 8. Las tres llaves nuevas
-- ---------------------------------------------------------------------------
-- Nacen en false para todos, como las de ordenes de compra: la seccion es
-- nueva y Ivan decide a quien se la da. admin y co-admin no miran estas
-- columnas. Quien aprueba no necesita ninguna: lo nombra el proyecto.
--
--   ver      — las aprobadas de sus proyectos.
--   crear    — escribirlas, solo en sus proyectos.
--   atender  — Compras: cotizaciones, cuadros, marcas, y (despues) crear la
--              solicitud de pago o la orden desde la requisicion.
ALTER TABLE user_permissions
  ADD COLUMN IF NOT EXISTS requisiciones_ver BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE user_permissions
  ADD COLUMN IF NOT EXISTS requisiciones_crear BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE user_permissions
  ADD COLUMN IF NOT EXISTS requisiciones_atender BOOLEAN NOT NULL DEFAULT false;
