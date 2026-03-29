/**
 * ============================================================================
 * VERCEL SERVERLESS ENTRY POINT
 * ============================================================================
 *
 * Ce fichier adapte l'application Express pour fonctionner sur Vercel
 * en mode serverless (fonctions sans état).
 *
 * IMPORTANT: Sur Vercel, les fonctions serverless ne supportent pas:
 * - Les cron jobs persistants (node-cron)
 * - Le stockage en mémoire persistant entre requêtes
 * - Les WebSockets
 *
 * Solutions mises en place:
 * - Scraping BRH à chaque requête si cache expiré (> 30 min)
 * - Grace period étendue (60 min) pour tolérer les cold starts
 * - Cache en mémoire (valide pendant la durée de vie de la fonction)
 * ============================================================================
 */

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();

// ============================================================================
// CONFIGURATION
// ============================================================================

const API_KEYS = {
  'dev-demo-key-001': { tier: 'free', dailyLimit: 1000, count: 0, lastReset: Date.now() },
  'dev-pro-key-002': { tier: 'pro', dailyLimit: 10000, count: 0, lastReset: Date.now() }
};

// Cache (valide pendant la durée de vie de la fonction serverless)
let cachedRate = null;
let lastFetch = null;
let isFetching = false;

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes en ms
const GRACE_PERIOD = 60 * 60 * 1000; // 60 minutes en ms

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(cors());
app.use(express.json());
app.set('trust proxy', 1);

// Rate limiting pour routes publiques
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Trop de requêtes',
      message: 'Limite de 100 requêtes par 15 minutes atteinte',
      retryAfter: 900
    });
  }
});

// ============================================================================
// FONCTION DE SCRAPING BRH (avec mutex)
// ============================================================================

async function scrapeExchangeRate(force = false) {
  // Vérifier si on peut utiliser le cache
  const now = Date.now();

  if (!force && cachedRate && lastFetch) {
    const age = now - lastFetch;

    // Cache valide (< 30 min)
    if (age < CACHE_TTL) {
      return { ...cachedRate, cached: true, age: Math.round(age / 1000 / 60) };
    }

    // Grace period (< 60 min) - données stale mais acceptables
    if (age < GRACE_PERIOD) {
      return { ...cachedRate, stale: true, age: Math.round(age / 1000 / 60) };
    }
  }

  // Mutex - éviter les requêtes parallèles
  if (isFetching) {
    let attempts = 0;
    while (isFetching && attempts < 20) {
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }

    if (cachedRate) {
      const age = now - lastFetch;
      return { ...cachedRate, cached: true, age: Math.round(age / 1000 / 60) };
    }
  }

  // Scraping BRH
  isFetching = true;

  try {
    const response = await axios.get('https://www.brh.ht/taux-du-jour/', {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BRH-API/1.0)'
      }
    });

    const $ = cheerio.load(response.data);

    // Extraction des taux bancaires
    const rows = $('table tbody tr');
    let tauxAchat = null;
    let tauxVente = null;

    rows.each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 3) {
        const devise = $(cells[0]).text().trim();
        if (devise === 'USD') {
          const achatText = $(cells[1]).text().trim().replace(',', '.');
          const venteText = $(cells[2]).text().trim().replace(',', '.');
          tauxAchat = parseFloat(achatText);
          tauxVente = parseFloat(venteText);
          return false;
        }
      }
    });

    // Extraction taux informel
    const tauxInformel = await scrapeInformalRate($);

    // Fallback si parsing échoue
    const safeTauxAchat = tauxAchat || 130.64;
    const safeTauxVente = tauxVente || 131.53;

    cachedRate = {
      devise_source: 'USD',
      devise_cible: 'HTG',
      taux_achat: safeTauxAchat,
      taux_vente: safeTauxVente,
      marche_informel_achat: tauxInformel.achat,
      marche_informel_vente: tauxInformel.vente,
      date_mise_a_jour: new Date().toISOString(),
      source: 'BRH - Banque de la Republique d\'Haiti'
    };

    lastFetch = now;

    return { ...cachedRate, fresh: true };

  } catch (error) {
    console.error('[SCRAPE ERROR]', error.message);

    // Grace period - servir données stale si disponibles
    if (cachedRate && lastFetch) {
      const age = now - lastFetch;
      if (age < GRACE_PERIOD) {
        return { ...cachedRate, stale: true, age: Math.round(age / 1000 / 60) };
      }
    }

    // Fallback complet
    return {
      devise_source: 'USD',
      devise_cible: 'HTG',
      taux_achat: 130.64,
      taux_vente: 131.53,
      marche_informel_achat: 131.00,
      marche_informel_vente: 136.00,
      date_mise_a_jour: new Date().toISOString(),
      source: 'BRH - Valeurs par défaut (fallback)',
      fallback: true,
      error: error.message
    };

  } finally {
    isFetching = false;
  }
}

async function scrapeInformalRate($) {
  try {
    const rows = $('table tbody tr');
    let achat = 131.00;
    let vente = 136.00;

    rows.each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 3) {
        const text = $(cells[0]).text().trim().toLowerCase();
        if (text.includes('informel') || text.includes('parall')) {
          const achatText = $(cells[1]).text().trim().replace(',', '.');
          const venteText = $(cells[2]).text().trim().replace(',', '.');
          achat = parseFloat(achatText) || 131.00;
          vente = parseFloat(venteText) || 136.00;
          return false;
        }
      }
    });

    return { achat, vente };
  } catch (error) {
    return { achat: 131.00, vente: 136.00 };
  }
}

