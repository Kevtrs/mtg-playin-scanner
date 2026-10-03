# MTG Playin Scanner — PWA iPhone

Application web statique : reconnaissance visuelle locale avec CollectorVision, identification exacte via Scryfall, puis vérification du prix public de rachat Playin. Elle ne se connecte à aucun compte et n’ajoute rien au panier.

Le moteur [CollectorVision](https://github.com/HanClinto/CollectorVision), ses modèles et son catalogue sont distribués sous licence AGPL-3.0. Le premier lancement télécharge environ 40 Mo, ensuite mis en cache sur l’appareil.

## Mise en ligne (très simple)

1. Sur GitHub, crée un dépôt public nommé `mtg-playin-scanner` sans ajouter de README.
2. Dans ce dossier, exécute :

   ```bash
   git init
   git add .
   git commit -m "PWA MTG Playin Scanner"
   git branch -M main
   git remote add origin https://github.com/TON-PSEUDO/mtg-playin-scanner.git
   git push -u origin main
   ```

3. Dans le dépôt GitHub : **Settings → Pages → Build and deployment → Source → GitHub Actions**.
4. Attends la coche verte dans l’onglet **Actions**, puis ouvre `https://TON-PSEUDO.github.io/mtg-playin-scanner/`.

## Installation iPhone

1. Ouvre l’URL dans **Safari** (pas dans le navigateur intégré d’une autre app).
2. Appuie sur **Partager**.
3. Choisis **Sur l’écran d’accueil**, puis **Ajouter**.
4. Lance l’icône et autorise la caméra au premier démarrage.

GitHub Pages fournit HTTPS : c’est indispensable à `getUserMedia`, donc la caméra fonctionne une fois le site publié.

## Limite Playin / CORS

Scryfall accepte les appels directs depuis le navigateur. Playin ne garantit pas l’accès cross-origin depuis une page GitHub Pages. Une PWA statique ne peut pas contourner ce blocage elle-même.

Par défaut, **Chercher sur Playin** ouvre la recherche publique dans un nouvel onglet. Dans **Réglages Playin**, on peut saisir un proxy CORS public configurable sous la forme `https://proxy.exemple/?url={url}`. N’utilise jamais un proxy inconnu avec un compte ou des cookies Playin : cette application ne lui transmet volontairement aucune authentification.

## Développement local

```bash
npm install
npm run dev
```

`localhost` est autorisé pour tester la caméra sur ordinateur. Sur iPhone, utilise la version HTTPS publiée.
