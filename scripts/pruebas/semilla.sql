-- Los datos mínimos que las pruebas de humo dan por hechos.
--
-- Se aplica sobre una base recién creada desde las migraciones (entorno.ts).
-- Nada de aquí sale de la copia local de nadie: son datos inventados con la
-- MISMA forma que las pruebas esperan. Si una prueba necesita algo más, se
-- añade aquí y no en la prueba: así una prueba nunca depende de lo que otra
-- haya dejado.
--
-- Lo que las pruebas esperan encontrar:
--   - un usuario admin activo (firman su token con él);
--   - el proyecto 1 con sus cuatro listas: 4 puestos fijos del bloque propio,
--     3 categorías de entrega, 5 equipos, y áreas activas;
--   - un puesto de OTRO proyecto (filas-humo comprueba que no se cuele);
--   - el proyecto 2 sin solicitudes de pago ni aprobadores
--     (aprobadores-transaccion-humo los crea y los quita él).
--
-- Los nombres de los cuatro puestos y de las tres categorías tienen que ser los
-- de PUESTOS_BASE y CATEGORIAS_BASE de src/routes/proyectoListas.ts: el GET de
-- las listas siembra los que falten, y con otros nombres saldrían ocho puestos
-- donde la prueba espera cuatro.

INSERT INTO clientes (id, nombre) VALUES (1, 'Cliente de pruebas');

-- `sp_prefijo` no es decorado: es de donde sale el número del reporte
-- (RD-PRU1-260910) y sin él la creación se rechaza con un 400.
INSERT INTO proyectos (id, nombre, nombre_corto, sp_prefijo, cliente_id, estado, activo) VALUES
  (1, 'Proyecto de pruebas 1', 'PRUEBAS1', 'PRU1', 1, 'en_ejecucion', true),
  (2, 'Proyecto de pruebas 2', 'PRUEBAS2', 'PRU2', 1, 'en_ejecucion', true);

-- El admin NO se crea aquí: la migración 001 ya crea uno («Ivan Admin») en toda
-- base nueva, y es el que las pruebas encuentran al pedir el primer admin
-- activo. Aquí van los otros.
--
-- Cuatro, ni uno menos: aprobadores-transaccion-humo coge los cuatro primeros
-- usuarios que no son el admin —dos para la configuración de antes y dos para
-- la de después— y con tres se queda a medias y el guardado bueno revienta.
--
-- Sin contraseña a propósito: por aquí no se inicia sesión, las pruebas firman
-- su propio token. Una contraseña de mentira en el repositorio no hace falta.
INSERT INTO users (nombre, email, rol, activo) VALUES
  ('Aprobador de pruebas 1', 'aprobador1@pruebas.local', 'usuario', true),
  ('Aprobador de pruebas 2', 'aprobador2@pruebas.local', 'usuario', true),
  ('Aprobador de pruebas 3', 'aprobador3@pruebas.local', 'usuario', true),
  ('Aprobador de pruebas 4', 'aprobador4@pruebas.local', 'usuario', true);

INSERT INTO proyecto_areas (proyecto_id, nombre, orden) VALUES
  (1, 'Área 1', 1),
  (1, 'Área 2', 2),
  (1, 'Área 3', 3);

INSERT INTO proyecto_equipos (proyecto_id, nombre, orden) VALUES
  (1, 'Retroexcavadora', 1),
  (1, 'Mixer',           2),
  (1, 'Grúa',            3),
  (1, 'Vibrocompactador', 4),
  (1, 'Bomba de concreto', 5);

INSERT INTO proyecto_entrega_categorias (proyecto_id, nombre, orden) VALUES
  (1, 'Material',    1),
  (1, 'Equipo',      2),
  (1, 'Herramienta', 3);

INSERT INTO proyecto_puestos (proyecto_id, empresa_id, nombre, orden, fijo) VALUES
  (1, NULL, 'Ingenieros',   1, true),
  (1, NULL, 'Supervisores', 2, true),
  (1, NULL, 'Calificados',  3, true),
  (1, NULL, 'Ayudantes',    4, true),
  -- Los del proyecto 2 existen solo para que filas-humo tenga un puesto ajeno
  -- que intentar colar en el proyecto 1.
  (2, NULL, 'Ingenieros',   1, true),
  (2, NULL, 'Supervisores', 2, true),
  (2, NULL, 'Calificados',  3, true),
  (2, NULL, 'Ayudantes',    4, true);

-- Las filas de arriba llevan id puesto a mano, así que el contador de cada
-- tabla se quedó en cero: sin esto, el primer INSERT de una prueba chocaría
-- contra el id 1.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clientes', 'proyectos', 'users', 'proyecto_areas',
                           'proyecto_equipos', 'proyecto_entrega_categorias',
                           'proyecto_puestos']
  LOOP
    EXECUTE format(
      'SELECT setval(pg_get_serial_sequence(%L, ''id''), COALESCE((SELECT MAX(id) FROM %I), 1))',
      t, t);
  END LOOP;
END $$;
