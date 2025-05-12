import express from "express";
import metascraper from "metascraper";
import metascraperAuthor from "metascraper-author";
import metascraperDate from "metascraper-date";
import metascraperDescription from "metascraper-description";
import metascraperImage from "metascraper-image";
import metascraperLogo from "metascraper-logo";
import metascraperPublisher from "metascraper-publisher";
import metascraperTitle from "metascraper-title";
import metascraperUrl from "metascraper-url";
import metascraperYoutube from "metascraper-youtube";
import got from "got";
import NodeCache from "node-cache";
import axios from "axios";
import imageSize from "image-size";

// Configuration du cache (TTL: 1 heure)
const cache = new NodeCache({ stdTTL: 3600 });

// Validation des URLs
const isValidUrl = (url) => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

// Configuration de Metascraper avec tous les modules nécessaires
const scraper = metascraper([
  metascraperAuthor(),
  metascraperDate(),
  metascraperDescription(),
  metascraperImage(),
  metascraperLogo(),
  metascraperPublisher(),
  metascraperTitle(),
  metascraperUrl(),
  metascraperYoutube(),
  // Ajout d'une règle personnalisée pour extraire la langue
  () => ({
    lang: [({ htmlDom }) => htmlDom("html").attr("lang")],
    // Ajout d'une règle personnalisée pour extraire le favicon comme logo
    logo: [
      ({ htmlDom, url }) => {
        const favicon =
          htmlDom('link[rel="icon"]').attr("href") ||
          htmlDom('link[rel="shortcut icon"]').attr("href");
        if (favicon && !favicon.startsWith("http")) {
          const baseUrl = new URL(url);
          return `${baseUrl.origin}${
            favicon.startsWith("/") ? "" : "/"
          }${favicon}`;
        }
        return favicon;
      },
    ],
  }),
]);

const app = express();

// Middleware pour gérer les requêtes CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*"); // À ajuster en production
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  next();
});

// Endpoint pour récupérer l'aperçu des liens
app.get("/api/preview", async (req, res) => {
  const { url } = req.query;

  // Vérification de la présence de l'URL
  if (!url) {
    return res.status(400).json({ error: "URL manquante" });
  }

  // Validation de l'URL
  if (!isValidUrl(url)) {
    return res.status(400).json({ error: "URL invalide" });
  }

  // Vérifier si les métadonnées sont en cache
  const cachedData = cache.get(url);
  if (cachedData) {
    return res.json(cachedData);
  }

  try {
    // Récupérer le HTML de l'URL avec got
    const { body: html, url: finalUrl } = await got(url, {
      timeout: { request: 50000 }, // Timeout de 5 secondes
      retry: { limit: 2 }, // Réessayer 2 fois en cas d'échec
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; LinkPreviewBot/1.0; +https://yourapp.com)", // Ajout d'un User-Agent pour éviter les blocages
      },
    });

    // Extraire les métadonnées avec Metascraper
    const metadata = await scraper({ html, url: finalUrl });

    // Enrichir les données de l'image
    let imageData = { url: metadata.image || "" };
    if (imageData.url) {
      try {
        const imageResponse = await axios.get(imageData.url, {
          responseType: "arraybuffer",
        });
        const buffer = Buffer.from(imageResponse.data);
        const dimensions = imageSize(buffer);
        imageData = {
          url: imageData.url,
          type:
            imageResponse.headers["content-type"].split("/")[1] || "unknown",
          size: Buffer.byteLength(buffer),
          height: dimensions.height,
          width: dimensions.width,
          size_pretty: `${(Buffer.byteLength(buffer) / 1000).toFixed(1)} kB`,
        };
      } catch (error) {
        console.warn(
          `Erreur lors de l'enrichissement de l'image pour ${imageData.url}:`,
          error.message
        );
      }
    }

    // Enrichir les données du logo
    let logoData = { url: metadata.logo || "" };
    if (logoData.url) {
      try {
        const logoResponse = await axios.get(logoData.url, {
          responseType: "arraybuffer",
        });
        const buffer = Buffer.from(logoResponse.data);
        const dimensions = imageSize(buffer);
        logoData = {
          url: logoData.url,
          type: logoResponse.headers["content-type"].split("/")[1] || "unknown",
          size: Buffer.byteLength(buffer),
          height: dimensions.height,
          width: dimensions.width,
          size_pretty: `${(Buffer.byteLength(buffer) / 1000).toFixed(1)} kB`,
        };
      } catch (error) {
        console.warn(
          `Erreur lors de l'enrichissement du logo pour ${logoData.url}:`,
          error.message
        );
      }
    }

    // Structure personnalisée des données à retourner
    const responseData = {
      title: metadata.title || "",
      description: metadata.description || "",
      image: imageData,
      logo: logoData,
      lang: metadata.lang || "",
      publisher: metadata.publisher || "",
      url: metadata.url || finalUrl,
    };

    // Stocker les métadonnées dans le cache
    cache.set(url, responseData);

    res.json(responseData);
  } catch (error) {
    console.error(
      "Erreur lors de la récupération des métadonnées :",
      error.message
    );
    res.status(500).json({
      error: "Impossible de récupérer les métadonnées",
      details: error.message,
    });
  }
});

// Dans server.mjs
app.get("/api/proxy", async (req, res) => {
  const { url } = req.query;

  if (!url) return res.status(400).json({ error: "URL manquante" });
  if (!isValidUrl(url)) return res.status(400).json({ error: "URL invalide" });

  try {
    const response = await axios.get(url, {
      responseType: "stream", // Récupérer comme flux pour les fichiers binaires
    });
    res.setHeader("Content-Type", response.headers["content-type"]);
    response.data.pipe(res); // Transférer le fichier au client
  } catch (error) {
    console.error("Erreur lors du proxy :", error.message);
    res
      .status(500)
      .json({ error: "Erreur lors de la récupération du fichier" });
  }
});

// Gestion des erreurs globales
app.use((err, req, res, next) => {
  console.error("Erreur serveur :", err);
  res.status(500).json({ error: "Erreur interne du serveur" });
});

// Démarrer le serveur
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
