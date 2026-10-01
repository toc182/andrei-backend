-- 179_asistente_lectura.sql
--
-- Lo que el asistente de WhatsApp puede preguntarle a la base por su cuenta.
-- Decision de Ivan del 2026-10-01: pregunto cuantos dias de calificado iban en
-- Playa Blanca y el asistente no supo, porque solo le llegaba un resumen con
-- promedios. En vez de agregarle al resumen un total por cada pregunta nueva,
-- el asistente escribe su propia consulta y la base hace la cuenta.
--
-- El asistente no ve las tablas del sistema: ve SOLO las vistas de este
-- esquema, hechas para que contar sea facil —una fila por cosa, y cada una con
-- su obra y su fecha, para que casi ninguna pregunta necesite juntar dos—.
-- Agregar otra parte del sistema (presupuestos, costos) es agregar vistas aqui:
-- el asistente lee la lista y sus descripciones de la base misma.
--
-- QUE OBRAS VE. Las mismas que en la pantalla. El sistema escribe en
-- asistente.acceso las obras de esa persona, marcadas con el numero de la
-- conexion que va a hacer la consulta (pg_backend_pid), y cada vista filtra por
-- ese numero. La conexion del asistente no puede escribir en esa tabla ni
-- inventarse otro numero, asi que nada de lo que escriba en su consulta le
-- abre una obra ajena.

CREATE SCHEMA IF NOT EXISTS asistente;

CREATE TABLE IF NOT EXISTS asistente.acceso (
  pid INTEGER NOT NULL,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  PRIMARY KEY (pid, proyecto_id)
);

