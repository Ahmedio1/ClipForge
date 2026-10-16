# ClipForge

Bibliothèque locale de clips de jeu : rangement automatique, découpe, montage multi-clips et publication.

## Lancer

```bash
npm install
npm start          # → http://localhost:4317
npm test           # 76 tests : unitaires, bout en bout (FFmpeg, Whisper, rclone, Ollama, MCP), navigateur
```

## Appli de bureau (Windows, macOS, Linux)

ClipForge existe en appli autonome (Electron) : double-clic, pas de terminal ni de Node.js à installer.
Tes données vont dans le dossier de l'appli (`~/.config/ClipForge`, `%APPDATA%\ClipForge`,
`~/Library/Application Support/ClipForge`).

```bash
npm run app          # lancer l'appli de bureau depuis les sources
npm run dist:linux   # → dist/ClipForge-<version>.AppImage
npm run dist:win     # → dist/ClipForge-<version>-windows-portable.zip (depuis Linux)
```

- **Toutes plateformes** : onglet *Actions* de GitHub → « Applications de bureau » → *Run workflow*
  (ou pousser un tag `v1.0.0`) : installateur Windows `.exe`, `.dmg` macOS (Apple Silicon), AppImage Linux.
- Les applis ne sont pas signées (certificats payants) : Windows SmartScreen → « Informations
  complémentaires » → « Exécuter quand même » ; macOS → clic droit → Ouvrir (ou `xattr -cr /Applications/ClipForge.app`).
- Linux : l'AppImage a besoin de FUSE 2 (`sudo apt install libfuse2t64` sur Ubuntu/Debian récents).
- `scripts/check-package.mjs` fait échouer la fabrication si un fichier privé (base, clés, exports) s'y glisse.

FFmpeg est fourni par `ffmpeg-static`, rien d'autre à installer. Le test navigateur utilise le
Chromium de Playwright s'il est présent (`CHROME_PATH` pour en indiquer un autre) ; sinon il est sauté.

## Fonctions

**Bibliothèque**
- Dossier surveillé (par défaut `~/Videos/Captures`, modifiable via ⚙), glisser-déposer pour importer.
- Noms Xbox Game Bar (`Valorant 2026-10-15 21-04-33.mp4`, `Valorant 10_15_2026 9_04_33 PM.mp4`) classés
  par jeu et par date ; sinon le sous-dossier sert de nom de jeu.
- Recherche, tri, favoris, titres, tags.

**Découpe** : sélection début/fin (souris ou `I`/`O`), export original, 9:16 recadré ou 9:16 fond flou.

**Montages**
- Coche des clips (✓ ou Maj + clic) → « Créer un montage », ou « Ajouter à un montage » depuis l'éditeur.
- Séquence réordonnable par glisser-déposer, découpe de chaque clip, duplication.
- Format 9:16 / 16:9, remplissage flou / recadré / bandes noires, 30 ou 60 i/s.
- 8 transitions, fondu d'ouverture/fermeture, volume du jeu.
- Textes (position, taille, couleur, fond, timing), retour à la ligne automatique.
- Musique (importée dans la bibliothèque musicale, bouclée, volume réglable).

**Moments forts** (✨)
- Chaque clip est analysé : pics de son (tirs, cris, explosions) ou, sans son, gros changements d'image.
- Dans l'éditeur : courbe d'intensité sur la timeline, et un clic sur un moment le sélectionne.
- « ✨ Best-of auto » : coche des clips, ClipForge garde le meilleur moment de chacun (60 s max).

**Sous-titres automatiques** (🎙, onglet Textes du montage)
- Reconnaissance vocale Whisper **en local** (transformers.js). Le modèle (≈ 80 Mo, ou 250 Mo en
  mode précis) est téléchargé une seule fois dans `data/models`.
- 7 langues, style TikTok (gros, centré, majuscules) ou classique, 2 à 8 mots par ligne, chaque ligne
  reste modifiable. Régénérer remplace les anciens sous-titres sans toucher tes textes.

**Modèles de montage** : 3 modèles fournis (TikTok dynamique, Best-of flou, YouTube classique), et
« Enregistrer ce style » pour garder les tiens (format, transitions, musique, textes fixes comme ton pseudo).

**Sur le téléphone** (⚙ Réglages → Accès depuis le téléphone)
- Scanne le QR code (même Wi-Fi). Il contient une clé secrète, puis un cookie garde la session.
- Désactivé par défaut. Sans la clé, tout est refusé. Le téléphone ne peut pas changer les réglages du PC.
- « Changer la clé » déconnecte tous les téléphones.
- Interface adaptée au mobile, avec un bouton « Importer » pour envoyer des vidéos depuis le téléphone.

