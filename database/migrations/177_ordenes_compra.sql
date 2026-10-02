-- 177_ordenes_compra.sql
--
-- La compra por ORDEN DE COMPRA, a credito. Hasta hoy una compra solo existia
-- cuando se pagaba; ahora entra el dia que se le manda la orden al proveedor.
-- Decisiones de Ivan (2026-09-23 al 2026-09-30):
--
--   * La orden es un registro propio, no una solicitud de pago. Vive en la
--     seccion Pagos, en su propia pestana al lado de las solicitudes.
--   * SE PAGA LO QUE SE VA RECIBIENDO. Una orden de 90 dias con un proveedor
--     que despacha por partes no se debe completa el primer dia: lo que se
--     debe es lo retirado. Por eso cada ENTREGA es una fila con su propia
--     fecha de vencimiento, y lo que falta por retirar no es deuda ni costo.
--   * El termino de pago corre desde CADA entrega, por separado.
--   * Un pago se amarra a entregas concretas (solicitud_pago_entregas), no al
--     saldo suelto de la orden: si fuera un monto suelto no sabria cual reloj
--     esta parando.
--   * El sistema no le manda correo al proveedor. Martina baja el PDF y lo
--     manda ella; de ahi el estado 'por_enviar' y que ella marque 'enviada'.
--   * Una orden ya enviada solo la edita un admin, y cada cambio queda en
--     orden_compra_cambios con su motivo.
--
-- Nada de esto reemplaza a las solicitudes de pago: el pago sigue saliendo por
-- la cadena de aprobadores del proyecto, tal como hoy.

-- ---------------------------------------------------------------------------
-- La orden
-- ---------------------------------------------------------------------------
-- numero: OC-<sp_prefijo del proyecto>-NNN. Reusa el prefijo que el proyecto
-- ya tiene para sus solicitudes (ET, CHIL, PC...), asi que un proyecto sin
-- prefijo configurado no puede emitir ordenes, igual que hoy no puede emitir
-- solicitudes.
--
-- itbms_tasa se guarda en la fila y no en el codigo porque cada entrega
-- calcula su propio ITBMS: con la tasa aqui, una orden vieja sigue cuadrando
-- si el impuesto cambia, y las dos cuentas (orden y entrega) salen del mismo
-- numero.
--
-- No se guardan 'recibido' ni 'pagado': se suman de las entregas y de las
-- solicitudes. Un total repetido en dos lados es un total que algun dia va a
-- mentir.
CREATE TABLE IF NOT EXISTS ordenes_compra (
  id SERIAL PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id),
  numero VARCHAR(50) NOT NULL UNIQUE,
  fecha DATE NOT NULL DEFAULT CURRENT_DATE,
  proveedor VARCHAR(255) NOT NULL,
  proveedor_ruc VARCHAR(100),
  categoria_id INTEGER REFERENCES categorias_gastos(id),
  termino_dias INTEGER NOT NULL DEFAULT 30,
  entrega VARCHAR(20) NOT NULL DEFAULT 'sitio',
  condiciones TEXT,
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
  descuento NUMERIC(14,2) NOT NULL DEFAULT 0,
  itbms_tasa NUMERIC(6,4) NOT NULL DEFAULT 0.07,
  itbms NUMERIC(14,2) NOT NULL DEFAULT 0,
  monto_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
  codigo_verificacion VARCHAR(20) NOT NULL UNIQUE,
  observaciones TEXT,
  creado_por INTEGER NOT NULL REFERENCES users(id),
  enviada_por INTEGER REFERENCES users(id),
  enviada_at TIMESTAMP WITH TIME ZONE,
  baja_motivo TEXT,
  baja_por INTEGER REFERENCES users(id),
  baja_at TIMESTAMP WITH TIME ZONE,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Aqui solo viven los estados que ALGUIEN decide. 'entrega_parcial' y
  -- 'recibida' no estan porque no son decisiones: son la consecuencia de lo que
  -- dicen las entregas, y se calculan al leer. Guardarlos obligaria a
  -- recalcularlos desde el registro de una entrega, desde el pago de una
  -- solicitud y desde el rechazo de una solicitud; el dia que se olvide uno de
  -- los tres, la lista miente y nadie se entera. La pantalla sigue mostrando
  -- los ocho estados de siempre.
  --
  -- 'cerrada' si se guarda: es un punto final, y a veces hay que ponerlo a mano
  -- cuando quedan centavos de redondeo del ITBMS que ya nadie va a pagar.
  CONSTRAINT ordenes_compra_estado_valido CHECK (estado IN (
    'pendiente',        -- esperando las aprobaciones del proyecto
    'rechazada',        -- un aprobador la rechazo; nunca llega al proveedor
    'por_enviar',       -- aprobada, esperando que Martina la mande
    'enviada',          -- Martina la marco como mandada
    'cerrada',          -- no queda nada por pagar
    'dada_de_baja'      -- se mato despues de enviarla
  )),
  CONSTRAINT ordenes_compra_entrega_valida CHECK (entrega IN ('sitio', 'local')),
  CONSTRAINT ordenes_compra_termino_valido CHECK (termino_dias >= 0)
);

