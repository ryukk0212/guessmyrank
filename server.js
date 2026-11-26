const express = require("express"), multer = require("multer"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
app.set('trust proxy', true); // Pour récupérer la vraie IP
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const OWNERS = ["1511466511611461845", "1247495035361038410", "1305652757578907720"];
const D_ID = process.env.DISCORD_CLIENT_ID || "", D_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const REDIRECT = process.env.DISCORD_REDIRECT_URI || "http://localhost:" + PORT + "/auth/discord/callback";
const SECURE = REDIRECT.startsWith("https://");
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const RANKS = ["Fer","Bronze","Argent","Or","Platine","Diamant","Ascendant","Immortel","Radiant"];
const id = () => crypto.randomBytes(6).toString("hex");
const clean = (s, n = 40) => String(s || "").trim().slice(0, n);

const s3 = new S3Client({
  endpoint: `https://${process.env.B2_ENDPOINT}`,
  region: process.env.B2_REGION,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APP_KEY,
  },
});

async function uploadToB2(file, prefix = "") {
  const fileKey = `${prefix}${id()}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "")}`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.B2_BUCKET_NAME,
    Key: fileKey,
    Body: file.buffer,
    ContentType: file.mimetype,
  }));
  return `https://${process.env.B2_BUCKET_NAME}.${process.env.B2_ENDPOINT}/${fileKey}`;
}

// --- DB SUR BACKBLAZE ---
let db = { clips: [], votes: [], reports: [], bans: [] };
async function loadDb() {
  try {
    const data = await s3.send(new GetObjectCommand({ Bucket: process.env.B2_BUCKET_NAME, Key: "db.json" }));
    const str = await data.Body.transformToString();
    db = JSON.parse(str);
    if (!db.reports) db.reports = [];
    if (!db.bans) db.bans = [];
  } catch (err) { console.log("Nouvelle DB initialisée"); }
}
loadDb();

const save = async () => { 
  try {
    await s3.send(new PutObjectCommand({ Bucket: process.env.B2_BUCKET_NAME, Key: "db.json", Body: JSON.stringify(db), ContentType: "application/json" })); 
  } catch(e) { console.error("Erreur sauvegarde DB B2", e); }
};

