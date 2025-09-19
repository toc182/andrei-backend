-- Migración 005: Crear tabla de equipos
-- Fecha: 2025-09-19

-- Tabla de equipos
CREATE TABLE equipos (
  id SERIAL PRIMARY KEY,
  codigo VARCHAR(20), -- Puede ser NULL para algunos equipos
  descripcion VARCHAR(255) NOT NULL,
  marca VARCHAR(100) NOT NULL,
  modelo VARCHAR(100) NOT NULL,
  ano INTEGER NOT NULL,
  motor VARCHAR(100), -- Número de motor
  chasis VARCHAR(100), -- Número de chasis
  costo DECIMAL(15,2), -- Costo de adquisición
  valor_actual DECIMAL(15,2), -- Valor actual
  rata_mes DECIMAL(15,2), -- Rata mensual
  proyecto VARCHAR(100), -- Proyecto asignado
  responsable VARCHAR(100), -- Responsable del equipo
  estado VARCHAR(50), -- Estado del equipo (OK, En reparación, etc.)
  observaciones TEXT, -- Observaciones adicionales
  owner VARCHAR(20) NOT NULL DEFAULT 'Pinellas' CHECK (owner IN ('Pinellas', 'COCP')), -- Propietario del equipo
  activo BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para mejorar rendimiento
CREATE INDEX idx_equipos_owner ON equipos(owner);
CREATE INDEX idx_equipos_estado ON equipos(estado);
CREATE INDEX idx_equipos_proyecto ON equipos(proyecto);
CREATE INDEX idx_equipos_codigo ON equipos(codigo);

-- Insertar datos existentes de equipos Pinellas
INSERT INTO equipos (codigo, descripcion, marca, modelo, ano, motor, chasis, costo, valor_actual, rata_mes, proyecto, responsable, estado, observaciones, owner) VALUES
('01-19', 'Retroexcavadora', 'John Deere', '310K', 2014, 'PE4045G945825', '1T0310KXPEC266013', 73000.00, 25000.00, 4500.00, '', '', 'OK', 'Comprado en sept14. Incluye kit para martillo', 'Pinellas'),
('01-20', 'Retroexcavadora', 'John Deere', '310K', 2014, 'PE4045G941718', '1T0310KXHEC264840', 73000.00, 25000.00, 4500.00, '', '', 'OK', 'Comprado en sept14. Incluye kit para martillo', 'Pinellas'),
('01-18', 'Tractor 700J', 'John Deere', '700J', 2008, '', 'T0700JX167545', 49166.50, 40000.00, 12600.00, '', '', '', '', 'Pinellas'),
(NULL, 'Tractor D5N', 'Caterpillar', 'D5N', 2010, '', '', NULL, 40000.00, NULL, '', '', '', '', 'Pinellas'),
('01-12', 'Pala 21 Ton', 'John Deere', '210G LC', 2012, 'PE6068G880193', '1FF210GXCCC520557', 175000.00, 40000.00, 11700.00, '', '', 'OK', '', 'Pinellas'),
('01-23', 'Pala 21 Ton', 'Case', 'CX210B', 2009, '', 'N8SAH1966', 56656.50, 25000.00, 11700.00, '', '', '', '', 'Pinellas'),
(NULL, 'Pala 20 Ton', 'Caterpillar', '320 GX', 2024, '', '', 130000.00, 150000.00, NULL, 'MOP', '', '', '50% CON ARAFAT', 'Pinellas'),
(NULL, 'Pala 22 Ton', 'Shantui', 'SE220LC', 2025, '93382160', '66SE22DKNS1022089', 110210.00, 140000.00, NULL, '', '', '', '50% CON ARAFAT', 'Pinellas'),
('01-21', 'Rola Vibratoria 10 Ton', 'Volvo', 'SD100DC', 2008, '36031658', '198475', 32034.60, 18000.00, 7500.00, '', '', '', '', 'Pinellas'),
(NULL, 'Rola Vibratoria 12P5', 'Shantui', 'SR12P-5', 2024, 'WEICHAI WP6G140E', 'CHSR12YPCP6000892', 59767.95, 80000.00, NULL, 'MOP', '', '', '50% CON ARAFAT', 'Pinellas'),
('01-22', 'Rodillo Neumático 9 Llantas', 'Hypac', 'C530AH', 2002, '46201274', '109A22201987', 32034.60, 15000.00, 7500.00, 'FINCA', '', '', '', 'Pinellas');

-- Insertar datos de equipos COCP
INSERT INTO equipos (codigo, descripcion, marca, modelo, ano, motor, chasis, costo, valor_actual, rata_mes, proyecto, responsable, estado, observaciones, owner) VALUES
(NULL, 'Tractor SD13', 'Shantui', 'SD13', 2024, 'CUMMINS 6CTA8.3-C145', 'CHSD13AATP1006074', 110437.91, 140000.00, NULL, 'MOP', '', '', '50% CON ARAFAT. POCO MAS GRANDE QUE UN D4 CAT', 'COCP'),
(NULL, 'Pala 20 Ton', 'Caterpillar', '320 GX', 2024, '', '', 130000.00, 150000.00, NULL, 'MOP', '', '', '50% CON ARAFAT', 'COCP'),
(NULL, 'Pala 22 Ton', 'Shantui', 'SE220LC', 2025, '93382160', '66SE22DKNS1022089', 110210.00, 140000.00, NULL, '', '', '', '50% CON ARAFAT', 'COCP'),
(NULL, 'Rola Vibratoria 12P5', 'Shantui', 'SR12P-5', 2024, 'WEICHAI WP6G140E', 'CHSR12YPCP6000892', 59767.95, 80000.00, NULL, 'MOP', '', '', '50% CON ARAFAT', 'COCP'),
('02-04', 'Pick-up Ford Ranger 4x4', 'Ford', 'Ranger', 2014, '', '', 11000.00, 5500.00, 0.00, '', '', '', '50% CON ARAFAT', 'COCP'),
('02-06', 'Camión 3.5 Ton Utilitario', 'Hyundai', 'DA0514', 2016, '', '', 15000.00, 7500.00, NULL, '', '', '', '50% CON ARAFAT', 'COCP');