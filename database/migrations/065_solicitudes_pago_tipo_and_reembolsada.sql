-- 065_solicitudes_pago_tipo_and_reembolsada.sql
-- Adds the `tipo` column to distinguish reembolso solicitudes from regular ones,
-- adds the `reembolsada` terminal estado, backfills existing reembolsos, and
-- renumbers them to use the M suffix.

-- 1. Add tipo column with default 'regular'
ALTER TABLE solicitudes_pago
  ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) NOT NULL DEFAULT 'regular';

ALTER TABLE solicitudes_pago
  DROP CONSTRAINT IF EXISTS solicitudes_pago_tipo_check;
ALTER TABLE solicitudes_pago
  ADD CONSTRAINT solicitudes_pago_tipo_check CHECK (tipo IN ('regular', 'reembolso'));

CREATE INDEX IF NOT EXISTS idx_sp_tipo ON solicitudes_pago(tipo);

-- 2. Allow the new 'reembolsada' estado
ALTER TABLE solicitudes_pago DROP CONSTRAINT IF EXISTS solicitudes_pago_estado_check;
ALTER TABLE solicitudes_pago ADD CONSTRAINT solicitudes_pago_estado_check
  CHECK (estado IN ('borrador', 'pendiente', 'aprobada', 'rechazada', 'pagada', 'facturada', 'devolucion', 'reembolsada'));

-- 3. Backfill existing reembolso solicitudes from the caja menuda link
UPDATE solicitudes_pago
SET tipo = 'reembolso'
WHERE id IN (
  SELECT DISTINCT solicitud_reembolso_id
  FROM cajas_menudas_gastos
  WHERE solicitud_reembolso_id IS NOT NULL
);

-- 4. Renumber existing reembolsos to use the M suffix.
-- For each project, assign 001M, 002M, ... in id order.
-- Done in two passes via a temporary placeholder to avoid colliding with the
-- unique constraint on numero during the rewrite.
DO $$
DECLARE
  rec RECORD;
  project_counter INTEGER;
  prev_project INTEGER;
  prefijo TEXT;
BEGIN
  -- Pass 1: park current numero in a temporary safe value
  UPDATE solicitudes_pago
  SET numero = '__pending_renumber__' || id
  WHERE tipo = 'reembolso';

  -- Pass 2: assign M-suffixed numbers per project, in id order
  prev_project := NULL;
  project_counter := 0;
  FOR rec IN
    SELECT sp.id, sp.proyecto_id, p.sp_prefijo
    FROM solicitudes_pago sp
    JOIN proyectos p ON p.id = sp.proyecto_id
    WHERE sp.tipo = 'reembolso'
    ORDER BY sp.proyecto_id, sp.id
  LOOP
    IF prev_project IS DISTINCT FROM rec.proyecto_id THEN
      project_counter := 1;
      prev_project := rec.proyecto_id;
    ELSE
      project_counter := project_counter + 1;
    END IF;

    prefijo := COALESCE(rec.sp_prefijo, 'SP');
    UPDATE solicitudes_pago
    SET numero = prefijo || '-' || LPAD(project_counter::text, 3, '0') || 'M'
    WHERE id = rec.id;
  END LOOP;
END $$;
