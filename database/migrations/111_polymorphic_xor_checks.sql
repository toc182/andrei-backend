-- 111_polymorphic_xor_checks.sql
-- M2 from schema audit: two tables have a pair of alternative parent
-- columns where exactly one should be set. Today nothing enforces this:
-- a row could have both NULL (orphaned) or both filled (ambiguous).
--   proyecto_miembros:        user_id XOR contacto_externo_id
--   proyecto_bitacora_adjuntos: bitacora_id XOR comentario_id
-- Local DB: zero violations in both tables. Self-verifying — aborts if
-- production has any row that would fail the new CHECK.

DO $$
DECLARE
  bad_count INTEGER;
BEGIN
  -- Preflight: proyecto_miembros must have exactly one of user_id / contacto_externo_id.
  SELECT COUNT(*) INTO bad_count
  FROM proyecto_miembros
  WHERE (user_id IS NOT NULL) = (contacto_externo_id IS NOT NULL);
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Migration 111 aborted. proyecto_miembros has % rows where neither or both of user_id / contacto_externo_id are set.',
      bad_count;
  END IF;

  -- Preflight: proyecto_bitacora_adjuntos must have exactly one of bitacora_id / comentario_id.
  SELECT COUNT(*) INTO bad_count
  FROM proyecto_bitacora_adjuntos
  WHERE (bitacora_id IS NOT NULL) = (comentario_id IS NOT NULL);
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Migration 111 aborted. proyecto_bitacora_adjuntos has % rows where neither or both of bitacora_id / comentario_id are set.',
      bad_count;
  END IF;

  RAISE NOTICE 'Preflight passed. Installing XOR CHECK constraints.';

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proyecto_miembros_user_or_contacto_xor'
  ) THEN
    ALTER TABLE proyecto_miembros
      ADD CONSTRAINT proyecto_miembros_user_or_contacto_xor
      CHECK ((user_id IS NOT NULL) <> (contacto_externo_id IS NOT NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proyecto_bitacora_adjuntos_parent_xor'
  ) THEN
    ALTER TABLE proyecto_bitacora_adjuntos
      ADD CONSTRAINT proyecto_bitacora_adjuntos_parent_xor
      CHECK ((bitacora_id IS NOT NULL) <> (comentario_id IS NOT NULL));
  END IF;

  RAISE NOTICE 'Migration 111 complete.';
END $$;
