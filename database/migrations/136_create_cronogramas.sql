-- 136_create_cronogramas.sql
--
-- Cronograma module: a project schedule (Gantt) ported from the standalone
-- Gantto tool. A `cronograma` is a first-class entity that OPTIONALLY attaches
-- to a project (proyecto_id nullable -> standalone cronogramas exist). A project
-- may have several cronogramas (no unique constraint on proyecto_id).
--
-- proyecto_id is ON DELETE SET NULL on purpose: if a project is ever hard-deleted
-- the schedule survives as a standalone cronograma rather than being destroyed
-- (the app path soft-deletes projects, so this is a safety net, not the norm).
--
-- Persisted state is {config (cronogramas row), tasks (cronograma_tareas),
-- dependencies (cronograma_dependencias)}. The COMPUTED schedule (each task's
-- start/finish dates, group rollup, critical path, violations) is NEVER stored
-- -- it is recomputed by the scheduling engine on every read. UI-only state
-- (collapse/zoom/overlay toggles) lives in the browser, never in the DB.
--
-- Soft delete via activo on cronogramas. Child rows hard-delete via CASCADE
-- (the whole task tree + edges belong to one cronograma); the application path
-- soft-deletes the cronograma and replaces children inside a transaction.

CREATE TABLE IF NOT EXISTS cronogramas (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(255) NOT NULL,
  proyecto_id INTEGER REFERENCES proyectos(id) ON DELETE SET NULL,  -- NULLABLE: standalone allowed
  fecha_inicio DATE NOT NULL,                                       -- engine project.startDate
  semana_laboral SMALLINT NOT NULL DEFAULT 5                        -- engine workWeek
    CHECK (semana_laboral IN (5, 6, 7)),
  feriados JSONB NOT NULL DEFAULT '[]'::jsonb,                       -- ["YYYY-MM-DD", ...] engine holidays
  baseline JSONB,                                                   -- {capturedAt, bars:{taskId:{s,f}}} or NULL
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado_por INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cronograma_tareas (
  id SERIAL PRIMARY KEY,
  cronograma_id INTEGER NOT NULL REFERENCES cronogramas(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES cronograma_tareas(id) ON DELETE CASCADE,  -- WBS nesting, nullable
  tipo VARCHAR(12) NOT NULL DEFAULT 'task'
    CHECK (tipo IN ('task', 'group', 'milestone')),
  tipo_hito VARCHAR(12)                                                  -- only for milestones
    CHECK (tipo_hito IN ('calculated', 'fixed')),
  nombre VARCHAR(500) NOT NULL,
  duracion INTEGER NOT NULL DEFAULT 0,                                   -- working days (task only)
  fecha_manual DATE,                                                     -- manualDate: "no antes de" / fixed milestone date
  porcentaje_completado SMALLINT NOT NULL DEFAULT 0
    CHECK (porcentaje_completado BETWEEN 0 AND 100),
  color VARCHAR(9),                                                      -- "#RRGGBB" or NULL (default)
  notas TEXT,
  orden DOUBLE PRECISION NOT NULL DEFAULT 0,                             -- DOUBLE: fractional reorder inserts (+0.5)
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cronograma_dependencias (
  id SERIAL PRIMARY KEY,
  cronograma_id INTEGER NOT NULL REFERENCES cronogramas(id) ON DELETE CASCADE,
  tarea_id INTEGER NOT NULL REFERENCES cronograma_tareas(id) ON DELETE CASCADE,        -- successor
  predecesora_id INTEGER NOT NULL REFERENCES cronograma_tareas(id) ON DELETE CASCADE,  -- predecessor
  tipo VARCHAR(2) NOT NULL DEFAULT 'FS'
    CHECK (tipo IN ('FS', 'SS', 'FF', 'SF')),
  lag INTEGER NOT NULL DEFAULT 0,                                        -- working-day lag (may be negative)
  CHECK (tarea_id <> predecesora_id),
  UNIQUE (tarea_id, predecesora_id)
);

CREATE INDEX IF NOT EXISTS idx_cronogramas_activo_created
  ON cronogramas (activo, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cronogramas_proyecto
  ON cronogramas (proyecto_id);
CREATE INDEX IF NOT EXISTS idx_cronograma_tareas_crono
  ON cronograma_tareas (cronograma_id);
CREATE INDEX IF NOT EXISTS idx_cronograma_tareas_parent
  ON cronograma_tareas (parent_id);
CREATE INDEX IF NOT EXISTS idx_cronograma_deps_crono
  ON cronograma_dependencias (cronograma_id);
CREATE INDEX IF NOT EXISTS idx_cronograma_deps_tarea
  ON cronograma_dependencias (tarea_id);

-- Granular permission for rol 'usuario' (admin/co-admin bypass). Added now but NOT
-- yet consulted: v1 is gated by EMAIL (only ivan@pinellaspanama.com) because the
-- permission system can't hide a feature from other admins. Flipping the gate to
-- this column later is a one-line change in canUseCronogramas (both repos).
ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS cronogramas_ver BOOLEAN DEFAULT FALSE;
