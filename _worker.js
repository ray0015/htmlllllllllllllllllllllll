// ============================================================
// EnvíosSolidarios — API Worker para Cloudflare Pages + D1
// ============================================================
// Endpoints:
//   PÚBLICOS:
//     GET  /api/rastrear?telefono=...   — buscar envíos por teléfono
//     GET  /api/rastrear?codigo=...     — buscar envío por código único
//
//   ADMIN (requieren token):
//     POST /api/admin/login             — { password } → { token }
//     GET  /api/admin/envios            — listar todos los envíos
//     POST /api/admin/envios            — crear envío
//     GET  /api/admin/envios/:id        — obtener envío con eventos
//     PUT  /api/admin/envios/:id        — actualizar envío
//     DELETE /api/admin/envios/:id      — eliminar envío
//     POST /api/admin/envios/:id/evento — añadir evento (adelantar/pausar/reanudar/error/entregar)
// ============================================================

// ---------- Utilidades ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

async function hmacSign(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function createToken(secret) {
  const payload = btoa(JSON.stringify({ exp: Date.now() + 86400000 }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sig = await hmacSign(payload, secret);
  return `${payload}.${sig}`;
}

async function verifyToken(token, secret) {
  if (!token) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expectedSig = await hmacSign(payload, secret);
  if (sig !== expectedSig) return false;
  try {
    const data = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return data.exp > Date.now();
  } catch {
    return false;
  }
}

function getAuth(request) {
  const h = request.headers.get('Authorization');
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

function generateCodigo() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'ES-';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ---------- Manejador principal ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    if (path.startsWith('/api/')) {
      return handleApi(request, env, url);
    }

    // Servir archivos estáticos (index.html, etc.)
    return env.ASSETS.fetch(request);
  },
};

// ---------- Router de API ----------

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const db = env.DB;

  // -- PÚBLICO: rastrear --
  if (path === '/api/rastrear' && method === 'GET') {
    const telefono = url.searchParams.get('telefono');
    const codigo = url.searchParams.get('codigo');

    if (codigo) {
      const envio = await db.prepare('SELECT * FROM envios WHERE codigo = ?').bind(codigo.toUpperCase()).first();
      if (!envio) return json({ error: 'No se encontró ningún envío con ese código' }, 404);
      const eventos = await db.prepare('SELECT * FROM eventos WHERE envio_id = ? ORDER BY fecha ASC').bind(envio.id).all();
      return json({ envios: [{ ...envio, eventos: eventos.results }] });
    }

    if (telefono) {
      const clean = telefono.replace(/\s+/g, '');
      const envios = await db.prepare('SELECT * FROM envios WHERE REPLACE(telefono, " ", "") LIKE ? ORDER BY creado_en DESC').bind('%' + clean + '%').all();
      if (!envios.results.length) return json({ error: 'No se encontraron envíos para ese teléfono' }, 404);
      const results = [];
      for (const e of envios.results) {
        const eventos = await db.prepare('SELECT * FROM eventos WHERE envio_id = ? ORDER BY fecha ASC').bind(e.id).all();
        results.push({ ...e, eventos: eventos.results });
      }
      return json({ envios: results });
    }

    return json({ error: 'Proporciona un teléfono o código' }, 400);
  }

  // -- ADMIN: login --
  if (path === '/api/admin/login' && method === 'POST') {
    const body = await request.json();
    if (!body.password) return json({ error: 'Contraseña requerida' }, 400);
    if (body.password !== env.ADMIN_PASSWORD) return json({ error: 'Contraseña incorrecta' }, 401);
    const token = await createToken(env.SESSION_SECRET);
    return json({ token });
  }

  // -- ADMIN: verificar token para el resto --
  const token = getAuth(request);
  if (!token || !(await verifyToken(token, env.SESSION_SECRET))) {
    return json({ error: 'No autorizado' }, 401);
  }

  // -- ADMIN: listar envíos --
  if (path === '/api/admin/envios' && method === 'GET') {
    const envios = await db.prepare('SELECT * FROM envios ORDER BY creado_en DESC').all();
    return json({ envios: envios.results });
  }

  // -- ADMIN: crear envío --
  if (path === '/api/admin/envios' && method === 'POST') {
    const body = await request.json();
    const codigo = generateCodigo();
    const result = await db.prepare(
      `INSERT INTO envios (codigo, beneficiario, telefono, origen, destino, descripcion, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      codigo,
      body.beneficiario || '',
      body.telefono || '',
      body.origen || '',
      body.destino || '',
      body.descripcion || '',
      body.estado || 'pendiente'
    ).run();

    const envioId = result.meta.last_row_id;
    // Evento inicial
    await db.prepare(
      `INSERT INTO eventos (envio_id, tipo, titulo, descripcion, ubicacion)
       VALUES (?, 'creado', 'Envío registrado', ?, ?)`
    ).bind(
      envioId,
      body.descripcion || 'El envío ha sido creado y está pendiente de salida.',
      body.origen || ''
    ).run();

    const envio = await db.prepare('SELECT * FROM envios WHERE id = ?').bind(envioId).first();
    return json({ envio }, 201);
  }

  // -- ADMIN: envío individual (GET, PUT, DELETE) --
  const match = path.match(/^\/api\/admin\/envios\/(\d+)$/);
  if (match) {
    const id = parseInt(match[1]);

    if (method === 'GET') {
      const envio = await db.prepare('SELECT * FROM envios WHERE id = ?').bind(id).first();
      if (!envio) return json({ error: 'Envío no encontrado' }, 404);
      const eventos = await db.prepare('SELECT * FROM eventos WHERE envio_id = ? ORDER BY fecha ASC').bind(id).all();
      return json({ envio: { ...envio, eventos: eventos.results } });
    }

    if (method === 'PUT') {
      const body = await request.json();
      await db.prepare(
        `UPDATE envios SET
          beneficiario = ?, telefono = ?, origen = ?, destino = ?,
          descripcion = ?, estado = ?, actualizado_en = datetime('now')
         WHERE id = ?`
      ).bind(
        body.beneficiario ?? '',
        body.telefono ?? '',
        body.origen ?? '',
        body.destino ?? '',
        body.descripcion ?? '',
        body.estado ?? 'pendiente',
        id
      ).run();
      const envio = await db.prepare('SELECT * FROM envios WHERE id = ?').bind(id).first();
      return json({ envio });
    }

    if (method === 'DELETE') {
      await db.prepare('DELETE FROM eventos WHERE envio_id = ?').bind(id).run();
      await db.prepare('DELETE FROM envios WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
  }

  // -- ADMIN: añadir evento a un envío --
  const eventMatch = path.match(/^\/api\/admin\/envios\/(\d+)\/evento$/);
  if (eventMatch && method === 'POST') {
    const id = parseInt(eventMatch[1]);
    const body = await request.json();
    const envio = await db.prepare('SELECT * FROM envios WHERE id = ?').bind(id).first();
    if (!envio) return json({ error: 'Envío no encontrado' }, 404);

    const tipo = body.tipo || 'nota';
    const titulo = body.titulo || tipo;
    const descripcion = body.descripcion || '';
    const ubicacion = body.ubicacion || '';

    await db.prepare(
      `INSERT INTO eventos (envio_id, tipo, titulo, descripcion, ubicacion)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(id, tipo, titulo, descripcion, ubicacion).run();

    // Actualizar estado del envío según el tipo de evento
    const estadoMap = {
      creado: 'pendiente',
      adelantado: 'en_transito',
      pausado: 'pausado',
      reanudado: 'en_transito',
      entregado: 'entregado',
      error: 'error',
    };
    if (estadoMap[tipo]) {
      await db.prepare('UPDATE envios SET estado = ?, actualizado_en = datetime(\'now\') WHERE id = ?')
        .bind(estadoMap[tipo], id).run();
    }

    const updated = await db.prepare('SELECT * FROM envios WHERE id = ?').bind(id).first();
    const eventos = await db.prepare('SELECT * FROM eventos WHERE envio_id = ? ORDER BY fecha ASC').bind(id).all();
    return json({ envio: { ...updated, eventos: eventos.results } });
  }

  return json({ error: 'Ruta no encontrada' }, 404);
}
