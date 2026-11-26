# onlymy — Guess My Rank
## Lancer
    npm install
    ADMIN_KEY=ton_mot_de_passe npm start      # http://localhost:3000
Node 18+ requis. Pour héberger : n'importe quel VPS / Render / Railway (disque persistant pour data/ et uploads/).
Derrière nginx, mets `client_max_body_size 0;` pour ne pas limiter la taille des vidéos.

## Logos des rangs
Dépose tes images dans `public/ranks/` (PNG transparent), noms en minuscules :
fer.png bronze.png argent.png or.png platine.png diamant.png ascendant.png immortel.png radiant.png
Sans image, le site affiche des gemmes colorées.

## Admin
Panneau admin : http://localhost:3000/admin (code à 4 chiffres = ADMIN_KEY, ex. ADMIN_KEY=4827 npm start)

## Panel admin
Va sur /admin (code à 4 chiffres = ADMIN_KEY, ex. ADMIN_KEY=4827 npm start) : nom du site, couleurs, image de fond + flou, icône du site, ordre des blocs, boutons Discord/liens (nom, lien, couleur, icône importée, haut/bas, suppression) et gestion des clips.
Réglages enregistrés dans data/settings.json.