// ============================================================================
// MIDDLEWARE AUTHENTIFICATION API KEY
// ============================================================================

function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;

  if (!apiKey) {
    return res.status(401).json({
      error: 'Authentification requise',
      message: 'Header X-API-Key ou paramètre api_key requis'
    });
  }

  const keyData = API_KEYS[apiKey];

  if (!keyData) {
    return res.status(403).json({
      error: 'Clé API invalide',
      message: 'La clé API fournie n\'est pas reconnue'
    });
  }

  // Reset quotidien
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;

  if (now - keyData.lastReset > oneDay) {
    keyData.count = 0;
    keyData.lastReset = now;
  }

  // Vérification quota
  if (keyData.count >= keyData.dailyLimit) {
    return res.status(429).json({
      error: 'Quota dépassé',
      message: `Limite de ${keyData.dailyLimit} requêtes/jour atteinte`,
      resetTime: new Date(keyData.lastReset + oneDay).toISOString(),
      dailyLimit: keyData.dailyLimit,
      currentCount: keyData.count
    });
  }

  keyData.count++;

  // Headers de tracking
  res.setHeader('X-RateLimit-Limit', keyData.dailyLimit);
  res.setHeader('X-RateLimit-Remaining', keyData.dailyLimit - keyData.count);
  res.setHeader('X-RateLimit-Reset', new Date(keyData.lastReset + oneDay).toISOString());
  res.setHeader('X-API-Tier', keyData.tier);

  req.keyData = keyData;
  next();
}

// ============================================================================
// ROUTES
// ============================================================================

// Route publique - Taux bancaire
app.get('/api/taux/latest', generalLimiter, async (req, res) => {
  try {
    const rate = await scrapeExchangeRate();
    res.json(rate);
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur', message: error.message });
  }
});

// Route publique - Taux informel
app.get('/api/taux/informel', generalLimiter, async (req, res) => {
  try {
    const rate = await scrapeExchangeRate();
    res.json({
      devise_source: 'USD',
      devise_cible: 'HTG',
      marche: 'informel',
      taux_achat: rate.marche_informel_achat || 131.00,
      taux_vente: rate.marche_informel_vente || 136.00,
      date_mise_a_jour: rate.date_mise_a_jour,
      source: rate.source
    });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur', message: error.message });
  }
});

// Route développeur - Taux avec metadata
app.get('/api/dev/rates', generalLimiter, requireApiKey, async (req, res) => {
  try {
    const rate = await scrapeExchangeRate();

    res.json({
      ...rate,
      _meta: {
        tier: req.keyData.tier,
        requestNumber: req.keyData.count,
        dailyLimit: req.keyData.dailyLimit,
        remaining: req.keyData.dailyLimit - req.keyData.count,
        cached: !!rate.cached,
        stale: !!rate.stale,
        fresh: !!rate.fresh,
        fallback: !!rate.fallback
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur', message: error.message });
  }
});

// Route développeur - Forcer rafraîchissement (Pro uniquement)
app.post('/api/dev/refresh', generalLimiter, requireApiKey, async (req, res) => {
  if (req.keyData.tier !== 'pro') {
    return res.status(403).json({
      error: 'Accès réservé',
      message: 'Niveau Pro requis pour forcer le rafraîchissement'
    });
  }

  try {
    const rate = await scrapeExchangeRate(true); // force refresh
    res.json({
      message: 'Rafraîchissement forcé réussi',
      ...rate,
      _meta: {
        tier: req.keyData.tier,
        requestNumber: req.keyData.count,
        forced: true
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors du rafraîchissement', message: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    cached: !!cachedRate,
    lastFetch: lastFetch ? new Date(lastFetch).toISOString() : null,
    environment: 'vercel-serverless'
  });
});

// Route racine - Frontend HTML
app.get('/', (req, res) => {
  res.json({
    name: 'BRH Exchange API',
    version: '1.0.0',
    description: 'API des taux de change HTG/USD - Banque de la République d\'Haïti',
    endpoints: {
      public: [
        { path: '/api/taux/latest', description: 'Taux bancaire USD/HTG' },
        { path: '/api/taux/informel', description: 'Taux marché informel' },
        { path: '/api/health', description: 'Health check' }
      ],
      developer: [
        { path: '/api/dev/rates', description: 'Taux avec metadata (API Key requise)' },
        { path: '/api/dev/refresh', description: 'Forcer rafraîchissement (Pro requis)' }
      ]
    },
    documentation: 'https://github.com/antifugazis/BRH#readme',
    keys_demo: {
      free: 'dev-demo-key-001',
      pro: 'dev-pro-key-002'
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Route non trouvée',
    path: req.path,
    method: req.method
  });
});

// ============================================================================
// EXPORT POUR VERCEL (Serverless)
// ============================================================================

// Export pour Vercel serverless functions
module.exports = app;

// Pour compatibilité avec les anciennes versions de Vercel
module.exports.default = app;
