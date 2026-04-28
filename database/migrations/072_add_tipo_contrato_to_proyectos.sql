-- 072_add_tipo_contrato_to_proyectos.sql
-- Add tipo_contrato column to proyectos so each project explicitly records
-- whether it is a public or private contract. Backfills from cliente.tipo
-- as a starting heuristic ('estado' → 'publico', anything else → 'privado').

ALTER TABLE proyectos
  ADD COLUMN IF NOT EXISTS tipo_contrato VARCHAR(10) DEFAULT 'privado';

-- Backfill projects whose cliente is a state entity → publico.
-- All other rows keep the column DEFAULT of 'privado'.
UPDATE proyectos
SET tipo_contrato = 'publico'
FROM clientes c
WHERE proyectos.cliente_id = c.id
  AND c.tipo = 'estado'
  AND proyectos.tipo_contrato = 'privado';

-- Add the CHECK constraint after backfill so existing data can't trip it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'proyectos_tipo_contrato_check'
  ) THEN
    ALTER TABLE proyectos
      ADD CONSTRAINT proyectos_tipo_contrato_check
      CHECK (tipo_contrato IN ('publico', 'privado'));
  END IF;
END $$;
