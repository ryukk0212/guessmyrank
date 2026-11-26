const express = require("express"), multer = require("multer"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3"); // Ajout

// ... (constantes OWNERS, D_ID, etc. inchangées) ...

// Configuration du client S3 pour Backblaze B2
const s3 = new S3Client({
  endpoint: `https://${process.env.B2_ENDPOINT}`, // ex: s3.us-west-004.backblazeb2.com
  region: process.env.B2_REGION, // ex: us-west-004
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APP_KEY,
  },
});

// Stockage en mémoire au lieu du disque
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_, file, cb) => cb(null, /^video\//.test(file.mimetype))
});

// ... (initialisation app, db, etc. inchangées) ...

// Route d'upload modifiée
app.post("/api/clips", upload.single("video"), async (req, res) => {
  const b = req.body, rank = clean(b.rank), yt = clean(b.yt, 11);
  if (!RANKS.includes(rank) || !clean(b.pseudo) || !["PC", "Console"].includes(b.platform)) {
    return res.status(400).json({ error: "Champs invalides" });
  }
  if (!req.file && !/^[\w-]{11}$/.test(yt)) {
    return res.status(400).json({ error: "Vidéo ou lien YouTube manquant" });
  }

  let videoUrl = undefined;
  let videoYt = undefined;

  if (req.file) {
    try {
      const fileKey = `${id()}-${req.file.originalname.replace(/[^.a-z0-9]/gi, "")}`;
      const command = new PutObjectCommand({
        Bucket: process.env.B2_BUCKET_NAME,
        Key: fileKey,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      });
      await s3.send(command);
      
      // Construction de l'URL publique (si le bucket est public)
      videoUrl = `https://${process.env.B2_BUCKET_NAME}.${process.env.B2_ENDPOINT}/${fileKey}`;
    } catch (err) {
      console.error("Erreur upload B2:", err);
      return res.status(500).json({ error: "Erreur lors de l'envoi de la vidéo" });
    }
  } else {
    videoYt = yt;
  }

  db.clips.push({
    id: id(),
    uid: clean(b.uid, 40),
    pseudo: clean(b.pseudo),
    discord: clean(b.discord),
    platform: b.platform,
    rank,
    div: rank === "Radiant" ? 0 : Math.min(3, Math.max(1, +b.div || 1)),
    yt: videoYt,
    url: videoUrl, // Contient maintenant l'URL B2
    created: Date.now()
  });

  save();
  res.json({ ok: true });
});

// ... (le reste du fichier reste identique) ...