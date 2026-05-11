-- 104_tracking_columns_not_null.sql
-- Cycle B of audit closeout (M1-M7).
-- Tightens NOT NULL on 7 tracking columns (who created / registered / updated).
-- Phase 0 verified: every writer path already supplies req.user!.id, and local
-- DB has zero NULLs across the 6 simple columns.
-- M7 (proyecto_presupuestos.actualizado_por) gets a backfill: existing rows
-- with NULL inherit their creator (the row's current responsible party).
-- The matching code edit in costs.ts sets actualizado_por = creado_por at
-- creation going forward.

-- Backfill M7: rows that have never been edited inherit their creator.
UPDATE proyecto_presupuestos
SET actualizado_por = creado_por
WHERE actualizado_por IS NULL;

-- SET NOT NULL on all 7 columns. Idempotent (rerun on already-NOT-NULL is no-op).
ALTER TABLE contactos_externos     ALTER COLUMN creado_por      SET NOT NULL;
ALTER TABLE comprobantes_pago      ALTER COLUMN registrado_por  SET NOT NULL;
ALTER TABLE facturas_solicitud     ALTER COLUMN registrado_por  SET NOT NULL;
ALTER TABLE devoluciones_solicitud ALTER COLUMN registrado_por  SET NOT NULL;
ALTER TABLE proyecto_gastos        ALTER COLUMN creado_por      SET NOT NULL;
ALTER TABLE proyecto_presupuestos  ALTER COLUMN creado_por      SET NOT NULL;
ALTER TABLE proyecto_presupuestos  ALTER COLUMN actualizado_por SET NOT NULL;