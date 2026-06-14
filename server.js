const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS: aperto per la Mini App Telegram ──
app.use(cors({ origin: '*' }));

// ── Serve file statici dalla cartella public ──
app.use(express.static(path.join(__dirname, 'public')));

// ── Headers comuni per simulare un browser italiano ──
const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          '*/*',
  'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
  'Referer':         'https://www.raiplay.it/',
  'Origin':          'https://www.raiplay.it',
};

// ── Canali con i loro stream originali ──
const CHANNELS = {
  rai1:      { url: 'https://mediapolis.rai.it/relinker/relinkerServlet.htm?cont=2606803',   referer: 'https://www.raiplay.it/' },
  rai2:      { url: 'https://mediapolis.rai.it/relinker/relinkerServlet.htm?cont=308718',    referer: 'https://www.raiplay.it/' },
  rai3:      { url: 'https://mediapolis.rai.it/relinker/relinkerServlet.htm?cont=308709',    referer: 'https://www.raiplay.it/' },
  rainews:   { url: 'https://mediapolis.rai.it/relinker/relinkerServlet.htm?cont=308753',    referer: 'https://www.rainews.it/' },
  raisport:  { url: 'https://mediapolis.rai.it/relinker/relinkerServlet.htm?cont=308722',    referer: 'https://www.raiplay.it/' },
  raistoria: { url: 'https://mediapolis.rai.it/relinker/relinkerServlet.htm?cont=308725',    referer: 'https://www.raiplay.it/' },
  raiscuola: { url: 'https://mediapolis.rai.it/relinker/relinkerServlet.htm?cont=308728',    referer: 'https://www.raiplay.it/' },
  raipremium:{ url: 'https://mediapolis.rai.it/relinker/relinkerServlet.htm?cont=308731',    referer: 'https://www.raiplay.it/' },
  raiyoyo:   { url: 'https://mediapolis.rai.it/relinker/relinkerServlet.htm?cont=308734',    referer: 'https://www.raiplay.it/' },
  raigulp:   { url: 'https://mediapolis.rai.it/relinker/relinkerServlet.htm?cont=308737',    referer: 'https://www.raiplay.it/' },
  rete4:     { url: 'https://live3-mediaset-it.akamaized.net/Content/hls_h0_clr_vos/live/channel(r4)/index.m3u8',    referer: 'https://mediasetplay.mediaset.it/' },
  canale5:   { url: 'https://live3-mediaset-it.akamaized.net/Content/hls_h0_clr_vos/live/channel(c5)/index.m3u8',    referer: 'https://mediasetplay.mediaset.it/' },
  italia1:   { url: 'https://live3-mediaset-it.akamaized.net/Content/hls_h0_clr_vos/live/channel(i1)/index.m3u8',    referer: 'https://mediasetplay.mediaset.it/' },
  focus:     { url: 'https://live3-mediaset-it.akamaized.net/Content/hls_h0_clr_vos/live/channel(focus)/index.m3u8', referer: 'https://mediasetplay.mediaset.it/' },
};

// Cache URL risolti (relinker → URL HLS finale)
const resolvedCache = new Map();
const CACHE_TTL = 1000 * 60 * 30; // 30 minuti

// ── Funzione: risolve relinker RAI seguendo i redirect ──
async function resolveUrl(originalUrl, referer) {
  const cached = resolvedCache.get(originalUrl);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.url;
  }

  let current = originalUrl;
  let attempts = 0;

  while (attempts < 8) {
    const res = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        ...BROWSER_HEADERS,
        'Referer': referer,
        'Origin':  new URL(referer).origin,
      },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) break;
      current = location.startsWith('http') ? location : new URL(location, current).href;
      attempts++;
    } else if (res.status === 200) {
      // Controlla se è già un .m3u8
      if (current.includes('.m3u8') || res.headers.get('content-type')?.includes('mpegurl')) {
        resolvedCache.set(originalUrl, { url: current, ts: Date.now() });
        return current;
      }
      // Potrebbe essere testo con l'URL dentro (alcuni relinker RAI)
      const text = await res.text();
      const m3u8Match = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
      if (m3u8Match) {
        resolvedCache.set(originalUrl, { url: m3u8Match[0], ts: Date.now() });
        return m3u8Match[0];
      }
      break;
    } else {
      break;
    }
  }

  // Se non risolto, restituisci l'URL originale (potrebbe funzionare direttamente)
  return current;
}

