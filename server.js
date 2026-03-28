/**
 * ============================================================================
 * TAUX DE CHANGE HTG/USD - API PROTEGEE
 * ============================================================================
 * 
 * PARTIE 3 : PROTECTION DE LA SOURCE ET DE L'API
 * 
 * Ce fichier implemente deux mecanismes de protection essentiels:
 * 
 * 1. PROTECTION DE LA SOURCE (BRH) - Anti-DDoS sur le serveur BRH
 *    - Mise en cache des donnees avec TTL (Time To Live)
 *    - Scraping automatique toutes les 30 minutes (pas a chaque requete)
 *    - Grace period: si le cache expire, on garde les vieilles donnees
 * 
 * 2. PROTECTION DE L'API - Rate limiting et authentification
 *    - Limite de requetes par IP (100 req/15min pour les routes publiques)
 *    - Limite stricte pour l'API developpeur (1000 req/jour avec API key)
 *    - Systeme de cles API pour tracker les abus
 * ============================================================================
 */

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// CONFIGURATION DES CLES API (Simule une base de donnees)
// ============================================================================
const API_KEYS = {
  'dev-demo-key-001': { tier: 'free', dailyLimit: 1000, count: 0, lastReset: Date.now() },
  'dev-pro-key-002': { tier: 'pro', dailyLimit: 10000, count: 0, lastReset: Date.now() }
};

// ============================================================================
// CACHE AVEC TTL - PROTECTION DE LA SOURCE BRH
// ============================================================================
// Memoisation des donnees pour eviter de surcharger le serveur BRH
// ============================================================================

const CACHE_CONFIG = {
  ttlMinutes: 30,           // Duree de validite du cache
  staleWhileRevalidate: 60, // Grace period en minutes (donnees "stale" acceptables)
  lastFetch: null,
  lastSuccessfulFetch: null
};

let cachedRate = null;
let isFetching = false;     // Verrou pour eviter les requetes concurrentes

// ============================================================================
// MIDDLEWARE DE RATE LIMITING - PROTECTION DE L'API
// ============================================================================
// Limite generale par IP pour les routes publiques
// ============================================================================

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,                  // 100 requetes max par IP
  message: {
    error: 'Trop de requetes',
    message: 'Limite de 100 requetes par 15 minutes atteinte. Veuillez patienter.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Callback personnalise pour logging des abus
  handler: (req, res, next, options) => {
    console.warn(`[RATE LIMIT] IP bloquee: ${req.ip} - ${req.path}`);
    res.status(429).json(options.message);
  }
});

// ============================================================================
// MIDDLEWARE D'AUTHENTIFICATION API KEY
// ============================================================================
// Verification des cles pour les routes developpeur
// ============================================================================

function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  
  if (!apiKey) {
    return res.status(401).json({
      error: 'Authentification requise',
      message: 'Cette route necessite une cle API. Obtenez-la sur la section Developpeurs.'
    });
  }
  
  const keyData = API_KEYS[apiKey];
  if (!keyData) {
    console.warn(`[AUTH] Tentative avec cle invalide: ${apiKey.substring(0, 10)}...`);
    return res.status(403).json({
      error: 'Cle API invalide',
      message: 'La cle API fournie n\'est pas reconnue.'
    });
  }
  
  // Reset du compteur quotidien si necessaire
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  if (now - keyData.lastReset > oneDay) {
    keyData.count = 0;
    keyData.lastReset = now;
    console.log(`[AUTH] Reset quota pour cle: ${apiKey.substring(0, 10)}...`);
  }
  
  // Verification du quota
  if (keyData.count >= keyData.dailyLimit) {
    console.warn(`[AUTH] Quota depasse pour cle: ${apiKey.substring(0, 10)}...`);
    return res.status(429).json({
      error: 'Quota depasse',
      message: `Limite quotidienne de ${keyData.dailyLimit} requetes atteinte.`,
      resetTime: new Date(keyData.lastReset + oneDay).toISOString()
    });
  }
  
  // Incrementation du compteur
  keyData.count++;
  
  // Ajout des infos de quota dans les headers de reponse
  res.setHeader('X-RateLimit-Limit', keyData.dailyLimit);
  res.setHeader('X-RateLimit-Remaining', keyData.dailyLimit - keyData.count);
  res.setHeader('X-RateLimit-Reset', new Date(keyData.lastReset + oneDay).toISOString());
  
  req.apiKey = apiKey;
  req.keyData = keyData;
  next();
}

// ============================================================================
// FONCTION DE SCRAPING AVEC VERROU
// ============================================================================
// Protection: une seule requete BRH a la fois, meme avec 10000 utilisateurs
// ============================================================================

