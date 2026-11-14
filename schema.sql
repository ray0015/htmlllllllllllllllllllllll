-- ============================================================
-- EnvíosSolidarios — Esquema de base de datos D1
-- ============================================================

-- Tabla principal de envíos
CREATE TABLE IF NOT EXISTS envios (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo        TEXT NOT NULL UNIQUE,           -- Código único de rastreo (ej: ES-AB3XK9)
  beneficiario  TEXT NOT NULL,                   -- Nombre del beneficiario
  telefono      TEXT NOT NULL,                   -- Teléfono para consulta pública
  origen        TEXT NOT NULL DEFAULT '',        -- Lugar de origen
  destino       TEXT NOT NULL DEFAULT '',         -- Lugar de destino
  descripcion   TEXT NOT NULL DEFAULT '',         -- Descripción del envío
  estado        TEXT NOT NULL DEFAULT 'pendiente', -- pendiente|en_transito|pausado|entregado|error
  creado_en     TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tabla de eventos / línea de tiempo de cada envío
CREATE TABLE IF NOT EXISTS eventos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  envio_id    INTEGER NOT NULL,
  tipo        TEXT NOT NULL,        -- creado|adelantado|pausado|reanudado|error|entregado|nota
  titulo      TEXT NOT NULL,        -- Título visible en la línea de tiempo
  descripcion TEXT NOT NULL DEFAULT '',
  ubicacion   TEXT NOT NULL DEFAULT '',
  fecha       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (envio_id) REFERENCES envios(id) ON DELETE CASCADE
);

-- Índices para búsquedas rápidas
CREATE INDEX IF NOT EXISTS idx_envios_telefono ON envios(telefono);
CREATE INDEX IF NOT EXISTS idx_envios_codigo   ON envios(codigo);
CREATE INDEX IF NOT EXISTS idx_eventos_envio   ON eventos(envio_id);