// ── Route: lista canali (health check + info) ──
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'TV Italia Live Proxy',
    channels: Object.keys(CHANNELS),
    endpoints: {
      stream:  '/stream/:channelId',
      resolve: '/resolve/:channelId',
      proxy:   '/proxy?url=<encoded_url>',
    }
  });
});

// ── Route: risolve e restituisce l'URL HLS finale ──
app.get('/resolve/:id', async (req, res) => {
  const ch = CHANNELS[req.params.id];
  if (!ch) return res.status(404).json({ error: 'Canale non trovato' });

  try {
    const resolved = await resolveUrl(ch.url, ch.referer);
    res.json({ id: req.params.id, url: resolved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Route principale: proxy HLS stream ──
app.get('/stream/:id', async (req, res) => {
  const ch = CHANNELS[req.params.id];
  if (!ch) return res.status(404).json({ error: 'Canale non trovato' });

  try {
    const resolvedUrl = await resolveUrl(ch.url, ch.referer);

    const upstream = await fetch(resolvedUrl, {
      headers: {
        ...BROWSER_HEADERS,
        'Referer': ch.referer,
        'Origin':  new URL(ch.referer).origin,
      },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Upstream error: ${upstream.status}` });
    }

    const contentType = upstream.headers.get('content-type') || 'application/vnd.apple.mpegurl';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Se è un manifest M3U8, riscrive gli URL interni per passare dal proxy
    if (contentType.includes('mpegurl') || resolvedUrl.includes('.m3u8')) {
      const text = await upstream.text();
      const baseUrl = resolvedUrl.substring(0, resolvedUrl.lastIndexOf('/') + 1);
      const proxyBase = `${req.protocol}://${req.get('host')}/proxy?url=`;

      // Riscrivi URL relativi e assoluti nei segment e sub-playlist
      const rewritten = text.split('\n').map(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || trimmed === '') return line;
        const absolute = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
        return proxyBase + encodeURIComponent(absolute);
      }).join('\n');

      return res.send(rewritten);
    }

    // Altrimenti streama binario direttamente
    upstream.body.pipe(res);

  } catch (err) {
    console.error(`[stream/${req.params.id}]`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Route: proxy generico per segmenti TS e sub-playlist ──
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'url param mancante' });

  try {
    const decoded = decodeURIComponent(targetUrl);

    // Determina referer appropriato
    const referer = decoded.includes('rai.it') || decoded.includes('rai.tv')
      ? 'https://www.raiplay.it/'
      : decoded.includes('mediaset')
        ? 'https://mediasetplay.mediaset.it/'
        : 'https://www.google.com/';

    const upstream = await fetch(decoded, {
      headers: {
        ...BROWSER_HEADERS,
        'Referer': referer,
        'Origin':  new URL(referer).origin,
      },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send('Upstream error');
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Se è una sub-playlist M3U8, riscrive anche quella
    if (contentType.includes('mpegurl') || decoded.includes('.m3u8')) {
      const text = await upstream.text();
      const baseUrl = decoded.substring(0, decoded.lastIndexOf('/') + 1);
      const proxyBase = `${req.protocol}://${req.get('host')}/proxy?url=`;

      const rewritten = text.split('\n').map(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || trimmed === '') return line;
        const absolute = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
        return proxyBase + encodeURIComponent(absolute);
      }).join('\n');

      return res.send(rewritten);
    }

    upstream.body.pipe(res);

  } catch (err) {
    console.error('[proxy]', err.message);
    res.status(500).send('Proxy error');
  }
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`TV Italia Proxy running on port ${PORT}`);
});