-- Para buscar en lo escrito sin que importen tildes ni mayusculas:
-- asistente.llano(texto) LIKE '%tuberia%'. Lo mismo que hace llano() en el
-- codigo del asistente.
CREATE OR REPLACE FUNCTION asistente.llano(texto TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT translate(lower(texto), 'áéíóúüñ', 'aeiouun') $$;

-- security_barrier: ninguna condicion de la consulta del asistente se evalua
-- antes que el filtro de obras de la vista.

CREATE OR REPLACE VIEW asistente.obras WITH (security_barrier) AS
SELECT p.id AS obra_id,
       COALESCE(NULLIF(p.nombre_corto, ''), p.nombre) AS obra,
       p.nombre AS nombre_completo,
       p.estado,
       c.nombre AS cliente,
       p.fecha_inicio,
       p.fecha_fin_estimada,
       CASE WHEN COALESCE(p.datos_adicionales->'es_consorcio' = 'true'::jsonb, false)
            THEN COALESCE(NULLIF(TRIM(p.contratista), ''), 'Consorcio')
            ELSE 'Pinellas' END AS cuadrilla_propia
  FROM proyectos p
  LEFT JOIN clientes c ON c.id = p.cliente_id
 WHERE p.id IN (SELECT a.proyecto_id FROM asistente.acceso a WHERE a.pid = pg_backend_pid());

COMMENT ON VIEW asistente.obras IS
  'Las obras (proyectos) que esta persona puede ver. obra = el nombre corto, el que se usa al hablar.';
COMMENT ON COLUMN asistente.obras.cuadrilla_propia IS
  'Como se llama la gente y las maquinas propias en esa obra: Pinellas, o el consorcio si la obra es en consorcio.';

-- Solo los reportes enviados (completo) y no eliminados (activo): un borrador
-- no es un reporte.
CREATE OR REPLACE VIEW asistente.reportes WITH (security_barrier) AS
SELECT r.id AS reporte_id,
       r.proyecto_id AS obra_id,
       o.obra,
       r.numero,
       r.fecha,
       r.clima,
       COALESCE(r.horas_perdidas, 0) AS horas_perdidas,
       r.motivo AS motivo_horas_perdidas,
       r.atrasos,
       r.novedades,
       u.nombre AS escrito_por,
       COALESCE(
         (SELECT SUM(pp.cantidad) FROM proyecto_reporte_personal pp WHERE pp.reporte_id = r.id),
         COALESCE(r.personal_calificado, 0) + COALESCE(r.ayudantes, 0)
       )::integer AS personas,
       (SELECT COUNT(*) FROM proyecto_reporte_fotos f WHERE f.reporte_id = r.id)::integer AS fotos
  FROM proyecto_reportes r
  JOIN asistente.obras o ON o.obra_id = r.proyecto_id
  LEFT JOIN users u ON u.id = r.creado_por
 WHERE r.activo AND r.completo;

COMMENT ON VIEW asistente.reportes IS
  'Un reporte diario enviado por fila (los borradores y los eliminados no estan). fecha = el dia que cuenta el reporte. Un dia de una obra tiene a lo sumo un reporte.';
COMMENT ON COLUMN asistente.reportes.clima IS
  'Soleado, Nublado, Lluvia parcial o Lluvia todo el dia.';
COMMENT ON COLUMN asistente.reportes.horas_perdidas IS
  'Horas de trabajo perdidas ese dia (0 si ninguna); el motivo va en motivo_horas_perdidas.';
COMMENT ON COLUMN asistente.reportes.atrasos IS 'Lo que atraso o paro el trabajo ese dia, como lo escribio el ingeniero.';
COMMENT ON COLUMN asistente.reportes.novedades IS 'Otras novedades del dia, como las escribio el ingeniero.';
COMMENT ON COLUMN asistente.reportes.personas IS
  'Total de gente que trabajo ese dia, todos los puestos juntos. El detalle por puesto esta en reporte_personal.';
COMMENT ON COLUMN asistente.reportes.fotos IS 'Cuantas fotos lleva el reporte.';

-- La gente: de la tabla por puesto o, en los reportes del formato anterior,
-- de sus dos columnas (calificados y ayudantes). Los puestos en cero no
-- aparecen, para que contar filas sea contar dias con gente de ese puesto.
CREATE OR REPLACE VIEW asistente.reporte_personal WITH (security_barrier) AS
SELECT r.reporte_id, r.obra_id, r.obra, r.fecha,
       pu.nombre AS puesto,
       COALESCE(e.nombre, o.cuadrilla_propia) AS empresa,
       (pu.empresa_id IS NULL) AS es_cuadrilla_propia,
       pp.cantidad,
       false AS reporte_de_antes
  FROM asistente.reportes r
  JOIN asistente.obras o ON o.obra_id = r.obra_id
  JOIN proyecto_reporte_personal pp ON pp.reporte_id = r.reporte_id
  JOIN proyecto_puestos pu ON pu.id = pp.puesto_id
  LEFT JOIN proyecto_empresas e ON e.id = pu.empresa_id
 WHERE pp.cantidad > 0
UNION ALL
SELECT r.reporte_id, r.obra_id, r.obra, r.fecha,
       v.puesto, o.cuadrilla_propia, true, v.cantidad, true
  FROM asistente.reportes r
  JOIN asistente.obras o ON o.obra_id = r.obra_id
  JOIN proyecto_reportes x ON x.id = r.reporte_id
 CROSS JOIN LATERAL (VALUES ('Calificados', x.personal_calificado), ('Ayudantes', x.ayudantes)) v(puesto, cantidad)
 WHERE COALESCE(v.cantidad, 0) > 0
   AND NOT EXISTS (SELECT 1 FROM proyecto_reporte_personal pp WHERE pp.reporte_id = r.reporte_id);

COMMENT ON VIEW asistente.reporte_personal IS
  'La gente que trabajo cada dia: una fila por reporte y puesto, solo los puestos con gente ese dia. SUM(cantidad) = dias-persona (jornadas trabajadas); COUNT(*) = dias en que hubo gente de ese puesto. No hay horas por persona.';
COMMENT ON COLUMN asistente.reporte_personal.puesto IS
  'Como se llama el puesto en esa obra (Calificados, Ayudantes, Ingenieros, Supervisores, Operadores...). Cada obra tiene su lista.';
COMMENT ON COLUMN asistente.reporte_personal.empresa IS
  'De quien es esa gente: la cuadrilla propia o un subcontratista.';
COMMENT ON COLUMN asistente.reporte_personal.cantidad IS 'Cuantas personas de ese puesto trabajaron ese dia.';
COMMENT ON COLUMN asistente.reporte_personal.reporte_de_antes IS
  'true = reporte del formato anterior, que solo distinguia Calificados y Ayudantes: en esos dias no hay ingenieros, supervisores ni otros puestos aunque los hubiera. Si la respuesta incluye dias asi, dilo.';

-- Las maquinas: de la tabla con horas o, en los reportes del formato
-- anterior, de la lista de nombres que tenian, sin horas.
CREATE OR REPLACE VIEW asistente.reporte_maquinas WITH (security_barrier) AS
SELECT r.reporte_id, r.obra_id, r.obra, r.fecha,
       q.nombre AS maquina,
       COALESCE(e.nombre, o.cuadrilla_propia) AS dueno,
       (q.empresa_id IS NULL) AS es_cuadrilla_propia,
       re.unidades,
       re.horas,
       false AS reporte_de_antes
  FROM asistente.reportes r
  JOIN asistente.obras o ON o.obra_id = r.obra_id
  JOIN proyecto_reporte_equipos re ON re.reporte_id = r.reporte_id
  JOIN proyecto_equipos q ON q.id = re.equipo_id
  LEFT JOIN proyecto_empresas e ON e.id = q.empresa_id
 WHERE COALESCE(re.unidades, 0) > 0 OR COALESCE(re.horas, 0) > 0
UNION ALL
SELECT r.reporte_id, r.obra_id, r.obra, r.fecha,
       m.nombre, NULL, NULL, NULL, NULL, true
  FROM asistente.reportes r
  JOIN proyecto_reportes x ON x.id = r.reporte_id
 CROSS JOIN LATERAL unnest(COALESCE(x.equipo, ARRAY[]::text[])) m(nombre)
 WHERE NOT EXISTS (SELECT 1 FROM proyecto_reporte_equipos re WHERE re.reporte_id = r.reporte_id);

COMMENT ON VIEW asistente.reporte_maquinas IS
  'Las maquinas que trabajaron cada dia: una fila por reporte y maquina. SUM(horas) = horas de maquina; COUNT(*) = dias que trabajo.';
COMMENT ON COLUMN asistente.reporte_maquinas.maquina IS
  'Como se llama la maquina en la lista de esa obra (Retroexcavadora, Excavadora 320...). En algunas obras el dueno va escrito en el nombre («RODSA - Retroexcavadora»).';
COMMENT ON COLUMN asistente.reporte_maquinas.dueno IS 'De quien es: la cuadrilla propia o un subcontratista.';
COMMENT ON COLUMN asistente.reporte_maquinas.unidades IS 'Cuantas maquinas de esas trabajaron ese dia.';
COMMENT ON COLUMN asistente.reporte_maquinas.horas IS 'Horas anotadas para esa maquina ese dia.';
COMMENT ON COLUMN asistente.reporte_maquinas.reporte_de_antes IS
  'true = reporte del formato anterior: solo decia que maquinas habia, sin dueno, unidades ni horas.';

CREATE OR REPLACE VIEW asistente.reporte_entregas WITH (security_barrier) AS
SELECT r.reporte_id, r.obra_id, r.obra, r.fecha,
       c.nombre AS categoria,
       en.descripcion,
       en.cantidad,
       en.unidad,
       en.notas,
       -- Donde se busca. Cada ingeniero lo escribe a su manera: el 30/09 de
       -- Playa Blanca dice «Accesorios de tuberias», 27, «codos de 45° de
       -- 12"» —lo que llego esta en la unidad—, y una busqueda solo en la
       -- descripcion no lo encontro (hoja de respuestas del 2026-10-01).
       CONCAT_WS(' · ', en.descripcion,
                 NULLIF(TRIM(CONCAT_WS(' ', trim_scale(en.cantidad)::text, en.unidad)), ''),
                 en.notas) AS todo_lo_escrito
  FROM asistente.reportes r
  JOIN proyecto_reporte_entregas en ON en.reporte_id = r.reporte_id
  LEFT JOIN proyecto_entrega_categorias c ON c.id = en.categoria_id;

COMMENT ON VIEW asistente.reporte_entregas IS
  'Lo que llego a la obra cada dia (materiales, equipos, herramientas): una fila por cosa recibida. Para buscar que llego, busca en todo_lo_escrito: lo que llego a veces esta escrito en la unidad o en las notas, no en la descripcion.';
COMMENT ON COLUMN asistente.reporte_entregas.todo_lo_escrito IS
  'descripcion, cantidad, unidad y notas juntas, para buscar.';
COMMENT ON COLUMN asistente.reporte_entregas.cantidad IS 'Cuanto llego, si el ingeniero lo anoto (puede ser NULL; a veces la cantidad esta escrita dentro de descripcion).';

-- El trabajo ejecutado: un punto por fila en los reportes de ahora; en los
-- del formato anterior, todo el texto en una fila con las areas que marcaron.
CREATE OR REPLACE VIEW asistente.reporte_trabajos WITH (security_barrier) AS
SELECT r.reporte_id, r.obra_id, r.obra, r.fecha,
       COALESCE(a.nombre, 'General') AS area,
       t.texto,
       false AS reporte_de_antes
  FROM asistente.reportes r
  JOIN proyecto_reporte_trabajos t ON t.reporte_id = r.reporte_id
  LEFT JOIN proyecto_areas a ON a.id = t.area_id
UNION ALL
SELECT r.reporte_id, r.obra_id, r.obra, r.fecha,
       COALESCE(
         (SELECT string_agg(a.nombre, ', ' ORDER BY a.orden, a.nombre)
            FROM proyecto_reporte_areas ra JOIN proyecto_areas a ON a.id = ra.area_id
           WHERE ra.reporte_id = r.reporte_id),
         'General'),
       x.que_se_hizo,
       true
  FROM asistente.reportes r
  JOIN proyecto_reportes x ON x.id = r.reporte_id
 WHERE COALESCE(TRIM(x.que_se_hizo), '') <> ''
   AND NOT EXISTS (SELECT 1 FROM proyecto_reporte_trabajos t WHERE t.reporte_id = r.reporte_id);

COMMENT ON VIEW asistente.reporte_trabajos IS
  'El trabajo ejecutado cada dia, por area de la obra: una fila por punto. texto es libre, como lo escribio el ingeniero.';
COMMENT ON COLUMN asistente.reporte_trabajos.area IS 'El area de la obra donde se hizo; General = de ninguna area en particular.';
COMMENT ON COLUMN asistente.reporte_trabajos.reporte_de_antes IS
  'true = reporte del formato anterior: todo el trabajo del dia en un solo texto, y area lleva todas las areas que marcaron ese dia.';

CREATE OR REPLACE VIEW asistente.reporte_fotos WITH (security_barrier) AS
SELECT r.reporte_id, r.obra_id, r.obra, r.fecha,
       f.orden,
       f.leyenda
  FROM asistente.reportes r
  JOIN proyecto_reporte_fotos f ON f.reporte_id = r.reporte_id;

COMMENT ON VIEW asistente.reporte_fotos IS
  'Las fotos de cada reporte, con su leyenda si la escribieron (muchas no tienen).';

-- ── La cuenta del asistente ────────────────────────────────────────────────
--
-- Una cuenta de la base aparte, que solo puede leer las vistas de arriba. No
-- ve ninguna tabla del sistema (ni pagos, ni usuarios, ni datos de banco), no
-- puede escribir nada y cada consulta tiene cinco segundos. Nace sin poder
-- entrar: la contrasena se la pone el servidor al usarla por primera vez
-- (services/whatsapp/consultas.ts), sacada de un secreto que ya tiene, asi que
-- no hay que configurar nada en Railway.
--
-- Las cuentas son de todo el servidor de base, no de una base: las bases de
-- prueba comparten esta, y cada una le da sus propios permisos aqui abajo.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'asistente_lector') THEN
    CREATE ROLE asistente_lector NOLOGIN;
  END IF;
