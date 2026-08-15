-- 148_cuentas_inicio_calculado.sql
--
-- El inicio del periodo de una cuenta deja de escribirse a mano y pasa a
-- deducirse:
--
--   Cuenta 1  → el día de la Orden de Proceder del proyecto (147).
--   Cuenta N  → el día siguiente al fin de la cuenta anterior.
--
-- Las cuentas que ya existen traen fechas tecleadas que pueden contradecir esa
-- regla. Se recalculan todas de una vez — decisión explícita: tener dos
-- criterios conviviendo es lo que hace que la hoja impresa y el sistema digan
-- cosas distintas.
--
-- Donde el dato del que depende no existe (proyecto sin orden de proceder,
-- cuenta anterior sin fin) queda NULL a propósito: la hoja imprime el periodo
-- en blanco y se ve que falta, en vez de inventar una fecha.
UPDATE cuentas c
   SET periodo_inicio = CASE
     WHEN c.numero <= 1 THEN (
       SELECT p.orden_proceder FROM proyectos p WHERE p.id = c.proyecto_id
     )
     ELSE (
       SELECT a.periodo_fin + INTERVAL '1 day'
         FROM cuentas a
        WHERE a.proyecto_id = c.proyecto_id
          AND a.activo = TRUE
          AND a.numero < c.numero
        ORDER BY a.numero DESC
        LIMIT 1
     )
   END
 WHERE c.activo = TRUE;
