-- 160_reporte_personal_equipo_entregas.sql
--
-- Tres secciones del reporte diario dejan de ser campos sueltos y pasan a ser
-- filas: Personal por puesto y por empresa, Equipo con unidades y horas, y
-- Entregas por categoria.
--
-- Cuatro listas del proyecto (que salen solas en cada reporte, como las areas)
-- y tres tablas hijas del reporte (los numeros de ese dia).
--
-- personal_calificado y ayudantes se quedan en proyecto_reportes con sus datos:
-- ningun registro de negocio se borra en duro, y que hacer con los reportes
-- viejos se decide despues.

-- ---------------------------------------------------------------------------
-- Listas del proyecto
-- ---------------------------------------------------------------------------

-- Subcontratistas. El bloque propio (Pinellas) NO es una fila de aqui: es el
-- que se representa con empresa_id NULL en proyecto_puestos.
CREATE TABLE IF NOT EXISTS proyecto_empresas (
  id SERIAL PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  nombre VARCHAR(120) NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado_por INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_proyecto_empresas_proyecto_id
  ON proyecto_empresas(proyecto_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_proyecto_empresas_nombre
  ON proyecto_empresas(proyecto_id, lower(nombre)) WHERE activo;

-- Puestos. empresa_id NULL es el bloque propio; con valor, el de esa empresa.
-- Cada bloque es dueno de sus puestos: quitar uno del bloque propio no le hace
-- nada a los de una empresa, y por eso el unico incluye la empresa.
-- `fijo` marca los cuatro de arranque del bloque propio, que no se quitan.
CREATE TABLE IF NOT EXISTS proyecto_puestos (
  id SERIAL PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  empresa_id INTEGER REFERENCES proyecto_empresas(id) ON DELETE CASCADE,
  nombre VARCHAR(120) NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0,
  fijo BOOLEAN NOT NULL DEFAULT FALSE,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado_por INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_proyecto_puestos_proyecto_id
  ON proyecto_puestos(proyecto_id);

-- COALESCE porque un unico con NULL no compara: sin esto, el bloque propio
-- admitiria "Ayudantes" dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS uq_proyecto_puestos_nombre
  ON proyecto_puestos(proyecto_id, COALESCE(empresa_id, 0), lower(nombre))
  WHERE activo;

-- La maquinaria que el ingeniero escribe en el reporte. OJO: no tiene ninguna
-- relacion con la tabla `equipos` del modulo de equipos ni con las
-- asignaciones. Es texto libre, como se decidio cuando se construyo el reporte.
CREATE TABLE IF NOT EXISTS proyecto_equipos (
  id SERIAL PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  nombre VARCHAR(160) NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado_por INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_proyecto_equipos_proyecto_id
  ON proyecto_equipos(proyecto_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_proyecto_equipos_nombre
  ON proyecto_equipos(proyecto_id, lower(nombre)) WHERE activo;

-- Categorias de entrega. Van por proyecto por decision de Ivan: arrancan con
-- Material, Equipo y Herramienta, y cada obra puede agregar las suyas.
CREATE TABLE IF NOT EXISTS proyecto_entrega_categorias (
  id SERIAL PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  nombre VARCHAR(80) NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado_por INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_proyecto_entrega_categorias_proyecto_id
  ON proyecto_entrega_categorias(proyecto_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_proyecto_entrega_categorias_nombre
  ON proyecto_entrega_categorias(proyecto_id, lower(nombre)) WHERE activo;

-- ---------------------------------------------------------------------------
-- Lo que se llena cada dia
-- ---------------------------------------------------------------------------

-- Cuantos de cada puesto hubo ese dia. Vacio es cero: si no hay fila, es cero.
CREATE TABLE IF NOT EXISTS proyecto_reporte_personal (
  id SERIAL PRIMARY KEY,
  reporte_id INTEGER NOT NULL REFERENCES proyecto_reportes(id) ON DELETE CASCADE,
  puesto_id INTEGER NOT NULL REFERENCES proyecto_puestos(id),
  cantidad INTEGER NOT NULL DEFAULT 0,
  UNIQUE (reporte_id, puesto_id)
);

CREATE INDEX IF NOT EXISTS idx_proyecto_reporte_personal_reporte_id
  ON proyecto_reporte_personal(reporte_id);

-- Unidades y horas de cada equipo ese dia. Las horas del equipo no son las del
-- personal: una maquina puede trabajar 6 horas en un dia de 8.
CREATE TABLE IF NOT EXISTS proyecto_reporte_equipos (
  id SERIAL PRIMARY KEY,
  reporte_id INTEGER NOT NULL REFERENCES proyecto_reportes(id) ON DELETE CASCADE,
  equipo_id INTEGER NOT NULL REFERENCES proyecto_equipos(id),
  unidades INTEGER NOT NULL DEFAULT 0,
  horas NUMERIC(5,2) NOT NULL DEFAULT 0,
  UNIQUE (reporte_id, equipo_id)
);

CREATE INDEX IF NOT EXISTS idx_proyecto_reporte_equipos_reporte_id
  ON proyecto_reporte_equipos(reporte_id);

-- Lo que llego ese dia. A diferencia de las otras dos, aqui no hay lista que
-- salga sola: una entrega es un hecho de ese dia. La unidad es texto libre
-- porque en obra siempre aparece una que nadie previo.
CREATE TABLE IF NOT EXISTS proyecto_reporte_entregas (
  id SERIAL PRIMARY KEY,
  reporte_id INTEGER NOT NULL REFERENCES proyecto_reportes(id) ON DELETE CASCADE,
  categoria_id INTEGER NOT NULL REFERENCES proyecto_entrega_categorias(id),
  descripcion VARCHAR(200) NOT NULL,
  cantidad NUMERIC(12,2),
  unidad VARCHAR(40),
  notas TEXT,
  orden INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_proyecto_reporte_entregas_reporte_id
  ON proyecto_reporte_entregas(reporte_id);

-- ---------------------------------------------------------------------------
-- Siembra de los proyectos que ya existen
-- ---------------------------------------------------------------------------

-- Los cuatro puestos de arranque del bloque propio, en su orden.
INSERT INTO proyecto_puestos (proyecto_id, empresa_id, nombre, orden, fijo)
SELECT p.id, NULL, v.nombre, v.orden, TRUE
  FROM proyectos p
 CROSS JOIN (VALUES
   ('Ingenieros', 1), ('Supervisores', 2), ('Calificados', 3), ('Ayudantes', 4)
 ) AS v(nombre, orden)
 WHERE NOT EXISTS (
   SELECT 1 FROM proyecto_puestos x
    WHERE x.proyecto_id = p.id AND x.empresa_id IS NULL
      AND lower(x.nombre) = lower(v.nombre) AND x.activo
 );

-- Las tres categorias de entrega.
INSERT INTO proyecto_entrega_categorias (proyecto_id, nombre, orden)
SELECT p.id, v.nombre, v.orden
  FROM proyectos p
 CROSS JOIN (VALUES ('Material', 1), ('Equipo', 2), ('Herramienta', 3))
   AS v(nombre, orden)
 WHERE NOT EXISTS (
   SELECT 1 FROM proyecto_entrega_categorias x
    WHERE x.proyecto_id = p.id AND lower(x.nombre) = lower(v.nombre) AND x.activo
 );

-- La lista de equipos se arma sola con lo que el ingeniero ya escribio en los
-- reportes de ese proyecto: nadie tiene que teclear de nuevo lo que ya existe.
INSERT INTO proyecto_equipos (proyecto_id, nombre, orden)
SELECT vistos.proyecto_id, vistos.nombre,
       ROW_NUMBER() OVER (PARTITION BY vistos.proyecto_id ORDER BY vistos.nombre)
  FROM (
    SELECT DISTINCT r.proyecto_id, trim(e) AS nombre
      FROM proyecto_reportes r
     CROSS JOIN LATERAL unnest(COALESCE(r.equipo, ARRAY[]::text[])) AS e
     WHERE r.activo = true AND trim(e) <> ''
  ) AS vistos
 WHERE NOT EXISTS (
   SELECT 1 FROM proyecto_equipos x
    WHERE x.proyecto_id = vistos.proyecto_id
      AND lower(x.nombre) = lower(vistos.nombre) AND x.activo
 );