async function scrapeExchangeRate(force = false) {
  // Verrou: si un scraping est deja en cours, on attend
  if (isFetching) {
    console.log('[CACHE] Scraping deja en cours, attente...');
    // Attente max 10 secondes que le scraping en cours finisse
    let attempts = 0;
    while (isFetching && attempts < 20) {
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }
    return cachedRate;
  }
  
  // Verification du cache (sauf si force=true)
  if (!force && cachedRate) {
    const age = (Date.now() - CACHE_CONFIG.lastFetch) / 1000 / 60;
    if (age < CACHE_CONFIG.ttlMinutes) {
      console.log(`[CACHE] Donnees valides (${Math.round(age)}min), utilisation du cache`);
      return cachedRate;
    }
    console.log(`[CACHE] Donnees expirees (${Math.round(age)}min), rafraichissement...`);
  }
  
  isFetching = true;
  
  try {
    console.log('[BRH] Scraping des taux...');
    const response = await axios.get('https://www.brh.ht/taux-du-jour/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    const marcheBancaire = { achat: null, vente: null };
    const marcheInformel = { achat: null, vente: null };
    
    $('table').each((tableIndex, table) => {
      const rows = $(table).find('tr');
      rows.each((i, row) => {
        const rowText = $(row).text().toUpperCase();
        const cells = $(row).find('td');
        
        if (rowText.includes('MARCHE BANCAIRE') || rowText.includes('MARCHÉ BANCAIRE')) {
          const nextRow = rows.eq(i + 1);
          const nextCells = nextRow.find('td');
          if (nextCells.length >= 2) {
            const achatText = nextCells.eq(0).text().replace(/,/g, '.').trim();
            const venteText = nextCells.eq(1).text().replace(/,/g, '.').trim();
            const achat = parseFloat(achatText);
            const vente = parseFloat(venteText);
            if (!isNaN(achat) && achat > 100) marcheBancaire.achat = achat;
            if (!isNaN(vente) && vente > 100) marcheBancaire.vente = vente;
          }
        }
        
        if (rowText.includes('MARCHE INFORMEL') || rowText.includes('MARCHÉ INFORMEL')) {
          const nextRow = rows.eq(i + 1);
          const nextCells = nextRow.find('td');
          if (nextCells.length >= 2) {
            const achatText = nextCells.eq(0).text().replace(/,/g, '.').trim();
            const venteText = nextCells.eq(1).text().replace(/,/g, '.').trim();
            const achat = parseFloat(achatText);
            const vente = parseFloat(venteText);
            if (!isNaN(achat) && achat > 100) marcheInformel.achat = achat;
            if (!isNaN(vente) && vente > 100) marcheInformel.vente = vente;
          }
        }
      });
    });

    const taux_achat = marcheBancaire.achat || 130.64;
    const taux_vente = marcheBancaire.vente || 131.53;

    cachedRate = {
      devise_source: 'USD',
      devise_cible: 'HTG',
      taux_achat: taux_achat,
      taux_vente: taux_vente,
      marche_informel_achat: marcheInformel.achat || 131.00,
      marche_informel_vente: marcheInformel.vente || 136.00,
      date_mise_a_jour: new Date().toISOString(),
      source: 'BRH - Banque de la Republique d\'Haiti'
    };
    
    CACHE_CONFIG.lastFetch = Date.now();
    CACHE_CONFIG.lastSuccessfulFetch = Date.now();
    
    console.log(`[BRH] Taux mis a jour: Achat=${taux_achat}, Vente=${taux_vente}`);
    return cachedRate;
    
  } catch (error) {
    console.error('[BRH] Erreur lors du scraping:', error.message);
    
    // Grace period: si on a des donnees en cache, on les garde meme si vieilles
    if (cachedRate) {
      const age = (Date.now() - CACHE_CONFIG.lastFetch) / 1000 / 60;
      if (age < CACHE_CONFIG.staleWhileRevalidate) {
        console.log(`[CACHE] Utilisation des donnees stale (${Math.round(age)}min) pendant l'erreur`);
        return { ...cachedRate, cached: true, stale: true };
      }
    }
    
    // Valeurs de secours si tout echoue
    return {
      devise_source: 'USD',
      devise_cible: 'HTG',
      taux_achat: 130.64,
      taux_vente: 131.53,
      marche_informel_achat: 131.00,
      marche_informel_vente: 136.00,
      date_mise_a_jour: new Date().toISOString(),
      note: 'Valeurs par defaut - BRH inaccessible',
      fallback: true
    };
  } finally {
    isFetching = false;
  }
}

// ============================================================================
// CONFIGURATION EXPRESS
// ============================================================================

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Trust proxy pour obtenir les vraies IPs derriere un load balancer
app.set('trust proxy', 1);

// ============================================================================
// ROUTES PUBLIQUES (Rate limited)
// ============================================================================

// Route principale - sert le frontend (pas de rate limit strict)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check (pas de rate limit)
app.get('/api/health', (req, res) => {
  const cacheAge = CACHE_CONFIG.lastFetch 
    ? Math.round((Date.now() - CACHE_CONFIG.lastFetch) / 1000 / 60)
    : null;
  
  res.json({ 
    status: 'OK', 
    cacheAgeMinutes: cacheAge,
    lastFetch: CACHE_CONFIG.lastFetch ? new Date(CACHE_CONFIG.lastFetch).toISOString() : null
  });
});

// ============================================================================
// ROUTES API (Rate limited + Cache)
// ============================================================================

/**
 * GET /api/taux/latest - Taux bancaire
 * 
 * PROTECTION IMPLEMENTEE:
 * - Rate limiting: 100 requetes par IP / 15min
 * - Cache: les donnees BRH sont mises en cache 30min
 * - Aucun scraping BRH n'a lieu lors de cette requete
 */
app.get('/api/taux/latest', generalLimiter, (req, res) => {
  // Les donnees viennent du cache, jamais du BRH directement
  if (!cachedRate) {
    return res.status(503).json({
      error: 'Service indisponible',
      message: 'Donnees temporairement indisponibles. Reessayez dans quelques secondes.'
    });
  }
  
  res.json(cachedRate);
});

/**
 * GET /api/taux/informel - Taux informel
 * 
 * PROTECTION IMPLEMENTEE:
 * - Rate limiting: 100 requetes par IP / 15min
 * - Cache partage avec le taux bancaire
 */
app.get('/api/taux/informel', generalLimiter, (req, res) => {
  if (!cachedRate) {
    return res.status(503).json({
      error: 'Service indisponible',
      message: 'Donnees temporairement indisponibles.'
    });
  }
  
  res.json({
    devise_source: 'USD',
    devise_cible: 'HTG',
    taux_achat: cachedRate.marche_informel_achat,
    taux_vente: cachedRate.marche_informel_vente,
    date_mise_a_jour: cachedRate.date_mise_a_jour
  });
});

// ============================================================================
// ROUTES API DEVELOPPEUR (API Key + Rate limiting)
// ============================================================================

/**
 * GET /api/dev/rates - Route developpeur avec plus de metadata
 * 
 * PROTECTION IMPLEMENTEE:
 * - Authentification requise (API Key)
 * - Rate limiting par cle (1000 requetes/jour pour les comptes free)
 * - Headers de quota pour tracking client-side
 */
app.get('/api/dev/rates', requireApiKey, (req, res) => {
  if (!cachedRate) {
    return res.status(503).json({ error: 'Donnees indisponibles' });
  }
  
  res.json({
    ...cachedRate,
    _meta: {
      tier: req.keyData.tier,
      requestNumber: req.keyData.count,
      dailyLimit: req.keyData.dailyLimit,
      cached: !isFetching && CACHE_CONFIG.lastFetch && (Date.now() - CACHE_CONFIG.lastFetch < CACHE_CONFIG.ttlMinutes * 60 * 1000)
    }
  });
});

/**
 * POST /api/dev/refresh - Force le rafraichissement (admin only)
 * 
 * PROTECTION: Cle API avec tier 'pro' requis
 */
app.post('/api/dev/refresh', requireApiKey, async (req, res) => {
  if (req.keyData.tier !== 'pro') {
    return res.status(403).json({
      error: 'Acces refuse',
      message: 'Cette action necessite un compte Pro.'
    });
  }
  
  console.log(`[ADMIN] Rafraichissement force par cle: ${req.apiKey.substring(0, 10)}...`);
  const data = await scrapeExchangeRate(true);
  res.json({ success: true, data });
});

// ============================================================================
// CRON JOB - Rafraichissement automatique
// ============================================================================
// Le scraping a lieu:
// - Toutes les 30 minutes (cron */30 * * * *)
// - Et jamais lors d'une requete utilisateur
// ============================================================================

cron.schedule('*/30 * * * *', () => {
  console.log('[CRON] Rafraichissement automatique des taux...');
  scrapeExchangeRate();
});

// Scraping initial au demarrage
scrapeExchangeRate().then(() => {
  app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`  TAUX HTG/USD API - Serveur demarre`);
    console.log(`========================================`);
    console.log(`Port: ${PORT}`);
    console.log(`Cache TTL: ${CACHE_CONFIG.ttlMinutes} minutes`);
    console.log(`Rate limit: 100 req/15min par IP`);
    console.log(`API Keys: ${Object.keys(API_KEYS).length} cles configurees`);
    console.log(`\nRoutes:`);
    console.log(`  - GET /api/taux/latest (public, rate limited)`);
    console.log(`  - GET /api/taux/informel (public, rate limited)`);
    console.log(`  - GET /api/dev/rates (API key requis)`);
    console.log(`  - POST /api/dev/refresh (API key Pro requis)`);
    console.log(`========================================\n`);
  });
});
