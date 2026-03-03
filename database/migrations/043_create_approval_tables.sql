-- Tabla de aprobadores configurados por proyecto
CREATE TABLE IF NOT EXISTS project_approval_settings (
  id SERIAL PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  orden INTEGER NOT NULL,
  activo BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(proyecto_id, user_id),
  UNIQUE(proyecto_id, orden)
);

CREATE INDEX IF NOT EXISTS idx_pas_proyecto ON project_approval_settings(proyecto_id);

-- Tabla de aprobaciones de solicitudes individuales
CREATE TABLE IF NOT EXISTS solicitud_aprobaciones (
  id SERIAL PRIMARY KEY,
  solicitud_pago_id INTEGER NOT NULL REFERENCES solicitudes_pago(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  orden INTEGER NOT NULL,
  accion VARCHAR NOT NULL,
  comentario TEXT,
  fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sa_accion_check CHECK (accion IN ('aprobado', 'rechazado'))
);

CREATE INDEX IF NOT EXISTS idx_sa_solicitud ON solicitud_aprobaciones(solicitud_pago_id);
