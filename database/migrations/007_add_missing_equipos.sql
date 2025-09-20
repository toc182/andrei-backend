-- Migration 007: Add missing equipos from CSV
-- Date: 2025-09-20

-- Add missing Pinellas equipos (without 50% ARAFAT)
INSERT INTO equipos (codigo, descripcion, marca, modelo, ano, motor, chasis, costo, valor_actual, rata_mes, proyecto, responsable, estado, observaciones, owner) VALUES
-- Retroexcavadoras PANAMAQUINAS (líneas 10-11 CSV)
(NULL, 'Retroexcavadora', 'John Deere', '310K', 2012, '', '', 36000.00, 22000.00, NULL, '', '', '', 'PANAMAQUINAS', 'Pinellas'),
(NULL, 'Retroexcavadora', 'John Deere', '310K', 2012, '', '', 36000.00, 22000.00, NULL, '', '', '', 'PANAMAQUINAS', 'Pinellas'),

-- Pala 20 Ton duplicada (línea 18 CSV) - Segunda instancia
(NULL, 'Pala 20 Ton', 'Caterpillar', '320 GX', 2024, '', '', 130000.00, 150000.00, NULL, 'MOP', '', '', '50% CON ARAFAT', 'Pinellas'),

-- Camiones Freightliner (líneas 32-33 CSV)
('02-21', 'Camión Plataforma 6x4 B Class', 'Freightliner', 'M2106MD', 2007, '92691600641537', '1FVHCYDJ77DZ17391', 18481.50, 10000.00, 3500.00, 'FINCA', '', '', '', 'Pinellas'),
('02-22', 'Camión de Agua 4000Gal 6x4', 'Freightliner', 'M2106MD', 2007, '906605569', '1FVHCYDJ17DZ17418', 43123.50, 25000.00, 4000.00, '', '', '', '', 'Pinellas'),

-- Plataforma Alta Mula (línea 34 CSV)
('02-19', 'Plataforma Alta Mula 42''', 'OK', '', 2000, '', '', 7000.00, 7000.00, NULL, 'FINCA', '', 'OK', 'Complemento para cabezal', 'Pinellas'),

-- Equipos pequeños sin ARAFAT (líneas 39-40 CSV)
(NULL, 'Bomba de Agua de 6"', 'Forsa', '', 2025, '', '', 2000.00, 2000.00, NULL, '', '', '', '', 'Pinellas'),
(NULL, 'Mezcladora de Concreto 2 Sacos', 'Honda', '', 2025, 'HONDA', '', 3000.00, 3000.00, NULL, '', '', '', '', 'Pinellas');

-- Add missing COCP equipos (with 50% ARAFAT)
INSERT INTO equipos (codigo, descripcion, marca, modelo, ano, motor, chasis, costo, valor_actual, rata_mes, proyecto, responsable, estado, observaciones, owner) VALUES
-- Motoniveladoras (líneas 23-24 CSV)
(NULL, 'Motoniveladora', 'Shantui', 'SG17-B6', 2024, 'CUMMINS 6CTAA5.9-C180', 'CHSGA17BLRB000252', 82817.93, 120000.00, NULL, '', '', '', '50% CON ARAFAT', 'COCP'),
(NULL, 'Motoniveladora', 'Shantui', 'SG17-B6', 2025, 'CUMMINS', 'CHSGA17BLSB000385', 102469.81, 125000.00, NULL, '', '', '', '50% CON ARAFAT', 'COCP'),

-- Cabezal de Mula (línea 29 CSV)
(NULL, 'Cabezal de Mula Blanco', 'HOWO', 'ZZ4257V3247B1', 2024, '1424B008718', 'LZZ5CLSB8RN268355', 70484.89, 90000.00, NULL, '', '', '', '50% CON ARAFAT', 'COCP'),

-- Remolques y rolas (líneas 35-38 CSV)
(NULL, 'Remolque Cama Baja 25Ton', 'OK', '', 2000, '', '', 18630.00, 9315.00, NULL, '', '', '', '50% CON ARAFAT', 'COCP'),
(NULL, 'Rola Doble Rodillo 1.5Ton', 'Beton Trowel', 'ROLLER BTDR700Y', 2025, '', '', 10700.00, 13000.00, NULL, '', '', '', '50% CON ARAFAT', 'COCP'),
(NULL, 'Rola Rompe Pecho', 'Shantui', 'AEPR 500L', 2023, '', '', 8025.00, 12000.00, NULL, '', '', '', '50% CON ARAFAT', 'COCP'),
(NULL, 'Rola Rompe Pecho', 'Shantui', 'AEPR 500L', 2023, '', '', 8025.00, 12000.00, NULL, '', '', '', '50% CON ARAFAT', 'COCP');