CREATE INDEX IF NOT EXISTS idx_ordenes_compra_proyecto ON ordenes_compra(proyecto_id);
CREATE INDEX IF NOT EXISTS idx_ordenes_compra_estado ON ordenes_compra(estado);
CREATE INDEX IF NOT EXISTS idx_ordenes_compra_proveedor ON ordenes_compra(proveedor);
CREATE INDEX IF NOT EXISTS idx_ordenes_compra_codigo_verificacion
  ON ordenes_compra(codigo_verificacion);

-- ---------------------------------------------------------------------------
-- Los renglones de la orden: lo que se pidio
-- ---------------------------------------------------------------------------
-- cantidad con 3 decimales porque se compra por m3 y por tonelada, y lo que
-- llega no siempre es un numero redondo.
CREATE TABLE IF NOT EXISTS orden_compra_items (
  id SERIAL PRIMARY KEY,
  orden_compra_id INTEGER NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
  cantidad NUMERIC(14,3) NOT NULL DEFAULT 1,
  unidad VARCHAR(50) NOT NULL DEFAULT 'unidad',
  codigo VARCHAR(100),
  descripcion VARCHAR(500) NOT NULL,
  precio_unitario NUMERIC(14,4) NOT NULL,
  precio_total NUMERIC(14,2) NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT orden_compra_items_cantidad_valida CHECK (cantidad > 0)
);

CREATE INDEX IF NOT EXISTS idx_orden_compra_items_orden
  ON orden_compra_items(orden_compra_id);

