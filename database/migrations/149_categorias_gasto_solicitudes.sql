-- 149_categorias_gasto_solicitudes.sql
-- Issue #71 — Categoría de gasto en solicitudes de pago.
--
-- Reuses the EXISTING categorias_gastos catalog instead of creating a second
-- one. The ERP already had a category list (used by Control de Costos and by
-- requisiciones); building a parallel list for solicitudes would split every
-- company-wide total in two.
--
-- Two earlier migrations (001 and 023) seeded overlapping rows with different
-- códigos (EQ/EQU, TR/TRA, SRV/SER), so the live table may hold duplicates.
-- This migration therefore does not assume a starting state: it deactivates
-- everything and then upserts the agreed list by código, landing on the same
-- result whatever was there before.
--
-- Nothing is deleted. Old rows stay with activo = false so any historical
-- reference keeps resolving.

-- 1. Retire whatever is currently in the catalog.
UPDATE categorias_gastos SET activo = false;

-- 2. Write the agreed list. MAT / SER / PER / OTR already exist and are
--    updated in place, keeping their ids; the rest are inserted.
INSERT INTO categorias_gastos (codigo, nombre, descripcion, color, orden, activo) VALUES
  ('MAT', 'Materiales',         'Materiales de construcción y suministros',      '#B91C1C', 1,  true),
  ('SUB', 'Subcontratos',       'Trabajos contratados a terceros',               '#0369A1', 2,  true),
  ('PLA', 'Planilla',           'Mano de obra propia',                           '#0F7B3A', 3,  true),
  ('ALQ', 'Alquiler Eq.',       'Alquiler de equipo a terceros',                 '#B45309', 4,  true),
  ('EQP', 'Equipos propios',    'Repuestos y mantenimiento de equipo propio',    '#7C3AED', 5,  true),
  ('COM', 'Combustible',        'Combustible y lubricantes',                     '#0F766E', 6,  true),
  ('SER', 'Servicios Prof.',    'Servicios profesionales y consultorías',        '#1F375F', 7,  true),
  ('PER', 'Permisos y Seguros', 'Permisos, licencias, fianzas y seguros',        '#C2410C', 8,  true),
  ('OFI', 'Oficina',            'Gastos administrativos y de oficina',           '#64748B', 9,  true),
  ('OTR', 'Otros',              'Gastos que no encajan en las demás categorías', '#334155', 10, true)
ON CONFLICT (codigo) DO UPDATE SET
  nombre      = EXCLUDED.nombre,
  descripcion = EXCLUDED.descripcion,
  color       = EXCLUDED.color,
  orden       = EXCLUDED.orden,
  activo      = true;

-- 3. The field on the solicitud.
--    Nullable on purpose: the category is never required. Whoever raises the
--    solicitud often does not know it; whoever does cost control fills it in
--    afterwards. See issue #71.
ALTER TABLE solicitudes_pago
  ADD COLUMN IF NOT EXISTS categoria_id INTEGER;

-- ON DELETE RESTRICT, not SET NULL: categories are retired with activo = false
-- and never deleted. If someone ever tries a hard delete, this stops it rather
-- than silently unclassifying every solicitud that pointed at it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'solicitudes_pago_categoria_id_fkey'
      AND table_name = 'solicitudes_pago'
  ) THEN
    ALTER TABLE solicitudes_pago
      ADD CONSTRAINT solicitudes_pago_categoria_id_fkey
      FOREIGN KEY (categoria_id) REFERENCES categorias_gastos(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Filtering the list by category, and finding what is still unclassified.
CREATE INDEX IF NOT EXISTS idx_solicitudes_pago_categoria
  ON solicitudes_pago(categoria_id);

COMMENT ON COLUMN solicitudes_pago.categoria_id IS
  'Categoría de gasto (categorias_gastos). Opcional por diseño — se clasifica después. Issue #71.';