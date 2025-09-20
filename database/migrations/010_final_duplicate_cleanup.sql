-- Migration 010: Final cleanup of remaining duplicates
-- Date: 2025-09-20

-- Remove one duplicate Pala 20 Ton COCP (keep one, remove one)
DELETE FROM equipos
WHERE id IN (
  SELECT id FROM equipos
  WHERE descripcion = 'Pala 20 Ton'
    AND marca = 'Caterpillar'
    AND modelo = '320 GX'
    AND ano = 2024
    AND owner = 'COCP'
  ORDER BY id DESC
  LIMIT 1
);

-- Remove one duplicate Retroexcavadora John Deere 310K 2012 Pinellas (keep one, remove one)
DELETE FROM equipos
WHERE id IN (
  SELECT id FROM equipos
  WHERE descripcion = 'Retroexcavadora'
    AND marca = 'John Deere'
    AND modelo = '310K'
    AND ano = 2012
    AND owner = 'Pinellas'
  ORDER BY id DESC
  LIMIT 1
);

-- Remove one duplicate Retroexcavadora John Deere 310K 2014 Pinellas (keep one, remove one)
DELETE FROM equipos
WHERE id IN (
  SELECT id FROM equipos
  WHERE descripcion = 'Retroexcavadora'
    AND marca = 'John Deere'
    AND modelo = '310K'
    AND ano = 2014
    AND owner = 'Pinellas'
  ORDER BY id DESC
  LIMIT 1
);