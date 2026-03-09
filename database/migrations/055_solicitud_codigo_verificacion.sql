-- Add verification code column to solicitudes_pago
ALTER TABLE solicitudes_pago ADD COLUMN IF NOT EXISTS codigo_verificacion VARCHAR(10) UNIQUE;

-- Backfill existing solicitudes with random codes
-- Using 8-char uppercase alphanumeric (excluding ambiguous chars: 0,O,1,I,L)
DO $$
DECLARE
  r RECORD;
  chars TEXT := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code TEXT;
  i INT;
BEGIN
  FOR r IN SELECT id FROM solicitudes_pago WHERE codigo_verificacion IS NULL LOOP
    LOOP
      code := '';
      FOR i IN 1..8 LOOP
        code := code || substr(chars, floor(random() * length(chars) + 1)::int, 1);
      END LOOP;
      -- Ensure uniqueness
      BEGIN
        UPDATE solicitudes_pago SET codigo_verificacion = code WHERE id = r.id;
        EXIT; -- success, break inner loop
      EXCEPTION WHEN unique_violation THEN
        -- retry with different code
      END;
    END LOOP;
  END LOOP;
END $$;

-- Make it NOT NULL after backfill
ALTER TABLE solicitudes_pago ALTER COLUMN codigo_verificacion SET NOT NULL;
