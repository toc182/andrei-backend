-- 184_adendas_monto.sql
--
-- Una adenda lleva UN monto. Antes tenía dos casillas, «nuevo monto total» y
-- «monto adicional», y nada impedía llenar las dos con números que no
-- cuadraban. Ahora el monto es lo que la adenda le suma al contrato, con ITBMS
-- (como el Monto Total del proyecto) y en negativo si lo reduce. El monto
-- vigente del contrato sale de sumar las aprobadas; no se guarda en ningún lado.
-- Decisiones de Ivan, 2026-10-03 al 2026-10-07.
--
-- Además, borrar una adenda la esconde (activo = false) en vez de borrarla: es
-- parte del contrato y su historia tiene que quedar.
--
-- Producción tenía, al escribir esto, cuatro adendas y todas de tiempo: no hay
-- montos que pasar. Lo de abajo cubre igual las copias que sí los tengan.

ALTER TABLE adendas ADD COLUMN IF NOT EXISTS monto NUMERIC(15,2);
ALTER TABLE adendas ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT TRUE;

-- El adicional ya era lo que la adenda sumaba.
UPDATE adendas SET monto = monto_adicional
 WHERE monto IS NULL AND monto_adicional IS NOT NULL;

-- Si solo se llenó el nuevo total, lo que sumó es la diferencia con el
-- contrato más las adendas aprobadas anteriores. Una por una, en orden, para
-- que cada una vea ya pasadas las de antes.
DO $$
DECLARE a RECORD;
BEGIN
  FOR a IN
    SELECT id, proyecto_id, numero_adenda, nuevo_monto FROM adendas
     WHERE monto IS NULL AND nuevo_monto IS NOT NULL
     ORDER BY proyecto_id, numero_adenda
  LOOP
    UPDATE adendas SET monto = a.nuevo_monto - (
      SELECT COALESCE(p.monto_total, 0) + COALESCE((
        SELECT SUM(b.monto) FROM adendas b
         WHERE b.proyecto_id = a.proyecto_id AND b.numero_adenda < a.numero_adenda
           AND b.estado = 'aprobada' AND b.monto IS NOT NULL), 0)
        FROM proyectos p WHERE p.id = a.proyecto_id)
     WHERE id = a.id;
  END LOOP;
END $$;

-- Cada tipo lleva lo suyo y nada más. La regla de antes dejaba pasar una de
-- tiempo con monto o una «tiempo y costo» a medias: cada una queda como lo que
-- de verdad dice, sin perder nada de lo escrito.
UPDATE adendas SET monto = NULL WHERE monto = 0;
UPDATE adendas SET tipo = 'mixta' WHERE tipo = 'tiempo' AND monto IS NOT NULL;
UPDATE adendas SET tipo = 'mixta' WHERE tipo = 'costo' AND nueva_fecha_fin IS NOT NULL;
UPDATE adendas SET tipo = 'costo'  WHERE tipo = 'mixta' AND nueva_fecha_fin IS NULL;
UPDATE adendas SET tipo = 'tiempo' WHERE tipo = 'mixta' AND monto IS NULL;
UPDATE adendas SET dias_extension = NULL WHERE tipo = 'costo';

ALTER TABLE adendas DROP CONSTRAINT IF EXISTS check_tiempo_fields;
ALTER TABLE adendas DROP COLUMN IF EXISTS nuevo_monto;
ALTER TABLE adendas DROP COLUMN IF EXISTS monto_adicional;

-- Que el monto no sea cero lo exige la ruta: aquí solo la forma de cada tipo.
ALTER TABLE adendas DROP CONSTRAINT IF EXISTS adendas_campos_por_tipo;
ALTER TABLE adendas ADD CONSTRAINT adendas_campos_por_tipo CHECK (
  (tipo = 'tiempo' AND nueva_fecha_fin IS NOT NULL AND monto IS NULL) OR
  (tipo = 'costo'  AND monto IS NOT NULL AND nueva_fecha_fin IS NULL AND dias_extension IS NULL) OR
  (tipo = 'mixta'  AND nueva_fecha_fin IS NOT NULL AND monto IS NOT NULL)
);
