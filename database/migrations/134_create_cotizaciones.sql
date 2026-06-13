-- 134_create_cotizaciones.sql
--
-- Cotizaciones module: the purchasing team captures supplier quotes so
-- pricing information stops getting lost in email and paper. One
-- cotizacion (request, e.g. "Cemento gris — 100 sacos") holds N
-- cotizacion_ofertas (one per supplier: proveedor, monto, nota), each
-- with N cotizacion_archivos in R2.
--
-- proyecto_id is nullable on purpose: office/general purchases have no
-- project ("Oficina / General" in the UI). tipo is nullable: optional
-- producto|servicio label. proveedor is free text in v1 — supplier
-- normalization (contactos_externos linking) is deferred.
--
-- Soft delete via activo on cotizaciones and cotizacion_ofertas.
-- cotizacion_archivos hard-delete, mirroring solicitud_pago_adjuntos.
-- ON DELETE CASCADE exists only for manual/admin hard deletes; the
-- application path is always soft delete.

CREATE TABLE IF NOT EXISTS cotizaciones (
  id SERIAL PRIMARY KEY,
  descripcion VARCHAR(255) NOT NULL,
  descripcion_larga TEXT,
  tipo VARCHAR(20) CHECK (tipo IN ('producto', 'servicio')),
  proyecto_id INTEGER REFERENCES proyectos(id),
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado_por INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cotizacion_ofertas (
  id SERIAL PRIMARY KEY,
  cotizacion_id INTEGER NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
  proveedor VARCHAR(255) NOT NULL,
  monto DECIMAL(12,2),
  nota TEXT,
  elegida BOOLEAN NOT NULL DEFAULT FALSE,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado_por INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cotizacion_archivos (
  id SERIAL PRIMARY KEY,
  oferta_id INTEGER NOT NULL REFERENCES cotizacion_ofertas(id) ON DELETE CASCADE,
  nombre_original TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  tipo_mime VARCHAR(100),
  tamano INTEGER,
  subido_por INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cotizaciones_activo_created
  ON cotizaciones (activo, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cotizaciones_proyecto
  ON cotizaciones (proyecto_id);
CREATE INDEX IF NOT EXISTS idx_cotizacion_ofertas_cotizacion
  ON cotizacion_ofertas (cotizacion_id);
CREATE INDEX IF NOT EXISTS idx_cotizacion_archivos_oferta
  ON cotizacion_archivos (oferta_id);

-- DB-level guarantee: at most one elegida activa per cotizacion. The
-- eleccion endpoint clears-then-sets inside a transaction; this index
-- is the backstop against concurrent updates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cotizacion_ofertas_unica_elegida
  ON cotizacion_ofertas (cotizacion_id) WHERE elegida = TRUE AND activo = TRUE;

-- Granular permission for rol 'usuario' (admin/co-admin bypass)
ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS cotizaciones BOOLEAN DEFAULT FALSE;