-- ---------------------------------------------------------------------------
-- Las entregas: lo que de verdad llego, y cuando hay que pagarlo
-- ---------------------------------------------------------------------------
-- vence se CONGELA al registrar la entrega (fecha + termino_dias de ese
-- momento). Si manana un admin cambia el termino de la orden, lo que ya se
-- recibio no cambia de fecha de pago: el proveedor y Pinellas ya quedaron en
-- una fecha.
--
-- Cada entrega calcula su propio ITBMS con la tasa de la orden. La suma de los
-- ITBMS de las entregas puede quedar a centavos del ITBMS de la orden: el
-- numero que se paga es el de la entrega, y el de la orden es la estimacion
-- del total. Sin esta regla una orden se queda a un centavo de cerrar para
-- siempre.
CREATE TABLE IF NOT EXISTS orden_compra_entregas (
  id SERIAL PRIMARY KEY,
  orden_compra_id INTEGER NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
  fecha DATE NOT NULL,
  vence DATE NOT NULL,
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
  itbms NUMERIC(14,2) NOT NULL DEFAULT 0,
  monto_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  nota TEXT,
  registrada_por INTEGER NOT NULL REFERENCES users(id),
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orden_compra_entregas_orden
  ON orden_compra_entregas(orden_compra_id);
CREATE INDEX IF NOT EXISTS idx_orden_compra_entregas_vence
  ON orden_compra_entregas(vence);

-- Cuanto llego de cada renglon en esa entrega. precio_unitario se congela
-- tambien: si el precio de la orden se corrige despues, lo ya recibido
-- conserva el valor con que entro al costo del proyecto.
CREATE TABLE IF NOT EXISTS orden_compra_entrega_items (
  id SERIAL PRIMARY KEY,
  entrega_id INTEGER NOT NULL REFERENCES orden_compra_entregas(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES orden_compra_items(id),
  cantidad NUMERIC(14,3) NOT NULL,
  precio_unitario NUMERIC(14,4) NOT NULL,
  precio_total NUMERIC(14,2) NOT NULL,
  CONSTRAINT orden_compra_entrega_items_cantidad_valida CHECK (cantidad > 0),
  CONSTRAINT orden_compra_entrega_items_una_vez UNIQUE (entrega_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_orden_compra_entrega_items_entrega
  ON orden_compra_entrega_items(entrega_id);
CREATE INDEX IF NOT EXISTS idx_orden_compra_entrega_items_item
  ON orden_compra_entrega_items(item_id);

-- ---------------------------------------------------------------------------
-- Adjuntos: la cotizacion de la orden y el documento de cada entrega
-- ---------------------------------------------------------------------------
-- entrega_id NULL = el archivo es de la orden (la cotizacion, el acuerdo de
-- credito). Con entrega_id = es el documento formal de esa entrega, el que en
-- campo se firma al recibir. Cada archivo lleva su descripcion escrita a mano,
-- porque el nombre del archivo del telefono no dice nada.
CREATE TABLE IF NOT EXISTS orden_compra_adjuntos (
  id SERIAL PRIMARY KEY,
  orden_compra_id INTEGER NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
  entrega_id INTEGER REFERENCES orden_compra_entregas(id) ON DELETE CASCADE,
  nombre_original VARCHAR(255) NOT NULL,
  r2_key VARCHAR(500) NOT NULL,
  tipo_mime VARCHAR(100),
  tamano INTEGER,
  descripcion VARCHAR(255),
  subido_por INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orden_compra_adjuntos_orden
  ON orden_compra_adjuntos(orden_compra_id);
CREATE INDEX IF NOT EXISTS idx_orden_compra_adjuntos_entrega
  ON orden_compra_adjuntos(entrega_id);

-- ---------------------------------------------------------------------------
-- Aprobaciones de la orden
-- ---------------------------------------------------------------------------
-- Misma forma que solicitud_aprobaciones, en su propia tabla. La CADENA de
-- aprobadores se reusa tal cual (proyecto_ajustes_aprobacion): son las mismas
-- personas en el mismo orden. Lo que no se comparte es el registro de quien
-- firmo que, porque volver polimorfica a solicitud_aprobaciones tocaria todas
-- las consultas de aprobacion del sistema. El costo es dos tablas parecidas.
CREATE TABLE IF NOT EXISTS orden_compra_aprobaciones (
  id SERIAL PRIMARY KEY,
  orden_compra_id INTEGER NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  orden INTEGER NOT NULL,
  accion VARCHAR(20) NOT NULL,
  comentario TEXT,
  fecha TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT orden_compra_aprobaciones_accion_valida
    CHECK (accion IN ('aprobado', 'rechazado'))
);

CREATE INDEX IF NOT EXISTS idx_orden_compra_aprobaciones_orden
  ON orden_compra_aprobaciones(orden_compra_id);
CREATE INDEX IF NOT EXISTS idx_orden_compra_aprobaciones_user
  ON orden_compra_aprobaciones(user_id);

-- ---------------------------------------------------------------------------
-- Cambios despues de enviarla
-- ---------------------------------------------------------------------------
-- Mismo patron que las correcciones del reporte semanal: las lineas ya armadas
-- en JSONB ([{campo, antes, despues}]), mas el motivo, que es obligatorio. Un
-- registro que dice que cambio pero no por que no sirve de nada seis meses
-- despues.
CREATE TABLE IF NOT EXISTS orden_compra_cambios (
  id SERIAL PRIMARY KEY,
  orden_compra_id INTEGER NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  motivo TEXT NOT NULL,
  cambios JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orden_compra_cambios_orden
  ON orden_compra_cambios(orden_compra_id);

-- ---------------------------------------------------------------------------
-- El puente con la solicitud de pago
-- ---------------------------------------------------------------------------
-- orden_compra_id en la solicitud es para listar y para abrir la orden desde
-- el pago. El monto por entrega vive en solicitud_pago_entregas, que es lo que
-- de verdad manda: una solicitud puede cubrir varias entregas, y de cada una
-- puede pagar solo una parte.
ALTER TABLE solicitudes_pago
  ADD COLUMN IF NOT EXISTS orden_compra_id INTEGER REFERENCES ordenes_compra(id);

CREATE INDEX IF NOT EXISTS idx_solicitudes_pago_orden_compra
  ON solicitudes_pago(orden_compra_id);

CREATE TABLE IF NOT EXISTS solicitud_pago_entregas (
  id SERIAL PRIMARY KEY,
  solicitud_pago_id INTEGER NOT NULL REFERENCES solicitudes_pago(id) ON DELETE CASCADE,
  entrega_id INTEGER NOT NULL REFERENCES orden_compra_entregas(id),
  monto NUMERIC(14,2) NOT NULL,
  CONSTRAINT solicitud_pago_entregas_monto_valido CHECK (monto > 0),
  CONSTRAINT solicitud_pago_entregas_una_vez UNIQUE (solicitud_pago_id, entrega_id)
);

CREATE INDEX IF NOT EXISTS idx_solicitud_pago_entregas_solicitud
  ON solicitud_pago_entregas(solicitud_pago_id);
CREATE INDEX IF NOT EXISTS idx_solicitud_pago_entregas_entrega
  ON solicitud_pago_entregas(entrega_id);

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
-- Las dos llaves nuevas nacen en false para todo el mundo, a diferencia de las
-- llaves de seccion de la migracion 159: esas se pusieron en true porque las
-- secciones ya existian y apagarlas le habria quitado el trabajo a la gente a
-- media marcha. Las ordenes de compra no existian ayer, asi que nadie pierde
-- nada. admin y co-admin no miran estas columnas.
--
-- ordenes_entregas ademas pasa por checkProjectAccess en su ruta: registrar
-- una entrega es cosa del ingeniero del proyecto, no de cualquiera.
ALTER TABLE user_permissions
  ADD COLUMN IF NOT EXISTS ordenes_ver BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE user_permissions
  ADD COLUMN IF NOT EXISTS ordenes_entregas BOOLEAN NOT NULL DEFAULT false;
