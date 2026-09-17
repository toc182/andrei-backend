-- 168_reportes_semanales.sql
-- El reporte semanal de obra.
--
-- Lo hace el mismo ingeniero que manda los diarios, una vez por semana, y sale
-- por correo igual que ellos. No repite el diario: lo resume y le agrega lo que
-- el diario no tiene —las metas de la semana, los problemas con su acción, el
-- plan de la semana que viene y las decisiones que hacen falta—.
--
-- Las decisiones de Ivan que explican esta forma:
--
-- * La semana va de LUNES a DOMINGO y se identifica por su número ISO; el
--   cálculo está en src/services/reporteSemana.ts (y su prueba en
--   scripts/reporte-semana.spec.ts), no en SQL, para que la pantalla, el papel
--   y la base digan todos lo mismo. Igual se guardan `anio_iso` y `semana_iso`
--   ya calculados, porque es por lo que se busca y se ordena.
-- * Hay UN reporte por proyecto y semana, a diferencia del diario, donde dos
--   ingenieros pueden reportar el mismo día.
-- * El reporte se queda como se envió: si después se corrige un diario, el
--   semanal NO cambia. Por eso los números de la semana (personal, equipo,
--   materiales, pagos y la comparación con la semana anterior) se guardan
--   en `datos` al enviarlo, y no se vuelven a calcular al abrirlo.
-- * Al enviarse, la semana queda CERRADA: ningún diario de esos siete días se
--   corrige, se elimina, ni se puede crear uno nuevo con fecha de esa semana.
--   Eso lo hace routes/proyectoReportes.ts con services/semanaCerrada.ts.
-- * La IA solo escribe texto (el resumen y los problemas). Todo número sale de
--   la base.
--
-- Como el diario, nace en borrador: `completo = false` y sin número. El número
-- se asigna al enviarlo, así que un borrador abandonado no gasta ninguno.

CREATE TABLE IF NOT EXISTS proyecto_reportes_semanales (
  id SERIAL PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  -- RS-<prefijo>-YYMMDD del lunes. NULL mientras es borrador.
  numero VARCHAR(40),
  semana_inicio DATE NOT NULL,          -- lunes
  semana_fin DATE NOT NULL,             -- domingo
  anio_iso SMALLINT NOT NULL,
  semana_iso SMALLINT NOT NULL CHECK (semana_iso BETWEEN 1 AND 53),
  -- Lo que escribe el ingeniero (o la IA y él corrige).
  resumen TEXT,
  lo_que_se_espera TEXT,
  -- La foto de los números al enviar. NULL mientras es borrador: hasta
  -- entonces se calculan al vuelo, porque los diarios todavía se mueven.
  datos JSONB,
  completo BOOLEAN NOT NULL DEFAULT FALSE,
  enviado_at TIMESTAMP,
  -- La cola del correo, igual que en el diario (migración 162).
  envio_proximo_intento TIMESTAMP,
  envio_intentos INTEGER NOT NULL DEFAULT 0,
  envio_ultimo_error TEXT,
  envio_avisado BOOLEAN NOT NULL DEFAULT FALSE,
  creado_por INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  activo BOOLEAN NOT NULL DEFAULT TRUE
);

-- El numero es visible para la gente y tiene que seguir siendo unico incluso
-- contra filas dadas de baja, misma disciplina que proyecto_reportes.numero.
CREATE UNIQUE INDEX IF NOT EXISTS uq_proyecto_reportes_semanales_numero
  ON proyecto_reportes_semanales(numero) WHERE numero IS NOT NULL;

-- Un reporte por proyecto y semana, borradores incluidos: volver a «Nuevo
-- reporte semanal» de una semana empezada sigue el mismo, no abre otro.
CREATE UNIQUE INDEX IF NOT EXISTS uq_proyecto_reportes_semanales_semana
  ON proyecto_reportes_semanales(proyecto_id, semana_inicio) WHERE activo;

CREATE INDEX IF NOT EXISTS idx_proyecto_reportes_semanales_proyecto
  ON proyecto_reportes_semanales(proyecto_id, semana_inicio DESC);
CREATE INDEX IF NOT EXISTS idx_proyecto_reportes_semanales_creado_por
  ON proyecto_reportes_semanales(creado_por);

