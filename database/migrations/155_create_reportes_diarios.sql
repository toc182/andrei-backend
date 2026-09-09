-- 155_create_reportes_diarios.sql
-- Reportes diarios de obra. Reemplazan a la Bitácora como el registro diario
-- de cada proyecto. Las tablas proyecto_bitacora* se quedan en su sitio
-- (ningún registro de negocio se borra en duro) pero ya nada las lee.

-- Áreas de trabajo de un proyecto ("Área de chorros", "Torre péndulo").
-- Van por proyecto porque son zonas físicas de una obra concreta.
CREATE TABLE IF NOT EXISTS proyecto_areas (
  id SERIAL PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  nombre VARCHAR(120) NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado_por INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_proyecto_areas_proyecto_id
  ON proyecto_areas(proyecto_id);

-- Un nombre de área no se repite dentro de un proyecto mientras esté activa.
CREATE UNIQUE INDEX IF NOT EXISTS uq_proyecto_areas_nombre
  ON proyecto_areas(proyecto_id, lower(nombre)) WHERE activo;

-- El reporte.
CREATE TABLE IF NOT EXISTS proyecto_reportes (
  id SERIAL PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  numero VARCHAR(40) NOT NULL,
  fecha DATE NOT NULL,
  clima VARCHAR(30) NOT NULL,
  horas_perdidas NUMERIC(4,1),
  motivo TEXT,
  personal_calificado INTEGER NOT NULL DEFAULT 0,
  ayudantes INTEGER NOT NULL DEFAULT 0,
  equipo TEXT[] NOT NULL DEFAULT '{}',
  que_se_hizo TEXT NOT NULL,
  atrasos TEXT,
  novedades TEXT,
  creado_por INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT chk_proyecto_reportes_clima CHECK (
    clima IN ('Soleado', 'Nublado', 'Lluvia parcial', 'Lluvia todo el día')
  ),
  CONSTRAINT chk_proyecto_reportes_horas CHECK (
    horas_perdidas IS NULL OR (horas_perdidas >= 0 AND horas_perdidas <= 24)
  )
);

-- numero es una secuencia visible para la gente; tiene que seguir siendo
-- única incluso contra filas dadas de baja, misma disciplina que
-- solicitudes_pago.numero.
CREATE UNIQUE INDEX IF NOT EXISTS uq_proyecto_reportes_numero
  ON proyecto_reportes(numero);
CREATE INDEX IF NOT EXISTS idx_proyecto_reportes_proyecto_id
  ON proyecto_reportes(proyecto_id);
CREATE INDEX IF NOT EXISTS idx_proyecto_reportes_fecha
  ON proyecto_reportes(proyecto_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_proyecto_reportes_creado_por
  ON proyecto_reportes(creado_por);

-- Nota deliberada: NO hay índice único sobre (proyecto_id, fecha). Se decidió
-- no limitar a un reporte por día, porque el caso de vacaciones o enfermedad
-- obligaría a decidir de quién es el día. Los repetidos se distinguen por el
-- sufijo del numero (RD-PB-260908-2).

-- Qué áreas tocó un reporte.
CREATE TABLE IF NOT EXISTS proyecto_reporte_areas (
  reporte_id INTEGER NOT NULL REFERENCES proyecto_reportes(id) ON DELETE CASCADE,
  area_id INTEGER NOT NULL REFERENCES proyecto_areas(id) ON DELETE CASCADE,
  PRIMARY KEY (reporte_id, area_id)
);

CREATE INDEX IF NOT EXISTS idx_proyecto_reporte_areas_area_id
  ON proyecto_reporte_areas(area_id);

-- Fotos, guardadas en R2 igual que proyecto_bitacora_adjuntos.
CREATE TABLE IF NOT EXISTS proyecto_reporte_fotos (
  id SERIAL PRIMARY KEY,
  reporte_id INTEGER NOT NULL REFERENCES proyecto_reportes(id) ON DELETE CASCADE,
  nombre_archivo VARCHAR(255) NOT NULL,
  r2_key VARCHAR(500) NOT NULL,
  tipo_mime VARCHAR(100),
  tamano INTEGER,
  orden INTEGER NOT NULL DEFAULT 0,
  creado_por INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_proyecto_reporte_fotos_reporte_id
  ON proyecto_reporte_fotos(reporte_id);