END $$;

-- Diez: tres por servidor, y durante un despliegue hay dos servidores a la vez.
ALTER ROLE asistente_lector CONNECTION LIMIT 10;
ALTER ROLE asistente_lector SET default_transaction_read_only = on;
ALTER ROLE asistente_lector SET statement_timeout = '5s';
ALTER ROLE asistente_lector SET idle_in_transaction_session_timeout = '10s';
-- Para que el asistente escriba «FROM reportes» y no «FROM asistente.reportes».
ALTER ROLE asistente_lector SET search_path = asistente;

GRANT USAGE ON SCHEMA asistente TO asistente_lector;
GRANT SELECT ON asistente.obras, asistente.reportes, asistente.reporte_personal,
  asistente.reporte_maquinas, asistente.reporte_entregas, asistente.reporte_trabajos,
  asistente.reporte_fotos TO asistente_lector;
GRANT EXECUTE ON FUNCTION asistente.llano(TEXT) TO asistente_lector;
-- asistente.acceso NO: la cuenta no puede ver ni tocar quien ve que.

-- ── Lo que pregunto ─────────────────────────────────────────────────────────
--
-- Cada consulta que el asistente le hace a la base, con lo que salio. Cuando
-- una cifra parezca mal, aqui se ve exactamente que conto.
CREATE TABLE IF NOT EXISTS whatsapp_consultas (
  id SERIAL PRIMARY KEY,
  conversacion_id INTEGER REFERENCES whatsapp_conversaciones(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  -- Lo que el asistente dice que esta contando, en sus palabras.
  proposito TEXT,
  consulta TEXT NOT NULL,
  filas INTEGER,
  -- Las filas que le llegaron, tal cual (con su tope).
  resultado JSONB,
  error TEXT,
  milisegundos INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_consultas_conversacion
  ON whatsapp_consultas (conversacion_id, id);