-- Las metas.
--
-- Una meta vive en DOS reportes: nace en el plan de uno y se marca en el
-- siguiente. Por eso las dos columnas:
--
--   reporte_plan_id        el reporte que la planeó. NULL si el ingeniero la
--                          agregó «fuera del plan» al marcar la semana.
--   reporte_evaluacion_id  el reporte donde se marcó cómo quedó. NULL mientras
--                          nadie la haya marcado todavía.
--
-- La cantidad y la unidad son opcionales (decisión de Ivan): una meta puede ser
-- «terminar la tubería sanitaria del bloque A», sin número. De ahí las dos
-- maneras de anotar un avance parcial: `cantidad_hecha` cuando la meta trae
-- cantidad, y `porcentaje` cuando no.
CREATE TABLE IF NOT EXISTS proyecto_reporte_semanal_metas (
  id SERIAL PRIMARY KEY,
  reporte_plan_id INTEGER REFERENCES proyecto_reportes_semanales(id) ON DELETE CASCADE,
  reporte_evaluacion_id INTEGER REFERENCES proyecto_reportes_semanales(id) ON DELETE CASCADE,
  texto VARCHAR(300) NOT NULL,
  cantidad NUMERIC(14,2),
  unidad VARCHAR(20),
  estado VARCHAR(20) CHECK (estado IN ('completada', 'parcial', 'no_completada')),
  cantidad_hecha NUMERIC(14,2),
  porcentaje SMALLINT CHECK (porcentaje BETWEEN 0 AND 100),
  motivo TEXT,
  orden INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- Una meta sin plan y sin evaluación no es de nadie.
  CONSTRAINT chk_meta_pertenece CHECK (
    reporte_plan_id IS NOT NULL OR reporte_evaluacion_id IS NOT NULL
  ),
  -- Marcada quiere decir marcada en algún reporte.
  CONSTRAINT chk_meta_marcada CHECK (
    estado IS NULL OR reporte_evaluacion_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_metas_plan
  ON proyecto_reporte_semanal_metas(reporte_plan_id);
CREATE INDEX IF NOT EXISTS idx_metas_evaluacion
  ON proyecto_reporte_semanal_metas(reporte_evaluacion_id);

-- Los problemas de la semana. El texto lo propone la IA a partir de los
-- diarios; la acción a tomar la escribe siempre el ingeniero.
CREATE TABLE IF NOT EXISTS proyecto_reporte_semanal_problemas (
  id SERIAL PRIMARY KEY,
  reporte_id INTEGER NOT NULL REFERENCES proyecto_reportes_semanales(id) ON DELETE CASCADE,
  -- El día de la semana al que se refiere. NULL si es de toda la semana.
  fecha DATE,
  problema TEXT NOT NULL,
  accion TEXT,
  orden INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_problemas_reporte
  ON proyecto_reporte_semanal_problemas(reporte_id);

-- Las decisiones que el reporte le pide a la oficina.
CREATE TABLE IF NOT EXISTS proyecto_reporte_semanal_decisiones (
  id SERIAL PRIMARY KEY,
  reporte_id INTEGER NOT NULL REFERENCES proyecto_reportes_semanales(id) ON DELETE CASCADE,
  texto TEXT NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_decisiones_reporte
  ON proyecto_reporte_semanal_decisiones(reporte_id);

-- Las fotos son las de los diarios de esa semana: el ingeniero elige hasta 15,
-- no sube ninguna nueva. Se apunta cuál y en qué orden; la foto, su archivo y
-- su leyenda siguen siendo del diario.
CREATE TABLE IF NOT EXISTS proyecto_reporte_semanal_fotos (
  id SERIAL PRIMARY KEY,
  reporte_id INTEGER NOT NULL REFERENCES proyecto_reportes_semanales(id) ON DELETE CASCADE,
  foto_id INTEGER NOT NULL REFERENCES proyecto_reporte_fotos(id) ON DELETE CASCADE,
  orden INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT uq_semanal_fotos UNIQUE (reporte_id, foto_id)
);

CREATE INDEX IF NOT EXISTS idx_semanal_fotos_reporte
  ON proyecto_reporte_semanal_fotos(reporte_id);
