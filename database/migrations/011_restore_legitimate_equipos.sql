-- Migration 011: Restore legitimate equipos that were incorrectly removed
-- Date: 2025-09-20

-- Restore second Retroexcavadora John Deere 310K 2012 Pinellas (PANAMAQUINAS)
-- These are two separate machines from the CSV (lines 10-11)
INSERT INTO equipos (codigo, descripcion, marca, modelo, ano, motor, chasis, costo, valor_actual, rata_mes, proyecto, responsable, estado, observaciones, owner) VALUES
(NULL, 'Retroexcavadora', 'John Deere', '310K', 2012, '', '', 36000.00, 22000.00, NULL, '', '', '', 'PANAMAQUINAS', 'Pinellas');

-- Restore second Retroexcavadora John Deere 310K 2014 Pinellas
-- These are two separate machines from the CSV
INSERT INTO equipos (codigo, descripcion, marca, modelo, ano, motor, chasis, costo, valor_actual, rata_mes, proyecto, responsable, estado, observaciones, owner) VALUES
('01-20', 'Retroexcavadora', 'John Deere', '310K', 2014, '', '', 36000.00, 22000.00, NULL, '', '', '', 'Comprado en sept14. Incluye kit para martillo', 'Pinellas');

-- Restore second Pala 20 Ton COCP (50% CON ARAFAT)
-- According to CSV, there should be 2 of these
INSERT INTO equipos (codigo, descripcion, marca, modelo, ano, motor, chasis, costo, valor_actual, rata_mes, proyecto, responsable, estado, observaciones, owner) VALUES
(NULL, 'Pala 20 Ton', 'Caterpillar', '320 GX', 2024, '', '', 130000.00, 150000.00, NULL, 'MOP', '', '', '50% CON ARAFAT', 'COCP');

-- Restore second Rola Rompe Pecho COCP (50% CON ARAFAT)
-- According to migration 007, there should be 2 of these (line 37)
INSERT INTO equipos (codigo, descripcion, marca, modelo, ano, motor, chasis, costo, valor_actual, rata_mes, proyecto, responsable, estado, observaciones, owner) VALUES
(NULL, 'Rola Rompe Pecho', 'Shantui', 'AEPR 500L', 2023, '', '', 8025.00, 12000.00, NULL, '', '', '', '50% CON ARAFAT', 'COCP');