**Mise en page « Combat »** (Tekken, Street Fighter…) : bandeau des barres de vie, caméra virtuelle
qui suit les persos (détection locale, zoom image par image), légende de replay retirée. Format d'export
« Vertical combat » ou modèle « Combat ». Le son de tous les exports est normalisé à −14 LUFS.

**Sources cloud** (☁) : OneDrive, Google Drive, Dropbox, iCloud (Drive et Photos), Mega, NAS/partage
Windows, ou un dossier monté. Basé sur rclone (téléchargé et vérifié automatiquement). Les nouvelles
vidéos sont copiées dans `<dossier des clips>/Cloud/<source>` selon l'intervalle choisi.
Google Drive : utilise tes identifiants Google Cloud (ceux de YouTube sont réutilisés).

**IA** (✨) : n'importe quel fournisseur — Claude (SDK officiel), ChatGPT, Gemini, Mistral, Groq,
OpenRouter, DeepSeek, ou tout service compatible OpenAI — et l'IA locale (Ollama, LM Studio).
- Textes de publication par plateforme (« Rédiger avec l'IA »), en regardant la vidéo.
- Accroches pour le haut des shorts.
- « Best-of IA » : l'IA regarde les moments forts et garde les plus spectaculaires.
- Assistant de montage : une demande en français modifie le montage, avec annulation.
- Les clés restent sur ton PC (`data/ai.json`, lisible par toi seul) et ne sont jamais renvoyées à l'interface.
- IA locale : ClipForge démarre tout seul Ollama s'il est installé dans `~/.local/ollama`
  (carte graphique intégrée AMD/Intel utilisée via Vulkan).

**Avec ton abonnement IA (MCP)** : les abonnements (Claude Pro/Max, Gemini…) ne donnent pas de clé
d'API, donc c'est ton appli d'IA qui pilote ClipForge via MCP. Elle liste et **regarde** tes clips,
crée et modifie un montage, génère les sous-titres, rend la vidéo, vérifie le rendu et publie.
- Claude Code : `claude mcp add --transport http clipforge http://localhost:4317/mcp`
  (ou lance `claude` dans ce dossier : `.mcp.json` le déclare déjà)
- Gemini CLI : `{"mcpServers":{"clipforge":{"httpUrl":"http://localhost:4317/mcp"}}}` dans `~/.gemini/settings.json`
- Claude Desktop : `{"mcpServers":{"clipforge":{"command":"node","args":["<chemin>/bin/clipforge-mcp.js"]}}}`
- ChatGPT et claude.ai web exigent un serveur public en HTTPS : non pris en charge (ClipForge reste local).

**Publication**
- **YouTube** : envoi direct (OAuth, envoi avec reprise, programmation, Shorts). Configuration unique
  avec tes propres identifiants Google Cloud, guidée dans l'appli. Tant que le projet Google n'a pas
  passé l'audit YouTube, les vidéos envoyées par API restent privées.
- **TikTok / Instagram / X** : publication assistée (légende prête à copier, téléchargement, ouverture
  de la page d'envoi). Leurs API n'acceptent pas une appli locale non auditée.

## Architecture

```
public/        interface (JS natif, sans étape de build)
  app.js         bibliothèque, éditeur de clip, exports
  montage.js     éditeur de montage + aperçu
  publish.js     fenêtre de publication
server/
  index.js       API HTTP (Express)
  library.js     scan + surveillance du dossier, miniatures
  naming.js      lecture des noms Game Bar / OBS
  montage.js     graphe FFmpeg des montages (fonction pure, testée)
  exports.js     file de rendus
  youtube.js     OAuth + envoi YouTube
  highlights.js  détection des moments forts
  transcribe.js  Whisper local ; captions.js découpe en sous-titres
  remote.js      accès téléphone (clé, QR) + protection anti-CSRF
  jobs.js        tâches longues suivies par l'interface
  mcp.js         outils MCP (pour Claude Code, Gemini CLI…) ; bin/clipforge-mcp.js : pont stdio
  camera.js      caméra virtuelle du mode Combat ; tracking.js détection des persos
  cloud.js       sources cloud via rclone ; unzip.js, rclone-output.js
  ai.js          fournisseurs d'IA ; ai-features.js ce que l'IA fait dans ClipForge
  db.js          SQLite (node:sqlite)
electron/      appli de bureau (main.js, icône) ; scripts/ fabrication multi-OS
data/          base, miniatures, exports, musiques (non versionné)
```

Le rendu d'un montage avec musique se fait en 2 passes (montage, puis mixage de la musique en copiant la
vidéo) : mélanger une entrée audio bouclée dans le graphe principal peut bloquer FFmpeg.