const upload = multer({ storage: multer.memoryStorage(), fileFilter: (_, file, cb) => cb(null, /^video\//.test(file.mimetype)) });

app.get("/api/clips", (req, res) => { const me = clean(req.query.uid, 40); res.json(db.clips.filter(c => !me || c.uid !== me).map(({ id, pseudo, platform, yt, url, medal, created }) => ({ id, pseudo, platform, yt, url, medal, created }))); });

app.post("/api/clips", upload.single("video"), async (req, res) => {
  const b = req.body, rank = clean(b.rank), yt = clean(b.yt, 11), medal = clean(b.medal, 200);
  const uid = clean(b.uid, 40);
  
  // VÉRIFICATION DU BAN
  const userIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const isBanned = db.bans.some(ban => ban.uid === uid || (ban.ip && ban.ip === userIp));
  if (isBanned) return res.status(403).json({ error: "Vous avez été banni et ne pouvez plus envoyer de clips." });

  if (!RANKS.includes(rank) || !clean(b.pseudo) || !["PC", "Console"].includes(b.platform)) return res.status(400).json({ error: "Champs invalides" });
  if (!req.file && !/^[\w-]{11}$/.test(yt) && !medal) return res.status(400).json({ error: "Vidéo, YouTube ou Medal manquant" });

  let videoUrl = undefined, videoYt = undefined, videoMedal = undefined;
  if (req.file) {
    try { videoUrl = await uploadToB2(req.file, "videos/"); } catch (err) { return res.status(500).json({ error: "Erreur d'envoi vidéo" }); }
  } else if (medal) { videoMedal = medal; } 
  else { videoYt = yt; }

  db.clips.push({ id: id(), uid, ip: userIp, pseudo: clean(b.pseudo), discord: clean(b.discord), platform: b.platform, rank,
    div: rank === "Radiant" ? 0 : Math.min(3, Math.max(1, +b.div || 1)),
    yt: videoYt, url: videoUrl, medal: videoMedal, created: Date.now() });
  await save(); res.json({ ok: true });
});

app.post("/api/clips/:id/vote", async (req, res) => {
  const c = db.clips.find(x => x.id === req.params.id), rank = req.body.rank, uid = clean(req.body.uid, 40), pseudo = clean(req.body.pseudo, 20) || "Anonyme";
  if (!c || !RANKS.includes(rank) || !uid) return res.status(400).json({ error: "Invalide" });
  let v = db.votes.find(x => x.clip === c.id && x.uid === uid);
  if (!v) { v = { clip: c.id, uid, pseudo, rank }; db.votes.push(v); } else { v.pseudo = pseudo; v.rank = rank; }
  await save();
  const tally = Object.fromEntries(RANKS.map(r => [r, 0]));
  db.votes.filter(x => x.clip === c.id).forEach(x => tally[x.rank]++);
  res.json({ mine: v.rank, rank: c.rank, div: c.div, tally });
});

app.get("/api/leaderboard", (req, res) => {
  const stats = {};
  db.votes.forEach(v => {
    const clip = db.clips.find(c => c.id === v.clip);
    if (!clip) return;
    const name = v.pseudo || "Anonyme";
    if (!stats[name]) stats[name] = { pseudo: name, total: 0, correct: 0 };
    stats[name].total++;
    if (v.rank === clip.rank) stats[name].correct++;
  });
  res.json(Object.values(stats).sort((a, b) => b.correct - a.correct || b.total - a.total).slice(0, 50));
});

app.post("/api/clips/:id/report", async (req, res) => {
  const c = db.clips.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Clip introuvable" });
  db.reports.push({ id: id(), clip: c.id, reason: clean(req.body.reason, 100) || "Non précisé", date: Date.now() });
  await save(); res.json({ ok: true });
});

// --- PARAMÈTRES SUR BACKBLAZE ---
const SET = path.join(__dirname, "data", "settings.json");
const DEF = { name: "onlymy", tagline: "GUESS MY RANK · VALORANT", accent: "#ff4d8d", bg: "#0b060b", bgImage: "", blur: 18, dim: 0.6, favicon: "",
  submitBlocks: ["clip","rank","identity","platform","send"].map(id => ({ id, w: id === "send" ? "full" : "half" })),
  playBlocks: ["filters","info","video","ranks"],
  links: [
    { id: "discord", label: "REJOINDRE LE DISCORD", sub: "La commu, les customs et les annonces", url: "https://discord.gg/onlymy", color: "#ff4d8d", icon: "💬", iconImg: "/logos/discord.png", pos: "bottom", big: true },
    { id: "paypal", label: "Me soutenir", sub: "Un petit don via PayPal", url: "https://www.paypal.com/paypalme/slashair", color: "#4f8cff", icon: "💙", iconImg: "/logos/paypal.png", pos: "bottom", big: false },
    { id: "uwuanime", label: "UwUanime", sub: "Best site streaming anime / kdrama", url: "https://uwuanime.com/", color: "#ff6fa5", icon: "🎬", iconImg: "/logos/uwuanime.png", pos: "bottom", big: false },
    { id: "tiktok", label: "Mon TikTok", sub: "@.myybe, clips et lives", url: "https://www.tiktok.com/@.myybe", color: "#25f4ee", icon: "🎵", iconImg: "/logos/tiktok.png", pos: "bottom", big: false },
    { id: "tunelio", label: "Tunelio", sub: "Outil d’optimisation PC · voir les offres !!", url: "https://tunelio.com/pricing", color: "#ff4d6d", icon: "⚡", iconImg: "/logos/tunelio.png", pos: "bottom", big: false },
    { id: "contact", label: "Contact pro", sub: "contact.onlymy@gmail.com", url: "mailto:contact.onlymy@gmail.com", color: "#ea4335", icon: "✉️", iconImg: "/logos/gmail.png", pos: "bottom", big: false }] };

let settings = DEF;
async function loadSettings() {
  try {
    const data = await s3.send(new GetObjectCommand({ Bucket: process.env.B2_BUCKET_NAME, Key: "settings.json" }));
    const str = await data.Body.transformToString();
    settings = { ...DEF, ...JSON.parse(str) };
  } catch (err) { 
    if (fs.existsSync(SET)) settings = { ...DEF, ...JSON.parse(fs.readFileSync(SET, "utf8")) };
  }
}
loadSettings();

const col = (v, d) => /^#[0-9a-f]{6}$/i.test(v) ? v : d;
// Accepte les liens http et le dossier /logos/
const img = v => /^(https?:\/\/\S+|\/logos\/[\w.-]+\.png)$/i.test(v) ? v : ""; 
const lnk = v => /^(https?:\/\/|mailto:)\S+$/i.test(String(v)) ? String(v).slice(0, 500) : "";
const uniq = (arr, ids, f) => { const o = []; (Array.isArray(arr) ? arr : []).forEach(x => { const i = f(x); if (ids.includes(i) && !o.find(y => f(y) === i)) o.push(x); }); ids.forEach(i => { if (!o.find(y => f(y) === i)) o.push(i); }); return o; };

function sanitize(b = {}) {
  const sIds = ["clip","rank","identity","platform","send"];
  const sb = uniq((b.submitBlocks || []).filter(x => x && x.id), sIds, x => x.id || x).map(x => typeof x === "string" ? { id: x, w: "half" } : { id: x.id, w: x.w === "full" ? "full" : "half" });
  return { name: clean(b.name, 40) || DEF.name, tagline: clean(b.tagline, 60), accent: col(b.accent, DEF.accent), bg: col(b.bg, DEF.bg),
    bgImage: img(b.bgImage), favicon: img(b.favicon), blur: Math.min(80, Math.max(0, +b.blur || 0)), dim: Math.min(0.95, Math.max(0, +b.dim || 0)),
    submitBlocks: sb, playBlocks: uniq(b.playBlocks, DEF.playBlocks, x => x),
    links: (Array.isArray(b.links) ? b.links : []).slice(0, 20).map(l => ({ id: clean(l.id, 20) || id(), label: clean(l.label, 60), sub: clean(l.sub, 100),
      url: lnk(l.url), color: col(l.color, "#ff4d8d"), icon: clean(l.icon, 4), iconImg: img(l.iconImg), pos: l.pos === "top" ? "top" : "bottom", big: !!l.big,
      w: Math.min(460, Math.max(0, Math.round(+l.w || 0))) >= 80 ? Math.min(460, Math.round(+l.w)) : 0, h: Math.min(200, Math.max(0, Math.round(+l.h || 0))) >= 40 ? Math.min(200, Math.round(+l.h)) : 0 })) };
}

// --- AUTH ---
const sign = v => crypto.createHmac("sha256", SESSION_SECRET).update(v).digest("base64url");
const mk = o => { const p = Buffer.from(JSON.stringify(o)).toString("base64url"); return p + "." + sign(p); };
const rd = t => { try { const [p, g] = String(t).split("."); const a = Buffer.from(sign(p)), b = Buffer.from(g || "");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const o = JSON.parse(Buffer.from(p, "base64url").toString()); return o.exp > Date.now() ? o : null; } catch { return null; } };
const cookies = req => Object.fromEntries(String(req.headers.cookie || "").split(";").map(x => x.trim().split(/=(.*)/s).slice(0, 2)).filter(x => x[0]));
const setC = (res, n, v, age) => res.append("Set-Cookie", `${n}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${SECURE ? "; Secure" : ""}`);
const session = req => { const o = rd(cookies(req).sess); return o && OWNERS.includes(o.id) ? o : null; };
const auth = (req, res, next) => session(req) ? next() : res.sendStatus(401);

app.get("/auth/discord", (req, res) => {
  if (!D_ID || !D_SECRET) return res.status(500).send("DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET manquants.");
  const state = crypto.randomBytes(16).toString("hex");
  setC(res, "st", mk({ state, exp: Date.now() + 10 * 60 * 1000 }), 600);
  res.redirect("https://discord.com/oauth2/authorize?" + new URLSearchParams({ client_id: D_ID, response_type: "code", redirect_uri: REDIRECT, scope: "identify", state, prompt: "consent" }));
});
app.get("/auth/discord/callback", async (req, res) => {
  const st = rd(cookies(req).st); setC(res, "st", "", 0);
  if (!st || !req.query.code || st.state !== req.query.state) return res.redirect("/admin?err=state");
  try {
    const t = await fetch("https://discord.com/api/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: D_ID, client_secret: D_SECRET, grant_type: "authorization_code", code: String(req.query.code), redirect_uri: REDIRECT }) }).then(r => r.json());
    if (!t.access_token) return res.redirect("/admin?err=token");
    const u = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: "Bearer " + t.access_token } }).then(r => r.json());
    if (!u.id || !OWNERS.includes(u.id)) return res.redirect("/admin?err=denied");
    setC(res, "sess", mk({ id: u.id, name: u.global_name || u.username, avatar: u.avatar || "", exp: Date.now() + 7 * 864e5 }), 7 * 86400);
    res.redirect("/admin");
  } catch { res.redirect("/admin?err=token"); }
});
app.post("/auth/logout", (_, res) => { setC(res, "sess", "", 0); res.json({ ok: true }); });
app.get("/api/admin/me", (req, res) => { const o = session(req); if (!o) return res.sendStatus(401);
  res.json({ id: o.id, name: o.name, avatar: o.avatar ? `https://cdn.discordapp.com/avatars/${o.id}/${o.avatar}.png?size=128` : "", owner: o.id === OWNERS[0] }); });

// --- ADMIN ---
const imgUp = multer({ storage: multer.memoryStorage(), fileFilter: (_, f, cb) => cb(null, /^image\/(png|jpeg|webp|gif|x-icon|vnd\.microsoft\.icon)$/.test(f.mimetype)) });

app.get("/api/settings", (_, r) => r.json(settings));
app.get("/admin", (_, r) => r.sendFile(path.join(__dirname, "public", "admin.html")));

app.put("/api/admin/settings", auth, async (req, res) => { 
  settings = sanitize(req.body); 
  fs.writeFileSync(SET, JSON.stringify(settings)); // Sauvegarde locale (fallback)
  try {
    await s3.send(new PutObjectCommand({ Bucket: process.env.B2_BUCKET_NAME, Key: "settings.json", Body: JSON.stringify(settings), ContentType: "application/json" }));
  } catch(e) { console.error("Erreur save settings B2", e); }
  res.json(settings); 
});

app.post("/api/admin/upload", auth, imgUp.single("img"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Image invalide" });
  try { res.json({ url: await uploadToB2(req.file, "images/") }); } catch(err) { res.status(500).json({ error: "Erreur d'upload" }); }
});

app.get("/api/admin/contacts", auth, (_, res) => res.json(db.clips.map(({ id, pseudo, discord, rank, div, yt, url, medal, ip, uid }) => ({ id, pseudo, discord, rank, div, yt, url, medal, ip, uid }))));
app.get("/api/admin/reports", auth, (_, res) => res.json(db.reports));
app.get("/api/admin/bans", auth, (_, res) => res.json(db.bans));

app.post("/api/admin/ban", auth, async (req, res) => {
  const { uid, ip, pseudo } = req.body;
  if (!uid && !ip) return res.status(400).json({ error: "UID ou IP requis" });
  const alreadyBanned = db.bans.some(b => (uid && b.uid === uid) || (ip && b.ip === ip));
  if (!alreadyBanned) { db.bans.push({ id: id(), uid, ip, pseudo, date: Date.now() }); await save(); }
  res.json({ ok: true });
});
app.delete("/api/admin/bans/:id", auth, async (req, res) => { db.bans = db.bans.filter(b => b.id !== req.params.id); await save(); res.json({ ok: true }); });

app.delete("/api/admin/clips/:id", auth, async (req, res) => {
  const c = db.clips.find(x => x.id === req.params.id);
  if (c && c.url && c.url.includes("backblazeb2.com")) {
    try {
      const key = c.url.split('/').pop();
      await s3.send(new DeleteObjectCommand({ Bucket: process.env.B2_BUCKET_NAME, Key: `videos/${key}` }));
    } catch(e) { console.error("Erreur suppression B2", e); }
  }
  db.clips = db.clips.filter(x => x.id !== req.params.id); db.votes = db.votes.filter(v => v.clip !== req.params.id); db.reports = db.reports.filter(r => r.clip !== req.params.id); 
  await save(); res.json({ ok: true }); 
});

app.delete("/api/admin/reports/:id", auth, async (req, res) => { db.reports = db.reports.filter(r => r.id !== req.params.id); await save(); res.json({ ok: true }); });

app.listen(PORT, () => console.log("onlymy sur http://localhost:" + PORT));