# ClipForge

Bibliothèque locale de clips de jeu : rangement automatique, découpe, montage multi-clips et publication.

## Lancer

```bash
npm install
npm start          # → http://localhost:4317
npm test           # 45 tests : unitaires, bout en bout (vrais rendus FFmpeg, vrai Whisper), navigateur
```

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
  db.js          SQLite (node:sqlite)
data/          base, miniatures, exports, musiques (non versionné)
```

Le rendu d'un montage avec musique se fait en 2 passes (montage, puis mixage de la musique en copiant la
vidéo) : mélanger une entrée audio bouclée dans le graphe principal peut bloquer FFmpeg.
