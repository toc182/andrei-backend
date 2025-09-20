-- Migration 008: Fix remaining Pinellas equipo with ARAFAT
-- Date: 2025-09-20

-- Move the remaining Pinellas equipo with "50% CON ARAFAT" to COCP
-- This should catch the Pala 20 Ton that wasn't moved in migration 006
UPDATE equipos
SET owner = 'COCP'
WHERE owner = 'Pinellas'
  AND observaciones LIKE '%50% CON ARAFAT%'
  AND descripcion = 'Pala 20 Ton'
  AND marca = 'Caterpillar'
  AND modelo = '320 GX'
  AND ano = 2024;