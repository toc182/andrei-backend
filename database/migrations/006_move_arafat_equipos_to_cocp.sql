-- Migration 006: Move Pinellas equipos with ARAFAT to COCP
-- Date: 2025-09-20

-- Move the 3 Pinellas equipos with "50% CON ARAFAT" to COCP
UPDATE equipos
SET owner = 'COCP'
WHERE owner = 'Pinellas'
  AND observaciones LIKE '%50% CON ARAFAT%';

-- Verify the changes (for logging purposes)
-- These equipos should now belong to COCP:
-- 1. Pala 20 Ton (Caterpillar 320 GX, 2024)
-- 2. Pala 22 Ton (Shantui SE220LC, 2025)
-- 3. Rola Vibratoria 12P5 (Shantui SR12P-5, 2024)